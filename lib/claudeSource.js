/*
 * Claude usage source.
 *
 * Supports two read-only sources without storing any secrets:
 *  1. Opt-in Claude Code CLI OAuth credentials (via 'claude-oauth-enabled',
 *     default false): $CLAUDE_CONFIG_DIR/.credentials.json or
 *     ~/.claude/.credentials.json -> claudeAiOauth.accessToken, against
 *     https://api.anthropic.com/api/oauth/usage.
 *  2. Opt-in Firefox claude.ai web session (via 'claude-firefox-enabled',
 *     default false): spawns tools/claude_web.py with python3, reading
 *     claude.ai session cookies in memory only and querying
 *     https://claude.ai/api/organizations/{id}/usage.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import {
    STATUS,
    errorSnapshot,
    normalizeClaude,
} from './contract.js';
import {claudeRoute} from './claudeGate.js';
import {USER_AGENT} from './identity.js';

const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// Required by the oauth/usage endpoint.
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const HTTP_TIMEOUT_SECONDS = 30;
const MAX_OUTPUT_BYTES = 256 * 1024;
const EXPIRY_GRACE_MS = 60 * 1000;

export class ClaudeSource {
    constructor({proxyUrl = '', settings = null, extensionPath = null} = {}) {
        this._proxyUrl = `${proxyUrl ?? ''}`.trim();
        this._session = this._createSession(this._proxyUrl);
        this._settings = settings;
        this._extensionPath = extensionPath;
    }

    _createSession(proxyUrl) {
        const session = new Soup.Session({timeout: HTTP_TIMEOUT_SECONDS});
        if (proxyUrl !== '')
            session.set_proxy_resolver(Gio.SimpleProxyResolver.new(proxyUrl, null));
        return session;
    }

    destroy() {
        this._session?.abort();
        this._session = null;
    }

    refresh(onSnapshot, cancellable = null) {
        const route = claudeRoute({
            oauthEnabled: this._oauthEnabled(),
            firefoxEnabled: this._firefoxEnabled(),
        });
        if (route === 'firefox') {
            this._fetchFirefox(onSnapshot, cancellable);
            return;
        }
        if (route === 'off') {
            onSnapshot(errorSnapshot('claude', STATUS.UNAVAILABLE,
                'Claude is turned off',
                'Turn on "Read Claude Code login" in Settings (reads the token in ~/.claude/.credentials.json), or "Fetch from Firefox session".'));
            return;
        }

        const configDir = GLib.getenv('CLAUDE_CONFIG_DIR') ??
            GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
        const credentialsPath = GLib.build_filenamev([configDir, '.credentials.json']);

        const file = Gio.File.new_for_path(credentialsPath);
        file.load_contents_async(cancellable, (f, result) => {
            if (cancellable?.is_cancelled?.()) {
                onSnapshot(errorSnapshot('claude', STATUS.ERROR, 'Cancelled'));
                return;
            }

            let accessToken = null;
            let expiresAt = null;
            try {
                const [, contents] = f.load_contents_finish(result);
                const auth = JSON.parse(new TextDecoder().decode(contents));
                const oauth = auth?.claudeAiOauth;
                accessToken = oauth?.accessToken ?? null;
                expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : null;
            } catch (e) {
                accessToken = null;
            }

            if (!accessToken) {
                this._fallbackOrUnavailable(
                    onSnapshot,
                    cancellable,
                    'Not signed in',
                    'Sign in with Claude Code (`claude auth login`), or turn on "Fetch from Firefox session" in Settings for claude.ai.'
                );
                return;
            }

            if (expiresAt !== null && expiresAt > 0 && expiresAt < Date.now() - EXPIRY_GRACE_MS) {
                this._fallbackOrUnavailable(
                    onSnapshot,
                    cancellable,
                    'OAuth token expired',
                    'Run `claude auth login` in a terminal, or turn on "Fetch from Firefox session" in Settings.'
                );
                return;
            }

            this._fetchOAuth(accessToken, onSnapshot, cancellable);
        });
    }

    _fallbackOrUnavailable(onSnapshot, cancellable, message, advice) {
        if (this._firefoxEnabled()) {
            this._fetchFirefox(onSnapshot, cancellable);
            return;
        }
        onSnapshot(errorSnapshot('claude', STATUS.UNAVAILABLE, message, advice));
    }

    _fetchOAuth(accessToken, onSnapshot, cancellable) {
        const message = Soup.Message.new('GET', OAUTH_USAGE_URL);
        message.request_headers.append('Authorization', `Bearer ${accessToken}`);
        message.request_headers.append('anthropic-beta', OAUTH_BETA_HEADER);
        message.request_headers.append('Accept', 'application/json');
        message.request_headers.append('User-Agent', USER_AGENT);

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    const status = message.status_code;

                    if (status === 401 || status === 403) {
                        this._fallbackOrUnavailable(
                            onSnapshot,
                            cancellable,
                            'Login required',
                            'Run `claude auth login` in a terminal, or turn on "Fetch from Firefox session" in Settings.'
                        );
                        return;
                    }

                    if (status === 429) {
                        if (this._firefoxEnabled()) {
                            this._fetchFirefox(onSnapshot, cancellable);
                            return;
                        }
                        onSnapshot(errorSnapshot('claude', STATUS.ERROR,
                            'Rate limited (HTTP 429)',
                            'Anthropic throttled usage polling — try increasing the refresh interval.'));
                        return;
                    }

                    if (status !== 200) {
                        onSnapshot(errorSnapshot('claude', STATUS.ERROR, `HTTP ${status}`));
                        return;
                    }

                    const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    try {
                        onSnapshot(normalizeClaude(data));
                    } catch (e) {
                        onSnapshot(errorSnapshot('claude', STATUS.UNAVAILABLE,
                            'No quota windows reported',
                            'Your Claude account has no metered usage windows reported yet.'));
                    }
                } catch (e) {
                    console.error('LLM Usage: Claude OAuth request failed:', e.message);
                    onSnapshot(errorSnapshot('claude', STATUS.ERROR,
                        cancellable?.is_cancelled?.() ? 'Cancelled' : 'API failed'));
                }
            }
        );
    }

    _fetchFirefox(onSnapshot, cancellable) {
        const python = GLib.find_program_in_path('python3');
        if (!python) {
            onSnapshot(errorSnapshot('claude', STATUS.UNAVAILABLE,
                'python3 not found',
                'Install python3, or sign in with Claude Code (`claude auth login`).'));
            return;
        }

        const script = this._extensionPath
            ? GLib.build_filenamev([this._extensionPath, 'tools', 'claude_web.py'])
            : null;
        if (!script || !GLib.file_test(script, GLib.FileTest.EXISTS)) {
            onSnapshot(errorSnapshot('claude', STATUS.UNAVAILABLE,
                'claude_web.py not found',
                'Reinstall the extension (tools/claude_web.py is missing), or turn off "Fetch from Firefox session".'));
            return;
        }

        try {
            const launcher = Gio.SubprocessLauncher.new(
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            if (this._proxyUrl !== '') {
                for (const key of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY'])
                    launcher.setenv(key, this._proxyUrl, true);
            }
            const proc = launcher.spawnv([python, script]);
            this._runFetch(proc, onSnapshot, cancellable);
        } catch (e) {
            onSnapshot(errorSnapshot('claude', STATUS.ERROR,
                'Claude fetch failed to start',
                'The python3 helper could not be launched. Try refreshing later.'));
        }
    }

    _runFetch(proc, onSnapshot, cancellable) {
        let cancelId = 0;
        const disconnectCancel = () => {
            if (cancelId && cancellable) {
                const id = cancelId;
                cancelId = 0;
                cancellable.disconnect(id);
            }
        };

        if (cancellable instanceof Gio.Cancellable) {
            cancelId = cancellable.connect(() => {
                disconnectCancel();
                try {
                    proc.force_exit();
                } catch (e) {
                    // process already gone
                }
            });
        }

        proc.communicate_utf8_async(null, null, (p, result) => {
            disconnectCancel();

            let stdoutText = '';
            try {
                [, stdoutText] = p.communicate_utf8_finish(result);
            } catch (e) {
                onSnapshot(errorSnapshot('claude', STATUS.ERROR,
                    cancellable?.is_cancelled?.() ? 'Cancelled' : 'Claude fetch failed',
                    'The Firefox session fetch did not complete. Try refreshing later.'));
                return;
            }

            stdoutText = stdoutText ?? '';
            if (stdoutText.length > MAX_OUTPUT_BYTES) {
                onSnapshot(errorSnapshot('claude', STATUS.ERROR, 'Claude fetch output too large'));
                return;
            }

            this._consumeOutput(stdoutText, onSnapshot);
        });
    }

    _consumeOutput(stdoutText, onSnapshot) {
        let data = null;
        try {
            const firstLine = stdoutText.trim().split('\n')[0] || '';
            data = JSON.parse(firstLine);
        } catch (e) {
            data = null;
        }

        if (!data || typeof data !== 'object') {
            onSnapshot(errorSnapshot('claude', STATUS.ERROR,
                'Claude fetch failed',
                'The python3 helper produced no usable output. Try refreshing later.'));
            return;
        }

        const SIGN_IN_ADVICE = 'Open https://claude.ai in Firefox and sign in - this option reads that browser session (cookies are used in memory only and never stored).';

        switch (data.status) {
        case 'ok':
            try {
                onSnapshot(normalizeClaude(data.usage, data.captured_at));
                return;
            } catch (e) {
                onSnapshot(errorSnapshot('claude', STATUS.UNAVAILABLE,
                    'No quota windows reported',
                    'Your Claude account has no metered usage windows reported yet.'));
                return;
            }
        case 'no-cookie':
        case 'signin':
            onSnapshot(errorSnapshot('claude', STATUS.UNAVAILABLE,
                'Sign in to claude.ai in Firefox', SIGN_IN_ADVICE));
            return;
        case 'cloudflare':
            onSnapshot(errorSnapshot('claude', STATUS.UNAVAILABLE,
                'Cloudflare check required',
                'Open https://claude.ai in Firefox to refresh your browser session, then refresh here.'));
            return;
        case 'rate-limited':
            onSnapshot(errorSnapshot('claude', STATUS.ERROR,
                'Rate limited (HTTP 429)',
                'Claude throttled usage polling — try increasing the refresh interval.'));
            return;
        case 'no-usage':
            onSnapshot(errorSnapshot('claude', STATUS.UNAVAILABLE,
                'No quota windows reported',
                'Your Claude account has no metered usage windows (Claude Pro, Max, or Team required, or send a message first).'));
            return;
        case 'parse-error':
            onSnapshot(errorSnapshot('claude', STATUS.ERROR,
                'Claude usage response changed',
                'The claude.ai usage response could not be parsed. Try refreshing later.'));
            return;
        default:
            onSnapshot(errorSnapshot('claude', STATUS.ERROR,
                `Claude fetch failed${data.reason ? ` (${data.reason})` : ''}`,
                'Try refreshing later.'));
        }
    }

    _oauthEnabled() {
        try {
            return this._settings?.get_boolean('claude-oauth-enabled') ?? false;
        } catch (e) {
            return false;
        }
    }

    _firefoxEnabled() {
        try {
            return this._settings?.get_boolean('claude-firefox-enabled') ?? false;
        } catch (e) {
            return false;
        }
    }
}
