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
    parseMaybeDate,
    selectPanelWindow,
    normalizeCodex,
    normalizeAgy,
    normalizeCopilot,
    monthlyResetIso,
    buildMistralManualSnapshot,
    buildMistralWebSnapshot,
} from '../../lib/contract.js';

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
check('agy note prose', agySnap.windows[0].note === 'You have used some of your weekly limit.');
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

const manualSnap = buildMistralManualSnapshot({
    apiUsed: 1.33,
    apiTotal: 12.75,
    vibeUsed: 24.64,
    vibeTotal: 127.5,
    updatedAt: '2026-10-26T10:00:00Z',
});
check('mistral manual ok', manualSnap !== null && manualSnap.status === STATUS.OK);
check('mistral manual two pools', manualSnap.windows.length === 2);
check('mistral manual currency unit',
    manualSnap.windows[0].unit === 'currency' && manualSnap.windows[0].currency === 'EUR');
check('mistral api used percent', approx(manualSnap.windows[0].usedPercent, 10.43, 0.01));
check('mistral vibe used percent', approx(manualSnap.windows[1].usedPercent, 19.32, 0.01));
check('mistral manual amounts kept',
    manualSnap.windows[0].usedAmount === 1.33 && manualSnap.windows[0].totalAmount === 12.75);
check('mistral pools never summed', manualSnap.windows[0].totalAmount !== 140.25);
check('mistral monthly resetsAt', manualSnap.windows[0].resetsAt === monthlyResetIso());
check('mistral capturedAt passthrough',
    manualSnap.capturedAt === '2026-10-26T10:00:00.000Z');
check('mistral manual flag', manualSnap.extras?.manual === true);
check('mistral manual empty is null', buildMistralManualSnapshot({}) === null);

const webSnap = buildMistralWebSnapshot({
    apiUsed: 1.33,
    apiTotal: 12.75,
    vibeUsed: 26.9,
    vibeTotal: 127.5,
    capturedAt: '2026-10-26T12:00:00.000Z',
});
check('mistral web ok', webSnap !== null && webSnap.status === STATUS.OK);
check('mistral web two pools', webSnap.windows.length === 2);
check('mistral web source flag', webSnap.extras?.source === 'firefox-web');
check('mistral web has no manual flag', webSnap.extras?.manual === undefined);
check('mistral web capturedAt passthrough', webSnap.capturedAt === '2026-10-26T12:00:00.000Z');
check('mistral web vibe amount', approx(webSnap.windows[1].usedAmount, 26.9, 0.001));
check('mistral web monthly resetsAt', webSnap.windows[0].resetsAt === monthlyResetIso());
const webVibeOnly = buildMistralWebSnapshot({vibeUsed: 5.0, vibeTotal: 50.0});
check('mistral web vibe-only single pool', webVibeOnly !== null && webVibeOnly.windows.length === 1);
check('mistral web empty is null', buildMistralWebSnapshot({}) === null);

/* ---------------- summary ---------------- */

console.log(`JS-TESTS: ${passed}/${passed + failed} passed`);
System.exit(failed > 0 ? 1 : 0);
