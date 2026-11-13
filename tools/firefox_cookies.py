"""Shared read-only Firefox/Zen/LibreWolf cookie reader (in memory only).

Copies cookies.sqlite (and WAL/SHM sidecars) to a private temp directory
with mode 0600, reads matching cookies in read-only SQLite mode, and deletes
the temporary copy immediately. Never writes, stores, or logs cookie values.
"""

import configparser
import os
import shutil
import sqlite3
import tempfile


def firefox_profile_roots():
    home = os.path.expanduser('~')
    return [
        os.path.join(home, '.mozilla/firefox'),
        os.path.join(home, '.var/app/org.mozilla.firefox/.mozilla/firefox'),
        os.path.join(home, 'snap/firefox/common/.mozilla/firefox'),
        os.path.join(home, '.zen/browser'),
        os.path.join(home, '.librewolf'),
    ]


def ordered_profile_dirs(root):
    """Return existing profile subdirectories under root, default profile first."""
    if not os.path.isdir(root):
        return []

    candidates = []
    seen = set()

    def add(path):
        if not path:
            return
        full = path if os.path.isabs(path) else os.path.join(root, path)
        real = os.path.realpath(full)
        if real not in seen and os.path.isdir(full):
            seen.add(real)
            candidates.append(full)

    ini_path = os.path.join(root, 'profiles.ini')
    if os.path.isfile(ini_path):
        cfg = configparser.RawConfigParser()
        try:
            cfg.read(ini_path, encoding='utf-8')
        except Exception:
            cfg = None
        if cfg is not None:
            for section in cfg.sections():
                if section.startswith('Install') and cfg.has_option(section, 'Default'):
                    add(cfg.get(section, 'Default'))
            for section in cfg.sections():
                if section.startswith('Profile') and cfg.get(section, 'Default', fallback='') == '1':
                    raw_path = cfg.get(section, 'Path', fallback='')
                    is_rel = cfg.get(section, 'IsRelative', fallback='1') == '1'
                    add(raw_path if is_rel else os.path.abspath(raw_path))

    try:
        entries = sorted(os.listdir(root))
    except OSError:
        entries = []
    for entry in entries:
        add(os.path.join(root, entry))

    return candidates


def read_cookies_from_profile(profile_dir, where_sql, params=(), prefix='llm-usage-'):
    """Read deduplicated (name, value) pairs matching where_sql from one profile."""
    db = os.path.join(profile_dir, 'cookies.sqlite')
    if not os.path.isfile(db):
        return []

    tmpdir = tempfile.mkdtemp(prefix=prefix)
    try:
        copy = os.path.join(tmpdir, 'cookies.sqlite')
        shutil.copy2(db, copy)
        os.chmod(copy, 0o600)
        for suffix in ('-wal', '-shm'):
            sidecar = db + suffix
            if os.path.isfile(sidecar):
                sidecar_copy = os.path.join(tmpdir, 'cookies.sqlite' + suffix)
                shutil.copy2(sidecar, sidecar_copy)
                os.chmod(sidecar_copy, 0o600)

        con = sqlite3.connect(f'file:{copy}?mode=ro', uri=True, timeout=3)
        try:
            try:
                rows = con.execute(
                    f'SELECT name, value FROM moz_cookies WHERE {where_sql}'
                    ' ORDER BY expiry DESC, lastAccessed DESC',
                    params,
                ).fetchall()
            except sqlite3.OperationalError:
                rows = con.execute(
                    f'SELECT name, value FROM moz_cookies WHERE {where_sql}',
                    params,
                ).fetchall()
        finally:
            con.close()

        deduped = []
        seen_names = set()
        for name, value in rows:
            if name and name not in seen_names:
                seen_names.add(name)
                deduped.append((name, value))
        return deduped
    except Exception:
        return []
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def iter_profile_cookies(where_sql, params=(), prefix='llm-usage-', roots=None):
    """Yield non-empty deduplicated cookie lists across browser profile roots."""
    for root in (roots if roots is not None else firefox_profile_roots()):
        for profile_dir in ordered_profile_dirs(root):
            rows = read_cookies_from_profile(profile_dir, where_sql, params, prefix=prefix)
            if rows:
                yield rows
