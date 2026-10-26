/*
 * GitHub Copilot quota source.
 *
 * Uses the internal (undocumented) endpoint GET /copilot_internal/user with
 * the editor headers CodexBar sends. Authentication is borrowed from the
 * GitHub CLI at runtime (`gh auth token`); tokens are never stored in
 * GSettings, never logged and never leave this process.
 *
 * Endpoint facts (validated 2026-10-26, HTTP 200 with a gh token):
 *   - quota_snapshots keyed by runtime string (premium_interactions, chat,
 *     completions, ...). Keys are dynamic; lookups are guarded.
 *   - per snapshot: percent_remaining (remaining, NOT used), unlimited,
 *     has_quota, entitlement, remaining, credits_used, quota_reset_at
 *     (0 = not reported), timestamp_utc.
 *   - no window length is reported; reset dates are usually absent.
 *   - credit pools may be duplicated across snapshot keys: never summed.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import {
    STATUS,
    errorSnapshot,
    normalizeCopilot,
} from './contract.js';

const COPILOT_USER_URL = 'https://api.github.com/copilot_internal/user';
const HTTP_TIMEOUT_SECONDS = 30;

export class CopilotSource {
    constructor({proxyUrl = ''} = {}) {
        this._session = this._createSession(proxyUrl);
    }

    _createSession(proxyUrl) {
        const session = new Soup.Session({timeout: HTTP_TIMEOUT_SECONDS});
        const trimmed = `${proxyUrl ?? ''}`.trim();
        if (trimmed !== '')
            session.set_proxy_resolver(Gio.SimpleProxyResolver.new(trimmed, null));
        return session;
    }

    destroy() {
        this._session?.abort();
        this._session = null;
    }

    refresh(onSnapshot, cancellable = null) {
        const ghPath = GLib.find_program_in_path('gh');
        if (!ghPath) {
            onSnapshot(errorSnapshot('copilot', STATUS.UNAVAILABLE, 'gh not found',
                'Install the GitHub CLI (gh) and sign in with a Copilot-enabled account'));
            return;
        }

        let subprocess;
        try {
            subprocess = Gio.Subprocess.new(
                [ghPath, 'auth', 'token'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            onSnapshot(errorSnapshot('copilot', STATUS.UNAVAILABLE, 'gh not found',
                'Install the GitHub CLI (gh) and sign in with a Copilot-enabled account'));
            return;
        }

        const cancelId = cancellable
            ? cancellable.connect(() => subprocess.force_exit())
            : 0;

        subprocess.communicate_utf8_async(null, null, (proc, result) => {
            if (cancelId)
                cancellable.disconnect(cancelId);

            let token = '';
            try {
                [, token] = proc.communicate_utf8_finish(result);
            } catch (e) {
                token = '';
            }
            token = `${token ?? ''}`.trim();

            if (!token || !proc.get_successful()) {
                onSnapshot(errorSnapshot('copilot', STATUS.UNAVAILABLE, 'gh not logged in',
                    'Run `gh auth login` with a Copilot-enabled account'));
                return;
            }

            this._fetchQuota(token, onSnapshot, cancellable);
        });
    }

    _fetchQuota(token, onSnapshot, cancellable) {
        const message = Soup.Message.new('GET', COPILOT_USER_URL);
        message.request_headers.append('Authorization', `token ${token}`);
        message.request_headers.append('Accept', 'application/json');
        message.request_headers.append('Editor-Version', 'vscode/1.96.2');
        message.request_headers.append('Editor-Plugin-Version', 'copilot-chat/0.26.7');
        message.request_headers.append('User-Agent', 'GitHubCopilotChat/0.26.7');
        message.request_headers.append('X-Github-Api-Version', '2025-04-01');

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    const status = message.status_code;

                    if (status === 401 || status === 403 || status === 404) {
                        onSnapshot(errorSnapshot('copilot', STATUS.ERROR,
                            `no Copilot access via gh (HTTP ${status})`,
                            'The internal Copilot endpoint rejected this token'));
                        return;
                    }
                    if (status !== 200) {
                        onSnapshot(errorSnapshot('copilot', STATUS.ERROR, `HTTP ${status}`));
                        return;
                    }

                    const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    try {
                        onSnapshot(normalizeCopilot(data));
                    } catch (e) {
                        onSnapshot(errorSnapshot('copilot', STATUS.UNAVAILABLE, 'No data'));
                    }
                } catch (e) {
                    console.error('Codex Usage: Copilot request failed:', e.message);
                    onSnapshot(errorSnapshot('copilot', STATUS.ERROR,
                        cancellable?.is_cancelled() ? 'Cancelled' : 'API failed'));
                }
            }
        );
    }
}
