#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Factory Desktop (v0.199.1+) Clean Uninstaller & Restorer (Windows & macOS)
Restores original app.asar, factory-desktop.exe / Info.plist, and bin/droid,
cleans up ~/.factory-zh, and restarts Factory.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
try:
    import pwd
except ImportError:
    pwd = None
import shlex
import shutil
import struct
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
BACKUP_DIR = (
    os.path.join(PERSIST_DIR, "backup")
    if os.path.isdir(os.path.join(PERSIST_DIR, "backup"))
    else os.path.join(BASE_DIR, "backup")
)


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
BACKUP_ASAR = os.path.join(BACKUP_DIR, "app.asar.orig")
BACKUP_PLIST = os.path.join(BACKUP_DIR, "Info.plist.orig")
BACKUP_EXE_HASH = os.path.join(BACKUP_DIR, "exe-integrity-hash.orig")
STATE_FILE = os.path.join(BACKUP_DIR, "patch-state.json")
LOCK_DIR = (
    os.path.join(tempfile.gettempdir(), f"factory-zh-{REAL_USER}.lock")
    if IS_WIN
    else f"/tmp/factory-zh-{REAL_UID}.lock"
)
PLIST_LABEL = "com.factory.zh-cn"
PLIST_PATH = os.path.join(REAL_HOME, "Library", "LaunchAgents", f"{PLIST_LABEL}.plist")

ENTITLEMENTS_XML = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>com.apple.security.cs.allow-jit</key>
\t<true/>
\t<key>com.apple.security.cs.allow-unsigned-executable-memory</key>
\t<true/>
\t<key>com.apple.security.cs.disable-library-validation</key>
\t<true/>
\t<key>com.apple.security.device.audio-input</key>
\t<true/>
\t<key>com.apple.security.device.camera</key>
\t<true/>
\t<key>com.apple.security.automation.apple-events</key>
\t<true/>
</dict>
</plist>
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


def _pid_alive(pid: int) -> bool:
    if not pid or pid <= 0:
        return False
    try:
        if IS_WIN:
            import ctypes
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            STILL_ACTIVE = 259
            kernel32 = ctypes.windll.kernel32
            kernel32.OpenProcess.restype = ctypes.c_void_p
            handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if not handle:
                return False
            try:
                exit_code = ctypes.c_ulong()
                if kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                    return exit_code.value == STILL_ACTIVE
                return True
            finally:
                kernel32.CloseHandle(handle)
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def acquire_lock(timeout_sec: float = 15.0) -> bool:
    shutil.rmtree(os.path.join(BACKUP_DIR, ".patcher.lock"), ignore_errors=True)
    shutil.rmtree(os.path.join(BASE_DIR, "backup", ".patcher.lock"), ignore_errors=True)
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        try:
            os.mkdir(LOCK_DIR, 0o700)
            with open(os.path.join(LOCK_DIR, "pid"), "w", encoding="utf-8") as fp:
                fp.write(str(os.getpid()))
            chown_to_real_user(LOCK_DIR)
            return True
        except FileExistsError:
            holder = 0
            try:
                with open(os.path.join(LOCK_DIR, "pid"), "r", encoding="utf-8") as fp:
                    holder = int((fp.read() or "").strip() or 0)
            except Exception:
                holder = 0
            if holder > 0 and _pid_alive(holder):
                time.sleep(0.2)
                continue
            # Stale lock (holder process no longer alive) -> take over.
            shutil.rmtree(LOCK_DIR, ignore_errors=True)
            time.sleep(0.05)
    return False


def release_lock() -> None:
    shutil.rmtree(LOCK_DIR, ignore_errors=True)


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
            print("[factory-zh] 正在为您自动重启 Factory Desktop 以恢复英文原版界面...")
            subprocess.Popen(
                [exe_path],
                cwd=APP_PATH,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
            )
        except Exception:
            print("[factory-zh] 请手动重新打开 Factory Desktop 以恢复英文原版界面。")


def restart_or_prompt_factory(skip_kill: bool) -> None:
    if not is_factory_running():
        return
    if skip_kill or is_running_inside_factory():
        print(
            "[factory-zh] 检测到当前在内置终端中运行（或指定了 --skip-kill），已跳过自动重启。\n"
            "[factory-zh] 请完全退出并重新打开 Factory 即可恢复英文原版界面！"
        )
        return
    try:
        print("[factory-zh] 正在为您自动重启 Factory.app 以恢复英文原版界面...")
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
        print("[factory-zh] 请手动重启 Factory.app 以恢复英文原版界面。")


def collect_files_recursive(root_dir: str, suffixes: tuple[str, ...] | None = None) -> list[str]:
    result: list[str] = []
    if not os.path.isdir(root_dir):
        return result
    for dirpath, _, filenames in os.walk(root_dir):
        for fname in filenames:
            full = os.path.join(dirpath, fname)
            if suffixes is None or full.endswith(suffixes):
                result.append(full)
    return result


def cleanup_persist_dir() -> None:
    if not os.path.isdir(PERSIST_DIR):
        return
    custom_titles = os.path.join(PERSIST_DIR, "backup", "custom-session-titles.json")
    has_custom = os.path.isfile(custom_titles)
    for entry in os.listdir(PERSIST_DIR):
        full = os.path.join(PERSIST_DIR, entry)
        if entry == "backup" and has_custom:
            for bfile in os.listdir(full):
                if bfile != "custom-session-titles.json":
                    bfull = os.path.join(full, bfile)
                    if os.path.isdir(bfull):
                        shutil.rmtree(bfull, ignore_errors=True)
                    else:
                        try:
                            os.remove(bfull)
                        except Exception:
                            pass
        else:
            if os.path.isdir(full):
                shutil.rmtree(full, ignore_errors=True)
            else:
                try:
                    os.remove(full)
                except Exception:
                    pass
    if not has_custom:
        shutil.rmtree(PERSIST_DIR, ignore_errors=True)


def compute_asar_header_hash(asar_path: str) -> str:
    with open(asar_path, "rb") as fp:
        hdr16 = fp.read(16)
        h_strlen = struct.unpack("<I", hdr16[12:16])[0]
        header_buf = fp.read(h_strlen)
    return hashlib.sha256(header_buf).hexdigest()


def update_windows_exe_integrity(exe_path: str, new_hash: str) -> None:
    prefix = b'[{"file":"resources\\\\app.asar","alg":"SHA256","value":"'
    with open(exe_path, "rb") as fp:
        data = bytearray(fp.read())
    idx = data.find(prefix)
    if idx == -1:
        raise RuntimeError("Failed to find ASAR integrity resource in factory-desktop.exe")
    start = idx + len(prefix)
    data[start : start + 64] = new_hash.lower().encode("ascii")
    tmp_exe = f"{exe_path}.zh-restore-{os.getpid()}"
    with open(tmp_exe, "wb") as fp:
        fp.write(data)
    os.replace(tmp_exe, exe_path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Factory Desktop Clean Uninstaller & Restorer")
    parser.add_argument("--skip-kill", action="store_true", help="Do not auto-restart Factory after restoring")
    args = parser.parse_args()

    if IS_WIN:
        if not os.path.exists(BACKUP_ASAR):
            print("[factory-zh] 未在 ~/.factory-zh/backup 中找到原版备份文件，无需还原。")
            return
        if is_running_inside_factory():
            print(
                "[factory-zh] 检测到当前正运行在 Factory 内置终端中。\n"
                "[factory-zh] Windows 下无法在 Factory 运行期间替换其程序文件，为保护当前会话已自动中止。\n"
                "[factory-zh] 请完全关闭 Factory Desktop 后，在系统自带的 PowerShell 或 CMD 中重新运行本脚本。"
            )
            return
        if not acquire_lock():
            raise RuntimeError("[factory-zh] Timed out waiting for active patcher lock.")
        was_running = False
        try:
            if not args.skip_kill:
                if is_factory_running():
                    print("[factory-zh] 检测到 Factory Desktop 正在运行，将自动关闭并在还原完成后重启...")
                was_running = stop_factory_on_windows()
            target_asar = os.path.join(APP_PATH, "resources", "app.asar")
            target_exe = os.path.join(APP_PATH, "factory-desktop.exe")
            target_droid = os.path.join(APP_PATH, "resources", "bin", "droid.exe")

            # Compute every hash BEFORE touching files, and sync the exe hash before
            # swapping the asar: any failure then leaves the app bootable either way.
            orig_hash = compute_asar_header_hash(BACKUP_ASAR)
            if os.path.exists(BACKUP_EXE_HASH):
                with open(BACKUP_EXE_HASH, "r", encoding="utf-8") as fp:
                    saved_h = fp.read().strip()
                    if len(saved_h) == 64:
                        orig_hash = saved_h
            patched_hash = compute_asar_header_hash(target_asar) if os.path.exists(target_asar) else None

            if os.path.exists(target_exe):
                update_windows_exe_integrity(target_exe, orig_hash)

            tmp_asar = f"{target_asar}.zh-restore-{os.getpid()}"
            shutil.copy2(BACKUP_ASAR, tmp_asar)
            try:
                os.replace(tmp_asar, target_asar)
            except Exception:
                # The still-patched asar keeps its own header hash; roll the exe back to it.
                if patched_hash and os.path.exists(target_exe):
                    try:
                        update_windows_exe_integrity(target_exe, patched_hash)
                    except Exception:
                        pass
                if os.path.exists(tmp_asar):
                    try:
                        os.remove(tmp_asar)
                    except Exception:
                        pass
                raise

            backup_droid = os.path.join(BACKUP_DIR, "droid.orig")
            if os.path.exists(backup_droid) and os.path.exists(target_droid):
                tmp_droid = f"{target_droid}.zh-restore-{os.getpid()}"
                shutil.copy2(backup_droid, tmp_droid)
                os.replace(tmp_droid, target_droid)

            backup_local_droid = os.path.join(BACKUP_DIR, "local-droid.orig")
            local_droid = os.path.join(REAL_HOME, ".local", "bin", "droid.exe")
            if os.path.exists(backup_local_droid) and os.path.exists(local_droid):
                try:
                    tmp_local = f"{local_droid}.zh-restore-{os.getpid()}"
                    shutil.copy2(backup_local_droid, tmp_local)
                    os.replace(tmp_local, local_droid)
                except Exception:
                    pass

            try:
                from localize_sessions import restore_all_sessions
                restore_all_sessions()
            except Exception:
                pass

            cleanup_persist_dir()
            print("[factory-zh] 已无损还原 Factory Desktop 英文原版，并清理 ~/.factory-zh 持久化目录！")
            if was_running and not args.skip_kill:
                start_factory_on_windows()
        finally:
            release_lock()
        return

    uid_str = str(REAL_UID)
    subprocess.run(["/bin/launchctl", "bootout", f"gui/{uid_str}/{PLIST_LABEL}"], stderr=subprocess.DEVNULL)
    if os.path.exists(PLIST_PATH):
        subprocess.run(["/bin/launchctl", "bootout", f"gui/{uid_str}", PLIST_PATH], stderr=subprocess.DEVNULL)
        try:
            os.remove(PLIST_PATH)
            print(f"[factory-zh] Unloaded and removed LaunchAgent: {PLIST_PATH}")
        except Exception:
            pass

    if not os.path.exists(BACKUP_ASAR) or not os.path.exists(BACKUP_PLIST):
        print("[factory-zh] No backup files found in ~/.factory-zh/backup; nothing to restore.")
        return

    if not acquire_lock():
        raise RuntimeError("[factory-zh] Timed out waiting for active patcher lock.")

    work_tmp_dir = tempfile.mkdtemp(prefix="factory-zh-restore-", dir="/private/tmp")
    staging_app = os.path.join(work_tmp_dir, "Factory.app.staging")
    old_app = os.path.join(work_tmp_dir, "Factory.app.old")
    ent_path = os.path.join(work_tmp_dir, "entitlements.plist")

    try:
        with open(ent_path, "w", encoding="utf-8") as fp:
            fp.write(ENTITLEMENTS_XML)

        subprocess.run(["/bin/cp", "-cR", APP_PATH, staging_app], check=True)
        shutil.copy2(BACKUP_ASAR, os.path.join(staging_app, "Contents/Resources/app.asar"))
        shutil.copy2(BACKUP_PLIST, os.path.join(staging_app, "Contents/Info.plist"))
        backup_droid = os.path.join(BACKUP_DIR, "droid.orig")
        if os.path.exists(backup_droid):
            shutil.copy2(backup_droid, os.path.join(staging_app, "Contents/Resources/bin/droid"))

        contents = os.path.join(staging_app, "Contents")
        resources = os.path.join(contents, "Resources")
        frameworks_dir = os.path.join(contents, "Frameworks")

        unpacked_nodes = collect_files_recursive(
            os.path.join(resources, "app.asar.unpacked"), (".node", ".dylib")
        )
        resource_bins = collect_files_recursive(os.path.join(resources, "bin"), None)
        frameworks = (
            [
                os.path.join(frameworks_dir, n)
                for n in os.listdir(frameworks_dir)
                if n.endswith(".framework")
            ]
            if os.path.isdir(frameworks_dir)
            else []
        )
        helper_apps = (
            [
                os.path.join(frameworks_dir, n)
                for n in os.listdir(frameworks_dir)
                if n.endswith(".app")
            ]
            if os.path.isdir(frameworks_dir)
            else []
        )

        sign_plain = unpacked_nodes + resource_bins + frameworks
        sign_ent = helper_apps + [staging_app]

        for t in sign_plain:
            if os.path.exists(t):
                subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", t], check=True)
        for t in sign_ent:
            if os.path.exists(t):
                subprocess.run(
                    ["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", "--entitlements", ent_path, t],
                    check=True,
                )

        subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", staging_app], check=True)

        os.rename(APP_PATH, old_app)
        try:
            os.rename(staging_app, APP_PATH)
        except Exception:
            os.rename(old_app, APP_PATH)
            raise
        shutil.rmtree(old_app, ignore_errors=True)

        backup_local_droid = os.path.join(BACKUP_DIR, "local-droid.orig")
        local_droid = os.path.join(REAL_HOME, ".local/bin/droid")
        if os.path.exists(backup_local_droid) and os.path.exists(local_droid):
            try:
                tmp_local = f"{local_droid}.zh-restore-{os.getpid()}"
                shutil.copy2(backup_local_droid, tmp_local)
                os.replace(tmp_local, local_droid)
                subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", local_droid], check=True)
                chown_to_real_user(local_droid)
            except Exception:
                pass

        try:
            from localize_sessions import restore_all_sessions
            restore_all_sessions()
        except Exception:
            pass

        subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", APP_PATH], check=True)
        cleanup_persist_dir()
        print("[factory-zh] Restored original Factory.app, cleaned ~/.factory-zh, and verified codesign!")
        restart_or_prompt_factory(args.skip_kill)
    except PermissionError:
        print(
            f"\n[factory-zh] ⚠️ 权限不足：当前「终端」没有修改 {APP_PATH} 的权限。\n"
            "请运行 sudo python3 restore.py 重试。",
            file=sys.stderr,
        )
        sys.exit(1)
    finally:
        shutil.rmtree(work_tmp_dir, ignore_errors=True)
        release_lock()


if __name__ == "__main__":
    main()
