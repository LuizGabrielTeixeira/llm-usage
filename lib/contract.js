/*
 * Pure data contract shared by every provider source and the UI.
 * No GNOME/GI imports in this file so it can be unit-tested with plain `gjs -m`
 * and reused outside the Shell process (tools/validate-sources.js).
 */

export const FIVE_HOUR_SECONDS = 5 * 3600;
export const SEVEN_DAY_SECONDS = 7 * 24 * 3600;

export const STATUS = Object.freeze({
    LOADING: 'loading',
    OK: 'ok',
    ERROR: 'error',
    UNAVAILABLE: 'unavailable',
    BLOCKED: 'blocked',
});

/* ------------------------------------------------------------------ */
/* pure display helpers                                                */
/* ------------------------------------------------------------------ */

export function severity(util) {
    if (util >= 90)
        return 'usage-critical';
    if (util >= 75)
        return 'usage-high';
    return 'usage-low';
}

export function colorRgb(c) {
    const scale = Math.max(c.red, c.green, c.blue) > 1 ? 255 : 1;
    return [c.red / scale, c.green / scale, c.blue / scale];
}

export function humanDuration(seconds, sep = ' ') {
    const s = Math.max(0, Math.floor(seconds));
    if (s < 60)
        return `${s}s`;
    const mins = Math.round(s / 60);
    if (mins < 60)
        return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)
        return `${hrs}h${sep}${mins % 60}m`;
    const days = Math.floor(hrs / 24);
    return `${days}d${sep}${hrs % 24}h`;
}

export function relativeReset(iso) {
    const target = Date.parse(iso ?? '');
    if (Number.isNaN(target))
        return '';
    const diff = target - Date.now();
    if (diff <= 0)
        return 'resetting...';
    return `resets in ${humanDuration(diff / 1000)}`;
}

export function expiresIn(iso) {
    const target = Date.parse(iso ?? '');
    if (Number.isNaN(target))
        return '';
    const diff = target - Date.now();
    if (diff <= 0)
        return 'expired';
    return `expires in ${humanDuration(diff / 1000)}`;
}

export function coercePercent(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function usedPercent(value) {
    return Math.min(100, Math.max(0, coercePercent(value)));
}

export function displayPercent(used, usageDisplayMode) {
    const normalized = usedPercent(used);
    return usageDisplayMode === 'remaining' ? 100 - normalized : normalized;
}

/* ------------------------------------------------------------------ */
/* snapshot model                                                      */
/* ------------------------------------------------------------------ */

export function makeError(message, advice = null) {
    return {message, advice};
}

export function snapshot(providerId, status, {
    capturedAt = null,
    windows = [],
    error = null,
    extras = null,
} = {}) {
    return {providerId, status, capturedAt, windows, error, extras};
}

export function errorSnapshot(providerId, status, message, advice = null) {
    return snapshot(providerId, status, {
        capturedAt: new Date().toISOString(),
        error: makeError(message, advice),
    });
}

/**
 * Accepts ISO strings, epoch seconds or epoch milliseconds; anything else
 * (including 0, null, '') maps to null. Used for reset dates where a 0
 * means "not reported" (GitHub Copilot quota_reset_at behaves this way).
 */
export function parseMaybeDate(value) {
    if (typeof value === 'string' && value) {
        const target = Date.parse(value);
        if (!Number.isNaN(target))
            return new Date(target).toISOString();
        return null;
    }
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        const target = value < 1e12 ? value * 1000 : value;
        return new Date(target).toISOString();
    }
    return null;
}

/**
 * Picks the window reflected by the panel. Codex keeps its historical
 * semantics: windows[0] is the 5-hour window, windows[1] the 7-day one,
 * 'max' picks the most used window, 'largest'
 * picks the window with the biggest allowance (totalAmount, e.g. the
 * EUR pools) so the panel tracks the pool the user actually lives off,
 * regardless of which pool has the higher percentage that day. Fallbacks
 * prefer the first displayable window - one with a finite percentage
 * that is not unlimited (Copilot's first window is an unlimited "Chat"
 * pool, which would render the panel as '-').
 */
export function selectPanelWindow(windows, mode) {
    if (!Array.isArray(windows) || windows.length === 0)
        return null;

    const displayable = windows.filter(win => win && !win.unlimited &&
        typeof win.usedPercent === 'number' && Number.isFinite(win.usedPercent));
    const fallback = displayable.length > 0 ? displayable[0] : windows[0];

    if (mode === 'largest') {
        let best = null;
        let bestAmount = 0;
        for (const win of windows) {
            const amount = Number(win?.totalAmount);
            if (Number.isFinite(amount) && amount > bestAmount) {
                bestAmount = amount;
                best = win;
            }
        }
        return best ?? fallback;
    }

    if (mode === 'max') {
        let best = null;
        let bestUsed = -1;
        for (const win of displayable) {
            const used = usedPercent(win.usedPercent);
            if (used > bestUsed) {
                bestUsed = used;
                best = win;
            }
        }
        return best ?? fallback;
    }

    if (mode === 'secondary' && windows.length > 1)
        return windows[1];

    return windows[0];
}

/* ------------------------------------------------------------------ */
/* provider normalizers (throw on unusable payloads)                   */
/* ------------------------------------------------------------------ */

function codexWindow(win, id, name, periodSeconds) {
    return {
        id,
        name,
        unit: 'percent',
        periodSeconds,
        usedPercent: usedPercent(win?.used_percent),
        unlimited: false,
        resetsAt: win?.reset_at
            ? new Date(win.reset_at * 1000).toISOString()
            : null,
        scope: null,
        requests: null,
        note: null,
    };
}

export function normalizeCodex(data) {
    const rl = data?.rate_limit;
    if (!rl)
        throw new Error('codex: missing rate_limit');

    const additional = (data.additional_rate_limits ?? [])
        .filter(entry => entry?.rate_limit)
        .map(entry => ({
            name: `${entry.limit_name ?? 'additional'}`.toUpperCase(),
            primary: codexWindow(entry.rate_limit.primary_window, 'primary', '5-Hour', FIVE_HOUR_SECONDS),
            secondary: codexWindow(entry.rate_limit.secondary_window, 'secondary', 'Weekly', SEVEN_DAY_SECONDS),
        }));

    return snapshot('codex', STATUS.OK, {
        capturedAt: new Date().toISOString(),
        windows: [
            codexWindow(rl.primary_window, 'primary', '5-Hour', FIVE_HOUR_SECONDS),
            codexWindow(rl.secondary_window, 'secondary', 'Weekly', SEVEN_DAY_SECONDS),
        ],
        extras: {
            additional,
            resetCredits: data.rate_limit_reset_credits?.available_count ?? 0,
            resetCreditDetails: [],
        },
    });
}

const AGY_WINDOW_SECONDS = {
    weekly: SEVEN_DAY_SECONDS,
    '5h': FIVE_HOUR_SECONDS,
};

function agyWindowLabel(windowKind) {
    if (windowKind === '5h')
        return '5-hour';
    if (windowKind === 'weekly')
        return 'weekly';
    return windowKind ?? 'limit';
}

export function normalizeAgy(data) {
    const groups = data?.command?.data?.groups;
    if (!Array.isArray(groups))
        throw new Error('antigravity: missing usage groups');

    const windows = [];
    for (const group of groups) {
        const scope = typeof group?.name === 'string' && group.name ? group.name : null;
        for (const bucket of group?.buckets ?? []) {
            const windowKind = typeof bucket?.window === 'string' ? bucket.window : null;
            const periodSeconds = AGY_WINDOW_SECONDS[windowKind] ?? null;
            const remainingFraction = typeof bucket?.remaining_fraction === 'number' &&
                Number.isFinite(bucket.remaining_fraction)
                ? bucket.remaining_fraction
                : null;
            const usedPercentValue = remainingFraction === null
                ? null
                : usedPercent((1 - remainingFraction) * 100);
            windows.push({
                id: `${scope ?? 'group'}:${bucket?.id ?? windows.length}`,
                name: `${scope ?? 'Quota'} — ${agyWindowLabel(windowKind)}`,
                unit: 'percent',
                periodSeconds,
                usedPercent: usedPercentValue,
                unlimited: false,
                resetsAt: typeof bucket?.reset_time === 'string' && bucket.reset_time
                    ? bucket.reset_time
                    : null,
                scope,
                requests: null,
                note: typeof bucket?.description === 'string' && bucket.description
                    ? bucket.description
                    : null,
            });
        }
    }

    if (windows.length === 0)
        throw new Error('antigravity: no quota buckets');

    return snapshot('antigravity', STATUS.OK, {
        capturedAt: new Date().toISOString(),
        windows,
    });
}

function prettifyKey(key) {
    return `${key}`.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function normalizeCopilot(data) {
    const snaps = data?.quota_snapshots;
    if (!snaps || typeof snaps !== 'object' || Array.isArray(snaps))
        throw new Error('copilot: missing quota_snapshots');

    const windows = [];
    let capturedAt = null;
    for (const [key, snap] of Object.entries(snaps)) {
        if (snap?.has_quota === false)
            continue;

        const unlimited = snap?.unlimited === true;
        const remainingPct = typeof snap?.percent_remaining === 'number' &&
            Number.isFinite(snap.percent_remaining)
            ? snap.percent_remaining
            : null;
        const usedPercentValue = unlimited || remainingPct === null
            ? null
            : usedPercent(100 - remainingPct);

        const resetIso = parseMaybeDate(snap?.quota_reset_at) ??
            parseMaybeDate(data?.quota_reset_date_utc) ??
            parseMaybeDate(data?.quota_reset_date);

        if (typeof snap?.timestamp_utc === 'string' && snap.timestamp_utc && !capturedAt)
            capturedAt = snap.timestamp_utc;

        const entitlement = typeof snap?.entitlement === 'number' ? snap.entitlement : null;
        windows.push({
            id: key,
            name: prettifyKey(key),
            unit: 'percent',
            periodSeconds: null, // the endpoint does not report window length
            usedPercent: usedPercentValue,
            unlimited,
            resetsAt: resetIso,
            scope: null,
            requests: entitlement !== null && entitlement > 0
                ? {
                    entitlement,
                    remaining: typeof snap?.remaining === 'number' ? snap.remaining : null,
                    used: typeof snap?.credits_used === 'number' ? snap.credits_used : null,
                }
                : null,
            note: null,
        });
    }

    if (windows.length === 0)
        throw new Error('copilot: no quota snapshots');

    return snapshot('copilot', STATUS.OK, {
        capturedAt: capturedAt ?? new Date().toISOString(),
        windows,
    });
}

/*
 * Monthly reset: Mistral allowances reset on the first day of each calendar
 * month, independently of the subscription renewal (validated against the
 * Mistral usage console: "Resets in 6 days" on 2026-10-26 -> Nov 1st).
 */
export function monthlyResetIso(now = new Date()) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
        .toISOString();
}

/*
 * Shared builder for the two monthly EUR pools. A pool is skipped when its
 * total is not a usable positive number (a missing pool stays absent — the
 * two pools are never summed or invented).
 */
function _mistralAmountSnapshot({
    apiUsed = null, apiTotal = null,
    vibeUsed = null, vibeTotal = null,
    capturedAt = null,
}, extras) {
    const windows = [];
    const addWindow = (id, name, used, total) => {
        const totalAmount = Number.isFinite(total) ? total : null;
        if (totalAmount === null || totalAmount <= 0)
            return;
        const usedAmount = Number.isFinite(used) ? Math.max(0, used) : 0;
        windows.push({
            id,
            name,
            unit: 'currency',
            currency: 'EUR',
            periodSeconds: null, // a month is not a fixed duration; resetsAt is exact
            periodKind: 'monthly',
            usedAmount,
            totalAmount,
            usedPercent: usedPercent((usedAmount / totalAmount) * 100),
            unlimited: false,
            resetsAt: monthlyResetIso(),
            scope: null,
            requests: null,
            note: null,
        });
    };
    addWindow('api', 'API / Studio', apiUsed, apiTotal);
    addWindow('vibe', 'Vibe Code', vibeUsed, vibeTotal);

    if (windows.length === 0)
        return null;

    return snapshot('mistral', STATUS.OK, {
        capturedAt: parseMaybeDate(capturedAt) ?? new Date().toISOString(),
        windows,
        extras,
    });
}

/**
 * Firefox-session Mistral snapshot: monthly EUR allowances parsed from the
 * server-rendered admin.mistral.ai/subscription page via
 * tools/mistral_web.py (opt-in; the session cookie is used in memory only
 * and never stored). Amount fields may be null when the console page only
 * shows one pool — the missing pool simply stays absent.
 */
export function buildMistralWebSnapshot({
    apiUsed = null, apiTotal = null,
    vibeUsed = null, vibeTotal = null,
    capturedAt = null,
} = {}) {
    return _mistralAmountSnapshot(
        {apiUsed, apiTotal, vibeUsed, vibeTotal, capturedAt},
        {source: 'firefox-web'});
}
