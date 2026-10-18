#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Factory Desktop (v0.199.1+) Chinese Localization Patcher (Windows & macOS)
Usage:
  python patcher.py             # Apply localization & persist runtime to ~/.factory-zh
  python patcher.py --force     # Rebuild from clean backup & re-apply localization
  python patcher.py --no-guard  # Apply localization without touching background guard
  python patcher.py --skip-kill # Do not auto-restart Factory after patching
  python patcher.py --check     # Check current patch status
"""
from __future__ import annotations

import argparse
import os
import plistlib
import re
try:
    import pwd
except ImportError:
    pwd = None
import shlex
import shutil
import subprocess
import sys
import tempfile
import time

IS_WIN = os.name == "nt"


def get_real_user_info() -> tuple[int, int, str, str]:
    if IS_WIN or pwd is None:
        return (
            0,
            0,
            os.environ.get("USERNAME") or os.environ.get("USER") or "user",
            os.path.expanduser("~"),
        )
    uid = os.getuid()
    gid = os.getgid()
    if uid != 0:
        pw = pwd.getpwuid(uid)
        return uid, gid, pw.pw_name, pw.pw_dir
    sudo_uid = os.environ.get("SUDO_UID")
    sudo_user = os.environ.get("SUDO_USER")
    if sudo_uid and sudo_uid.isdigit() and int(sudo_uid) > 0:
        pw = pwd.getpwuid(int(sudo_uid))
        return pw.pw_uid, pw.pw_gid, pw.pw_name, pw.pw_dir
    if sudo_user and sudo_user != "root":
        try:
            pw = pwd.getpwnam(sudo_user)
            return pw.pw_uid, pw.pw_gid, pw.pw_name, pw.pw_dir
        except KeyError:
            pass
    try:
        st = os.stat("/dev/console")
        if st.st_uid > 0:
            pw = pwd.getpwuid(st.st_uid)
            return pw.pw_uid, pw.pw_gid, pw.pw_name, pw.pw_dir
    except Exception:
        pass
    pw = pwd.getpwuid(0)
    return 0, 0, pw.pw_name, pw.pw_dir


REAL_UID, REAL_GID, REAL_USER, REAL_HOME = get_real_user_info()
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PERSIST_DIR = os.path.join(REAL_HOME, ".factory-zh")
PERSIST_ENGINE_SCRIPT = os.path.join(PERSIST_DIR, "engine", "asar-patcher.js")
PERSIST_GUARD_SCRIPT = os.path.join(PERSIST_DIR, "guard.js")


def _parse_semver_key(name: str) -> tuple[int, int, int, str]:
    m = re.match(r"^app-(\d+)\.(\d+)\.(\d+)", name, re.IGNORECASE)
    if not m:
        return (0, 0, 0, name)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)), name)


def _resolve_win_app_dir(root_dir: str | None) -> str | None:
    if not root_dir or not os.path.exists(root_dir):
        return None
    if os.path.exists(os.path.join(root_dir, "resources", "app.asar")):
        return root_dir
    try:
        subdirs = [
            d for d in os.listdir(root_dir)
            if os.path.isdir(os.path.join(root_dir, d)) and d.lower().startswith("app-")
        ]
        subdirs.sort(key=_parse_semver_key, reverse=True)
        for d in subdirs:
            candidate = os.path.join(root_dir, d)
            if os.path.exists(os.path.join(candidate, "resources", "app.asar")):
                return candidate
    except Exception:
        pass
    return None


def resolve_app_path() -> str:
    if IS_WIN:
        local_app_data = os.environ.get("LOCALAPPDATA") or os.path.join(REAL_HOME, "AppData", "Local")
        program_files = os.environ.get("PROGRAMFILES") or r"C:\Program Files"
        candidates = [
            os.environ.get("FACTORY_APP_PATH"),
            os.path.join(local_app_data, "Factory"),
            os.path.join(program_files, "Factory"),
        ]
        for c in candidates:
            resolved = _resolve_win_app_dir(c)
            if resolved:
                return resolved
        return os.path.join(local_app_data, "Factory")

    candidates = [
        os.environ.get("FACTORY_APP_PATH"),
        "/Applications/Factory.app",
        os.path.join(REAL_HOME, "Applications", "Factory.app"),
    ]
    for c in candidates:
        if c and os.path.exists(os.path.join(c, "Contents", "Resources", "app.asar")):
            return c
    return "/Applications/Factory.app"


APP_PATH = resolve_app_path()
ASAR_FILE = (
    os.path.join(APP_PATH, "resources", "app.asar")
    if IS_WIN
    else os.path.join(APP_PATH, "Contents", "Resources", "app.asar")
)
DROID_BIN = (
    os.path.join(APP_PATH, "resources", "bin", "droid.exe")
    if IS_WIN
    else os.path.join(APP_PATH, "Contents", "Resources", "bin", "droid")
)
PLIST_LABEL = "com.factory.zh-cn"
PLIST_PATH = os.path.join(REAL_HOME, "Library", "LaunchAgents", f"{PLIST_LABEL}.plist")

GUARD_JS_CONTENT = """#!/usr/bin/env node
/**
 * Factory Desktop (v0.199.1+) Auto-Heal Guard
 * Automatically generated into ~/.factory-zh/guard.js by patcher.py
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  isAlreadyPatched,
  runPatch,
  computeAsarHeaderHash,
  BACKUP_DIR,
  ASAR_PATH,
  STATE_FILE
} = require('./engine/asar-patcher.js');

const LOG_FILE = path.join(BACKUP_DIR, 'guard.log');
const MAX_LOG_BYTES = 256 * 1024;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true, mode: 0o700 });
    if (fs.existsSync(LOG_FILE)) {
      const st = fs.statSync(LOG_FILE);
      if (st.size > MAX_LOG_BYTES) {
        const tail = fs.readFileSync(LOG_FILE).subarray(st.size - Math.floor(MAX_LOG_BYTES / 2));
        fs.writeFileSync(LOG_FILE, tail, { mode: 0o600 });
      }
    }
    fs.appendFileSync(LOG_FILE, line, { encoding: 'utf8', mode: 0o600 });
  } catch (_) {}
}

function main() {
  let currentHash = '';
  try {
    if (!fs.existsSync(ASAR_PATH)) {
      return;
    }
    if (isAlreadyPatched()) {
      return;
    }
    currentHash = computeAsarHeaderHash(ASAR_PATH);
    if (fs.existsSync(STATE_FILE)) {
      try {
        const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (st.lastFailedHash && st.lastFailedHash === currentHash) {
          return;
        }
      } catch (_) {}
    }
    log(`Detected unpatched or updated Factory (hash=${currentHash.slice(0, 12)}...); applying Chinese localization patch...`);
    const res = runPatch({ force: false });
    log(`Auto-heal result: ${JSON.stringify(res)}`);
  } catch (err) {
    log(`Auto-heal error: ${err && err.stack ? err.stack : String(err)}`);
    if (currentHash) {
      try {
        let st = {};
        if (fs.existsSync(STATE_FILE)) {
          st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        }
        st.lastFailedHash = currentHash;
        st.lastFailedAt = new Date().toISOString();
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true, mode: 0o700 });
        fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2), 'utf8');
      } catch (_) {}
    }
    process.exitCode = 1;
  }
}

main();
"""


def chown_to_real_user(target_path: str) -> None:
    if IS_WIN or not hasattr(os, "getuid") or os.getuid() != 0 or REAL_UID == 0 or not os.path.exists(target_path):
        return
    try:
        subprocess.run(
            ["/usr/sbin/chown", "-R", f"{REAL_UID}:{REAL_GID}", target_path],
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except Exception:
        pass


def sync_runtime_to_persist() -> None:
    os.makedirs(os.path.join(PERSIST_DIR, "backup"), mode=0o700, exist_ok=True)
    if os.path.abspath(BASE_DIR) != os.path.abspath(PERSIST_DIR):
        for subdir in ("engine", "locales"):
            src_dir = os.path.join(BASE_DIR, subdir)
            dst_dir = os.path.join(PERSIST_DIR, subdir)
            if os.path.isdir(src_dir):
                os.makedirs(dst_dir, exist_ok=True)
                for fname in os.listdir(src_dir):
                    sfile = os.path.join(src_dir, fname)
                    dfile = os.path.join(dst_dir, fname)
                    if os.path.isfile(sfile):
                        shutil.copy2(sfile, dfile)
        for fname in ("patcher.py", "restore.py", "localize_sessions.py"):
            sfile = os.path.join(BASE_DIR, fname)
            dfile = os.path.join(PERSIST_DIR, fname)
            if os.path.isfile(sfile):
                shutil.copy2(sfile, dfile)

        legacy_backup = os.path.join(BASE_DIR, "backup")
        if os.path.isdir(legacy_backup):
            for fname in os.listdir(legacy_backup):
                if fname == ".patcher.lock":
                    continue
                sfile = os.path.join(legacy_backup, fname)
                dfile = os.path.join(PERSIST_DIR, "backup", fname)
                if os.path.isfile(sfile) and not os.path.exists(dfile):
                    shutil.copy2(sfile, dfile)
            shutil.rmtree(os.path.join(legacy_backup, ".patcher.lock"), ignore_errors=True)

    with open(PERSIST_GUARD_SCRIPT, "w", encoding="utf-8") as fp:
        fp.write(GUARD_JS_CONTENT)
    try:
        os.chmod(PERSIST_GUARD_SCRIPT, 0o755)
    except Exception:
        pass

    try:
        with open(os.path.join(PERSIST_DIR, "backup", "python-bin.txt"), "w", encoding="utf-8") as fp:
            fp.write(sys.executable or "python")
    except Exception:
        pass

    chown_to_real_user(PERSIST_DIR)


def resolve_js_runtime() -> tuple[str, dict[str, str], str | None]:
    node_bin = shutil.which("node")
    if IS_WIN:
        if node_bin and os.path.exists(node_bin):
            return node_bin, {}, None
        if os.path.exists(DROID_BIN):
            # Copy droid.exe to a temp file so it does not lock resources/bin/droid.exe during in-place patching
            tmp_droid = os.path.join(tempfile.gettempdir(), f"factory-zh-bun-{os.getpid()}.exe")
            shutil.copy2(DROID_BIN, tmp_droid)
            return tmp_droid, {"BUN_BE_BUN": "1"}, tmp_droid
        return "node", {}, None

    for candidate in ("/opt/homebrew/bin/node", "/usr/local/bin/node", node_bin):
        if candidate and os.path.exists(candidate):
            return candidate, {}, None
    if os.path.exists(DROID_BIN):
        return DROID_BIN, {"BUN_BE_BUN": "1"}, None
    return "node", {}, None


def run_engine(args: list[str]) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["FACTORY_APP_PATH"] = APP_PATH
    runtime_bin, extra_env, tmp_runtime = resolve_js_runtime()
    env.update(extra_env)
    script_path = (
        PERSIST_ENGINE_SCRIPT
        if os.path.exists(PERSIST_ENGINE_SCRIPT)
        else os.path.join(BASE_DIR, "engine", "asar-patcher.js")
    )
    cmd = [runtime_bin, script_path] + args
    try:
        return subprocess.run(cmd, env=env, text=True, encoding="utf-8", errors="replace", capture_output=True, check=False)
    finally:
        if tmp_runtime and os.path.exists(tmp_runtime):
            try:
                os.remove(tmp_runtime)
            except Exception:
                pass


def install_launch_agent() -> None:
    if IS_WIN:
        return
    launch_agents_dir = os.path.dirname(PLIST_PATH)
    os.makedirs(launch_agents_dir, exist_ok=True)
    chown_to_real_user(launch_agents_dir)

    runtime_bin, extra_env, _ = resolve_js_runtime()
    env_vars = {
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        "FACTORY_APP_PATH": APP_PATH,
    }
    env_vars.update(extra_env)
    watch_paths = [
        os.path.dirname(APP_PATH),
        os.path.join(APP_PATH, "Contents", "Resources"),
    ]
    plist_data = {
        "Label": PLIST_LABEL,
        "ProgramArguments": [runtime_bin, PERSIST_GUARD_SCRIPT],
        "EnvironmentVariables": env_vars,
        "RunAtLoad": True,
        "StartInterval": 120,
        "WatchPaths": watch_paths,
        "StandardOutPath": "/dev/null",
        "StandardErrorPath": "/dev/null",
    }
    with open(PLIST_PATH, "wb") as f:
        plistlib.dump(plist_data, f)
    os.chmod(PLIST_PATH, 0o644)
    chown_to_real_user(PLIST_PATH)

    uid_str = str(REAL_UID)
    subprocess.run(["/bin/launchctl", "bootout", f"gui/{uid_str}/{PLIST_LABEL}"], stderr=subprocess.DEVNULL)
    subprocess.run(["/bin/launchctl", "bootout", f"gui/{uid_str}", PLIST_PATH], stderr=subprocess.DEVNULL)
    subprocess.run(["/bin/launchctl", "enable", f"gui/{uid_str}/{PLIST_LABEL}"], stderr=subprocess.DEVNULL)
    subprocess.run(["/bin/launchctl", "bootstrap", f"gui/{uid_str}", PLIST_PATH], stderr=subprocess.DEVNULL, check=False)
    print(f"[factory-zh] Installed and loaded LaunchAgent: {PLIST_PATH} -> {PERSIST_GUARD_SCRIPT}")


def _win_ancestor_exes() -> list[str]:
    """Lowercase exe names of ancestor processes (excluding ourselves), via Toolhelp32."""
    try:
        import ctypes
        from ctypes import wintypes

        class _PE32W(ctypes.Structure):
            _fields_ = [
                ("dwSize", wintypes.DWORD),
                ("cntUsage", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.c_size_t),
                ("th32ModuleID", wintypes.DWORD),
                ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", ctypes.c_long),
                ("dwFlags", wintypes.DWORD),
                ("szExeFile", ctypes.c_wchar * 260),
            ]

        k32 = ctypes.windll.kernel32
        k32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
        k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        k32.Process32FirstW.argtypes = [ctypes.c_void_p, ctypes.POINTER(_PE32W)]
        k32.Process32NextW.argtypes = [ctypes.c_void_p, ctypes.POINTER(_PE32W)]
        k32.Process32FirstW.restype = wintypes.BOOL
        k32.Process32NextW.restype = wintypes.BOOL
        k32.CloseHandle.argtypes = [ctypes.c_void_p]

        snap = k32.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
        if not snap or snap == ctypes.c_void_p(-1).value:
            return []
        table = {}
        try:
            entry = _PE32W()
            entry.dwSize = ctypes.sizeof(_PE32W)
            ok = k32.Process32FirstW(snap, ctypes.byref(entry))
            while ok:
                table[entry.th32ProcessID] = (entry.szExeFile, entry.th32ParentProcessID)
                ok = k32.Process32NextW(snap, ctypes.byref(entry))
        finally:
            k32.CloseHandle(snap)

        names: list[str] = []
        seen = set()
        pid = os.getpid()
        for _ in range(64):
            if not pid or pid in seen:
                break
            seen.add(pid)
            info = table.get(pid)
            if not info:
                break
            pid = info[1]
            parent = table.get(pid)
            if not parent:
                break
            names.append(parent[0].lower())
        return names
    except Exception:
        return []


def is_running_inside_factory() -> bool:
    if IS_WIN:
        ancestors = _win_ancestor_exes()
        return any(n in ("factory-desktop.exe", "droid.exe") for n in ancestors)
    pid = os.getpid()
    visited = set()
    while pid and pid > 1 and pid not in visited:
        visited.add(pid)
        try:
            out = subprocess.check_output(
                ["/bin/ps", "-o", "ppid=,comm=", "-p", str(pid)],
                stderr=subprocess.DEVNULL,
                text=True,
            ).strip()
            if not out:
                break
            parts = out.split(None, 1)
            ppid = int(parts[0])
            comm = parts[1] if len(parts) > 1 else ""
            if any(k in comm for k in ("Factory.app", "/Factory", "bin/droid")):
                return True
            pid = ppid
        except Exception:
            break
    return False


def is_factory_running() -> bool:
    if IS_WIN:
        res = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq factory-desktop.exe", "/FO", "CSV", "/NH"],
            capture_output=True,
            check=False,
        )
        return b"factory-desktop.exe" in (res.stdout or b"").lower()
    res = subprocess.run(["/usr/bin/pgrep", "-x", "Factory"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return res.returncode == 0


def stop_factory_on_windows() -> bool:
    res = subprocess.run(
        ["taskkill", "/F", "/IM", "factory-desktop.exe"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    was_running = res.returncode == 0
    subprocess.run(["taskkill", "/F", "/IM", "droid.exe"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    if was_running:
        time.sleep(1.2)
    return was_running


def start_factory_on_windows() -> None:
    exe_path = os.path.join(APP_PATH, "factory-desktop.exe")
    if os.path.exists(exe_path):
        try:
            print("[factory-zh] 正在为您自动重新启动 Factory Desktop 以应用全量中文界面...")
            subprocess.Popen(
                [exe_path],
                cwd=APP_PATH,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
            )
        except Exception:
            print("[factory-zh] 请手动重新打开 Factory Desktop 以应用中文界面。")


def restart_or_prompt_factory(skip_kill: bool) -> None:
    if not is_factory_running():
        return
    if skip_kill or is_running_inside_factory():
        print(
            "[factory-zh] 检测到当前在内置终端中运行（或指定了 --skip-kill），已跳过自动重启以防中断。\n"
            "[factory-zh] 请完全退出并重新打开 Factory 即可生效！"
        )
        return
    try:
        print("[factory-zh] 正在为您自动重启 Factory.app 以应用全量中文界面...")
        subprocess.run(["/usr/bin/killall", "Factory"], stderr=subprocess.DEVNULL, check=False)
        time.sleep(1.0)
        if os.getuid() == 0 and REAL_USER != "root":
            subprocess.run(
                ["/usr/bin/su", "-", REAL_USER, "-c", f"open -a {shlex.quote(APP_PATH)}"],
                check=False,
            )
        else:
            subprocess.run(["/usr/bin/open", "-a", APP_PATH], check=False)
    except Exception:
        print("[factory-zh] 请手动重启 Factory.app 以应用中文界面。")


def main() -> None:
    parser = argparse.ArgumentParser(description="Factory Desktop Chinese Localization Patcher")
    parser.add_argument("--force", action="store_true", help="Force re-patch from clean backup")
    parser.add_argument("--no-guard", action="store_true", help="Do not install/reload background guard")
    parser.add_argument("--skip-kill", action="store_true", help="Do not auto-restart Factory after patching")
    parser.add_argument("--check", action="store_true", help="Check if Factory is currently patched")
    args = parser.parse_args()

    if args.check:
        res = run_engine(["--check"])
        if res.stdout:
            print(res.stdout.strip())
        sys.exit(res.returncode)

    if IS_WIN and is_running_inside_factory():
        print(
            "[factory-zh] 检测到当前正运行在 Factory 内置终端中。\n"
            "[factory-zh] Windows 下无法在 Factory 运行期间替换其程序文件，为保护当前会话已自动中止。\n"
            "[factory-zh] 请完全关闭 Factory Desktop 后，在系统自带的 PowerShell 或 CMD 中重新运行本脚本。"
        )
        sys.exit(1)

    if not os.path.exists(ASAR_FILE):
        print(
            f"[factory-zh] 错误：未找到 Factory 安装目录（已检查 {APP_PATH}）。\n"
            "请确认已安装 Factory Desktop，或通过环境变量 FACTORY_APP_PATH 指定安装路径。"
        )
        sys.exit(1)

    sync_runtime_to_persist()

    was_running_win = False
    if IS_WIN and not args.skip_kill:
        if is_factory_running():
            print("[factory-zh] 检测到 Factory Desktop 正在运行，将自动关闭并在汉化完成后重启...")
        was_running_win = stop_factory_on_windows()

    engine_args = ["--force"] if args.force else []
    res = run_engine(engine_args)
    if res.stdout:
        print(res.stdout, end="")
    if res.returncode != 0:
        err_text = (res.stderr or "") + (res.stdout or "")
        if res.stderr:
            print(res.stderr, end="", file=sys.stderr)
        if any(k in err_text for k in ("EACCES", "EPERM", "EBUSY", "Permission denied", "Operation not permitted")):
            if IS_WIN:
                print(
                    f"\n[factory-zh] ⚠️ 文件被占用或权限不足：无法修改 {APP_PATH}。\n"
                    "请先完全关闭 Factory Desktop（含任务管理器中的 factory-desktop.exe / droid.exe）后重试。",
                    file=sys.stderr,
                )
            else:
                print(
                    f"\n[factory-zh] ⚠️ 权限不足：当前「终端」没有修改 {APP_PATH} 的权限。\n"
                    "请运行 sudo python3 patcher.py 重试。",
                    file=sys.stderr,
                )
        sys.exit(res.returncode)

    try:
        from localize_sessions import localize_all_sessions
        sres = localize_all_sessions()
        if sres["updated_jsonl"] or sres["updated_db"]:
            print(
                f"[factory-zh] Localized session titles: "
                f"{sres['updated_jsonl']} .jsonl files, {sres['updated_db']} SQLite rows."
            )
    except Exception as e:
        print(f"[factory-zh] Warning localizing sessions: {e}")

    if not args.no_guard and not IS_WIN:
        install_launch_agent()

    chown_to_real_user(PERSIST_DIR)
    if IS_WIN:
        if not args.skip_kill and (was_running_win or not is_factory_running()):
            start_factory_on_windows()
    else:
        restart_or_prompt_factory(args.skip_kill)


if __name__ == "__main__":
    main()
