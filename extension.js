import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Cairo from 'cairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    STATUS,
    severity,
    colorRgb,
    relativeReset,
    expiresIn,
    usedPercent,
    displayPercent,
    snapFullPercent,
    selectPanelWindow,
    snapshot,
} from './lib/contract.js';
import {CodexSource} from './lib/codexSource.js';
import {AgySource} from './lib/agySource.js';
import {CopilotSource} from './lib/copilotSource.js';
import {MistralSource} from './lib/mistralSource.js';
import {ProviderCoordinator} from './lib/coordinator.js';

const TRACK_WIDTH = 300;
const PANEL_BAR_WIDTH = 50;
const RING_SIZE = 18;
const RING_WIDTH = 3;

const PROVIDERS = [
    {id: 'codex', label: 'Codex'},
    {id: 'antigravity', label: 'Antigravity'},
    {id: 'copilot', label: 'Copilot'},
    {id: 'mistral', label: 'Mistral'},
];
const PROVIDER_BY_ID = new Map(PROVIDERS.map(provider => [provider.id, provider]));

const PROVIDER_USAGE_URLS = {
    codex: 'https://chatgpt.com/#settings/Usage',
    copilot: 'https://github.com/settings/copilot/features',
    mistral: 'https://console.mistral.ai/usage',
};

function wrapLabel(label) {
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

class Meter {
    constructor(name) {
        this.root = new St.BoxLayout({vertical: true, style_class: 'codex-meter'});

        const row = new St.BoxLayout({style_class: 'codex-meter-row'});
        this._name = new St.Label({text: name, style_class: 'codex-meter-name', x_expand: true});
        this._pct = new St.Label({text: '...', style_class: 'codex-meter-pct'});
        row.add_child(this._name);
        row.add_child(this._pct);

        this._track = new St.BoxLayout({style_class: 'codex-track'});
        this._fill = new St.Widget({style_class: 'codex-fill'});
        this._track.add_child(this._fill);

        this._caption = new St.Label({text: '', style_class: 'codex-caption'});

        this.root.add_child(row);
        this.root.add_child(this._track);
        this.root.add_child(this._caption);
    }

    setValue(util, caption, colorUtil = util, displayValue = util, displaySuffix = 'used') {
        const clamped = snapFullPercent(util);
        this._pct.text = `${displayValue.toFixed(1)}% ${displaySuffix}`;
        this._fill.set_width(Math.round((clamped / 100) * TRACK_WIDTH));
        this._fill.style_class = `codex-fill ${severity(colorUtil)}`;
        this._caption.text = caption ?? '';
        this._caption.visible = !!caption;
    }

    setAmount(displayText, util, colorUtil = util, caption = null) {
        const clamped = snapFullPercent(util);
        this._pct.text = displayText;
        this._fill.set_width(Math.round((clamped / 100) * TRACK_WIDTH));
        this._fill.style_class = `codex-fill ${severity(colorUtil)}`;
        this._caption.text = caption ?? '';
        this._caption.visible = !!caption;
    }

    setMuted(detail = '-') {
        this._pct.text = detail;
        this._fill.set_width(0);
        this._fill.style_class = 'codex-fill';
        this._caption.visible = false;
    }
}

const Ring = GObject.registerClass(
    class Ring extends St.DrawingArea {
        _init() {
            super._init({
                style_class: 'codex-ring',
                width: RING_SIZE,
                height: RING_SIZE,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._util = null;
        }

        setValue(util) {
            this._util = snapFullPercent(util);
            this.queue_repaint();
        }

        setUnknown() {
            this._util = null;
            this.queue_repaint();
        }

        vfunc_repaint() {
            const cr = this.get_context();
            const [w, h] = this.get_surface_size();
            const cx = w / 2;
            const cy = h / 2;
            const radius = Math.min(w, h) / 2 - RING_WIDTH / 2;
            const start = -Math.PI / 2;

            cr.setLineWidth(RING_WIDTH);
            cr.setLineCap(Cairo.LineCap.ROUND);

            const [fr, fg, fb] = colorRgb(this.get_theme_node().get_foreground_color());
            cr.setSourceRGBA(fr, fg, fb, 0.22);
            cr.arc(cx, cy, radius, 0, 2 * Math.PI);
            cr.stroke();

            if (this._util !== null && this._util > 0) {
                cr.setSourceRGBA(fr, fg, fb, 1);
                cr.arc(cx, cy, radius, start, start + (this._util / 100) * 2 * Math.PI);
                cr.stroke();
            }

            cr.$dispose();
        }
    }
);

class PanelBar {
    constructor() {
        this.root = new St.BoxLayout({
            style_class: 'codex-panel-bar',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._fill = new St.Widget({style_class: 'codex-panel-bar-fill'});
        this.root.add_child(this._fill);
    }

    setValue(util) {
        this._fill.set_width(Math.round((snapFullPercent(util) / 100) * PANEL_BAR_WIDTH));
    }

    setUnknown() {
        this._fill.set_width(0);
    }
}

const UsageIndicator = GObject.registerClass(
    class UsageIndicator extends PanelMenu.Button {
        _init(extensionPath, settings, openPreferences) {
            super._init(0.0, 'AI Subscription Usage Indicator');

            this._extensionPath = extensionPath;
            this._settings = settings;
            this._openPreferences = openPreferences;

            this._snapshots = new Map();
            this._checkedAt = new Map();
            this._countdownTimer = null;
            this._timerId = null;
            this._coordinator = null;
            this._sources = null;
            this._scrollAccum = 0;
            this._lastScrollMs = 0;

            const box = new St.BoxLayout({style_class: 'codex-panel'});
            this._icon = new St.Icon({
                style_class: 'codex-panel-icon',
                icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._iconGiconByProvider = new Map();
            this._ring = new Ring();
            this._panelBar = new PanelBar();
            this._label = new St.Label({
                text: '...',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'codex-panel-pct',
            });

            box.add_child(this._icon);
            box.add_child(this._ring);
            box.add_child(this._panelBar.root);
            box.add_child(this._label);
            this.add_child(box);

            this._createMenu();
            this._rebuildProviderSubmenu();

            for (const id of this._enabledProviderIds())
                this._snapshots.set(id, snapshot(id, STATUS.LOADING, {}));

            this._renderMenu();
            this._renderPanel();
            this._updateDisplayMode();
            this._updateIconVisibility();
            this._updateIconStyle();

            this._settingsChangedId = this._settings.connect('changed', (settings, key) => {
                this._onSettingsChanged(key);
            });

            this.menu.connectObject('open-state-changed', (_menu, open) => {
                if (open)
                    this._refreshAll();
            }, this);

            this.connect('scroll-event', this._onScroll.bind(this));

            this._createSources();
            this._refreshAll();
            this._startTimer();
        }

        _onSettingsChanged(key) {
            if (key === 'refresh-interval') {
                this._restartTimer();
            } else if (key === 'display-mode') {
                this._updateDisplayMode();
            } else if (key === 'show-icon') {
                this._updateIconVisibility();
            } else if (key === 'icon-style') {
                this._updateIconStyle();
            } else if (key === 'proxy-url') {
                this._recreateSources();
            } else if (key === 'usage-display') {
                this._renderMenu();
                this._renderPanel();
            } else if (key === 'show-additional-limits') {
                this._renderMenu();
            } else if (key === 'panel-window') {
                this._renderPanel();
            } else if (key === 'panel-provider') {
                this._rebuildProviderSubmenu();
                this._renderMenu();
                this._renderPanel();
                this._updateFooterTime();
            } else if (key.startsWith('provider-')) {
                this._coordinator?.setEnabled(this._enabledProviderIds());
                this._rebuildProviderSubmenu();
                this._renderMenu();
                this._renderPanel();
                this._updateFooterTime();
            } else if (key.startsWith('mistral-')) {
                this._coordinator?.refreshProvider('mistral');
            }
        }

        _enabledProviderIds() {
            const enabled = [];
            for (const provider of PROVIDERS) {
                let on = true;
                try {
                    on = this._settings.get_boolean(`provider-${provider.id}-enabled`);
                } catch (e) {
                    on = true;
                }
                if (on)
                    enabled.push(provider.id);
            }
            return enabled;
        }

        _favoriteProviderId() {
            let favorite = 'codex';
            try {
                favorite = this._settings.get_string('panel-provider');
            } catch (e) {
                favorite = 'codex';
            }
            const enabled = this._enabledProviderIds();
            if (!enabled.includes(favorite))
                favorite = enabled[0] ?? null;
            return favorite;
        }

        _onScroll(_actor, event) {
            const enabled = this._enabledProviderIds();
            if (enabled.length < 2)
                return Clutter.EVENT_PROPAGATE;

            let steps = 0;
            const direction = event.get_scroll_direction();
            if (direction === Clutter.ScrollDirection.UP) {
                steps = -1;
            } else if (direction === Clutter.ScrollDirection.DOWN) {
                steps = 1;
            } else if (direction === Clutter.ScrollDirection.SMOOTH) {
                const [, dy] = event.get_scroll_delta();
                this._scrollAccum += dy;
                if (Math.abs(this._scrollAccum) < 1)
                    return Clutter.EVENT_STOP;
                steps = this._scrollAccum > 0 ? 1 : -1;
                this._scrollAccum = 0;
            }

            if (steps === 0)
                return Clutter.EVENT_STOP;

            const nowMs = Math.floor(GLib.get_monotonic_time() / 1000);
            if (nowMs - this._lastScrollMs < 150)
                return Clutter.EVENT_STOP;
            this._lastScrollMs = nowMs;

            const favorite = this._favoriteProviderId();
            const index = enabled.indexOf(favorite);
            const current = index >= 0 ? index : 0;
            const next = (current + steps + enabled.length) % enabled.length;
            this._settings.set_string('panel-provider', enabled[next]);
            return Clutter.EVENT_STOP;
        }

        _updateDisplayMode() {
            const mode = this._settings.get_string('display-mode');
            this._ring.visible = mode === 'ring';
            this._panelBar.root.visible = mode === 'bar' || mode === 'both';
            this._label.visible = mode === 'text' || mode === 'both' || mode === 'ring';
        }

        _updateIconVisibility() {
            this._icon.visible =
                this._settings.get_boolean('show-icon') && this._icon.gicon !== null;
        }

        _updateIconStyle() {
            const style = this._settings.get_string('icon-style');
            const desatName = 'monochrome-desaturate';
            const brightName = 'monochrome-brightness';
            const hasEffect = this._icon.get_effect(desatName) !== null;

            if (style === 'monochrome' && !hasEffect) {
                this._icon.add_effect(new Clutter.DesaturateEffect({factor: 1.0, name: desatName}));
                const brightnessEffect = new Clutter.BrightnessContrastEffect({name: brightName});
                brightnessEffect.set_brightness_full(1, 1, 1);
                this._icon.add_effect(brightnessEffect);
            } else if (style !== 'monochrome' && hasEffect) {
                this._icon.remove_effect_by_name(desatName);
                this._icon.remove_effect_by_name(brightName);
            }
        }

        _createMenu() {
            this._providerSubmenu = new PopupMenu.PopupSubMenuMenuItem('Provider');
            this.menu.addMenuItem(this._providerSubmenu);

            const item = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
            });
            const root = new St.BoxLayout({
                vertical: true,
                style_class: 'codex-popup',
            });
            item.add_child(root);
            this.menu.addMenuItem(item);

            const header = new St.BoxLayout({style_class: 'codex-header'});
            const who = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._title = new St.Label({
                text: 'Codex Usage',
                style_class: 'codex-title',
            });
            this._subtitle = new St.Label({
                text: 'AI subscription usage',
                style_class: 'codex-subtitle',
            });
            who.add_child(this._title);
            who.add_child(this._subtitle);
            header.add_child(who);
            root.add_child(header);

            root.add_child(new St.Label({
                text: 'USAGE LIMITS',
                style_class: 'codex-section-label',
            }));
            this._limitsBox = new St.BoxLayout({vertical: true});
            root.add_child(this._limitsBox);

            this._resetsSection = new St.BoxLayout({vertical: true});
            this._resetsSection.add_child(new St.Label({
                text: 'PENDING RESETS',
                style_class: 'codex-section-label',
            }));
            this._resetList = new St.BoxLayout({
                vertical: true,
                style_class: 'codex-reset-list',
            });
            this._resetsSection.add_child(this._resetList);
            root.add_child(this._resetsSection);

            this._error = wrapLabel(new St.Label({
                text: '',
                style_class: 'codex-error',
            }));
            this._error.visible = false;
            root.add_child(this._error);

            this._advice = wrapLabel(new St.Label({
                text: '',
                style_class: 'codex-advice',
            }));
            this._advice.visible = false;
            root.add_child(this._advice);

            const actions = new St.BoxLayout({style_class: 'codex-actions'});
            this._actions = actions;

            this._usageButton = new St.Button({
                label: 'Usage page',
                style_class: 'codex-button codex-button-primary',
                x_expand: true,
                can_focus: true,
                reactive: true,
                track_hover: true,
            });
            this._usageButton.connect('clicked', () => {
                const url = PROVIDER_USAGE_URLS[this._favoriteProviderId()];
                if (url) {
                    this.menu.close();
                    Gio.AppInfo.launch_default_for_uri(url, null);
                }
            });
            actions.add_child(this._usageButton);
            root.add_child(actions);

            const footer = new St.BoxLayout({style_class: 'codex-footer'});
            this._lastUpdatedLabel = new St.Label({
                text: 'Loading...',
                style_class: 'codex-updated',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            footer.add_child(this._lastUpdatedLabel);

            const settingsButton = new St.Button({
                label: 'Settings',
                style_class: 'codex-footer-button',
                can_focus: true,
                reactive: true,
                track_hover: true,
            });
            settingsButton.connect('clicked', () => {
                this.menu.close();
                this._openPreferences();
            });
            footer.add_child(settingsButton);

            const refreshButton = new St.Button({
                label: 'Refresh',
                style_class: 'codex-footer-button',
                can_focus: true,
                reactive: true,
                track_hover: true,
            });
            refreshButton.connect('clicked', () => this._refreshAll());
            footer.add_child(refreshButton);
            root.add_child(footer);
        }

        _rebuildProviderSubmenu() {
            const submenu = this._providerSubmenu;
            if (!submenu)
                return;
            submenu.menu.removeAll();

            const favorite = this._favoriteProviderId();
            for (const id of this._enabledProviderIds()) {
                const meta = PROVIDER_BY_ID.get(id);
                const menuItem = new PopupMenu.PopupMenuItem(meta?.label ?? id);
                menuItem.setOrnament(
                    id === favorite ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
                menuItem.connect('activate', () => {
                    this._settings.set_string('panel-provider', id);
                });
                submenu.menu.addMenuItem(menuItem);
            }

            const favoriteLabel = favorite
                ? (PROVIDER_BY_ID.get(favorite)?.label ?? 'AI')
                : 'AI';
            if (submenu.label)
                submenu.label.text = `Provider: ${favoriteLabel}`;
        }

        _renderMenu() {
            const favorite = this._favoriteProviderId();
            const snap = favorite ? this._snapshots.get(favorite) : null;
            const meta = PROVIDER_BY_ID.get(favorite) ?? {label: 'AI'};

            this._title.text = `${meta.label} Usage`;
            this._subtitle.text = 'AI subscription usage';
            this._usageButton.visible = !!PROVIDER_USAGE_URLS[favorite];
            this._actions.visible = this._usageButton.visible;

            const isCodex = favorite === 'codex';
            this._resetsSection.visible = isCodex;

            this._limitsBox.destroy_all_children();
            this._error.visible = false;
            this._advice.visible = false;

            if (!snap || snap.status === STATUS.LOADING) {
                this._limitsBox.add_child(new St.Label({
                    text: 'loading...',
                    style_class: 'codex-caption',
                }));
                if (isCodex)
                    this._setResetListEmpty('...');
                return;
            }

            if (snap.status !== STATUS.OK) {
                this._error.text = snap.error?.message ?? 'No data';
                this._error.visible = true;
                if (snap.error?.advice) {
                    this._advice.text = snap.error.advice;
                    this._advice.visible = true;
                }
                if (isCodex)
                    this._setResetListEmpty('-');
                return;
            }

            for (const win of snap.windows) {
                const meter = new Meter(win.name);
                this._applyWindow(meter, win);
                this._limitsBox.add_child(meter.root);
            }

            if (isCodex) {
                this._renderAdditional(snap);
                this._updateResetSummary(snap);
            }

            if (snap.capturedAt) {
                const parsed = GLib.DateTime.new_from_iso8601(snap.capturedAt, null);
                const local = parsed?.to_local();
                if (local) {
                    this._limitsBox.add_child(new St.Label({
                        text: `Updated ${local.format('%Y-%m-%d %H:%M')}`,
                        style_class: 'codex-updated',
                    }));
                }
            }
        }

        _renderAdditional(snap) {
            if (!this._settings.get_boolean('show-additional-limits'))
                return;

            const limits = snap.extras?.additional ?? [];
            for (const limit of limits) {
                this._limitsBox.add_child(new St.Label({
                    text: limit.name,
                    style_class: 'codex-section-label',
                }));
                const fiveHour = new Meter('5-hour window');
                const weekly = new Meter('7-day window');
                this._applyWindow(fiveHour, limit.primary);
                this._applyWindow(weekly, limit.secondary);
                this._limitsBox.add_child(fiveHour.root);
                this._limitsBox.add_child(weekly.root);
            }
        }

        _applyWindow(meter, win) {
            if (!win) {
                meter.setMuted();
                return;
            }

            if (win.unlimited) {
                meter.setMuted('unlimited');
                return;
            }

            if (win.usedPercent === null || win.usedPercent === undefined) {
                meter.setMuted('unknown');
                return;
            }

            const util = usedPercent(win.usedPercent);
            const display = displayPercent(util, this._usageDisplayMode());
            const displaySuffix = this._usageDisplayMode() === 'remaining' ? 'remaining' : 'used';
            const caption = win.resetsAt ? relativeReset(win.resetsAt)
                : (util > 0 ? '' : 'not used yet');

            const reqs = win.requests;
            const showRequests = win.unit !== 'currency' && reqs && reqs.entitlement > 0;

            if (win.unit === 'currency' && win.totalAmount > 0) {
                meter.setAmount(`\u20AC${(win.usedAmount ?? 0).toFixed(2)} / \u20AC${win.totalAmount.toFixed(2)}`,
                    util, util, caption);
            } else if (showRequests) {
                meter.setAmount(`${reqs.used ?? 0} / ${reqs.entitlement} requests`,
                    util, util, caption);
            } else {
                meter.setValue(util, caption, util, display, displaySuffix);
            }
        }

        _addResetRow(name, value) {
            const row = new St.BoxLayout({style_class: 'codex-reset-row'});
            row.add_child(new St.Label({
                text: name,
                style_class: 'codex-reset-name',
                x_expand: true,
            }));
            row.add_child(new St.Label({
                text: value,
                style_class: 'codex-reset-time',
            }));
            this._resetList.add_child(row);
        }

        _updateResetSummary(snap) {
            const resetCredits = snap.extras?.resetCredits ?? 0;
            if (!resetCredits) {
                this._setResetListEmpty('none banked');
                return;
            }

            this._resetList.destroy_all_children();
            const details = snap.extras?.resetCreditDetails ?? [];
            if (details.length === 0) {
                this._addResetRow('banked resets', `${resetCredits} available`);
                return;
            }

            for (const credit of details)
                this._addResetRow(credit.title, expiresIn(credit.expiresAt));
        }

        _setResetListEmpty(text) {
            this._resetList.destroy_all_children();
            this._resetList.add_child(new St.Label({
                text,
                style_class: 'codex-reset-empty',
            }));
        }

        _providerIconGicon(favorite) {
            if (favorite && !this._iconGiconByProvider.has(favorite)) {
                for (const ext of ['svg', 'png']) {
                    const path = GLib.build_filenamev(
                        [this._extensionPath, 'icons', `${favorite}.${ext}`]);
                    try {
                        if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
                            this._iconGiconByProvider.set(
                                favorite, Gio.icon_new_for_string(path));
                            break;
                        }
                    } catch (e) {
                        // no icon for this provider - stay without an icon
                    }
                }
            }
            return favorite
                ? (this._iconGiconByProvider.get(favorite) ?? null)
                : null;
        }

        _renderPanel() {
            this._updateDisplayMode();
            const favorite = this._favoriteProviderId();
            const snap = favorite ? this._snapshots.get(favorite) : null;

            this._icon.gicon = this._providerIconGicon(favorite);
            this._updateIconVisibility();

            if (!snap || snap.status === STATUS.LOADING) {
                this._label.text = '...';
                this._label.style_class = 'codex-panel-pct';
                this._ring.setUnknown();
                this._panelBar.setUnknown();
                return;
            }

            if (snap.status !== STATUS.OK) {
                this._label.text = snap.status === STATUS.ERROR ? '!' : '-';
                this._label.style_class = 'codex-panel-pct';
                this._ring.setUnknown();
                this._panelBar.setUnknown();
                return;
            }

            const win = selectPanelWindow(snap.windows, this._settings.get_string('panel-window'));
            if (!win || win.unlimited || win.usedPercent === null || win.usedPercent === undefined) {
                this._label.text = '-';
                this._label.style_class = 'codex-panel-pct';
                this._ring.setUnknown();
                this._panelBar.setUnknown();
                return;
            }

            const util = usedPercent(win.usedPercent);
            const display = displayPercent(util, this._usageDisplayMode());
            this._label.text = `${Math.round(display)}%`;
            this._label.style_class = 'codex-panel-pct';
            this._ring.setValue(util);
            this._panelBar.setValue(util);
        }

        _updateFooterTime() {
            const favorite = this._favoriteProviderId();
            const checked = favorite ? this._checkedAt.get(favorite) : null;
            if (!checked) {
                this._lastUpdatedLabel.text = 'Loading...';
                return;
            }
            this._lastUpdatedLabel.text =
                `${checked.success ? 'Updated' : 'Checked'} ${checked.time.format('%H:%M:%S')}`;
        }

        _onSnapshot(id, snap) {
            this._snapshots.set(id, snap);
            this._checkedAt.set(id, {
                time: GLib.DateTime.new_now_local(),
                success: snap.status === STATUS.OK,
            });
            if (id === this._favoriteProviderId()) {
                this._renderMenu();
                this._renderPanel();
                this._updateFooterTime();
            }
            this._scheduleCountdown();
        }

        _createSources() {
            const proxyUrl = this._settings.get_string('proxy-url').trim();
            this._sources = {
                codex: new CodexSource({proxyUrl}),
                antigravity: new AgySource(),
                copilot: new CopilotSource({proxyUrl}),
                mistral: new MistralSource({settings: this._settings, extensionPath: this._extensionPath}),
            };

            this._coordinator = new ProviderCoordinator({
                sources: PROVIDERS.map(provider => ({
                    id: provider.id,
                    source: this._sources[provider.id],
                })),
                onUpdate: (id, snap) => this._onSnapshot(id, snap),
            });
        }

        _destroySources() {
            this._coordinator?.destroy();
            this._coordinator = null;
            for (const source of Object.values(this._sources ?? {}))
                source?.destroy?.();
            this._sources = null;
        }

        _recreateSources() {
            this._destroySources();
            this._createSources();
            this._restartTimer();
            this._refreshAll();
        }

        _refreshAll() {
            this._coordinator?.refreshAll();
        }

        _startTimer() {
            const interval = this._settings.get_int('refresh-interval');
            this._timerId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                interval,
                () => {
                    this._refreshAll();
                    return GLib.SOURCE_CONTINUE;
                }
            );
        }

        _stopTimer() {
            if (this._timerId) {
                GLib.source_remove(this._timerId);
                this._timerId = null;
            }
        }

        _restartTimer() {
            this._stopTimer();
            this._startTimer();
        }

        _scheduleCountdown() {
            if (this._countdownTimer) {
                GLib.source_remove(this._countdownTimer);
                this._countdownTimer = null;
            }

            const soonest = this._soonestResetSeconds();
            if (soonest === null)
                return;

            const interval = soonest < 90 ? 1 : 30;
            this._countdownTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
                this._countdownTimer = null;
                this._renderMenu();
                this._renderPanel();
                this._scheduleCountdown();
                return GLib.SOURCE_REMOVE;
            });
        }

        _soonestResetSeconds() {
            let soonest = null;
            for (const snap of this._snapshots.values()) {
                if (snap.status !== STATUS.OK)
                    continue;
                for (const win of snap.windows) {
                    if (!win?.resetsAt)
                        continue;
                    const target = Date.parse(win.resetsAt);
                    if (Number.isNaN(target))
                        continue;
                    const seconds = (target - Date.now()) / 1000;
                    if (seconds > 0 && (soonest === null || seconds < soonest))
                        soonest = seconds;
                }
            }
            return soonest;
        }

        _usageDisplayMode() {
            return this._settings.get_string('usage-display');
        }

        destroy() {
            this._stopTimer();
            if (this._countdownTimer) {
                GLib.source_remove(this._countdownTimer);
                this._countdownTimer = null;
            }
            this.menu.disconnectObject(this);
            this._destroySources();
            if (this._settingsChangedId) {
                this._settings.disconnect(this._settingsChangedId);
                this._settingsChangedId = null;
            }
            super.destroy();
        }
    }
);

export default class CodexUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new UsageIndicator(
            this.path,
            this._settings,
            () => this.openPreferences()
        );
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
