"""Integration checks for the multi-provider extension layout.

Run from the repository root: python3 -m unittest discover -s tests -v
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

EXPECTED_SCHEMA_KEYS = {
    # original keys (unchanged behavior)
    'refresh-interval', 'display-mode', 'panel-window', 'usage-display',
    'icon-style', 'show-icon', 'show-additional-limits',
    'proxy-url',
    # multi-provider additions
    'provider-codex-enabled', 'provider-antigravity-enabled',
    'provider-copilot-enabled', 'provider-mistral-enabled',
    'provider-claude-enabled',
    'panel-provider',
    'mistral-firefox-enabled',
    'claude-firefox-enabled',
    'claude-oauth-enabled',
}

SCHEMA_PATH = ROOT / 'schemas' / 'org.gnome.shell.extensions.llm-usage.gschema.xml'


class SchemaTests(unittest.TestCase):
    def setUp(self):
        self.tree = ET.parse(SCHEMA_PATH)
        self.schema = self.tree.getroot().find('schema')
        self.keys = {k.attrib['name']: k for k in self.schema.findall('key')}

    def test_schema_id_matches_extension(self):
        metadata = json.loads((ROOT / 'metadata.json').read_text())
        self.assertEqual(
            self.schema.attrib['id'],
            metadata['settings-schema'],
            'schema id must match metadata settings-schema',
        )

    def test_expected_keys_present(self):
        self.assertTrue(
            EXPECTED_SCHEMA_KEYS.issubset(self.keys),
            f'missing keys: {EXPECTED_SCHEMA_KEYS - set(self.keys)}',
        )

    def _default(self, name):
        return self.keys[name].find('default').text

    def test_provider_defaults_enabled(self):
        for provider in ('codex', 'antigravity', 'copilot', 'mistral', 'claude'):
            self.assertEqual(self._default(f'provider-{provider}-enabled'), 'true')

    def test_panel_provider_default_codex(self):
        self.assertEqual(self._default('panel-provider'), "'codex'")

    def test_mistral_firefox_fetch_opt_in(self):
        self.assertEqual(
            self._default('mistral-firefox-enabled'), 'false',
            'Firefox session reuse must be opt-in (never on by default)',
        )
        description = self.keys['mistral-firefox-enabled'].find('description').text.lower()
        self.assertIn('in memory only', description)
        self.assertIn('never stored', description)

    def test_mistral_web_script_present(self):
        script = ROOT / 'tools' / 'mistral_web.py'
        self.assertTrue(script.is_file(), 'tools/mistral_web.py must ship with the extension')
        content = script.read_text()
        self.assertIn('CODEX_USAGE_MISTRAL_FIXTURE_HTML', content,
                      'fixture test mode marker missing')

    def test_claude_oauth_opt_in(self):
        self.assertEqual(self._default('claude-oauth-enabled'), 'false')

    def test_claude_firefox_fetch_opt_in(self):
        self.assertEqual(
            self._default('claude-firefox-enabled'), 'false',
            'Firefox session reuse must be opt-in (never on by default)',
        )
        description = self.keys['claude-firefox-enabled'].find('description').text.lower()
        self.assertIn('in memory only', description)
        self.assertIn('never stored', description)

    def test_claude_web_script_present(self):
        script = ROOT / 'tools' / 'claude_web.py'
        cookies = ROOT / 'tools' / 'firefox_cookies.py'
        self.assertTrue(script.is_file(), 'tools/claude_web.py must ship with the extension')
        self.assertTrue(cookies.is_file(), 'tools/firefox_cookies.py must ship with the extension')
        self.assertIn('LLM_USAGE_CLAUDE_FIXTURE_JSON', script.read_text(),
                      'fixture test mode marker missing')

    def test_compiles_strict(self):
        binary = shutil.which('glib-compile-schemas')
        if binary is None:
            self.skipTest('glib-compile-schemas not available')
        with tempfile.TemporaryDirectory() as target:
            result = subprocess.run(
                [binary, '--strict', '--targetdir', target,
                 str(SCHEMA_PATH.parent)],
                capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stderr)


class MetadataTests(unittest.TestCase):
    def setUp(self):
        self.metadata = json.loads((ROOT / 'metadata.json').read_text())

    def test_uuid_and_schema(self):
        self.assertEqual(self.metadata['uuid'], 'llm-usage@LuizGabrielTeixeira')
        self.assertEqual(self.metadata['settings-schema'],
                         'org.gnome.shell.extensions.llm-usage')

    def test_shell_versions_declared(self):
        self.assertTrue(self.metadata.get('shell-version'),
                        'shell-version must be a non-empty list')

    def test_provider_icon_files_exist(self):
        for provider in ('codex', 'antigravity', 'copilot', 'mistral', 'claude'):
            files = [ROOT / 'icons' / f'{provider}.svg',
                     ROOT / 'icons' / f'{provider}.png']
            self.assertTrue(any(f.is_file() for f in files),
                            f'icons/{provider}.svg|png must exist')

    def test_provider_usage_urls(self):
        ext_text = (ROOT / 'extension.js').read_text(encoding='utf-8')
        self.assertRegex(ext_text, r"mistral:\s*'https://admin\.mistral\.ai/subscription'")
        self.assertRegex(ext_text, r"claude:\s*'https://claude\.ai/settings/usage'")
        self.assertNotIn('console.mistral.ai/usage', ext_text)


class ModuleResolutionTests(unittest.TestCase):
    JS_FILES = (
        [ROOT / 'extension.js', ROOT / 'prefs.js']
        + sorted((ROOT / 'lib').glob('*.js'))
        + sorted((ROOT / 'tests' / 'js').glob('*.js'))
        + sorted((ROOT / 'tools').glob('*.js'))
    )

    def test_relative_imports_resolve(self):
        pattern = re.compile(r"""(?:from\s+|import\(\s*)'(\.[^']*)'""")
        problems = []
        for path in self.JS_FILES:
            text = path.read_text()
            for match in pattern.finditer(text):
                target = (path.parent / match.group(1)).resolve()
                if not target.is_file():
                    problems.append(f'{path.name} -> {match.group(1)}')
        self.assertEqual(problems, [], f'unresolved imports: {problems}')


class JsContractTests(unittest.TestCase):
    def test_reset_notifier_across_process_restarts(self):
        binary = shutil.which('gjs')
        compiler = shutil.which('glib-compile-schemas')
        if binary is None or compiler is None:
            self.skipTest('gjs and glib-compile-schemas required')
        with tempfile.TemporaryDirectory() as target:
            subprocess.run(
                [compiler, '--strict', '--targetdir', target, str(SCHEMA_PATH.parent)],
                check=True, capture_output=True, text=True, timeout=30,
            )
            env = {**os.environ, 'GSETTINGS_SCHEMA_DIR': target,
                   'GSETTINGS_BACKEND': 'keyfile', 'XDG_CONFIG_HOME': target}
            for phase in ('baseline', 'wake', 'verify'):
                with self.subTest(phase=phase):
                    result = subprocess.run(
                        [binary, '-m', 'tests/js/reset-notifier.js', phase],
                        cwd=ROOT, capture_output=True, text=True, timeout=60, env=env,
                    )
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue((Path(target) / 'glib-2.0/settings/keyfile').is_file())

    def test_reset_notifier_with_persisted_settings(self):
        binary = shutil.which('gjs')
        compiler = shutil.which('glib-compile-schemas')
        if binary is None or compiler is None:
            self.skipTest('gjs and glib-compile-schemas required')
        with tempfile.TemporaryDirectory() as target:
            subprocess.run(
                [compiler, '--strict', '--targetdir', target, str(SCHEMA_PATH.parent)],
                check=True, capture_output=True, text=True, timeout=30,
            )
            result = subprocess.run(
                [binary, '-m', 'tests/js/reset-notifier.js'],
                cwd=ROOT, capture_output=True, text=True, timeout=60,
                env={**os.environ, 'GSETTINGS_SCHEMA_DIR': target,
                     'GSETTINGS_BACKEND': 'memory'},
            )
        combined = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, f'reset notifier tests failed:\n{combined}')
        self.assertIn('RESET-NOTIFIER-TESTS:', combined)

    def test_contract_suite_passes(self):
        binary = shutil.which('gjs')
        if binary is None:
            self.skipTest('gjs not available')
        result = subprocess.run(
            [binary, '-m', 'tests/js/run.js'],
            cwd=ROOT, capture_output=True, text=True, timeout=60,
        )
        combined = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0,
                         f'js tests failed:\n{combined}')
        self.assertIn('JS-TESTS:', combined)
        self.assertIn('passed', combined)

    def test_claude_source_suite_passes(self):
        binary = shutil.which('gjs')
        if binary is None:
            self.skipTest('gjs not available')
        result = subprocess.run(
            [binary, '-m', 'tests/js/claude-source.js'],
            cwd=ROOT, capture_output=True, text=True, timeout=60,
        )
        combined = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0,
                         f'js claude-source tests failed:\n{combined}')
        self.assertIn('JS-CLAUDE-SOURCE-TESTS:', combined)
        self.assertIn('passed', combined)


class JsSmokeTests(unittest.TestCase):
    """Runs the coordinator smoke suite (fake sources, no network)."""

    def test_coordinator_smoke_passes(self):
        binary = shutil.which('gjs')
        if binary is None:
            self.skipTest('gjs not available')
        result = subprocess.run(
            [binary, '-m', 'tests/js/smoke.js'],
            cwd=ROOT, capture_output=True, text=True, timeout=60,
        )
        combined = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0,
                         f'smoke tests failed:\n{combined}')
        self.assertIn('JS-SMOKE:', combined)
        self.assertIn('passed', combined)


class GjsNamespaceTests(unittest.TestCase):
    """Catch wrong-namespace constructor errors before they reach GNOME.

    Regression for a real incident: GCancellable lives in GIO, so
    `new GLib.Cancellable()` evaluated to `new undefined` and crashed the
    extension inside enable() with '(intermediate value).Cancellable is
    not a constructor'.
    """

    # Classes that genuinely exist as GLib constructors in GJS.
    GLIB_CONSTRUCTIBLE = {'MainLoop', 'VariantDict'}
    # Classes that live in GIO and must never be accessed via GLib.
    GIO_ONLY_CLASSES = {
        'Cancellable', 'Settings', 'Subprocess', 'SubprocessLauncher',
        'SimpleProxyResolver', 'SimpleAction', 'Menu', 'ThemedIcon',
        'Icon', 'File',
    }
    JS_FILES = (
        [ROOT / 'extension.js', ROOT / 'prefs.js']
        + sorted((ROOT / 'lib').glob('*.js'))
        + sorted((ROOT / 'tests' / 'js').glob('*.js'))
        + sorted((ROOT / 'tools').glob('*.js'))
    )

    @staticmethod
    def _strip_comments(text):
        text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
        text = re.sub(r'^\s*//.*$', '', text, flags=re.M)
        return text

    def test_no_glib_constructors_outside_whitelist(self):
        pattern = re.compile(r'new GLib\.(\w+)')
        problems = []
        for path in self.JS_FILES:
            for match in pattern.finditer(self._strip_comments(path.read_text())):
                name = match.group(1)
                if name not in self.GLIB_CONSTRUCTIBLE:
                    problems.append(f'{path.name}: new GLib.{name}')
        self.assertEqual(problems, [],
                         f'invalid GLib constructors: {problems}')

    def test_no_gio_classes_accessed_via_glib(self):
        pattern = re.compile(r'\bGLib\.(\w+)')
        problems = []
        for path in self.JS_FILES:
            for match in pattern.finditer(self._strip_comments(path.read_text())):
                if match.group(1) in self.GIO_ONLY_CLASSES:
                    problems.append(f'{path.name}: GLib.{match.group(1)}')
        self.assertEqual(problems, [],
                         f'GIO classes accessed via GLib: {problems}')


class StylesheetTests(unittest.TestCase):
    """The menu follows the simplified original-like design: one provider
    at a time, neutral bars, and all text explicitly white (user requests:
    'sem cores, sem icons, sem services' + 'mete mesmo as fontes a branco')."""

    def setUp(self):
        self.css = (ROOT / 'stylesheet.css').read_text()

    def test_core_classes_present(self):
        for cls in ('.codex-meter', '.codex-track', '.codex-fill',
                    '.codex-button', '.codex-button-primary',
                    '.codex-reset-list', '.codex-error', '.codex-advice'):
            self.assertIn(cls, self.css, f'{cls} must be styled')

    def test_no_severity_or_brand_colors(self):
        forbidden = (
            '#33d17a', '#ff7800', '#e01b24', '#ffa348', '#ff6b6b',
            '#ff9c8a', '#3584e4', '#4a90e0', '#62a0ea',
            'rgba(51, 209', 'rgba(255, 167', 'rgba(224, 27', 'rgba(230, 97',
        )
        for color in forbidden:
            self.assertNotIn(color, self.css,
                             f'severity/brand color {color} violates the neutral design')

    def test_removed_service_sections_stay_removed(self):
        for cls in ('.codex-status-pill', '.codex-provider-header',
                    '.codex-provider-details', '.codex-overview',
                    '.codex-logo', '.codex-pill', '.codex-panel-tier'):
            self.assertNotIn(cls, self.css, f'{cls} belongs to the removed services UI')


class ProviderSelectorTests(unittest.TestCase):
    """The provider picker is a native submenu list the user can choose from,
    not a cycle button (user request: 'queria que abrisse uma lista dos
    providers e eu escolhesse. e não so ir pro proximo')."""

    def setUp(self):
        self.source = (ROOT / 'extension.js').read_text()

    def test_uses_popup_submenu_with_checkmarks(self):
        self.assertIn('PopupSubMenuMenuItem', self.source)
        self.assertIn('PopupMenu.Ornament.CHECK', self.source)
        self.assertIn("set_string('panel-provider'", self.source)

    def test_cycle_button_is_gone(self):
        self.assertNotIn('_cycleProvider', self.source)
        self.assertNotIn('_providerButton', self.source)


class ProviderIconTests(unittest.TestCase):
    """Per-provider panel icons resolve from icons/<id>.svg|png.
    There is no extension-level fallback icon — a provider without an
    icon file simply shows no icon in the panel."""

    def test_icon_lookup_mechanism(self):
        source = (ROOT / 'extension.js').read_text()
        self.assertIn("'icons'", source)
        self.assertIn('svg', source)
        self.assertIn('_providerIconGicon', source)
        # No extension-level fallback icon in the PANEL lookup; the reset
        # notification tray source may use the llm-usage.png logo.
        start = source.index('_providerIconGicon')
        end = source.index('_resetTraySource', start)
        panel_lookup = source[start:end]
        self.assertNotIn('llm-usage.png', panel_lookup)

    def test_icons_readme_documents_formats(self):
        readme = (ROOT / 'icons' / 'README.md')
        self.assertTrue(readme.exists(), 'icons/README.md must exist')
        text = readme.read_text()
        for provider in ('codex', 'antigravity', 'copilot', 'mistral', 'claude'):
            self.assertIn(provider, text)
        self.assertIn('SVG', text)
        self.assertIn('PNG', text)

    def test_claude_svg_and_icon_style_wiring(self):
        claude_svg = ROOT / 'icons' / 'claude.svg'
        self.assertTrue(claude_svg.is_file(), 'icons/claude.svg must exist')
        self.assertFalse((ROOT / 'icons' / 'claude-code.svg').exists(),
                         'claude-code.svg is not matched by provider id; keep claude.svg')
        self.assertFalse((ROOT / 'icons' / 'claude.png').exists(),
                         'remove redundant claude.png when claude.svg is shipped')
        svg_text = claude_svg.read_text(encoding='utf-8')
        self.assertIn('<svg', svg_text)
        self.assertIn('viewBox=', svg_text)
        self.assertIn('fill="#', svg_text)

        source = (ROOT / 'extension.js').read_text(encoding='utf-8')
        self.assertIn("'icon-style'", source)
        self.assertIn('_updateIconStyle', source)
        self.assertIn('DesaturateEffect', source)
        self.assertIn('BrightnessContrastEffect', source)


class ScrollCycleTests(unittest.TestCase):
    """Scrolling the mouse wheel over the panel indicator cycles providers,
    like GNOME's own workspace switcher (user request 2026-10-26)."""

    def setUp(self):
        self.source = (ROOT / 'extension.js').read_text()

    def test_scroll_event_is_wired_to_provider_cycling(self):
        self.assertIn("'scroll-event'", self.source)
        self.assertIn('Clutter.ScrollDirection.UP', self.source)
        self.assertIn('Clutter.ScrollDirection.DOWN', self.source)
        self.assertIn('Clutter.ScrollDirection.SMOOTH', self.source)
        self.assertIn('get_scroll_delta', self.source)
        self.assertIn("set_string('panel-provider'", self.source)

    def test_scroll_has_debounce_guard(self):
        self.assertIn('_lastScrollMs', self.source)
        self.assertIn('150', self.source)

    def test_scroll_wraps_around_enabled_providers(self):
        self.assertIn('_enabledProviderIds', self.source)
        self.assertIn('% enabled.length', self.source)


class CopilotRequestsDisplayTests(unittest.TestCase):
    """Copilot meters lead with request counts - the 200/month allowance is
    what the user actually manages (user request: 'coloca o copilot com as
    requisicoes, pq é isso que importa, temos apenas 200 por mes')."""

    def setUp(self):
        self.source = (ROOT / 'extension.js').read_text()

    def test_requests_shown_in_meter_row(self):
        self.assertIn('win.requests', self.source)
        self.assertIn('reqs.entitlement', self.source)
        self.assertIn('/ ${reqs.entitlement} requests', self.source)

    def test_requests_not_duplicated_in_note(self):
        self.assertNotIn('requests used`}', self.source,
                         'requests must not also render as a redundant note')

    def test_panel_label_is_percent_only(self):
        """Panel label shows only the percent so its width never changes
        (user request: 'nao mostra os requests mostra % igual todos pra
        nao ficar mudando o tamanho da barra'). Requests stay in the menu."""
        self.assertNotIn('reqSuffix', self.source)
        self.assertIn("${Math.round(display)}%`", self.source)


class BarFullnessTests(unittest.TestCase):
    """A "100%" reading must render a completely full bar everywhere.
    Two independent causes were fixed after the user report 2026-10-26:
    (1) rounding: the panel text rounds to an integer (~99.5%+ reads
    "100%") while bars rounded fractional pixels short - all renderers
    now clamp through snapFullPercent.
    (2) geometry: the menu popup is 320px wide and St.BoxLayout children
    are x-filled by default, so the track paints at its allocated width
    while the fill was capped at a fixed TRACK_WIDTH=300 - a permanent
    ~20px gap even at 100%. The fill now follows the track's allocated
    width (notify::allocation + _syncFill) instead of a fixed constant."""

    def setUp(self):
        self.source = (ROOT / 'extension.js').read_text()

    def test_bars_render_through_snap_helper(self):
        # Meter (setValue + setAmount), PanelBar and Ring all snap.
        self.assertGreaterEqual(self.source.count('snapFullPercent('), 4)

    def test_meter_clamps_via_snap_helper(self):
        self.assertNotIn('Math.max(0, Math.min(100, util))', self.source,
                         'renderers must clamp through snapFullPercent')

    def test_meter_fill_follows_track_allocation(self):
        self.assertIn('notify::allocation', self.source,
                      'meter fill must resync when the track is allocated')
        self.assertIn('_syncFill', self.source)
        self.assertNotIn('TRACK_WIDTH', self.source,
                         'fixed-width fills under-fill stretched tracks')


class MenuCleanlinessTests(unittest.TestCase):
    """The Antigravity CLI describes buckets in prose ("You have used some
    of your weekly limit.") - text beyond the usage numbers. That prose must
    not be surfaced in the menu (user report 2026-10-26)."""

    def setUp(self):
        self.source = (ROOT / 'extension.js').read_text()

    def test_note_label_removed(self):
        self.assertNotIn('codex-note', self.source)
        self.assertNotIn('win.note', self.source)


class ResetNotificationWiringTests(unittest.TestCase):
    """Desktop reset notifications (user request 2026-10-27: "notificação
    aqui no pc apenas, quando ligar ou durante a utilização. por app e
    subscrição que reseta. sem notificações externas pra já"). The feature
    is a self-contained module plus hook points, revertable in one commit."""

    def setUp(self):
        self.source = (ROOT / 'extension.js').read_text()
        self.prefs = (ROOT / 'prefs.js').read_text()
        self.schema = (ROOT / 'schemas' /
                       'org.gnome.shell.extensions.llm-usage.gschema.xml').read_text()

    def test_extension_wires_the_notifier(self):
        self.assertIn("from './lib/resetNotifications.js'", self.source)
        self.assertIn('new ResetNotifier(', self.source)
        self.assertIn('this._resetNotifier?.note(id, snap)', self.source)

    def test_reset_notifications_stay_in_the_tray(self):
        """Persistent notifications (user request 2026-10-27): reset banners
        must NOT be transient like Main.notify() — they belong in the
        message list/calendar until dismissed."""
        self.assertIn('ui/messageTray.js', self.source)
        self.assertIn('Main.messageTray.add(', self.source)
        self.assertIn('addNotification(', self.source)
        self.assertNotIn('Main.notify', self.source)

    def test_schema_and_prefs_expose_the_toggle(self):
        self.assertIn('notify-on-reset', self.schema)
        self.assertIn('reset-notification-state', self.schema)
        self.assertIn("'notify-on-reset'", self.prefs)

    def test_notifier_module_exists(self):
        self.assertTrue((ROOT / 'lib' / 'resetNotifications.js').exists())


class IdentityTests(unittest.TestCase):
    def test_user_agent_is_own_and_used_by_sources(self):
        identity = (ROOT / 'lib' / 'identity.js').read_text()
        self.assertRegex(identity, r"USER_AGENT = 'llm-usage ")
        for name in ('claudeSource', 'codexSource', 'copilotSource'):
            text = (ROOT / 'lib' / f'{name}.js').read_text()
            self.assertIn("from './identity.js'", text, name)

    def test_no_source_impersonates_another_client(self):
        for path in (ROOT / 'lib').glob('*.js'):
            text = path.read_text()
            for needle in ('claude-code/', 'codex-cli', 'GitHubCopilotChat', 'Editor-Version'):
                self.assertNotIn(needle, text, f'{path.name} contains {needle}')


class PrefsNoticeTests(unittest.TestCase):
    def test_account_notice_next_to_sensitive_options(self):
        text = (ROOT / 'prefs.js').read_text()
        self.assertEqual(text.count('accountNotice('), 4, 'definition + three uses')
        for url in ('code.claude.com/docs/en/legal-and-compliance',
                    'google-gemini/gemini-cli/discussions/20632'):
            self.assertIn(url, text)
        for key in ('claude-oauth-enabled', 'claude-firefox-enabled', 'mistral-firefox-enabled'):
            self.assertIn(f"'{key}'", text)


class PureJsTests(unittest.TestCase):
    """Runs the GI-free unit tests with node when it is installed."""

    def test_pure_modules(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('node not available')
        for name in ('claude-gate.js', 'backoff.js'):
            result = subprocess.run(
                [node, str(ROOT / 'tests' / 'js' / name)],
                capture_output=True, text=True, timeout=60,
            )
            self.assertEqual(result.returncode, 0, f'{name} failed: {result.stdout}{result.stderr}')


if __name__ == '__main__':
    unittest.main()
