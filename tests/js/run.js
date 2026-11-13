/*
 * Pure contract tests, run with: gjs -m tests/js/run.js
 * Fixtures mirror the real payload shapes validated on 2026-10-26
 * (Codex backend, agy 1.4.7 usage JSON, GitHub copilot_internal/user,
 * vibe whoami cache + Mistral console monthly EUR allowances).
 */
import System from 'system';

import {
    STATUS,
    FIVE_HOUR_SECONDS,
    SEVEN_DAY_SECONDS,
    severity,
    humanDuration,
    displayPercent,
    snapFullPercent,
    parseMaybeDate,
    selectPanelWindow,
    normalizeCodex,
    normalizeAgy,
    normalizeCopilot,
    monthlyResetIso,
    buildMistralWebSnapshot,
    normalizeClaude,
} from '../../lib/contract.js';

import {
    scopeGroup,
    targetsFromSnapshot,
    computeResetEvents,
} from '../../lib/resetNotifications.js';

let passed = 0;
let failed = 0;

function check(name, condition) {
    if (condition) {
        passed += 1;
        console.log(`ok - ${name}`);
    } else {
        failed += 1;
        console.error(`FAIL - ${name}`);
    }
}

function approx(a, b, eps = 0.01) {
    return Math.abs(a - b) <= eps;
}

function throws(fn) {
    try {
        fn();
        return false;
    } catch (e) {
        return true;
    }
}

/* ---------------- helpers ---------------- */

check('severity thresholds', severity(10) === 'usage-low' &&
    severity(75) === 'usage-high' && severity(95) === 'usage-critical');

check('humanDuration seconds', humanDuration(30) === '30s');
check('humanDuration one hour', humanDuration(3600) === '1h 0m');
check('humanDuration one day plus', humanDuration(90000) === '1d 1h');

check('displayPercent remaining', displayPercent(25, 'remaining') === 75);
check('displayPercent used', displayPercent(25, 'used') === 25);

check('snapFullPercent proportional below threshold',
    snapFullPercent(99.49) === 99.49 && snapFullPercent(42.5) === 42.5);
check('snapFullPercent full when panel reads 100',
    snapFullPercent(99.5) === 100 && snapFullPercent(99.9) === 100);
check('snapFullPercent clamps and passes exact values',
    snapFullPercent(100) === 100 && snapFullPercent(120) === 100 &&
    snapFullPercent(0) === 0 && snapFullPercent(-3) === 0);

check('parseMaybeDate zero is null', parseMaybeDate(0) === null);
check('parseMaybeDate epoch seconds',
    parseMaybeDate(1790000000) === new Date(1790000000 * 1000).toISOString());
check('parseMaybeDate ISO passthrough',
    parseMaybeDate('2026-10-26T10:00:00Z') === '2026-10-26T10:00:00.000Z');

const flatWindows = [
    {usedPercent: 10, unlimited: false, resetsAt: null, periodSeconds: null},
    {usedPercent: 80, unlimited: false, resetsAt: null, periodSeconds: null},
];
check('selectPanelWindow primary', selectPanelWindow(flatWindows, 'primary') === flatWindows[0]);
check('selectPanelWindow secondary', selectPanelWindow(flatWindows, 'secondary') === flatWindows[1]);
check('selectPanelWindow max picks highest',
    selectPanelWindow(flatWindows, 'max') === flatWindows[1]);
const mixedWindows = [
    {usedPercent: null, unlimited: true, resetsAt: null, periodSeconds: null},
    {usedPercent: 42, unlimited: false, resetsAt: null, periodSeconds: null},
];
check('selectPanelWindow max skips unlimited',
    selectPanelWindow(mixedWindows, 'max') === mixedWindows[1]);

const amountWindows = [
    {name: 'API / Studio', usedPercent: 30, totalAmount: 12.75, unlimited: false, resetsAt: null, periodSeconds: null},
    {name: 'Vibe Code', usedPercent: 10, totalAmount: 127.5, unlimited: false, resetsAt: null, periodSeconds: null},
];
check('selectPanelWindow largest picks biggest allowance, not highest percent',
    selectPanelWindow(amountWindows, 'largest') === amountWindows[1]);
check('selectPanelWindow largest without amounts falls back to first',
    selectPanelWindow(flatWindows, 'largest') === flatWindows[0]);

const copilotWindows = [
    {name: 'Chat', usedPercent: null, unlimited: true, resetsAt: null, periodSeconds: null},
    {name: 'Completions', usedPercent: null, unlimited: true, resetsAt: null, periodSeconds: null},
    {name: 'Premium Interactions', usedPercent: 2.4, unlimited: false,
        resetsAt: '2026-11-01T00:00:00.000Z', periodSeconds: null},
];
check('selectPanelWindow largest skips unlimited copilot chat (panel would show -)',
    selectPanelWindow(copilotWindows, 'largest') === copilotWindows[2]);
check('selectPanelWindow max on copilot picks premium interactions',
    selectPanelWindow(copilotWindows, 'max') === copilotWindows[2]);
check('selectPanelWindow primary stays literal first window',
    selectPanelWindow(copilotWindows, 'primary') === copilotWindows[0]);

/* ---------------- codex ---------------- */

check('codex unknown usage stays unknown, not a synthetic reset to zero',
    normalizeCodex({rate_limit: {
        primary_window: {used_percent: null},
        secondary_window: {used_percent: NaN},
    }}).windows.every(win => win.usedPercent === null));

const codexFixture = {
    rate_limit: {
        primary_window: {used_percent: 42.5, reset_at: 1790000000},
        secondary_window: {used_percent: 10, reset_at: 1790000600},
    },
    plan_type: 'pro',
    additional_rate_limits: [
        {
            limit_name: 'spark',
            rate_limit: {
                primary_window: {used_percent: 5, reset_at: 1790000000},
                secondary_window: {used_percent: 1, reset_at: 1790000600},
            },
        },
    ],
    rate_limit_reset_credits: {available_count: 2},
};

const codexSnap = normalizeCodex(codexFixture);
check('codex status ok', codexSnap.status === STATUS.OK);
check('codex two windows', codexSnap.windows.length === 2);
check('codex primary used', codexSnap.windows[0].usedPercent === 42.5);
check('codex primary period', codexSnap.windows[0].periodSeconds === FIVE_HOUR_SECONDS);
check('codex secondary period', codexSnap.windows[1].periodSeconds === SEVEN_DAY_SECONDS);
check('codex reset ISO',
    codexSnap.windows[0].resetsAt === new Date(1790000000 * 1000).toISOString());
check('codex additional name', codexSnap.extras.additional[0].name === 'SPARK');
check('codex additional windows',
    codexSnap.extras.additional[0].primary.usedPercent === 5);
check('codex reset credits', codexSnap.extras.resetCredits === 2);
check('codex missing rate_limit throws', throws(() => normalizeCodex({})));

/* ---------------- antigravity (agy) ---------------- */

const agyFixture = {
    command: {
        name: 'usage',
        data: {
            description: 'usage report',
            groups: [
                {
                    name: 'Gemini Models',
                    description: 'Models within this group: Gemini Flash',
                    buckets: [
                        {
                            id: 'gemini-weekly',
                            name: 'Weekly limit',
                            window: 'weekly',
                            remaining_fraction: 0.08,
                            reset_time: '2026-10-26T20:15:11Z',
                            description: 'You have used some of your weekly limit.',
                        },
                        {
                            id: 'gemini-5h',
                            name: 'Five-hour limit',
                            window: '5h',
                            remaining_fraction: 1,
                            reset_time: '2026-10-26T14:28:05Z',
                            description: '',
                        },
                    ],
                },
                {
                    name: 'Claude and GPT models',
                    buckets: [
                        {
                            id: '3p-weekly',
                            window: 'weekly',
                            remaining_fraction: 0.8713520169258118,
                            reset_time: '2026-10-28T15:29:57Z',
                        },
                    ],
                },
                {
                    name: 'Odd group',
                    buckets: [{id: 'odd', window: 'unknown', remaining_fraction: 0.5}],
                },
            ],
        },
    },
    status: 'SUCCESS',
};

const agySnap = normalizeAgy(agyFixture);
check('agy status ok', agySnap.status === STATUS.OK);
check('agy window count', agySnap.windows.length === 4);
check('agy weekly used ~92%', approx(agySnap.windows[0].usedPercent, 92, 0.01));
check('agy weekly period', agySnap.windows[0].periodSeconds === SEVEN_DAY_SECONDS);
check('agy 5h period', agySnap.windows[1].periodSeconds === FIVE_HOUR_SECONDS);
check('agy unknown window period null', agySnap.windows[3].periodSeconds === null);
check('agy scope passthrough', agySnap.windows[0].scope === 'Gemini Models');
check('agy reset passthrough', agySnap.windows[0].resetsAt === '2026-10-26T20:15:11Z');
check('agy description prose dropped', agySnap.windows[0].note === null);
check('agy second group used ~12.9%', approx(agySnap.windows[2].usedPercent, 12.86, 0.01));
check('agy name has scope and label', agySnap.windows[2].name.includes('Claude and GPT models'));
check('agy full remaining is 0 used', agySnap.windows[1].usedPercent === 0);
check('agy missing groups throws', throws(() => normalizeAgy({})));
check('agy empty groups throws', throws(() => normalizeAgy({command: {data: {groups: []}}})));

/* ---------------- copilot ---------------- */

const copilotFixture = {
    copilot_plan: 'individual',
    quota_reset_date: null,
    quota_reset_date_utc: null,
    quota_snapshots: {
        premium_interactions: {
            has_quota: true,
            unlimited: false,
            percent_remaining: 97.6,
            entitlement: 200,
            remaining: 195,
            credits_used: 4,
            quota_reset_at: 0,
            timestamp_utc: '2026-10-26T09:27:28.915Z',
        },
        chat: {
            has_quota: true,
            unlimited: true,
            percent_remaining: 100,
            entitlement: 0,
            quota_reset_at: 0,
            timestamp_utc: '2026-10-26T09:27:28.916Z',
        },
        legacy_pool: {
            has_quota: false,
            unlimited: false,
            percent_remaining: 50,
        },
    },
};

const copilotSnap = normalizeCopilot(copilotFixture);
check('copilot status ok', copilotSnap.status === STATUS.OK);
check('copilot skips has_quota false', copilotSnap.windows.length === 2);
check('copilot premium used 2.4%', approx(copilotSnap.windows[0].usedPercent, 2.4, 0.001));
check('copilot premium name', copilotSnap.windows[0].name === 'Premium Interactions');
check('copilot requests mapped',
    copilotSnap.windows[0].requests?.entitlement === 200 &&
    copilotSnap.windows[0].requests?.remaining === 195 &&
    copilotSnap.windows[0].requests?.used === 4);
check('copilot reset zero stays null', copilotSnap.windows[0].resetsAt === null);
check('copilot unlimited window', copilotSnap.windows[1].unlimited === true &&
    copilotSnap.windows[1].usedPercent === null);
check('copilot capturedAt passthrough',
    copilotSnap.capturedAt === '2026-10-26T09:27:28.915Z');
check('copilot missing snapshots throws', throws(() => normalizeCopilot({})));

/* ---------------- mistral ---------------- */

check('monthly reset from mid-month',
    monthlyResetIso(new Date('2026-10-26T12:00:00Z')) === '2026-11-01T00:00:00.000Z');
check('monthly reset rolls the year',
    monthlyResetIso(new Date('2026-12-15T00:00:00Z')) === '2027-01-01T00:00:00.000Z');

const webSnap = buildMistralWebSnapshot({
    apiUsed: 1.50,
    apiTotal: 20.00,
    vibeUsed: 6.00,
    vibeTotal: 60.00,
    capturedAt: '2026-10-26T12:00:00.000Z',
});
check('mistral web ok', webSnap !== null && webSnap.status === STATUS.OK);
check('mistral web two pools', webSnap.windows.length === 2);
check('mistral web source flag', webSnap.extras?.source === 'firefox-web');
check('mistral web has no manual flag', webSnap.extras?.manual === undefined);
check('mistral web capturedAt passthrough', webSnap.capturedAt === '2026-10-26T12:00:00.000Z');
check('mistral web vibe amount', approx(webSnap.windows[1].usedAmount, 6.0, 0.001));
check('mistral web pools never summed', webSnap.windows[0].totalAmount !== 80.00);
check('mistral web monthly resetsAt', webSnap.windows[0].resetsAt === monthlyResetIso());
const webVibeOnly = buildMistralWebSnapshot({vibeUsed: 5.0, vibeTotal: 50.0});
check('mistral web vibe-only single pool', webVibeOnly !== null && webVibeOnly.windows.length === 1);
check('mistral web empty is null', buildMistralWebSnapshot({}) === null);

/* ---------------- claude ---------------- */

const claudeFixture = {
    five_hour: {utilization: 18.5, resets_at: '2026-06-01T15:00:00Z'},
    seven_day: {utilization: 64, resets_at: '2026-06-06T00:00:00Z'},
    seven_day_sonnet: {utilization: 30, resets_at: '2026-06-06T00:00:00Z'},
    seven_day_opus: {utilization: 10, resets_at: '2026-06-07T00:00:00Z'},
    seven_day_custom_scope: {utilization: 5, resets_at: '2026-06-08T00:00:00Z'},
    seven_day_breakdown: {utilization: 99, resets_at: '2026-06-06T00:00:00Z'},
    extra_usage: {
        is_enabled: true,
        utilization: 37.5,
        monthly_limit: 5000,
        used_credits: 1875,
        resets_at: '2026-07-01T00:00:00Z',
    },
};

const claudeSnap = normalizeClaude(claudeFixture, '2026-06-01T12:00:00Z');
check('claude status ok', claudeSnap.status === STATUS.OK && claudeSnap.providerId === 'claude');
check('claude capturedAt passthrough', claudeSnap.capturedAt === '2026-06-01T12:00:00.000Z');
check('claude six normalized windows (skips seven_day_breakdown)',
    claudeSnap.windows.length === 6 && !claudeSnap.windows.some(w => w.id === 'seven_day_breakdown'));

const claude5h = claudeSnap.windows.find(w => w.id === 'five_hour');
check('claude 5h metadata & percent',
    claude5h?.name === '5-Hour' &&
    claude5h.periodSeconds === FIVE_HOUR_SECONDS &&
    claude5h.usedPercent === 18.5 &&
    claude5h.additional === false &&
    claude5h.scope === null &&
    claude5h.resetsAt === '2026-06-01T15:00:00.000Z');

const claudeWeekly = claudeSnap.windows.find(w => w.id === 'seven_day');
check('claude weekly metadata',
    claudeWeekly?.name === 'Weekly' &&
    claudeWeekly.periodSeconds === SEVEN_DAY_SECONDS &&
    claudeWeekly.usedPercent === 64 &&
    claudeWeekly.additional === false &&
    claudeWeekly.scope === null);

const claudeSonnet = claudeSnap.windows.find(w => w.id === 'seven_day_sonnet');
check('claude sonnet additional scoped weekly',
    claudeSonnet?.name === 'Sonnet Weekly' &&
    claudeSonnet.scope === 'Sonnet' &&
    claudeSonnet.additional === true &&
    claudeSonnet.periodSeconds === SEVEN_DAY_SECONDS);

const claudeOpus = claudeSnap.windows.find(w => w.id === 'seven_day_opus');
check('claude opus additional scoped weekly',
    claudeOpus?.name === 'Opus Weekly' &&
    claudeOpus.scope === 'Opus' &&
    claudeOpus.additional === true);

const claudeCustom = claudeSnap.windows.find(w => w.id === 'seven_day_custom_scope');
check('claude unknown seven_day_* falls back cleanly',
    claudeCustom?.name === 'Custom Scope Weekly' &&
    claudeCustom.scope === 'Custom Scope' &&
    claudeCustom.additional === true);

const claudeExtra = claudeSnap.windows.find(w => w.id === 'extra_usage');
check('claude extra_usage normalized without totalAmount',
    claudeExtra?.name === 'Extra Usage' &&
    claudeExtra.periodSeconds === null &&
    claudeExtra.scope === 'Extra Usage' &&
    claudeExtra.additional === false &&
    claudeExtra.usedPercent === 37.5 &&
    claudeExtra.totalAmount === undefined &&
    claudeExtra.resetsAt === '2026-07-01T00:00:00.000Z');

check('selectPanelWindow largest keeps 5-Hour for claude',
    selectPanelWindow(claudeSnap.windows, 'largest')?.id === 'five_hour');
check('selectPanelWindow max picks highest claude window',
    selectPanelWindow(claudeSnap.windows, 'max')?.id === 'seven_day');

const claudeExtraFallback = normalizeClaude({
    extra_usage: {
        is_enabled: true,
        utilization: null,
        monthly_limit: 2000,
        used_credits: 500,
        resets_at: null,
    },
});
check('claude extra_usage computes percent fallback from credits/limit',
    claudeExtraFallback.windows.length === 1 &&
    claudeExtraFallback.windows[0].id === 'extra_usage' &&
    claudeExtraFallback.windows[0].usedPercent === 25 &&
    claudeExtraFallback.windows[0].resetsAt === null);

const claudeExtraDisabled = normalizeClaude({
    five_hour: {utilization: 12, resets_at: null},
    extra_usage: {is_enabled: false, utilization: 80},
});
check('claude disabled extra_usage omitted',
    claudeExtraDisabled.windows.length === 1 && claudeExtraDisabled.windows[0].id === 'five_hour');

check('claude invalid/empty payloads throw',
    throws(() => normalizeClaude(null)) &&
    throws(() => normalizeClaude([])) &&
    throws(() => normalizeClaude({})) &&
    throws(() => normalizeClaude({five_hour: null, seven_day: null, limits: []})));

/* ---------------- reset notifications ---------------- */

// scopeGroup: target identity per (provider, scope-group).
check('scopeGroup: null scope is null', scopeGroup('codex', null) === null);
check('scopeGroup: empty scope is null', scopeGroup('codex', '') === null);
check('scopeGroup: agy claude alias', scopeGroup('antigravity', 'Claude 4.5 Sonnet') === 'Claude/GPT models');
check('scopeGroup: agy gpt alias', scopeGroup('antigravity', 'GPT-5.3 high') === 'Claude/GPT models');
check('scopeGroup: agy unmapped passthrough', scopeGroup('antigravity', 'Gemini') === 'Gemini');
check('scopeGroup: other provider passthrough', scopeGroup('codex', 'Weekly') === 'Weekly');

const NOTIFICATION_NOW = Date.parse('2026-10-27T12:00:00.000Z');
const isoIn = hours => new Date(NOTIFICATION_NOW + hours * 3600 * 1000).toISOString();

// targetsFromSnapshot: windows -> notification targets.
const codexTargets = targetsFromSnapshot('codex', {
    status: STATUS.OK,
    windows: [
        {id: 'primary', name: '5-Hour', scope: null, periodSeconds: FIVE_HOUR_SECONDS, resetsAt: isoIn(2)},
        {id: 'secondary', name: 'Weekly', scope: null, periodSeconds: SEVEN_DAY_SECONDS, resetsAt: isoIn(24 * 7)},
    ],
});
check('targets: codex weekly only (5h excluded)', codexTargets.length === 1);
check('targets: codex group null', codexTargets[0].group === null);
check('targets: codex key', codexTargets[0].key === 'codex::');
check('targets: codex names', codexTargets[0].names.length === 1 && codexTargets[0].names[0] === 'Weekly');

const mistralTargets = targetsFromSnapshot('mistral', {
    status: STATUS.OK,
    windows: [
        {id: 'api', name: 'API / Studio', scope: null, periodSeconds: null, resetsAt: isoIn(24 * 5)},
        {id: 'vibe', name: 'Vibe Code', scope: null, periodSeconds: null, resetsAt: isoIn(24 * 5)},
    ],
});
check('targets: mistral pools merged', mistralTargets.length === 1);
check('targets: mistral both names', mistralTargets[0].names.length === 2);

const agyTargets = targetsFromSnapshot('antigravity', {
    status: STATUS.OK,
    windows: [
        {id: 'Gemini:weekly', name: 'Gemini weekly', scope: 'Gemini', periodSeconds: SEVEN_DAY_SECONDS, resetsAt: isoIn(24 * 6)},
        {id: 'Argon:weekly', name: 'Argon weekly', scope: 'Argon', periodSeconds: SEVEN_DAY_SECONDS, resetsAt: isoIn(24 * 6)},
        {id: 'Claude:weekly', name: 'Claude 4.5 weekly', scope: 'Claude 4.5 Sonnet', periodSeconds: SEVEN_DAY_SECONDS, resetsAt: isoIn(24 * 6)},
        {id: 'GPT:weekly', name: 'GPT-5.3 weekly', scope: 'GPT-5.3 high', periodSeconds: SEVEN_DAY_SECONDS, resetsAt: isoIn(24 * 6)},
        {id: 'Gemini:5h', name: 'Gemini 5h', scope: 'Gemini', periodSeconds: FIVE_HOUR_SECONDS, resetsAt: isoIn(3)},
    ],
});
check('targets: agy three families', agyTargets.length === 3);
const agyMerged = agyTargets.find(target => target.group === 'Claude/GPT models');
check('targets: agy claude/gpt merged', agyMerged !== undefined && agyMerged.names.length === 2);
check('targets: agy gemini present', agyTargets.some(target => target.group === 'Gemini'));
check('targets: agy 5h window excluded', !agyTargets.some(target => target.names.includes('Gemini 5h')));

check('targets: error snapshot ignored',
    targetsFromSnapshot('codex', {status: STATUS.ERROR, windows: []}).length === 0);
check('targets: null resetsAt ignored',
    targetsFromSnapshot('codex', {
        status: STATUS.OK,
        windows: [{id: 'w', name: 'Weekly', scope: null, periodSeconds: SEVEN_DAY_SECONDS, resetsAt: null}],
    }).length === 0);

const claudeTargets = targetsFromSnapshot('claude', claudeSnap);
check('targets: claude 5h excluded',
    !claudeTargets.some(target => target.names.includes('5-Hour')));
check('targets: claude primary weekly uses null group',
    claudeTargets.some(target => target.group === null && target.names.includes('Weekly')));
check('targets: claude scoped windows and extra_usage kept separate',
    ['Sonnet', 'Opus', 'Custom Scope', 'Extra Usage'].every(
        group => claudeTargets.some(target => target.group === group)));

// computeResetEvents: pure transition logic (state mutated in place).
const EVENT_T0 = NOTIFICATION_NOW - 48 * 3600 * 1000; // past
const EVENT_T1 = NOTIFICATION_NOW + 24 * 3600 * 1000; // future
const EVENT_T2 = NOTIFICATION_NOW + 72 * 3600 * 1000;
const mkTarget = ms => ({
    key: 'codex::',
    providerId: 'codex',
    group: null,
    resetsAtMs: ms,
    names: ['Weekly'],
});

let eventState = {};
let events = computeResetEvents(eventState, [mkTarget(EVENT_T1)], NOTIFICATION_NOW);
check('events: first-seen future baselines silently',
    events.length === 0 && eventState['codex::'].resetsAt === EVENT_T1 && eventState['codex::'].notified === false);

eventState = {};
events = computeResetEvents(eventState, [mkTarget(EVENT_T0)], NOTIFICATION_NOW);
check('events: first-seen past baselines silently',
    events.length === 0 && eventState['codex::'].notified === true);

eventState = {'codex::': {resetsAt: EVENT_T1, notified: false}};
events = computeResetEvents(eventState, [mkTarget(EVENT_T1)], NOTIFICATION_NOW);
check('events: future instant silent', events.length === 0);

events = computeResetEvents(eventState, [mkTarget(EVENT_T1)], NOTIFICATION_NOW + 25 * 3600 * 1000);
check('events: crossing notifies', events.length === 1 && events[0].missed === false);
check('events: crossing marks notified', eventState['codex::'].notified === true);
check('events: no duplicate on next poll',
    computeResetEvents(eventState, [mkTarget(EVENT_T1)], NOTIFICATION_NOW + 26 * 3600 * 1000).length === 0);

eventState = {'codex::': {resetsAt: EVENT_T0, notified: false}};
events = computeResetEvents(eventState, [mkTarget(EVENT_T1)], NOTIFICATION_NOW);
check('events: missed-while-away notifies',
    events.length === 1 && events[0].missed === true && events[0].resetsAtMs === EVENT_T0);
check('events: missed tracks new instant',
    eventState['codex::'].resetsAt === EVENT_T1 && eventState['codex::'].notified === false);

eventState = {'codex::': {resetsAt: EVENT_T0, notified: true}};
events = computeResetEvents(eventState, [mkTarget(EVENT_T1)], NOTIFICATION_NOW);
check('events: notified cycle rolls silently',
    events.length === 0 && eventState['codex::'].resetsAt === EVENT_T1);

eventState = {'codex::': {resetsAt: EVENT_T1, notified: false}};
events = computeResetEvents(eventState, [mkTarget(EVENT_T2)], NOTIFICATION_NOW);
check('events: moved-later before crossing silent',
    events.length === 0 && eventState['codex::'].resetsAt === EVENT_T2 && eventState['codex::'].notified === false);

eventState = {'codex::': {resetsAt: EVENT_T1, notified: false}};
events = computeResetEvents(eventState, [mkTarget(EVENT_T0)], NOTIFICATION_NOW);
check('events: moved-earlier silent',
    events.length === 0 && eventState['codex::'].resetsAt === EVENT_T0 && eventState['codex::'].notified === true);

/* ---------------- summary ---------------- */

console.log(`JS-TESTS: ${passed}/${passed + failed} passed`);
System.exit(failed > 0 ? 1 : 0);
