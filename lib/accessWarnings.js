/*
 * Options that make the extension read a login token or browser cookie, per
 * provider. The menu shows one warning row (with a Turn off button) for each
 * of these that is currently on. Pure (no GNOME/GI imports) so it can be
 * unit-tested with plain node or gjs.
 */
const SENSITIVE_OPTIONS = {
    claude: [
        {key: 'claude-oauth-enabled', text: 'Reading your Claude Code login'},
        {key: 'claude-firefox-enabled', text: 'Reading your claude.ai Firefox cookie'},
    ],
    mistral: [
        {key: 'mistral-firefox-enabled', text: 'Reading your Mistral Firefox cookie'},
    ],
};

export function activeAccessWarnings(providerId, getBoolean) {
    return (SENSITIVE_OPTIONS[providerId] ?? []).filter(option => getBoolean(option.key));
}
