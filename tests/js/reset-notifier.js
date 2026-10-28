/* Stateful regression tests: real normalization, Gio.Settings persistence and
 * ResetNotifier delivery callback. No network, live settings or desktop alerts.
 * Run through tests/test_extension.py, which supplies an isolated schema/backend.
 */
import Gio from 'gi://Gio';
import System from 'system';

import {normalizeCodex, STATUS} from '../../lib/contract.js';
import {ResetNotifier} from '../../lib/resetNotifications.js';

let passed = 0;
let failed = 0;
function check(name, condition) {
    if (condition) {
        passed++;
        console.log(`ok - ${name}`);
    } else {
        failed++;
        console.error(`FAIL - ${name}`);
    }
}

const settings = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.llm-usage'});
const originalNow = Date.now;
let now = Date.parse('2026-10-27T10:17:00Z');
Date.now = () => now;
const oldReset = Date.parse('2026-11-02T08:45:26Z');
const newReset = Date.parse('2026-11-04T08:54:30Z');
const wake = Date.parse('2026-10-28T08:55:00Z');
const delivered = [];
function notifier() {
    return new ResetNotifier({
        settings,
        providerLabels: {codex: 'Codex'},
        notify: (title, body, providerId) => delivered.push({title, body, providerId}),
    });
}
function fresh() {
    settings.reset('reset-notification-state');
    settings.set_boolean('notify-on-reset', true);
    delivered.length = 0;
    now = Date.parse('2026-10-27T10:17:00Z');
    return notifier();
}
// Dates mirror the reported case; percentages are synthetic regression data.
function codex(reset, percent, primaryPercent = 50, primaryReset = oldReset) {
    return normalizeCodex({rate_limit: {
        primary_window: {used_percent: primaryPercent, reset_at: primaryReset / 1000},
        secondary_window: {used_percent: percent, reset_at: reset / 1000},
    }});
}
function persisted() {
    return JSON.parse(settings.get_string('reset-notification-state'));
}

function finish() {
    console.log(`RESET-NOTIFIER-TESTS: ${passed}/${passed + failed} passed`);
    System.exit(failed > 0 ? 1 : 0);
}

// The Python harness also invokes these phases in THREE separate processes
// with an isolated, disk-backed keyfile backend (no user's dconf access).
if (ARGV.length > 0) {
    const phase = ARGV[0];
    if (phase === 'baseline') {
        fresh().note('codex', codex(oldReset, 75));
        check('baseline process is silent', delivered.length === 0);
    } else {
        now = wake;
        notifier().note('codex', codex(newReset, 0));
        check(`${phase} process delivery count`, delivered.length === (phase === 'wake' ? 1 : 0));
        check(`${phase} process persists new deadline`, persisted()['codex::'].resetsAt === newReset);
    }
    Gio.Settings.sync();
    finish();
}

try {
    let active = fresh();
    active.note('codex', codex(oldReset, 75));
    check('first observation is silent', delivered.length === 0);
    check('weekly percentage survives serialization',
        Object.values(persisted()['codex::'].windows ?? {}).some(win => win.usedPercent === 75));
    // Destroy/recreate the observer, just as when logging back in after PC off.
    active = notifier();
    now = wake;
    active.note('codex', codex(newReset, 0));
    check('renewal before old deadline is delivered after restart', delivered.length === 1);
    check('renewal uses provider label/icon routing', delivered[0]?.providerId === 'codex' &&
        delivered[0]?.title.startsWith('Codex quota reset'));
    check('early renewal reports observation, not an invented reset time',
        delivered[0]?.body.includes('observed'));
    active.note('codex', codex(newReset, 1));
    notifier().note('codex', codex(newReset, 2));
    check('renewal is not duplicated on poll or next restart', delivered.length === 1);
    check('new deadline remains armed', persisted()['codex::'].notified === false);
    now = newReset + 1000;
    notifier().note('codex', codex(newReset, 2));
    check('following scheduled deadline still notifies', delivered.length === 2);

    active = fresh();
    active.note('codex', codex(oldReset, 75));
    active.note('codex', codex(oldReset, 90));
    now = wake;
    notifier().note('codex', codex(newReset, 80));
    check('same-cycle polls persist latest percentage before restart', delivered.length === 1);

    for (const percent of [75, 80, null, undefined, NaN]) {
        active = fresh();
        active.note('codex', codex(oldReset, 75));
        now = wake;
        notifier().note('codex', codex(newReset, percent));
        check(`date-only correction without usage drop stays silent (${percent})`, delivered.length === 0);
    }

    active = fresh();
    active.note('codex', codex(oldReset, 75));
    notifier().note('codex', codex(oldReset, 0));
    check('usage-only correction without cycle change stays silent', delivered.length === 0);

    active = fresh();
    active.note('codex', codex(oldReset, 75));
    notifier().note('codex', codex(newReset, 75, 0, newReset));
    check('5-hour reset cannot trigger weekly alert', delivered.length === 0);

    active = fresh();
    active.note('codex', codex(oldReset, 75));
    notifier().note('codex', codex(oldReset - 1000, 0));
    check('earlier deadline plus drop is not a new cycle', delivered.length === 0);

    active = fresh();
    active.note('codex', codex(oldReset, 75));
    active.note('codex', {status: STATUS.ERROR, windows: []});
    now = wake;
    notifier().note('codex', codex(newReset, 0));
    check('failed fetch does not erase offline baseline', delivered.length === 1);

    active = fresh();
    settings.set_string('reset-notification-state', JSON.stringify({
        'codex::': {resetsAt: oldReset, notified: false},
    }));
    now = wake;
    notifier().note('codex', codex(newReset, 0));
    check('legacy state without usage does not invent an early reset', delivered.length === 0);
    check('legacy state learns usage for subsequent cycles',
        Object.keys(persisted()['codex::'].windows ?? {}).length === 1);

    for (const raw of ['{broken', '[]', 'null', '{"codex::":{"resetsAt":"bad"}}']) {
        fresh();
        settings.set_string('reset-notification-state', raw);
        notifier().note('codex', codex(oldReset, 75));
        check(`invalid persisted baseline is replaced silently (${raw})`,
            delivered.length === 0 && persisted()['codex::'].resetsAt === oldReset);
    }

    // A pool disappearing/changing IDs must not masquerade as a reset, nor
    // should percentages from different pools be compared to one another.
    const pools = (reset, windows) => ({status: STATUS.OK, windows: windows.map(([id, percent]) => ({
        id, name: id, scope: null, periodSeconds: null,
        resetsAt: new Date(reset).toISOString(), usedPercent: percent,
        usedAmount: 123, totalAmount: 456,
    }))});
    active = fresh();
    active.note('mistral', pools(oldReset, [['api', 90], ['vibe', 20]]));
    active.note('mistral', pools(newReset, [['vibe', 20]]));
    check('removing a heavily used pool does not look like renewal', delivered.length === 0);
    check('amounts are not persisted', !settings.get_string('reset-notification-state').includes('Amount'));
    active = fresh();
    active.note('mistral', pools(oldReset, [['api', 90], ['vibe', 20]]));
    notifier().note('mistral', pools(newReset, [['vibe', 0], ['api', 0]]));
    check('merged pools deliver only one renewal independent of order',
        delivered.length === 1 && delivered[0].providerId === 'mistral');

    active = fresh();
    active.note('codex', codex(oldReset, 75));
    settings.set_boolean('notify-on-reset', false);
    now = wake;
    notifier().note('codex', codex(newReset, 0));
    settings.set_boolean('notify-on-reset', true);
    notifier().note('codex', codex(newReset, 0));
    check('disabled notifications track renewal without replay on re-enable', delivered.length === 0);

    active = fresh();
    active.note('codex', codex(oldReset, 75));
    now = oldReset + 1000;
    notifier().note('codex', codex(newReset, 0));
    check('scheduled reset missed offline still delivers once',
        delivered.length === 1 && delivered[0].title.includes('(missed)'));
    notifier().note('codex', codex(newReset, 0));
    check('scheduled offline reset does not duplicate after restart', delivered.length === 1);
} finally {
    Date.now = originalNow;
}

finish();
