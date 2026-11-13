#!/usr/bin/env python3
"""
Fetch Claude subscription quota usage for the llm-usage GNOME extension
using an existing Firefox claude.ai session (opt-in via
'claude-firefox-enabled').

How it works:
  1. Uses tools/firefox_cookies.py to copy cookies.sqlite (plus WAL/SHM) to a
     private temp directory (mode 0600, deleted immediately after reading).
  2. Reads claude.ai session cookies IN MEMORY ONLY; cookies, org UUIDs, and
     account identifiers are never stored, logged, or printed.
  3. Queries GET https://claude.ai/api/organizations, selects chat-capable
     organizations (preferring lastActiveOrg and paid tiers), and fetches
     GET https://claude.ai/api/organizations/{uuid}/usage.
  4. Prints ONE line of sanitized JSON on stdout (status + quota windows).

Test mode: point LLM_USAGE_CLAUDE_FIXTURE_JSON at a local JSON file to parse
it without touching Firefox or the network (used by tests/test_claude_web.py).
"""

import json
import math
import os
import sys
from datetime import datetime, timezone

_TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
if _TOOLS_DIR not in sys.path:
    sys.path.insert(0, _TOOLS_DIR)

from firefox_cookies import iter_profile_cookies  # noqa: E402

BASE_URL = 'https://claude.ai'
ORGS_URL = f'{BASE_URL}/api/organizations'
USER_AGENT = ('Mozilla/5.0 (X11; Linux x86_64; rv:132.0) '
              'Gecko/20100101 Firefox/132.0')
MAX_BYTES = 2 * 1024 * 1024


def emit(payload):
    """Print one JSON line and exit 0 (statuses travel inside the JSON)."""
    print(json.dumps(payload, separators=(',', ':')))
    sys.exit(0)


def _finite_number(value):
    return (isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(value))


def _sanitize_window(entry):
    if not isinstance(entry, dict):
        return None
    util = entry.get('utilization')
    if not _finite_number(util):
        return None
    out = {'utilization': float(util)}
    resets_at = entry.get('resets_at')
    if isinstance(resets_at, str) and resets_at:
        out['resets_at'] = resets_at
    else:
        out['resets_at'] = None
    return out


def sanitize_usage_payload(raw):
    """Extract only quota windows and extra_usage flags; strip everything else.

    Returns (sanitized_dict, has_any_metric, looks_like_usage_payload).
    """
    if not isinstance(raw, dict):
        return {}, False, False

    looks_like_usage = any(
        k in raw for k in ('five_hour', 'seven_day', 'limits', 'extra_usage')
    )
    sanitized = {}
    has_metric = False

    five_hour = _sanitize_window(raw.get('five_hour'))
    if five_hour is not None:
        sanitized['five_hour'] = five_hour
        has_metric = True

    seven_day = _sanitize_window(raw.get('seven_day'))
    if seven_day is not None:
        sanitized['seven_day'] = seven_day
        has_metric = True

    for key, value in raw.items():
        if key == 'seven_day' or key == 'seven_day_breakdown':
            continue
        if key.startswith('seven_day_'):
            win = _sanitize_window(value)
            if win is not None:
                sanitized[key] = win
                has_metric = True

    extra = raw.get('extra_usage')
    if isinstance(extra, dict) and extra.get('is_enabled') is True:
        extra_out = {'is_enabled': True}
        util = extra.get('utilization')
        monthly = extra.get('monthly_limit')
        used = extra.get('used_credits')
        if _finite_number(util):
            extra_out['utilization'] = float(util)
            has_metric = True
        if _finite_number(monthly):
            extra_out['monthly_limit'] = float(monthly)
        if _finite_number(used):
            extra_out['used_credits'] = float(used)
        if ('utilization' not in extra_out
                and _finite_number(monthly) and monthly > 0
                and _finite_number(used)):
            has_metric = True
        if isinstance(extra.get('resets_at'), str) and extra['resets_at']:
            extra_out['resets_at'] = extra['resets_at']
        sanitized['extra_usage'] = extra_out

    return sanitized, has_metric, looks_like_usage


def rank_organizations(orgs, last_active_org=None):
    """Order candidate organizations, preferring chat-capable and active ones."""
    if not isinstance(orgs, list):
        return []

    valid = [
        org for org in orgs
        if isinstance(org, dict) and isinstance(org.get('uuid'), str) and org['uuid']
    ]
    chat_orgs = [
        org for org in valid
        if not org.get('capabilities') or 'chat' in org.get('capabilities', [])
    ]
    pool = chat_orgs if chat_orgs else valid

    def sort_key(org):
        is_last = 0 if (last_active_org and org['uuid'] == last_active_org) else 1
        tier = str(org.get('rate_limit_tier') or '')
        is_paid = 0 if (tier and tier != 'default_claude_ai') else 1
        return (is_last, is_paid)

    return sorted(pool, key=sort_key)


def _is_cloudflare_response(status, headers, body_bytes):
    if status != 403:
        return False
    cf_mitigated = (headers.get('cf-mitigated') or '').lower()
    if 'challenge' in cf_mitigated:
        return True
    server = (headers.get('server') or '').lower()
    if 'cloudflare' in server:
        snippet = body_bytes[:4096].decode('utf-8', 'replace').lower()
        if ('just a moment' in snippet or 'cf_chl' in snippet
                or '<!doctype html' in snippet or '<html' in snippet):
            return True
    return False


def fetch_json(url, cookie_header, referer=BASE_URL + '/'):
    """Perform one GET with redirects disabled; return (status, headers, body)."""
    import socket
    import urllib.error
    import urllib.request

    socket.setdefaulttimeout(20)

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    opener = urllib.request.build_opener(_NoRedirect)
    request = urllib.request.Request(url, headers={
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Referer': referer,
        'Cookie': cookie_header,
    })
    try:
        with opener.open(request, timeout=25) as response:
            headers = {k.lower(): v for k, v in response.headers.items()}
            return response.status, headers, response.read(MAX_BYTES)
    except urllib.error.HTTPError as error:
        headers = {k.lower(): v for k, v in error.headers.items()} if error.headers else {}
        try:
            body = error.read(MAX_BYTES)
        except Exception:
            body = b''
        return error.code, headers, body
    except Exception:
        return 0, {}, b''


def resolve_usage_from_fetcher(orgs, last_active_org, get_usage_for_org):
    """Evaluate ranked orgs via get_usage_for_org(uuid) -> (status, headers, body_obj_or_bytes)."""
    ranked = rank_organizations(orgs, last_active_org)
    if not ranked:
        return {'status': 'parse-error'}

    saw_no_usage = False
    saw_cloudflare = False
    saw_signin = False
    last_error = None

    for org in ranked:
        status, headers, payload = get_usage_for_org(org['uuid'])
        if status == 429:
            return {'status': 'rate-limited'}
        if status in (301, 302, 303, 307, 308, 401):
            saw_signin = True
            continue
        if status == 403:
            raw_bytes = payload if isinstance(payload, (bytes, bytearray)) else b''
            if _is_cloudflare_response(status, headers, raw_bytes):
                saw_cloudflare = True
            else:
                saw_signin = True
            continue
        if status != 200:
            last_error = f'http {status}'
            continue

        if isinstance(payload, (bytes, bytearray)):
            try:
                data = json.loads(payload.decode('utf-8', 'replace'))
            except Exception:
                last_error = 'parse-error'
                continue
        else:
            data = payload

        sanitized, has_metric, looks_like_usage = sanitize_usage_payload(data)
        if has_metric:
            return {
                'status': 'ok',
                'usage': sanitized,
                'captured_at': datetime.now(timezone.utc).isoformat(),
            }
        if looks_like_usage:
            saw_no_usage = True
        else:
            last_error = 'parse-error'

    if saw_no_usage:
        return {'status': 'no-usage'}
    if saw_cloudflare:
        return {'status': 'cloudflare'}
    if saw_signin:
        return {'status': 'signin'}
    if last_error == 'parse-error':
        return {'status': 'parse-error'}
    return {'status': 'error', 'reason': last_error or 'unavailable'}


def run_fixture(path):
    try:
        with open(path, 'rb') as handle:
            raw = json.loads(handle.read(MAX_BYTES).decode('utf-8', 'replace'))
    except Exception:
        emit({'status': 'parse-error'})

    if isinstance(raw, dict) and 'orgs' in raw and 'usage_by_org' in raw:
        usage_by_org = raw.get('usage_by_org') or {}
        result = resolve_usage_from_fetcher(
            raw.get('orgs'),
            raw.get('last_active_org'),
            lambda uuid: (200, {}, usage_by_org.get(uuid))
            if uuid in usage_by_org else (403, {}, b''),
        )
        emit(result)

    sanitized, has_metric, looks_like_usage = sanitize_usage_payload(raw)
    if has_metric:
        emit({
            'status': 'ok',
            'usage': sanitized,
            'captured_at': datetime.now(timezone.utc).isoformat(),
        })
    if looks_like_usage:
        emit({'status': 'no-usage'})
    emit({'status': 'parse-error'})


def main():
    fixture = os.environ.get('LLM_USAGE_CLAUDE_FIXTURE_JSON')
    if fixture:
        run_fixture(fixture)

    saw_session_cookie = False
    saw_cloudflare = False
    saw_signin = False
    saw_no_usage = False
    last_error = None

    where = "host = 'claude.ai' OR host = '.claude.ai'"
    for rows in iter_profile_cookies(where, prefix='llm-usage-claude-'):
        cookie_map = dict(rows)
        if not (cookie_map.get('sessionKey') or cookie_map.get('sessionKeyV3')):
            continue

        saw_session_cookie = True
        cookie_header = '; '.join(f'{name}={val}' for name, val in rows)
        last_active_org = cookie_map.get('lastActiveOrg')

        status, headers, body = fetch_json(ORGS_URL, cookie_header)
        if status == 429:
            emit({'status': 'rate-limited'})
        if status in (301, 302, 303, 307, 308, 401):
            saw_signin = True
            continue
        if status == 403:
            if _is_cloudflare_response(status, headers, body):
                saw_cloudflare = True
            else:
                saw_signin = True
            continue
        if status != 200 or not body:
            last_error = f'http {status}' if status else 'network'
            continue

        try:
            orgs = json.loads(body.decode('utf-8', 'replace'))
        except Exception:
            last_error = 'parse-error'
            continue

        result = resolve_usage_from_fetcher(
            orgs,
            last_active_org,
            lambda uuid: fetch_json(
                f'{BASE_URL}/api/organizations/{uuid}/usage',
                cookie_header,
                referer=f'{BASE_URL}/settings/usage',
            ),
        )
        res_status = result.get('status')
        if res_status in ('ok', 'rate-limited'):
            emit(result)
        if res_status == 'no-usage':
            saw_no_usage = True
        elif res_status == 'cloudflare':
            saw_cloudflare = True
        elif res_status == 'signin':
            saw_signin = True
        elif res_status == 'parse-error':
            last_error = 'parse-error'
        else:
            last_error = result.get('reason') or last_error

    if not saw_session_cookie:
        emit({'status': 'no-cookie'})
    if saw_no_usage:
        emit({'status': 'no-usage'})
    if saw_cloudflare:
        emit({'status': 'cloudflare'})
    if saw_signin:
        emit({'status': 'signin'})
    if last_error == 'parse-error':
        emit({'status': 'parse-error'})
    emit({'status': 'error', 'reason': last_error or 'request failed'})


if __name__ == '__main__':
    main()
