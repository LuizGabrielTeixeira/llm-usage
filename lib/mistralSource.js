/*
 * Mistral Pro Student source.
 *
 * The official Admin API is Enterprise-only (user-validated against the
 * official docs), so three honest paths exist:
 *
 *  1. Firefox session fetch (opt-in via 'mistral-firefox-enabled',
 *     default off): spawns tools/mistral_web.py with python3. That
 *     helper reads the admin.mistral.ai session cookie (ory_session_*)
 *     from the local Firefox profile - IN MEMORY ONLY, never stored,
 *     logged or written to GSettings - and fetches the server-rendered
 *     /subscription page, parsing the two monthly EUR allowance blocks.
 *     The helper prints one sanitized JSON line; cookie values never
 *     cross the process boundary.
 *  2. Manual monthly entry (default off): user-entered amounts only.
 *  3. Blocked state with an honest explanation.
 *
 * Firefox fetch and manual entry are independent modes (no silent
 * fallback): the enabled mode's state is always reported as-is.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {
    STATUS,
    buildMistralManualSnapshot,
    buildMistralWebSnapshot,
    errorSnapshot,
} from './contract.js';

const MAX_OUTPUT_BYTES = 256 * 1024;

const OFF_MESSAGE = 'Automatic usage is off';
const OFF_ADVICE = 'Turn on "Fetch from Firefox session" in the extension Settings (requires being signed in to admin.mistral.ai in Firefox), or enter the monthly amounts manually there.';

export class MistralSource {
    constructor({settings = null, extensionPath = null} = {}) {
        this._settings = settings;
        this._extensionPath = extensionPath;
    }

    refresh(onSnapshot, cancellable = null) {
        if (this._firefoxEnabled()) {
            this._fetchFirefox(onSnapshot, cancellable);
            return;
        }

        if (this._manualEnabled()) {
            const snap = buildMistralManualSnapshot({
                apiUsed: this._settings.get_double('mistral-api-used'),
                apiTotal: this._settings.get_double('mistral-api-total'),
                vibeUsed: this._settings.get_double('mistral-vibe-used'),
                vibeTotal: this._settings.get_double('mistral-vibe-total'),
                updatedAt: this._settings.get_string('mistral-manual-updated-at'),
            });
            if (snap) {
                onSnapshot(snap);
                return;
            }
        }

        onSnapshot(errorSnapshot('mistral', STATUS.BLOCKED, OFF_MESSAGE, OFF_ADVICE));
    }

    _fetchFirefox(onSnapshot, cancellable) {
        const python = GLib.find_program_in_path('python3');
        if (!python) {
            onSnapshot(errorSnapshot('mistral', STATUS.UNAVAILABLE,
                'python3 not found',
                'Install python3, or turn off "Fetch from Firefox session" and use the manual monthly entry.'));
            return;
        }

        const script = this._extensionPath
            ? GLib.build_filenamev([this._extensionPath, 'tools', 'mistral_web.py'])
            : null;
        if (!script || !GLib.file_test(script, GLib.FileTest.EXISTS)) {
            onSnapshot(errorSnapshot('mistral', STATUS.UNAVAILABLE,
                'mistral_web.py not found',
                'Reinstall the extension (tools/mistral_web.py is missing), or turn off "Fetch from Firefox session" and use the manual monthly entry.'));
            return;
        }

        try {
            const launcher = Gio.SubprocessLauncher.new(
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            const proc = launcher.spawnv([python, script]);
            this._runFetch(proc, onSnapshot, cancellable);
        } catch (e) {
            onSnapshot(errorSnapshot('mistral', STATUS.ERROR,
                'Mistral fetch failed to start',
                'The python3 helper could not be launched. Try refreshing later, or use the manual monthly entry.'));
        }
    }

    _runFetch(proc, onSnapshot, cancellable) {
        const cancelId = cancellable instanceof Gio.Cancellable
            ? cancellable.connect(() => {
                cancellable.disconnect(cancelId);
                try {
                    proc.force_exit();
                } catch (e) {
                    // process already gone
                }
            })
            : 0;

        proc.communicate_utf8_async(null, null, (p, result) => {
            if (cancelId)
                cancellable.disconnect(cancelId);

            let stdoutText = '';
            try {
                [, stdoutText] = p.communicate_utf8_finish(result);
            } catch (e) {
                onSnapshot(errorSnapshot('mistral', STATUS.ERROR,
                    cancellable?.is_cancelled?.() ? 'Cancelled' : 'Mistral fetch failed',
                    'The Firefox session fetch did not complete. Try refreshing later, or use the manual monthly entry.'));
                return;
            }

            stdoutText = stdoutText ?? '';
            if (stdoutText.length > MAX_OUTPUT_BYTES) {
                onSnapshot(errorSnapshot('mistral', STATUS.ERROR, 'Mistral fetch output too large'));
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
            onSnapshot(errorSnapshot('mistral', STATUS.ERROR,
                'Mistral fetch failed',
                'The python3 helper produced no usable output. Try refreshing later, or use the manual monthly entry.'));
            return;
        }

        const SIGN_IN_ADVICE = 'Open https://admin.mistral.ai in Firefox and sign in - this provider reads that browser session (the cookie is used in memory only and never stored).';

        switch (data.status) {
        case 'ok': {
            const snap = buildMistralWebSnapshot({
                apiUsed: data.api_used,
                apiTotal: data.api_total,
                vibeUsed: data.vibe_used,
                vibeTotal: data.vibe_total,
                capturedAt: data.captured_at,
            });
            if (snap) {
                onSnapshot(snap);
                return;
            }
            onSnapshot(errorSnapshot('mistral', STATUS.ERROR,
                'Mistral console amounts unusable',
                'No allowance amounts could be read from the console page. Try refreshing later, or use the manual monthly entry.'));
            return;
        }
        case 'no-cookie':
        case 'signin':
            onSnapshot(errorSnapshot('mistral', STATUS.UNAVAILABLE,
                'Sign in to admin.mistral.ai in Firefox', SIGN_IN_ADVICE));
            return;
        case 'parse-error':
            onSnapshot(errorSnapshot('mistral', STATUS.ERROR,
                'Mistral console page changed',
                'The console page could not be parsed (layout change?). Turn off "Fetch from Firefox session" and use the manual monthly entry meanwhile.'));
            return;
        default:
            onSnapshot(errorSnapshot('mistral', STATUS.ERROR,
                `Mistral fetch failed${data.reason ? ` (${data.reason})` : ''}`,
                'Try refreshing later, or use the manual monthly entry.'));
        }
    }

    _firefoxEnabled() {
        try {
            return this._settings?.get_boolean('mistral-firefox-enabled') ?? false;
        } catch (e) {
            return false;
        }
    }

    _manualEnabled() {
        try {
            return this._settings?.get_boolean('mistral-manual-enabled') ?? false;
        } catch (e) {
            return false;
        }
    }

    destroy() {
    }
}
