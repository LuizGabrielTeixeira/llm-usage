/*
 * Validates the real provider pipelines outside GNOME Shell:
 *   gjs -m tools/validate-sources.js
 *
 * Goes through ProviderCoordinator - the exact path extension.js uses -
 * so coordinator bugs are exercised too (direct source.refresh calls once
 * missed a `new GLib.Cancellable()` crash that only the coordinator path
 * triggered).
 *
 * Safe by design: read-only HTTP requests with existing local sessions,
 * bounded subprocesses, no GNOME session interaction, and sanitized
 * output (status/percentages/dates only - never tokens, cookies or ids).
 */
import GLib from 'gi://GLib';
import System from 'system';

import {ProviderCoordinator} from '../lib/coordinator.js';
import {CodexSource} from '../lib/codexSource.js';
import {AgySource} from '../lib/agySource.js';
import {CopilotSource} from '../lib/copilotSource.js';
import {MistralSource} from '../lib/mistralSource.js';

function describeSnapshot(snap) {
    const lines = [`  status: ${snap.status}`];
    if (snap.error)
        lines.push(`  error: ${snap.error.message}`);
    for (const win of snap.windows ?? []) {
        const parts = [`    ${win.name}`];
        if (win.unlimited)
            parts.push('unlimited');
        else if (win.usedPercent === null || win.usedPercent === undefined)
            parts.push('unknown');
        else
            parts.push(`${win.usedPercent.toFixed(1)}% used`);
        if (win.unit === 'currency' && win.totalAmount > 0)
            parts.push(`EUR ${(win.usedAmount ?? 0).toFixed(2)} / ${win.totalAmount.toFixed(2)}`);
        if (win.requests?.entitlement > 0)
            parts.push(`${win.requests.used}/${win.requests.entitlement} requests`);
        if (win.resetsAt)
            parts.push(`resets ${win.resetsAt}`);
        lines.push(parts.join(' | '));
    }
    return lines.join('\n');
}

const loop = new GLib.MainLoop(null, false);

const settingsStub = {
    get_boolean(key) {
        return key === 'mistral-firefox-enabled';
    },
    get_double(_key) {
        return 0;
    },
    get_string(_key) {
        return '';
    },
};

const sources = [
    {id: 'codex', source: new CodexSource({proxyUrl: ''})},
    {id: 'antigravity', source: new AgySource()},
    {id: 'copilot', source: new CopilotSource({proxyUrl: ''})},
    {id: 'mistral', source: new MistralSource({settings: settingsStub, extensionPath: '.'})},
];

const pending = new Set(sources.map(({id}) => id));

const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 120, () => {
    console.error('validate-sources: timed out after 120s (pending: ' +
                  [...pending].join(', ') + ')');
    loop.quit();
    return GLib.SOURCE_REMOVE;
});

const coordinator = new ProviderCoordinator({
    sources,
    onUpdate: (id, snap) => {
        console.log(`${id}:`);
        console.log(describeSnapshot(snap));
        pending.delete(id);
        if (pending.size === 0) {
            GLib.source_remove(timeoutId);
            loop.quit();
        }
    },
});

coordinator.refreshAll();
loop.run();

coordinator.destroy();
for (const {source} of sources)
    source?.destroy?.();

System.exit(pending.size > 0 ? 1 : 0);
