from pathlib import Path
import re
import unittest


class TextStyleTests(unittest.TestCase):
    def test_text_classes_use_white(self):
        stylesheet = Path('stylesheet.css').read_text()
        text_classes = [
            '.codex-panel-pct', '.codex-title',
            '.codex-subtitle', '.codex-section-label',
            '.codex-meter-name', '.codex-meter-pct', '.codex-caption',
            '.codex-reset-name', '.codex-reset-time',
            '.codex-reset-empty', '.codex-error', '.codex-advice',
            '.codex-button', '.codex-updated', '.codex-footer-button',
        ]
        for cls in text_classes:
            match = re.search(
                re.escape(cls) + r'\s*\{(?P<body>[^}]*)\}', stylesheet, re.DOTALL)
            self.assertIsNotNone(match, f'{cls} missing from stylesheet.css')
            self.assertRegex(
                match.group('body'), r'\bcolor:\s*#ffffff\s*;',
                f'{cls} must set white text (user request 2026-10-26)')

    def test_text_classes_have_no_opacity_dimming(self):
        stylesheet = Path('stylesheet.css').read_text()
        text_classes = [
            '.codex-subtitle', '.codex-section-label',
            '.codex-caption', '.codex-reset-time',
            '.codex-reset-empty', '.codex-advice', '.codex-updated',
            '.codex-footer-button',
        ]
        for cls in text_classes:
            match = re.search(
                re.escape(cls) + r'\s*\{(?P<body>[^}]*)\}', stylesheet, re.DOTALL)
            self.assertIsNotNone(match, f'{cls} missing from stylesheet.css')
            self.assertNotIn('opacity', match.group('body'),
                             f'{cls} must not dim white text with opacity')


class FixedPanelSizeTests(unittest.TestCase):
    """The panel must keep a constant size across providers and values
    (user request: 'faz um tamanho padrao, pra nao ficar crescendo e
    diminuindo dependendo de qual esta exposta')."""

    def setUp(self):
        self.css = Path('stylesheet.css').read_text()

    def _body(self, cls):
        match = re.search(re.escape(cls) + r'\s*\{(?P<body>[^}]*)\}',
                          self.css, re.DOTALL)
        self.assertIsNotNone(match, f'{cls} missing from stylesheet.css')
        return match.group('body')

    def test_panel_labels_have_fixed_width(self):
        body = self._body('.codex-panel-pct')
        self.assertRegex(body, r'\bmin-width:\s*[\d.]+px\s*;',
                         '.codex-panel-pct must pin its width to keep the panel stable')

    def test_fixed_width_covers_widest_values(self):
        pct = self._body('.codex-panel-pct')
        self.assertRegex(pct, r'\bmin-width:\s*(\d+)px')
        self.assertGreaterEqual(int(re.search(r'min-width:\s*(\d+)px', pct).group(1)),
                                38, 'must fit "100%"')


class PanelBarStyleTests(unittest.TestCase):
    """The panel bar follows the original extension's standard: 50px wide,
    10px tall, white fill on translucent white track (user request
    'coloca um pouco maior a barra... padrao da extensao original')."""

    def setUp(self):
        self.css = Path('stylesheet.css').read_text()

    def _body(self, cls):
        match = re.search(re.escape(cls) + r'\s*\{(?P<body>[^}]*)\}',
                           self.css, re.DOTALL)
        self.assertIsNotNone(match, f'{cls} missing from stylesheet.css')
        return match.group('body')

    def test_panel_bar_is_50px(self):
        body = self._body('.codex-panel-bar')
        self.assertRegex(body, r'\bwidth:\s*50px\s*;',
                         'panel bar must be 50px wide like the original')

    def test_panel_bar_fill_is_white(self):
        self.assertRegex(self._body('.codex-panel-bar-fill'),
                         r'\bbackground-color:\s*#ffffff\s*;',
                         'panel bar fill must be white like the original')
        self.assertRegex(self._body('.codex-panel-bar'),
                         r'rgba\(255,\s*255,\s*255,\s*0\.2\)',
                         'panel bar track must be translucent white')


if __name__ == '__main__':
    unittest.main()
