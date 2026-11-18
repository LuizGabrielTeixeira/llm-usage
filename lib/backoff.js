/*
 * Polling back-off after HTTP 429. Pure (no GNOME/GI imports) so it can be
 * unit-tested with plain node or gjs.
 */
export const MAX_BACKOFF_SECONDS = 30 * 60;
export const MAX_RETRY_AFTER_SECONDS = 60 * 60;

export function isRateLimited(snapshot) {
    return /\b429\b/.test(snapshot?.error?.message ?? '');
}

/**
 * Delay before a provider's next timer refresh.
 * Rate limited: double the current delay (capped at 30 minutes, never below
 * the configured interval), or the server's Retry-After (snapshot.retryAfterSeconds,
 * capped at 1 hour) if that is longer. Success: back to the configured interval.
 * Any other outcome (e.g. a network error): keep the current delay.
 */
export function nextDelaySeconds(baseSeconds, currentSeconds, snapshot) {
    if (isRateLimited(snapshot)) {
        const cap = Math.max(baseSeconds, MAX_BACKOFF_SECONDS);
        const doubled = Math.min(Math.max(currentSeconds, baseSeconds) * 2, cap);
        const retryAfter = Number.isFinite(snapshot.retryAfterSeconds)
            ? Math.min(Math.max(snapshot.retryAfterSeconds, 0), MAX_RETRY_AFTER_SECONDS) : 0;
        return Math.max(doubled, retryAfter);
    }
    if (snapshot?.status === 'ok')
        return baseSeconds;
    return Math.max(currentSeconds, baseSeconds);
}
