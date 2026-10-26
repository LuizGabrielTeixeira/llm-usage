/*
 * Antigravity (agy) usage source.
 *
 * Uses the community-reported print mode:
 *   agy -p /usage --output-format json --print-timeout <n>s
 * Probing hardening mirrors what CodexBar does:
 *   - AGY_CLI_DISABLE_AUTO_UPDATE=true (literal 'true'; '1' is ignored)
 *   - bounded run (--print-timeout plus the coordinator's cancellable)
 *   - private temp cwd, output cap, never sends a model prompt
 *   - sign-in failures surface a clear actionable message
 * The local HTTPS server path is a dead end on agy >= 1.2.2 (needs an
 * unobtainable CSRF token), so print mode is the only viable path.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {
    STATUS,
    errorSnapshot,
    normalizeAgy,
} from './contract.js';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const PRINT_TIMEOUT_SECONDS = 60;
const SIGN_IN_RE = /not signed in|sign[ -]?in|log[ -]?in|authenticat/i;

export class AgySource {
    refresh(onSnapshot, cancellable = null) {
        const agyPath = GLib.find_program_in_path('agy');
        if (!agyPath) {
            onSnapshot(errorSnapshot('antigravity', STATUS.UNAVAILABLE, 'agy not found',
                'Install the Antigravity CLI (agy) and sign in once in a terminal'));
            return;
        }

        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        launcher.set_cwd(this._workdir());
        launcher.setenv('AGY_CLI_DISABLE_AUTO_UPDATE', 'true', true);

        let subprocess;
        try {
            subprocess = launcher.spawnv([
                agyPath, '-p', '/usage', '--output-format', 'json',
                `--print-timeout`, `${PRINT_TIMEOUT_SECONDS}s`,
            ]);
        } catch (e) {
            onSnapshot(errorSnapshot('antigravity', STATUS.ERROR, 'agy failed to start'));
            return;
        }

        const cancelId = cancellable
            ? cancellable.connect(() => subprocess.force_exit())
            : 0;

        subprocess.communicate_utf8_async(null, null, (proc, result) => {
            if (cancelId)
                cancellable.disconnect(cancelId);

            let stdoutText = '';
            let stderrText = '';
            try {
                [, stdoutText, stderrText] = proc.communicate_utf8_finish(result);
            } catch (e) {
                onSnapshot(errorSnapshot('antigravity', STATUS.ERROR, 'agy failed',
                    'Try running `agy -p /usage --output-format json` in a terminal'));
                return;
            }

            stdoutText = stdoutText ?? '';
            stderrText = stderrText ?? '';

            if (stdoutText.length > MAX_OUTPUT_BYTES) {
                onSnapshot(errorSnapshot('antigravity', STATUS.ERROR, 'agy output too large'));
                return;
            }

            let data = null;
            try {
                data = JSON.parse(stdoutText);
            } catch (e) {
                data = null;
            }

            if (data && Array.isArray(data?.command?.data?.groups)) {
                try {
                    onSnapshot(normalizeAgy(data));
                } catch (e) {
                    onSnapshot(errorSnapshot('antigravity', STATUS.UNAVAILABLE, 'No usage data'));
                }
                return;
            }

            const hintSource = `${data?.response ?? ''}\n${stderrText}`;
            if (SIGN_IN_RE.test(hintSource)) {
                onSnapshot(errorSnapshot('antigravity', STATUS.UNAVAILABLE, 'Sign-in required',
                    'Run `agy` in a terminal and sign in'));
                return;
            }

            const detail = `${data?.status ?? ''} ${data?.response ?? ''}`.trim();
            onSnapshot(errorSnapshot('antigravity', STATUS.ERROR,
                detail ? `agy: ${detail.slice(0, 120)}` : 'Usage report unavailable',
                'The usage report needs agy >= 1.1.11 (community-reported boundary)'));
        });
    }

    _workdir() {
        if (this._workdirPath)
            return this._workdirPath;
        try {
            this._workdirPath = GLib.dir_make_tmp('codex-usage-agy-XXXXXX');
        } catch (e) {
            this._workdirPath = GLib.get_tmp_dir();
        }
        return this._workdirPath;
    }

    destroy() {
    }
}
