/*
 * Polling back-off after HTTP 429. Pure (no GNOME/GI imports) so it can be
 * unit-tested with plain node or gjs.
 */
export const MAX_BACKOFF_SECONDS = 30 * 60;

export function isRateLimited(snapshot) {
    return /\b429\b/.test(snapshot?.error?.message ?? '');
}

/**
 * Delay before a provider's next timer refresh.
 * Rate limited: double the current delay (capped at 30 minutes, never below
 * the configured interval). Success: back to the configured interval.
 * Any other outcome (e.g. a network error): keep the current delay.
 */
export function nextDelaySeconds(baseSeconds, currentSeconds, snapshot) {
    if (isRateLimited(snapshot)) {
        const cap = Math.max(baseSeconds, MAX_BACKOFF_SECONDS);
        return Math.min(Math.max(currentSeconds, baseSeconds) * 2, cap);
    }
    if (snapshot?.status === 'ok')
        return baseSeconds;
    return Math.max(currentSeconds, baseSeconds);
}
