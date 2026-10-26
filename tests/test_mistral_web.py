"""Tests for tools/mistral_web.py fixture mode (no network, no cookies)."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'tools' / 'mistral_web.py'


def fixture_html(api_pair, vibe_pair):
    """Build a subscription-page fragment.

    ``api_pair``/``vibe_pair`` are (used, total) strings, or None to omit
    the block. The span structure mirrors the server-rendered console page
    validated on 2026-10-26 (adjacent € spans after the title).
    """
    def block(title, pair):
        if pair is None:
            return ''
        used, total = pair
        return (
            '<div>'
            f'<span class="text-muted text-xs font-semibold">{title}</span>'
            f'<span class="text-sm font-medium tabular-nums">€{used}</span>'
            f'<span class="text-muted text-sm font-medium tabular-nums">€{total}</span>'
            '<span>Resets in 6 days</span>'
            '</div>'
        )

    return (
        '<html><body>'
        + block('Included API usage', api_pair)
        + block('Included Vibe Code usage', vibe_pair)
        + '</body></html>'
    )


class MistralWebScriptTests(unittest.TestCase):
    def run_fixture(self, html):
        with tempfile.NamedTemporaryFile(
                'w', suffix='.html', delete=False) as handle:
            handle.write(html)
            path = handle.name
        try:
            env = dict(os.environ)
            env['CODEX_USAGE_MISTRAL_FIXTURE_HTML'] = path
            result = subprocess.run(
                [sys.executable, str(SCRIPT)],
                env=env, capture_output=True, text=True, timeout=30,
            )
        finally:
            os.unlink(path)
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = [line for line in result.stdout.strip().splitlines() if line]
        self.assertTrue(lines, 'script printed no JSON payload')
        return json.loads(lines[0])

    def test_both_pools(self):
        payload = self.run_fixture(fixture_html(('2.50', '25.00'), ('5.00', '50.00')))
        self.assertEqual(payload['status'], 'ok')
        self.assertEqual(payload['api_used'], 2.5)
        self.assertEqual(payload['api_total'], 25.0)
        self.assertEqual(payload['vibe_used'], 5.0)
        self.assertEqual(payload['vibe_total'], 50.0)

    def test_vibe_only(self):
        payload = self.run_fixture(fixture_html(None, ('5.00', '50.00')))
        self.assertEqual(payload['status'], 'ok')
        self.assertIsNone(payload.get('api_used'))
        self.assertIsNone(payload.get('api_total'))
        self.assertEqual(payload['vibe_used'], 5.0)
        self.assertEqual(payload['vibe_total'], 50.0)

    def test_comma_decimals(self):
        payload = self.run_fixture(fixture_html(('2,50', '25,00'), ('5,00', '50,00')))
        self.assertEqual(payload['status'], 'ok')
        self.assertEqual(payload['api_used'], 2.5)
        self.assertEqual(payload['api_total'], 25.0)
        self.assertEqual(payload['vibe_used'], 5.0)
        self.assertEqual(payload['vibe_total'], 50.0)

    def test_thousands_separators(self):
        payload = self.run_fixture(fixture_html(('1.275,50', '12.750,00'), None))
        self.assertEqual(payload['status'], 'ok')
        self.assertEqual(payload['api_used'], 1275.5)
        self.assertEqual(payload['api_total'], 12750.0)

    def test_no_blocks_is_parse_error(self):
        payload = self.run_fixture(fixture_html(None, None))
        self.assertEqual(payload['status'], 'parse-error')

    def test_ok_has_captured_at(self):
        payload = self.run_fixture(fixture_html(('2.50', '25.00'), None))
        self.assertTrue(payload.get('captured_at'))


if __name__ == '__main__':
    unittest.main()
