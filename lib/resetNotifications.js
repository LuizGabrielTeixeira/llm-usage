/*
 * Desktop notifications for subscription quota resets (PC only).
 *
 * Self-contained by design: the whole feature is this module plus two
 * hook points in extension.js (construct + _onSnapshot), so it can be
 * reverted in a single git commit (user request 2026-10-27: "de maneira
 * que a gnt consiga voltar, sempre com track no git").
 *
 * Detection is poll-based: every snapshot refresh compares the stored
 * last-known reset instant per target with the freshly reported one.
 *   - instant crossed while running      -> notify ("durante a utilização")
 *   - instant moved on while the stored one already passed -> the reset
 *     happened while the extension was not refreshing (PC off / logged
 *     out) -> notify ("quando ligar")
 *   - first time a target is ever seen   -> baseline only, no notification
 *     (avoids replaying old resets on first enable)
 */

import GLib from 'gi://GLib';

import {STATUS} from './contract.js';

// Cadence filter: weekly windows (~6-8 days) and windows with an exact
// reset instant but unknown length (monthly pools, Copilot). 5-hour
// windows are deliberately ignored - only the weekly/monthly reset
// matters (user request 2026-10-27).
const WEEKLY_MIN_SECONDS = 6 * 24 * 3600;
const WEEKLY_MAX_SECONDS = 8 * 24 * 3600;

// Antigravity model families come from the agy CLI as scope names.
// Claude and GPT quotas belong to the same subscription here, so they
// merge into one notification target (user: "3 notificações - Gemini,
// Argon, Claude/GPT"). Unmapped scopes pass through unchanged, so new
// model families just work.
const SCOPE_ALIASES = [
    [/^claude/i, 'Claude/GPT models'],
    [/^gpt/i, 'Claude/GPT models'],
];

export function scopeGroup(providerId, scope) {
    if (scope === null || scope === undefined || scope === '')
        return null;
    if (providerId === 'antigravity') {
        for (const [pattern, alias] of SCOPE_ALIASES) {
            if (pattern.test(scope))
                return alias;
        }
    }
    return String(scope);
}

function isMonitoredWindow(win) {
    if (!win || typeof win.resetsAt !== 'string' || !win.resetsAt)
        return false;
    const period = win.periodSeconds;
    if (period === null || period === undefined)
        return true; // unknown length but exact instant (monthly/Copilot)
    return period >= WEEKLY_MIN_SECONDS && period <= WEEKLY_MAX_SECONDS;
}

// Merge the monitored windows of one snapshot into notification targets:
// windows sharing (provider, scope-group) collapse into a single target,
// so Codex weekly windows, Antigravity families and Mistral's two pools
// each produce exactly one notification per reset instant.
export function targetsFromSnapshot(providerId, snap) {
    const targets = [];
    if (!snap || snap.status !== STATUS.OK)
        return targets;
    const byKey = new Map();
    for (const win of snap.windows ?? []) {
        if (!isMonitoredWindow(win))
            continue;
        const resetsAtMs = Date.parse(win.resetsAt);
        if (!Number.isFinite(resetsAtMs))
            continue;
        const group = scopeGroup(providerId, win.scope);
        const key = `${providerId}::${group ?? ''}`;
        let target = byKey.get(key);
        if (!target) {
            target = {key, providerId, group, resetsAtMs, names: []};
            byKey.set(key, target);
            targets.push(target);
        }
        if (resetsAtMs < target.resetsAtMs)
            target.resetsAtMs = resetsAtMs; // earliest instant crosses first
        if (!target.names.includes(win.name))
            target.names.push(win.name);
    }
    return targets;
}

// Pure transition logic. `state` maps target key -> {resetsAt, notified}
// (instants as epoch ms) and is mutated in place; returns the events to
// raise. `nowMs` is injected so tests are deterministic.
export function computeResetEvents(state, targets, nowMs) {
    const events = [];
    for (const target of targets) {
        const stored = state[target.key];
        if (!stored) {
            // First ever sighting: baseline only, never notify.
            state[target.key] = {
                resetsAt: target.resetsAtMs,
                notified: target.resetsAtMs <= nowMs,
            };
            continue;
        }
        if (stored.resetsAt === target.resetsAtMs) {
            if (!stored.notified && nowMs >= target.resetsAtMs) {
                // Reset crossed since the last poll -> notify now.
                state[target.key] = {resetsAt: target.resetsAtMs, notified: true};
                events.push({...target, missed: false});
            }
            continue;
        }
        // Provider moved to a different instant than the stored one.
        const movedLater = target.resetsAtMs > stored.resetsAt;
        const storedCrossed = nowMs >= stored.resetsAt;
        if (movedLater && storedCrossed && !stored.notified) {
            // The stored instant passed while the extension was not
            // refreshing (PC off) -> missed reset, catch up on wake.
            state[target.key] = {
                resetsAt: target.resetsAtMs,
                notified: target.resetsAtMs <= nowMs,
            };
            events.push({...target, missed: true, resetsAtMs: stored.resetsAt});
            continue;
        }
        // Instant moved without a crossed-and-unnotified stored one
        // (provider correction, or already notified) -> just track.
        state[target.key] = {
            resetsAt: target.resetsAtMs,
            notified: target.resetsAtMs <= nowMs,
        };
    }
    return events;
}

function formatInstant(ms) {
    const dt = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    return dt ? dt.format('%d %b %H:%M') : '';
}

// Thin shell around the pure logic: owns the persisted state map, the
// settings gate and the actual desktop notification.
export class ResetNotifier {
    constructor({settings, notify, providerLabels}) {
        this._settings = settings;
        this._notify = notify;
        this._labels = providerLabels ?? {};
        this._state = this._loadState();
    }

    _loadState() {
        try {
            const raw = this._settings.get_string('reset-notification-state');
            const parsed = raw ? JSON.parse(raw) : {};
            return typeof parsed === 'object' && parsed !== null ? parsed : {};
        } catch (e) {
            return {};
        }
    }

    _persist() {
        this._settings.set_string('reset-notification-state',
            JSON.stringify(this._state));
    }

    // Hook point for extension.js: called with every provider snapshot.
    // State is tracked even while notifications are disabled, so turning
    // the feature back on never replays a backlog.
    note(providerId, snap) {
        const targets = targetsFromSnapshot(providerId, snap);
        if (targets.length === 0)
            return;
        const enabled = this._settings.get_boolean('notify-on-reset');
        const before = JSON.stringify(this._state);
        const events = computeResetEvents(this._state, targets, Date.now());
        if (JSON.stringify(this._state) === before)
            return;
        this._persist();
        if (!enabled)
            return;
        for (const event of events)
            this._emit(event);
    }

    _emit(event) {
        const label = this._labels[event.providerId] ?? event.providerId;
        const who = event.group ? `${label} · ${event.group}` : label;
        const what = event.names.length > 0 ? event.names.join(', ') : 'quota';
        const when = formatInstant(event.resetsAtMs);
        const title = event.missed
            ? `${who} quota reset (missed)`
            : `${who} quota reset`;
        const body = event.missed
            ? `${what} — reset on ${when}, while the extension was not running. Counters are back to full.`
            : `${what} — counters back to full (${when}).`;
        this._notify(title, body);
    }
}
