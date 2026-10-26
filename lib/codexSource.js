/*
 * Codex (ChatGPT backend) usage source. Preserves the historical behaviour of
 * the extension: reads the local codex CLI auth file, calls the usage
 * endpoint, then best-effort the reset credits endpoint.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import {
    STATUS,
    errorSnapshot,
    normalizeCodex,
} from './contract.js';

const USAGE_API_URL = 'https://chatgpt.com/backend-api/wham/usage';
const RESET_CREDITS_API_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const HTTP_TIMEOUT_SECONDS = 30;

export class CodexSource {
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
        const codexHome = GLib.getenv('CODEX_HOME') ??
            GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
        const authPath = GLib.build_filenamev([codexHome, 'auth.json']);

        const file = Gio.File.new_for_path(authPath);
        file.load_contents_async(cancellable, (f, result) => {
            let accessToken = null;
            let accountId = null;
            try {
                const [, contents] = f.load_contents_finish(result);
                const auth = JSON.parse(new TextDecoder().decode(contents));
                const tokens = auth.tokens ?? auth;
                accessToken = tokens.access_token ?? null;
                accountId = tokens.account_id ?? null;
            } catch (e) {
                console.error('Codex Usage: Failed to read auth:', e.message);
                onSnapshot(errorSnapshot('codex', STATUS.UNAVAILABLE, 'No auth',
                    'Sign in with the Codex CLI (codex login)'));
                return;
            }

            if (!accessToken) {
                onSnapshot(errorSnapshot('codex', STATUS.UNAVAILABLE, 'Login required',
                    'Sign in with the Codex CLI (codex login)'));
                return;
            }

            this._fetchUsage(accessToken, accountId, onSnapshot, cancellable);
        });
    }

    _newApiMessage(url, accessToken, accountId) {
        const message = Soup.Message.new('GET', url);
        message.request_headers.append('Authorization', `Bearer ${accessToken}`);
        message.request_headers.append('User-Agent', 'codex-cli');
        if (accountId)
            message.request_headers.append('ChatGPT-Account-Id', accountId);
        return message;
    }

    _fetchUsage(accessToken, accountId, onSnapshot, cancellable) {
        const message = this._newApiMessage(USAGE_API_URL, accessToken, accountId);

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);

                    if (message.status_code !== 200) {
                        onSnapshot(errorSnapshot('codex', STATUS.ERROR, `HTTP ${message.status_code}`));
                        return;
                    }

                    const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));

                    let snap;
                    try {
                        snap = normalizeCodex(data);
                    } catch (e) {
                        onSnapshot(errorSnapshot('codex', STATUS.UNAVAILABLE, 'No data'));
                        return;
                    }
                    this._fetchResetCredits(accessToken, accountId, snap, onSnapshot, cancellable);
                } catch (e) {
                    console.error('Codex Usage: API request failed:', e.message);
                    onSnapshot(errorSnapshot('codex', STATUS.ERROR,
                        cancellable?.is_cancelled() ? 'Cancelled' : 'API failed'));
                }
            }
        );
    }

    _fetchResetCredits(accessToken, accountId, snap, onSnapshot, cancellable) {
        const message = this._newApiMessage(RESET_CREDITS_API_URL, accessToken, accountId);

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    if (message.status_code === 200) {
                        const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                        snap.extras.resetCreditDetails = (data.credits ?? [])
                            .filter(credit => credit?.status === 'available')
                            .map(credit => ({
                                title: credit.title || 'Full reset',
                                expiresAt: credit.expires_at ?? null,
                            }));
                    }
                } catch (e) {
                    console.error('Codex Usage: Reset credits request failed:', e.message);
                }
                onSnapshot(snap);
            }
        );
    }
}
