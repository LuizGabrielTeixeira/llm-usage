import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class CodexUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'LLM Usage Settings',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const generalGroup = new Adw.PreferencesGroup({
            title: 'General',
            description: 'AI subscription usage monitor (Codex, Antigravity, Copilot, Mistral)',
        });
        page.add(generalGroup);

        const refreshRow = new Adw.SpinRow({
            title: 'Refresh Interval',
            subtitle: 'How often to refresh usage data (in seconds)',
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 600,
                step_increment: 10,
                page_increment: 60,
                value: settings.get_int('refresh-interval'),
            }),
        });
        settings.bind(
            'refresh-interval',
            refreshRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        generalGroup.add(refreshRow);

        const providersGroup = new Adw.PreferencesGroup({
            title: 'Providers',
            description: 'Choose which subscriptions are monitored and which one drives the panel',
        });
        page.add(providersGroup);

        const providerRows = [
            ['provider-codex-enabled', 'Codex', 'ChatGPT backend usage via the local Codex CLI session'],
            ['provider-antigravity-enabled', 'Antigravity', 'Reads the agy usage report (requires a signed-in agy CLI)'],
            ['provider-copilot-enabled', 'Copilot', 'GitHub Copilot quota via the GitHub CLI session'],
            ['provider-mistral-enabled', 'Mistral', 'Fetches admin.mistral.ai through your Firefox session - see the Mistral group below'],
        ];
        for (const [key, title, subtitle] of providerRows) {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            providersGroup.add(row);
        }

        const panelProviderRow = new Adw.ComboRow({
            title: 'Panel Provider',
            subtitle: 'Which subscription the panel percentage reflects',
        });
        const panelProviderModel = new Gtk.StringList();
        panelProviderModel.append('Codex');
        panelProviderModel.append('Antigravity');
        panelProviderModel.append('Copilot');
        panelProviderModel.append('Mistral');
        panelProviderRow.set_model(panelProviderModel);

        const currentProvider = settings.get_string('panel-provider');
        panelProviderRow.set_selected(currentProvider === 'antigravity' ? 1
            : currentProvider === 'copilot' ? 2
                : currentProvider === 'mistral' ? 3
                    : 0);

        panelProviderRow.connect('notify::selected', () => {
            const selected = panelProviderRow.get_selected();
            const providers = ['codex', 'antigravity', 'copilot', 'mistral'];
            settings.set_string('panel-provider', providers[selected]);
        });
        providersGroup.add(panelProviderRow);

        const displayGroup = new Adw.PreferencesGroup({
            title: 'Panel Display',
            description: 'Configure how usage is shown in the top panel',
        });
        page.add(displayGroup);

        const displayModeRow = new Adw.ComboRow({
            title: 'Display Mode',
            subtitle: 'Show a ring or bar, a percentage, or combine them',
        });

        const displayModeModel = new Gtk.StringList();
        displayModeModel.append('Ring + Percentage');
        displayModeModel.append('Text (percentage)');
        displayModeModel.append('Progress Bar');
        displayModeModel.append('Bar + Percentage');
        displayModeModel.append('Ring only');
        displayModeRow.set_model(displayModeModel);

        const currentMode = settings.get_string('display-mode');
        const modeIndex = currentMode === 'text' ? 1
            : currentMode === 'bar' ? 2
                : currentMode === 'both' ? 3
                    : currentMode === 'ring-only' ? 4
                        : 0;
        displayModeRow.set_selected(modeIndex);

        displayModeRow.connect('notify::selected', () => {
            const selected = displayModeRow.get_selected();
            const modes = ['ring', 'text', 'bar', 'both', 'ring-only'];
            settings.set_string('display-mode', modes[selected]);
        });

        displayGroup.add(displayModeRow);

        const panelWindowRow = new Adw.ComboRow({
            title: 'Panel Reflects',
            subtitle: 'Choose which quota the panel percentage follows',
        });

        const panelWindowModel = new Gtk.StringList();
        panelWindowModel.append('Biggest allowance');
        panelWindowModel.append('Most used');
        panelWindowModel.append('First window');
        panelWindowModel.append('Second window');
        panelWindowRow.set_model(panelWindowModel);

        const currentPanelWindow = settings.get_string('panel-window');
        panelWindowRow.set_selected(currentPanelWindow === 'max' ? 1
            : currentPanelWindow === 'primary' ? 2
                : currentPanelWindow === 'secondary' ? 3
                    : 0);

        panelWindowRow.connect('notify::selected', () => {
            const selected = panelWindowRow.get_selected();
            const windows = ['largest', 'max', 'primary', 'secondary'];
            settings.set_string('panel-window', windows[selected]);
        });

        displayGroup.add(panelWindowRow);

        const usageDisplayRow = new Adw.ComboRow({
            title: 'Usage Values',
            subtitle: 'Show consumed usage or remaining allowance',
        });

        const usageDisplayModel = new Gtk.StringList();
        usageDisplayModel.append('Used');
        usageDisplayModel.append('Remaining');
        usageDisplayRow.set_model(usageDisplayModel);

        const currentUsageDisplay = settings.get_string('usage-display');
        usageDisplayRow.set_selected(currentUsageDisplay === 'remaining' ? 1 : 0);

        usageDisplayRow.connect('notify::selected', () => {
            const selected = usageDisplayRow.get_selected();
            settings.set_string('usage-display', selected === 1 ? 'remaining' : 'used');
        });

        displayGroup.add(usageDisplayRow);

        const iconStyleRow = new Adw.ComboRow({
            title: 'Icon Style',
            subtitle: 'Use a color or monochrome icon in the panel',
        });

        const iconStyleModel = new Gtk.StringList();
        iconStyleModel.append('Color');
        iconStyleModel.append('Monochrome');
        iconStyleRow.set_model(iconStyleModel);

        const currentStyle = settings.get_string('icon-style');
        iconStyleRow.set_selected(currentStyle === 'monochrome' ? 1 : 0);

        iconStyleRow.connect('notify::selected', () => {
            const selected = iconStyleRow.get_selected();
            settings.set_string('icon-style', selected === 1 ? 'monochrome' : 'color');
        });

        displayGroup.add(iconStyleRow);

        const showIconRow = new Adw.SwitchRow({
            title: 'Show Icon',
            subtitle: 'Display the extension icon in the top bar',
        });
        settings.bind(
            'show-icon',
            showIconRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        displayGroup.add(showIconRow);

        const menuGroup = new Adw.PreferencesGroup({
            title: 'Menu',
            description: 'Configure what the dropdown menu shows',
        });
        page.add(menuGroup);

        const additionalLimitsRow = new Adw.SwitchRow({
            title: 'Show Additional Limits',
            subtitle: 'Display model-specific limits (e.g. GPT-5.3-Codex-Spark) in the menu',
        });
        settings.bind(
            'show-additional-limits',
            additionalLimitsRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        menuGroup.add(additionalLimitsRow);

        const notificationsGroup = new Adw.PreferencesGroup({
            title: 'Notifications',
            description: 'Desktop notifications on this PC only - no external services',
        });
        page.add(notificationsGroup);

        const notifyResetRow = new Adw.SwitchRow({
            title: 'Notify on Reset',
            subtitle: 'Desktop notification when a weekly or monthly quota resets, including resets missed while you were away',
        });
        settings.bind(
            'notify-on-reset',
            notifyResetRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        notificationsGroup.add(notifyResetRow);

        const mistralGroup = new Adw.PreferencesGroup({
            title: 'Mistral',
            description: 'Mistral allowances are only visible in the Mistral console (browser session)',
        });
        page.add(mistralGroup);

        const firefoxRow = new Adw.SwitchRow({
            title: 'Fetch from Firefox session',
            subtitle: 'Reads your admin.mistral.ai session cookie from Firefox (in memory only - never stored)',
        });
        settings.bind(
            'mistral-firefox-enabled',
            firefoxRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        mistralGroup.add(firefoxRow);

        const mistralHint = new Gtk.Label({
            label: 'Sign in to admin.mistral.ai in Firefox once and the extension reads the page directly. Allowances reset on the first day of each month. Nothing is stored - never credentials, never cookies.',
            xalign: 0,
            css_classes: ['dim-label', 'caption'],
            margin_start: 12,
            margin_top: 4,
            wrap: true,
        });
        mistralGroup.add(mistralHint);

        const networkGroup = new Adw.PreferencesGroup({
            title: 'Network',
            description: 'Configure network settings',
        });
        page.add(networkGroup);

        const proxyRow = new Adw.EntryRow({
            title: 'Proxy URL',
            show_apply_button: true,
        });
        proxyRow.set_text(settings.get_string('proxy-url'));
        proxyRow.connect('apply', () => {
            settings.set_string('proxy-url', proxyRow.get_text());
        });
        networkGroup.add(proxyRow);

        const proxyHint = new Gtk.Label({
            label: 'Example: http://localhost:11809 (leave empty for no proxy)',
            xalign: 0,
            css_classes: ['dim-label', 'caption'],
            margin_start: 12,
            margin_top: 4,
        });
        networkGroup.add(proxyHint);
    }
}
