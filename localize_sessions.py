#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Factory Historical & Live Session Title Localizer
Translates English session titles in:
1. ~/.factory/sessions/**/*.jsonl (preserving exact atime/mtime and ownership so recency order never changes)
2. ~/.factory/cache/session-index/index.db (sessions + session_ingest size sync)
3. ~/.factory/cache/session-discovery-index.json
Saves reversible backup in ~/.factory-zh/backup/session-titles-backup.json.
"""
from __future__ import annotations

import glob
import json
import os
try:
    import pwd
except ImportError:
    pwd = None
import sqlite3


def get_real_user_info() -> tuple[int, int, str, str]:
    if os.name == "nt" or pwd is None:
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
PERSIST_DIR = os.path.join(REAL_HOME, ".factory-zh")
BACKUP_FILE = os.path.join(PERSIST_DIR, "backup/session-titles-backup.json")
CUSTOM_MAP_FILE = os.path.join(PERSIST_DIR, "backup/custom-session-titles.json")
SESSIONS_DIR = os.path.join(REAL_HOME, ".factory/sessions")
INDEX_DB_PATH = os.path.join(REAL_HOME, ".factory/cache/session-index/index.db")
DISCOVERY_JSON_PATH = os.path.join(REAL_HOME, ".factory/cache/session-discovery-index.json")

# Only Factory's built-in default/placeholder titles belong here.
# Never add personal session titles. For your own mappings, create
# ~/.factory-zh/backup/custom-session-titles.json instead.
SESSION_TITLE_MAP = {
    "New Session": "新会话",
    "Untitled": "未命名会话",
    "Untitled session": "未命名会话",
    "Start new chat": "开始新对话",
    "Handoff session": "交接会话",
}

if os.path.exists(CUSTOM_MAP_FILE):
    try:
        with open(CUSTOM_MAP_FILE, "r", encoding="utf-8") as _fp:
            _custom = json.load(_fp)
            if isinstance(_custom, dict):
                SESSION_TITLE_MAP.update(_custom)
    except Exception:
        pass


def translate_session_title(title: str) -> str:
    if not title or not isinstance(title, str):
        return title
    t = title.strip()
    if t in SESSION_TITLE_MAP:
        return SESSION_TITLE_MAP[t]
    # Handle [Fork] prefix
    if t.startswith("[Fork] "):
        inner = t[7:].strip()
        if inner in SESSION_TITLE_MAP:
            return "[分支] " + SESSION_TITLE_MAP[inner]
    return title


def _atomic_write_preserve_times(fpath: str, content: str, st) -> None:
    tmp_path = f"{fpath}.zh-tmp-{os.getpid()}"
    try:
        with open(tmp_path, "w", encoding="utf-8") as fp:
            fp.write(content)
        try:
            os.chmod(tmp_path, st.st_mode & 0o777)
        except Exception:
            pass
        if hasattr(os, "getuid") and os.getuid() == 0:
            try:
                os.chown(tmp_path, st.st_uid, st.st_gid)
            except Exception:
                pass
        os.replace(tmp_path, fpath)
        os.utime(fpath, (st.st_atime, st.st_mtime))
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass


def localize_all_sessions() -> dict:
    os.makedirs(os.path.dirname(BACKUP_FILE), mode=0o700, exist_ok=True)
    backup = {}
    if os.path.exists(BACKUP_FILE):
        try:
            with open(BACKUP_FILE, "r", encoding="utf-8") as fp:
                backup = json.load(fp)
        except Exception:
            backup = {}

    updated_jsonl = 0
    size_map = {}

    if os.path.exists(SESSIONS_DIR):
        for fpath in sorted(glob.glob(os.path.join(SESSIONS_DIR, "**/*.jsonl"), recursive=True)):
            try:
                st = os.stat(fpath)
                with open(fpath, "r", encoding="utf-8", errors="ignore") as fp:
                    content = fp.read()
                if not content:
                    continue
                nl_idx = content.find("\n")
                first_line = content[:nl_idx] if nl_idx != -1 else content
                rest = content[nl_idx:] if nl_idx != -1 else ""
                obj = json.loads(first_line)
                if obj.get("type") != "session_start":
                    continue
                old_title = obj.get("title", "")
                sid = obj.get("id") or os.path.splitext(os.path.basename(fpath))[0]
                new_title = translate_session_title(old_title)
                if new_title != old_title:
                    if sid not in backup:
                        backup[sid] = {
                            "path": fpath,
                            "originalTitle": old_title,
                            "hadManualFlag": "isSessionTitleManuallySet" in obj,
                            "originalManualFlag": obj.get("isSessionTitleManuallySet"),
                        }
                    obj["title"] = new_title
                    obj["isSessionTitleManuallySet"] = True
                    new_first_line = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
                    new_content = new_first_line + rest
                    _atomic_write_preserve_times(fpath, new_content, st)
                    new_st = os.stat(fpath)
                    size_map[sid] = new_st.st_size
                    updated_jsonl += 1
                elif sid in backup:
                    size_map[sid] = st.st_size
            except Exception:
                pass

    with open(BACKUP_FILE, "w", encoding="utf-8") as fp:
        json.dump(backup, fp, ensure_ascii=False, indent=2)
    if hasattr(os, "getuid") and os.getuid() == 0 and REAL_UID != 0:
        for p in (PERSIST_DIR, os.path.dirname(BACKUP_FILE), BACKUP_FILE):
            try:
                os.chown(p, REAL_UID, REAL_GID)
            except Exception:
                pass

    updated_db = 0
    if os.path.exists(INDEX_DB_PATH):
        try:
            conn = sqlite3.connect(INDEX_DB_PATH, timeout=5.0)
            cur = conn.cursor()
            rows = cur.execute("SELECT session_id, title FROM sessions WHERE title IS NOT NULL").fetchall()
            for sid, old_title in rows:
                new_title = translate_session_title(old_title)
                if new_title != old_title:
                    cur.execute("UPDATE sessions SET title = ? WHERE session_id = ?", (new_title, sid))
                    updated_db += 1
                if sid in size_map:
                    cur.execute(
                        "UPDATE session_ingest SET transcript_size = ? WHERE session_id = ?",
                        (size_map[sid], sid),
                    )
            conn.commit()
            conn.close()
        except Exception as e:
            print(f"[factory-zh] Warning updating index.db: {e}")

    updated_disc = 0
    if os.path.exists(DISCOVERY_JSON_PATH):
        try:
            st = os.stat(DISCOVERY_JSON_PATH)
            with open(DISCOVERY_JSON_PATH, "r", encoding="utf-8") as fp:
                disc = json.load(fp)
            entries = disc.get("entries", {})
            for sid, entry in entries.items():
                old_t = entry.get("title", "")
                new_t = translate_session_title(old_t)
                if new_t != old_t:
                    entry["title"] = new_t
                    updated_disc += 1
                if sid in size_map and isinstance(entry.get("sessionFingerprint"), dict):
                    entry["sessionFingerprint"]["size"] = size_map[sid]
            if updated_disc > 0 or size_map:
                _atomic_write_preserve_times(
                    DISCOVERY_JSON_PATH,
                    json.dumps(disc, ensure_ascii=False, indent=2),
                    st,
                )
        except Exception as e:
            print(f"[factory-zh] Warning updating session-discovery-index.json: {e}")

    return {
        "updated_jsonl": updated_jsonl,
        "updated_db": updated_db,
        "updated_discovery": updated_disc,
    }


def restore_all_sessions() -> int:
    if not os.path.exists(BACKUP_FILE):
        return 0
    with open(BACKUP_FILE, "r", encoding="utf-8") as fp:
        backup = json.load(fp)
    restored = 0
    size_map = {}
    for sid, info in backup.items():
        fpath = info.get("path")
        orig_title = info.get("originalTitle")
        if fpath and os.path.exists(fpath) and orig_title is not None:
            try:
                st = os.stat(fpath)
                with open(fpath, "r", encoding="utf-8", errors="ignore") as fp:
                    content = fp.read()
                nl_idx = content.find("\n")
                first_line = content[:nl_idx] if nl_idx != -1 else content
                rest = content[nl_idx:] if nl_idx != -1 else ""
                obj = json.loads(first_line)
                obj["title"] = orig_title
                if info.get("hadManualFlag"):
                    obj["isSessionTitleManuallySet"] = info.get("originalManualFlag")
                else:
                    obj.pop("isSessionTitleManuallySet", None)
                new_first = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
                _atomic_write_preserve_times(fpath, new_first + rest, st)
                size_map[sid] = os.stat(fpath).st_size
                restored += 1
            except Exception:
                pass

    if os.path.exists(INDEX_DB_PATH):
        try:
            conn = sqlite3.connect(INDEX_DB_PATH, timeout=5.0)
            cur = conn.cursor()
            for sid, info in backup.items():
                orig_title = info.get("originalTitle")
                if orig_title is not None:
                    cur.execute("UPDATE sessions SET title = ? WHERE session_id = ?", (orig_title, sid))
                if sid in size_map:
                    cur.execute(
                        "UPDATE session_ingest SET transcript_size = ? WHERE session_id = ?",
                        (size_map[sid], sid),
                    )
            conn.commit()
            conn.close()
        except Exception:
            pass

    if os.path.exists(DISCOVERY_JSON_PATH):
        try:
            st = os.stat(DISCOVERY_JSON_PATH)
            with open(DISCOVERY_JSON_PATH, "r", encoding="utf-8") as fp:
                disc = json.load(fp)
            entries = disc.get("entries", {})
            changed = False
            for sid, info in backup.items():
                orig_title = info.get("originalTitle")
                entry = entries.get(sid)
                if isinstance(entry, dict):
                    if orig_title is not None and entry.get("title") != orig_title:
                        entry["title"] = orig_title
                        changed = True
                    if sid in size_map and isinstance(entry.get("sessionFingerprint"), dict):
                        entry["sessionFingerprint"]["size"] = size_map[sid]
                        changed = True
            if changed:
                _atomic_write_preserve_times(
                    DISCOVERY_JSON_PATH,
                    json.dumps(disc, ensure_ascii=False, indent=2),
                    st,
                )
        except Exception:
            pass

    return restored


if __name__ == "__main__":
    import sys
    if "--restore" in sys.argv:
        n = restore_all_sessions()
        print(f"[factory-zh] Restored {n} session titles.")
    else:
        res = localize_all_sessions()
        print(
            f"[factory-zh] Localized session titles: "
            f"{res['updated_jsonl']} .jsonl files, "
            f"{res['updated_db']} SQLite index rows, "
            f"{res['updated_discovery']} discovery entries."
        )
