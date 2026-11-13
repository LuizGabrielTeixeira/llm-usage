/*
 * ClaudeSource integration tests against temp credentials and fixture JSON,
 * run with: gjs -m tests/js/claude-source.js
 */
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

import {ClaudeSource} from '../../lib/claudeSource.js';
import {STATUS} from '../../lib/contract.js';

let passed = 0;
let failed = 0;

function check(name, cond) {
    if (cond) {
        passed++;
    } else {
        failed++;
        printerr(`FAIL: ${name}\n`);
    }
}

function makeSettingsStub({firefoxEnabled = false} = {}) {
    return {
        get_boolean(key) {
            if (key === 'claude-firefox-enabled')
                return firefoxEnabled;
            return false;
        },
    };
}

function runRefresh(source, cancellable = null) {
    const loop = GLib.MainLoop.new(null, false);
    let snapshot = null;
    let done = false;
    let timedOut = false;

    const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
        timedOut = true;
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });

    source.refresh(snap => {
        snapshot = snap;
        done = true;
        if (loop.is_running())
            loop.quit();
    }, cancellable);

    if (!done)
        loop.run();

    if (!timedOut)
        GLib.source_remove(timeoutId);
    if (timedOut)
        throw new Error('ClaudeSource.refresh timed out');
    return snapshot;
}

function removeTree(path) {
    const dir = Gio.File.new_for_path(path);
    if (!dir.query_exists(null))
        return;
    const enumerator = dir.enumerate_children(
        'standard::name,standard::type',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        null
    );
    let info;
    while ((info = enumerator.next_file(null)) !== null) {
        const childPath = GLib.build_filenamev([path, info.get_name()]);
        if (info.get_file_type() === Gio.FileType.DIRECTORY)
            removeTree(childPath);
        else
            Gio.File.new_for_path(childPath).delete(null);
    }
    dir.delete(null);
}

const repoRoot = Gio.File.new_for_uri(import.meta.url)
    .get_parent().get_parent().get_parent().get_path();
const tmpDir = GLib.dir_make_tmp('llm-usage-claude-source-XXXXXX');
const origConfigDir = GLib.getenv('CLAUDE_CONFIG_DIR');
const origFixture = GLib.getenv('LLM_USAGE_CLAUDE_FIXTURE_JSON');

try {
    GLib.setenv('CLAUDE_CONFIG_DIR', tmpDir, true);
    GLib.unsetenv('LLM_USAGE_CLAUDE_FIXTURE_JSON');

    // 1. Unauthenticated + Firefox disabled -> UNAVAILABLE ('Not signed in')
    {
        const source = new ClaudeSource({
            settings: makeSettingsStub({firefoxEnabled: false}),
            extensionPath: repoRoot,
        });
        const snap = runRefresh(source);
        source.destroy();
        check('unauthenticated returns unavailable Not signed in',
            snap?.providerId === 'claude' &&
            snap.status === STATUS.UNAVAILABLE &&
            snap.error?.message === 'Not signed in' &&
            snap.windows.length === 0);
    }

    // 2. Expired OAuth + Firefox disabled -> UNAVAILABLE ('OAuth token expired')
    const credsPath = GLib.build_filenamev([tmpDir, '.credentials.json']);
    GLib.file_set_contents(credsPath, JSON.stringify({
        claudeAiOauth: {
            accessToken: 'sk-ant-test-expired',
            expiresAt: 1000,
        },
    }));
    {
        const source = new ClaudeSource({
            settings: makeSettingsStub({firefoxEnabled: false}),
            extensionPath: repoRoot,
        });
        const snap = runRefresh(source);
        source.destroy();
        check('expired oauth returns unavailable OAuth token expired',
            snap?.providerId === 'claude' &&
            snap.status === STATUS.UNAVAILABLE &&
            snap.error?.message === 'OAuth token expired');
    }

    // 3. Expired OAuth + Firefox enabled + valid fixture -> falls back to Firefox helper and returns OK
    const validFixturePath = GLib.build_filenamev([tmpDir, 'valid-usage.json']);
    GLib.file_set_contents(validFixturePath, JSON.stringify({
        five_hour: {utilization: 24, resets_at: '2026-06-01T17:00:00Z'},
        seven_day: {utilization: 55, resets_at: '2026-06-06T00:00:00Z'},
        seven_day_sonnet: {utilization: 12, resets_at: '2026-06-06T00:00:00Z'},
        extra_usage: {is_enabled: true, utilization: 10, resets_at: null},
    }));
    GLib.setenv('LLM_USAGE_CLAUDE_FIXTURE_JSON', validFixturePath, true);
    {
        const source = new ClaudeSource({
            settings: makeSettingsStub({firefoxEnabled: true}),
            extensionPath: repoRoot,
        });
        const snap = runRefresh(source);
        source.destroy();
        check('firefox fallback returns OK snapshot with 4 windows',
            snap?.providerId === 'claude' &&
            snap.status === STATUS.OK &&
            snap.windows.length === 4 &&
            snap.windows[0].id === 'five_hour' &&
            snap.windows[0].usedPercent === 24 &&
            snap.windows[1].id === 'seven_day' &&
            snap.windows[2].scope === 'Sonnet' &&
            snap.windows[3].id === 'extra_usage');
    }

    // 4. Unauthenticated + Firefox enabled + empty Free-tier fixture -> UNAVAILABLE ('No quota windows reported')
    Gio.File.new_for_path(credsPath).delete(null);
    const freeFixturePath = GLib.build_filenamev([tmpDir, 'free-usage.json']);
    GLib.file_set_contents(freeFixturePath, JSON.stringify({
        five_hour: null,
        seven_day: null,
        limits: [],
        extra_usage: null,
    }));
    GLib.setenv('LLM_USAGE_CLAUDE_FIXTURE_JSON', freeFixturePath, true);
    {
        const source = new ClaudeSource({
            settings: makeSettingsStub({firefoxEnabled: true}),
            extensionPath: repoRoot,
        });
        const snap = runRefresh(source);
        source.destroy();
        check('firefox no-usage fixture returns unavailable No quota windows reported',
            snap?.providerId === 'claude' &&
            snap.status === STATUS.UNAVAILABLE &&
            snap.error?.message === 'No quota windows reported');
    }

    // 5. Pre-cancelled Gio.Cancellable -> ERROR ('Cancelled')
    {
        const source = new ClaudeSource({
            settings: makeSettingsStub({firefoxEnabled: false}),
            extensionPath: repoRoot,
        });
        const cancellable = Gio.Cancellable.new();
        cancellable.cancel();
        const snap = runRefresh(source, cancellable);
        source.destroy();
        check('pre-cancelled refresh returns ERROR Cancelled',
            snap?.providerId === 'claude' &&
            snap.status === STATUS.ERROR &&
            snap.error?.message === 'Cancelled');
    }
} finally {
    if (origConfigDir !== null)
        GLib.setenv('CLAUDE_CONFIG_DIR', origConfigDir, true);
    else
        GLib.unsetenv('CLAUDE_CONFIG_DIR');

    if (origFixture !== null)
        GLib.setenv('LLM_USAGE_CLAUDE_FIXTURE_JSON', origFixture, true);
    else
        GLib.unsetenv('LLM_USAGE_CLAUDE_FIXTURE_JSON');

    removeTree(tmpDir);
}

console.log(`JS-CLAUDE-SOURCE-TESTS: ${passed}/${passed + failed} passed`);
System.exit(failed > 0 ? 1 : 0);
