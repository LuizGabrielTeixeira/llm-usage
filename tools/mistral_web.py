#!/usr/bin/env python3
"""
Fetch Mistral Pro Student monthly allowance usage for the codex-usage
GNOME extension.

How it works (user-requested 2026-10-26, opt-in via the
'mistral-firefox-enabled' preference):

  1. Finds the local Firefox profile(s) and copies cookies.sqlite (plus
     its WAL/SHM sidecars) to a private temporary directory - Firefox
     keeps the database locked while running, so a copy reads safely.
  2. Reads the admin.mistral.ai session cookie (ory_session_*) from the
     copy. The cookie is used IN MEMORY ONLY for a single GET to
     https://admin.mistral.ai/subscription; it is never printed, logged
     or stored anywhere. The temporary copy is deleted right after.
  3. The subscription page is server-side rendered (validated
     2026-10-26): its raw HTML contains the two monthly allowance blocks
     ("Included API usage" and "Included Vibe Code usage") with the
     used/included EUR amounts.
  4. Prints ONE line of sanitized JSON on stdout (status + amounts).
     Nothing else ever leaves this process.

Test mode: point CODEX_USAGE_MISTRAL_FIXTURE_HTML at a local HTML file
to parse it without touching Firefox or the network. Used by
tests/test_mistral_web.py with synthetic fixtures.

Context: the Mistral Admin API is Enterprise-only (official docs) and
the usage console needs the browser session - reusing the Firefox
session cookie is the only automatic path for a Pro Student plan.
"""

import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone

SUBSCRIPTION_URL = 'https://admin.mistral.ai/subscription'
USER_AGENT = ('Mozilla/5.0 (X11; Linux x86_64; rv:132.0) '
              'Gecko/20100101 Firefox/132.0')
MAX_HTML_BYTES = 2 * 1024 * 1024
BLOCK_SCAN_CHARS = 4000


def emit(payload):
    """Print the single-line JSON result and exit 0 (statuses travel in
    the JSON; the exit code only reflects process-level failures)."""
    print(json.dumps(payload, separators=(',', ':')))
    sys.exit(0)


def normalize_amount(text):
    """'1.33', '1,33', '1.275,50' or '1,275.50' -> float (or None)."""
    text = text.strip().replace(' ', '')
    if not text:
        return None
    has_dot = '.' in text
    has_comma = ',' in text
    if has_dot and has_comma:
        if text.rfind(',') > text.rfind('.'):
            # 1.275,50 -> dot is the thousands separator
            text = text.replace('.', '').replace(',', '.')
        else:
            # 1,275.50 -> comma is the thousands separator
            text = text.replace(',', '')
    elif has_comma:
        text = text.replace(',', '.')
    try:
        value = float(text)
    except ValueError:
        return None
    return value if value >= 0 else None


def parse_amount_pair(html, title):
    """Amounts (used, total) for one allowance block, or None."""
    index = html.find(title)
    if index < 0:
        return None
    segment = html[index:index + BLOCK_SCAN_CHARS]
    # Preferred: the adjacent used/total span pair from the console layout.
    pair = re.search(
        r'€\s*([0-9][0-9.,]*)</span>\s*'
        r'<span[^>]*>€\s*([0-9][0-9.,]*)',
        segment)
    if pair:
        used = normalize_amount(pair.group(1))
        total = normalize_amount(pair.group(2))
        if used is not None and total is not None:
            return used, total
    # Fallback: first two EUR amounts after the block title.
    amounts = re.findall(r'€\s*([0-9][0-9.,]*)', segment)
    values = [a for a in (normalize_amount(x) for x in amounts)
              if a is not None]
    if len(values) >= 2:
        return values[0], values[1]
    return None


def parse_console(html):
    api = parse_amount_pair(html, 'Included API usage')
    vibe = parse_amount_pair(html, 'Included Vibe Code usage')
    return api, vibe


def ok_payload(api, vibe, captured_at=None):
    return {
        'status': 'ok',
        'api_used': api[0] if api else None,
        'api_total': api[1] if api else None,
        'vibe_used': vibe[0] if vibe else None,
        'vibe_total': vibe[1] if vibe else None,
        'captured_at': captured_at
                       or datetime.now(timezone.utc).isoformat(),
    }


def firefox_profile_roots():
    home = os.path.expanduser('~')
    return [
        os.path.join(home, '.mozilla/firefox'),
        os.path.join(home,
                     '.var/app/org.mozilla.firefox/.mozilla/firefox'),
        os.path.join(home, 'snap/firefox/common/.mozilla/firefox'),
        os.path.join(home, '.zen/browser'),
        os.path.join(home, '.librewolf'),
    ]


def find_session_cookie():
    """Cookie header value for the admin.mistral.ai ory session, or None.

    Reads through a temporary copy of each profile's cookies.sqlite
    (Firefox keeps the live database locked); the copy lives in a
    private temp dir and is deleted before returning.
    """
    for root in firefox_profile_roots():
        if not os.path.isdir(root):
            continue
        try:
            entries = sorted(os.listdir(root))
        except OSError:
            continue
        for entry in entries:
            db = os.path.join(root, entry, 'cookies.sqlite')
            if not os.path.isfile(db):
                continue
            tmpdir = tempfile.mkdtemp(prefix='codex-usage-mistral-')
            try:
                copy = os.path.join(tmpdir, 'cookies.sqlite')
                shutil.copy2(db, copy)
                os.chmod(copy, 0o600)
                for suffix in ('-wal', '-shm'):
                    sidecar = db + suffix
                    if os.path.isfile(sidecar):
                        sidecar_copy = os.path.join(
                            tmpdir, 'cookies.sqlite' + suffix)
                        shutil.copy2(sidecar, sidecar_copy)
                        os.chmod(sidecar_copy, 0o600)
                con = sqlite3.connect(
                    'file:' + os.path.join(tmpdir, 'cookies.sqlite')
                    + '?mode=ro',
                    uri=True, timeout=3)
                try:
                    rows = con.execute(
                        "SELECT name, value FROM moz_cookies"
                        " WHERE (host = 'admin.mistral.ai'"
                        " OR host = '.mistral.ai')"
                        " AND name LIKE 'ory_session%'").fetchall()
                finally:
                    con.close()
                if rows:
                    return '; '.join('%s=%s' % (n, v) for n, v in rows)
            except Exception:
                continue
            finally:
                shutil.rmtree(tmpdir, ignore_errors=True)
    return None


def fetch_subscription(cookie_header):
    """(status, html) for GET /subscription; redirects are disabled so an
    expired session surfaces as 3xx/401 instead of a login page."""
    import socket
    import urllib.error
    import urllib.request

    socket.setdefaulttimeout(20)

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    opener = urllib.request.build_opener(_NoRedirect)
    request = urllib.request.Request(SUBSCRIPTION_URL, headers={
        'User-Agent': USER_AGENT,
        'Cookie': cookie_header,
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Referer': SUBSCRIPTION_URL,
    })
    try:
        with opener.open(request, timeout=25) as response:
            return response.status, response.read(MAX_HTML_BYTES)
    except urllib.error.HTTPError as error:
        return error.code, b''
    except Exception:
        return 0, b''


def main():
    fixture = os.environ.get('CODEX_USAGE_MISTRAL_FIXTURE_HTML')
    if fixture:
        with open(fixture, 'rb') as handle:
            html = handle.read(MAX_HTML_BYTES).decode('utf-8', 'replace')
        api, vibe = parse_console(html)
        if api is None and vibe is None:
            emit({'status': 'parse-error'})
        emit(ok_payload(api, vibe))

    cookie_header = find_session_cookie()
    if not cookie_header:
        emit({'status': 'no-cookie'})

    status, body = fetch_subscription(cookie_header)
    if status in (301, 302, 303, 307, 308, 401, 403):
        emit({'status': 'signin'})
    if status != 200:
        emit({'status': 'error', 'reason': 'http %d' % status})
    if not body:
        emit({'status': 'error', 'reason': 'empty response'})

    html = body.decode('utf-8', 'replace')
    api, vibe = parse_console(html)
    if api is None and vibe is None:
        lowered = html.lower()
        if 'sign in' in lowered or 'log in' in lowered or 'oauth' in lowered:
            emit({'status': 'signin'})
        emit({'status': 'parse-error'})
    emit(ok_payload(api, vibe))


if __name__ == '__main__':
    main()
