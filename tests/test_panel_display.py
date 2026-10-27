"""Panel mode regressions without loading or restarting GNOME Shell."""

import re
import shutil
import subprocess
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class PanelDisplayTests(unittest.TestCase):
    def _run_js(self, script):
        binary = shutil.which('gjs')
        if binary is None:
            self.skipTest('gjs not available')
        result = subprocess.run(
            [binary, '-c', script], cwd=ROOT, capture_output=True,
            text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_all_modes_and_transitions_with_optional_icon(self):
        source = (ROOT / 'extension.js').read_text()
        methods = []
        for name in ('_updateDisplayMode', '_updateIconVisibility'):
            match = re.search(rf'        {name}\(\) \{{.*?^        \}}', source, re.S | re.M)
            self.assertIsNotNone(match, f'{name} missing')
            methods.append(match.group())
        self._run_js('const indicator = {\n' + ',\n'.join(methods) + r'''
        };
        const modes = [
            ['ring', true, false, true],
            ['text', false, false, true],
            ['bar', false, true, false],
            ['both', false, true, true],
            ['ring-only', true, false, false],
        ];
        indicator._ring = {};
        indicator._panelBar = {root: {}};
        indicator._label = {};
        for (const showIcon of [true, false]) {
            for (const gicon of [{}, null]) {
                indicator._icon = {gicon};
                // Exercise every transition, including leaving ring-only.
                for (const previous of modes) {
                    for (const [mode, ring, bar, label] of modes) {
                        let current = previous[0];
                        indicator._settings = {
                            get_string: () => current,
                            get_boolean: () => showIcon,
                        };
                        indicator._updateDisplayMode();
                        current = mode;
                        indicator._updateDisplayMode();
                        indicator._updateIconVisibility();
                        if (indicator._ring.visible !== ring ||
                            indicator._panelBar.root.visible !== bar ||
                            indicator._label.visible !== label ||
                            indicator._icon.visible !== (showIcon && gicon !== null))
                            throw new Error(`Incorrect visibility for ${mode}`);
                    }
                }
            }
        }
        ''')

    def test_preferences_restore_and_save_every_mode(self):
        source = (ROOT / 'prefs.js').read_text()
        start = source.index('        const displayModeRow =')
        end = source.index('        displayGroup.add(displayModeRow);', start)
        code = source[start:end]
        self._run_js(r'''
        const modes = ['ring', 'text', 'bar', 'both', 'ring-only'];
        const Gtk = {StringList: class extends Array {
            append(value) { this.push(value); }
        }};
        const Adw = {ComboRow: class {
            set_model(model) { this.model = model; }
            set_selected(index) { this.selected = index; }
            get_selected() { return this.selected; }
            connect(_signal, callback) { this.changed = callback; }
        }};
        for (const current of modes) {
            let saved = null;
            const settings = {
                get_string: () => current,
                set_string: (_key, value) => { saved = value; },
            };
        ''' + code + r'''
            if (displayModeRow.selected !== modes.indexOf(current))
                throw new Error(`Failed to restore ${current}`);
            if (displayModeRow.model.length !== modes.length ||
                displayModeRow.model[4] !== 'Ring only')
                throw new Error('Missing ring-only preference');
            for (let i = 0; i < modes.length; i++) {
                displayModeRow.set_selected(i);
                displayModeRow.changed();
                if (saved !== modes[i])
                    throw new Error(`Failed to save ${modes[i]}`);
            }
        }
        ''')

    def test_schema_preserves_default_and_documents_ring_only(self):
        schema = ET.parse(ROOT / 'schemas' / 'org.gnome.shell.extensions.llm-usage.gschema.xml')
        key = schema.find(".//key[@name='display-mode']")
        self.assertEqual(key.findtext('default'), "'ring'")
        self.assertIn("'ring-only'", key.findtext('description'))

    def test_modes_share_existing_spacing_and_fixed_gauge_sizes(self):
        css = (ROOT / 'stylesheet.css').read_text()

        def body(name):
            return re.search(r'\.' + name + r'\s*\{([^}]+)\}', css).group(1)

        # Keep the existing provider-to-gauge breathing room and outer padding.
        self.assertRegex(body('codex-panel'), r'\bspacing:\s*5px;')
        self.assertRegex(body('codex-panel'), r'\bpadding:\s*0 4px;')
        self.assertRegex(body('codex-panel-icon'), r'\bmargin-right:\s*8px;')
        for property_name in ('width', 'height'):
            self.assertRegex(body('codex-ring'), rf'\b{property_name}:\s*18px;')
        self.assertRegex(body('codex-panel-bar'), r'\bwidth:\s*50px;')
        self.assertRegex(body('codex-panel-pct'), r'\bmin-width:\s*40px;')


if __name__ == '__main__':
    unittest.main()
