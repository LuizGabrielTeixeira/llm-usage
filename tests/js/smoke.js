/*
 * Coordinator smoke tests: exercise ProviderCoordinator outside GNOME with
 * fake sources (no network). Regression for the real incident where
 * `new GLib.Cancellable()` (GCancellable lives in GIO, not GLib) crashed the
 * extension inside enable() with '(intermediate value).Cancellable is not a
 * constructor'. The main loop covers the async paths exactly like the real
 * coordinator does.
 *
 * Run: gjs -m tests/js/smoke.js
 */
import GLib from 'gi://GLib';
import System from 'system';

import {ProviderCoordinator} from '../../lib/coordinator.js';

let passed = 0;
let failed = 0;

function check(name, cond) {
    if (cond) {
        passed += 1;
        console.log(`ok - ${name}`);
    } else {
        failed += 1;
        console.error(`FAIL - ${name}`);
    }
}

const loop = new GLib.MainLoop(null, false);

// --- 1) synchronous delivery + re-refresh allowed after completion ---------
{
    const got = [];
    const mk = id => ({refresh: cb => cb({providerId: id, status: 'ok'})});
    const c = new ProviderCoordinator({
        sources: [{id: 'a', source: mk('a')}, {id: 'b', source: mk('b')}],
        onUpdate: id => got.push(id),
    });
    c.refreshAll();
    check('sync refreshAll delivers in order', got.join(',') === 'a,b');
    c.refreshAll();
    check('re-refresh allowed after completion', got.length === 4);
    c.destroy();
}

// --- 2) async delivery + dedup + real cancellable ---------------------------
{
    let calls = 0;
    const cancellables = [];
    const got = [];
    const slow = {
        refresh: (cb, cancellable) => {
            calls += 1;
            cancellables.push(cancellable);
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                cb({providerId: 'slow', status: 'ok'});
                return GLib.SOURCE_REMOVE;
            });
        },
    };
    const c = new ProviderCoordinator({
        sources: [{id: 'slow', source: slow}],
        onUpdate: id => {
            got.push(id);
            loop.quit();
        },
    });
    c.refreshProvider('slow');
    check('refresh started', calls === 1);
    check('in-flight cancellable is a GCancellable',
          !!cancellables[0] &&
          typeof cancellables[0].cancel === 'function' &&
          typeof cancellables[0].is_cancelled === 'function');
    c.refreshProvider('slow');
    check('dedup while in flight', calls === 1);
    loop.run();
    check('async snapshot delivered', got.join(',') === 'slow');
    c.refreshProvider('slow');
    check('re-refresh after completion', calls === 2);
    c.destroy();
}

// --- 3) destroy-safety: pending callback never fires after destroy ----------
{
    let delivered = false;
    const never = {
        refresh: (cb, cancellable) => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                cb({providerId: 'never', status: 'ok'});
                return GLib.SOURCE_REMOVE;
            });
        },
    };
    const c = new ProviderCoordinator({
        sources: [{id: 'never', source: never}],
        onUpdate: () => {
            delivered = true;
        },
    });
    c.refreshProvider('never');
    c.destroy();
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
    loop.run();
    check('no delivery after destroy', delivered === false);
}

// --- 4) setEnabled refreshes only newly enabled providers --------------------
{
    let calls = 0;
    const c = new ProviderCoordinator({
        sources: [{id: 'x', source: {
            refresh: cb => {
                calls += 1;
                cb({providerId: 'x', status: 'ok'});
            },
        }}],
        onUpdate: () => {},
    });
    check('all enabled by default', c.isEnabled('x'));
    c.setEnabled([]);
    check('disabled via setEnabled', !c.isEnabled('x'));
    c.setEnabled(['x']);
    check('newly enabled refreshed once', calls === 1);
    c.setEnabled(['x']);
    check('no redundant refresh when already enabled', calls === 1);
    c.destroy();
}

console.log(`JS-SMOKE: ${passed}/${passed + failed} passed`);
System.exit(failed > 0 ? 1 : 0);
