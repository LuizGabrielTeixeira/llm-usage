/*
 * Which Claude source may run, given the two opt-in settings.
 * Pure (no GNOME/GI imports) so it can be unit-tested with plain node or gjs.
 */
export function claudeRoute({oauthEnabled, firefoxEnabled}) {
    if (oauthEnabled)
        return 'oauth';
    return firefoxEnabled ? 'firefox' : 'off';
}
