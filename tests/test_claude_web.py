import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS_DIR = ROOT / 'tools'
SCRIPT = TOOLS_DIR / 'claude_web.py'

if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import claude_web  # noqa: E402
import firefox_cookies  # noqa: E402


def _run_fixture(payload_text):
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8') as handle:
        handle.write(payload_text)
        fixture_path = handle.name

    try:
        env = dict(os.environ, LLM_USAGE_CLAUDE_FIXTURE_JSON=fixture_path)
        proc = subprocess.run(
            [sys.executable, str(SCRIPT)],
            capture_output=True, text=True, env=env, timeout=15,
        )
        return proc.returncode, proc.stdout, proc.stderr
    finally:
        os.unlink(fixture_path)


class ClaudeWebFixtureTests(unittest.TestCase):
    def test_valid_pro_usage_payload_and_pii_redaction(self):
        secret_cookie = 'sk-ant-sid01-fake-secret-cookie'
        secret_org = '00000000-1111-2222-3333-444444444444'
        payload = {
            'organization_uuid': secret_org,
            'sessionKey': secret_cookie,
            'email': 'private-user@example.invalid',
            'five_hour': {'utilization': 22.0, 'resets_at': '2026-06-01T15:00:00Z'},
            'seven_day': {'utilization': 48.0, 'resets_at': '2026-06-06T00:00:00Z'},
            'seven_day_sonnet': {'utilization': 15.0, 'resets_at': '2026-06-06T00:00:00Z'},
            'seven_day_breakdown': {'utilization': 99.0, 'resets_at': '2026-06-06T00:00:00Z'},
            'extra_usage': {
                'is_enabled': True,
                'utilization': 33.5,
                'monthly_limit': 5000,
                'used_credits': 1675,
                'resets_at': '2026-07-01T00:00:00Z',
            },
        }
        code, stdout, stderr = _run_fixture(json.dumps(payload))
        self.assertEqual(code, 0, stderr)
        self.assertEqual(len(stdout.strip().splitlines()), 1)
        for forbidden in (secret_cookie, secret_org, 'private-user@example.invalid'):
            self.assertNotIn(forbidden, stdout)

        data = json.loads(stdout)
        self.assertEqual(data['status'], 'ok')
        self.assertIn('captured_at', data)
        usage = data['usage']
        self.assertEqual(usage['five_hour']['utilization'], 22.0)
        self.assertEqual(usage['seven_day']['utilization'], 48.0)
        self.assertEqual(usage['seven_day_sonnet']['utilization'], 15.0)
        self.assertNotIn('seven_day_breakdown', usage)
        self.assertTrue(usage['extra_usage']['is_enabled'])
        self.assertEqual(usage['extra_usage']['utilization'], 33.5)

    def test_multi_org_skips_api_org_and_falls_back_from_empty_free_org(self):
        bundle = {
            'last_active_org': 'org-free',
            'orgs': [
                {'uuid': 'org-api', 'capabilities': ['api'], 'rate_limit_tier': 'tier_1'},
                {'uuid': 'org-free', 'capabilities': ['chat'], 'rate_limit_tier': 'default_claude_ai'},
                {'uuid': 'org-max', 'capabilities': ['chat'], 'rate_limit_tier': 'default_claude_max_5x'},
            ],
            'usage_by_org': {
                'org-api': {'five_hour': {'utilization': 99}},
                'org-free': {'five_hour': None, 'seven_day': None, 'limits': []},
                'org-max': {
                    'five_hour': {'utilization': 17, 'resets_at': '2026-06-01T16:00:00Z'},
                    'seven_day': {'utilization': 41, 'resets_at': '2026-06-06T00:00:00Z'},
                },
            },
        }
        code, stdout, stderr = _run_fixture(json.dumps(bundle))
        self.assertEqual(code, 0, stderr)
        for org_uuid in ('org-api', 'org-free', 'org-max'):
            self.assertNotIn(org_uuid, stdout)
        data = json.loads(stdout)
        self.assertEqual(data['status'], 'ok')
        self.assertEqual(data['usage']['five_hour']['utilization'], 17.0)
        self.assertEqual(data['usage']['seven_day']['utilization'], 41.0)

    def test_extra_usage_only_without_utilization_is_ok(self):
        payload = {
            'five_hour': None,
            'seven_day': None,
            'extra_usage': {
                'is_enabled': True,
                'utilization': None,
                'monthly_limit': 5000,
                'used_credits': 1250,
            },
        }
        code, stdout, _ = _run_fixture(json.dumps(payload))
        self.assertEqual(code, 0)
        data = json.loads(stdout)
        self.assertEqual(data['status'], 'ok')
        self.assertTrue(data['usage']['extra_usage']['is_enabled'])
        self.assertEqual(data['usage']['extra_usage']['monthly_limit'], 5000.0)
        self.assertEqual(data['usage']['extra_usage']['used_credits'], 1250.0)

    def test_free_tier_no_usage_reports_no_usage(self):
        payload = {
            'five_hour': None,
            'seven_day': None,
            'limits': [],
            'extra_usage': None,
        }
        code, stdout, _ = _run_fixture(json.dumps(payload))
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(stdout), {'status': 'no-usage'})

    def test_malformed_or_unexpected_fixture_reports_parse_error(self):
        for bad in ('{not json', json.dumps({'hello': 'world'})):
            code, stdout, _ = _run_fixture(bad)
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(stdout), {'status': 'parse-error'})

    def test_rank_organizations_preferences(self):
        orgs = [
            {'uuid': 'api-only', 'capabilities': ['api'], 'rate_limit_tier': 'pro'},
            {'uuid': 'free-last', 'capabilities': ['chat'], 'rate_limit_tier': 'default_claude_ai'},
            {'uuid': 'pro-other', 'capabilities': ['chat'], 'rate_limit_tier': 'default_claude_pro'},
        ]
        ranked = claude_web.rank_organizations(orgs, last_active_org='free-last')
        self.assertEqual([o['uuid'] for o in ranked], ['free-last', 'pro-other'])

        ranked_no_last = claude_web.rank_organizations(orgs, last_active_org=None)
        self.assertEqual([o['uuid'] for o in ranked_no_last], ['pro-other', 'free-last'])

    def test_resolve_usage_status_mapping(self):
        orgs = [{'uuid': 'org-1', 'capabilities': ['chat']}]
        cf = claude_web.resolve_usage_from_fetcher(
            orgs, None,
            lambda _: (403, {'cf-mitigated': 'challenge'}, b''),
        )
        self.assertEqual(cf, {'status': 'cloudflare'})

        signin = claude_web.resolve_usage_from_fetcher(
            orgs, None,
            lambda _: (401, {}, b'{}'),
        )
        self.assertEqual(signin, {'status': 'signin'})

        limited = claude_web.resolve_usage_from_fetcher(
            orgs, None,
            lambda _: (429, {}, b'{}'),
        )
        self.assertEqual(limited, {'status': 'rate-limited'})


class FirefoxCookiesTests(unittest.TestCase):
    def test_ordered_profiles_and_newest_cookie_cleanup(self):
        prefix = 'llm-usage-test-prefix-'
        before_tmp = {
            name for name in os.listdir(tempfile.gettempdir())
            if name.startswith(prefix)
        }

        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            default_dir = root_path / 'bbb.default-release'
            alt_dir = root_path / 'aaa.alt-profile'
            default_dir.mkdir()
            alt_dir.mkdir()

            (root_path / 'profiles.ini').write_text(
                '[Install123]\n'
                'Default=bbb.default-release\n'
                '[Profile0]\n'
                'Name=alt\n'
                'IsRelative=1\n'
                'Path=aaa.alt-profile\n'
                '[Profile1]\n'
                'Name=default-release\n'
                'IsRelative=1\n'
                'Path=bbb.default-release\n'
                'Default=1\n',
                encoding='utf-8',
            )

            ordered = firefox_cookies.ordered_profile_dirs(root)
            self.assertEqual(ordered[0], str(default_dir))
            self.assertEqual(ordered[1], str(alt_dir))

            db_path = default_dir / 'cookies.sqlite'
            con = sqlite3.connect(db_path)
            try:
                con.execute(
                    'CREATE TABLE moz_cookies ('
                    'id INTEGER PRIMARY KEY, name TEXT, value TEXT, host TEXT, '
                    'expiry INTEGER, lastAccessed INTEGER)'
                )
                con.executemany(
                    'INSERT INTO moz_cookies (name, value, host, expiry, lastAccessed) '
                    'VALUES (?, ?, ?, ?, ?)',
                    [
                        ('sessionKey', 'older-cookie', '.claude.ai', 1000, 1000),
                        ('sessionKey', 'newest-cookie', '.claude.ai', 9000, 2000),
                        ('cf_clearance', 'cf-token', 'claude.ai', 8000, 1500),
                        ('session_id', 'other-site', 'console.mistral.ai', 9500, 3000),
                    ],
                )
                con.commit()
            finally:
                con.close()

            rows = firefox_cookies.read_cookies_from_profile(
                str(default_dir),
                "host = 'claude.ai' OR host = '.claude.ai'",
                prefix=prefix,
            )
            cookie_map = dict(rows)
            self.assertEqual(cookie_map.get('sessionKey'), 'newest-cookie')
            self.assertEqual(cookie_map.get('cf_clearance'), 'cf-token')
            self.assertNotIn('session_id', cookie_map)

        after_tmp = {
            name for name in os.listdir(tempfile.gettempdir())
            if name.startswith(prefix)
        }
        self.assertEqual(after_tmp, before_tmp, 'temporary SQLite copies must be removed')


if __name__ == '__main__':
    unittest.main()
