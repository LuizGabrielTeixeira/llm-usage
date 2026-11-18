/*
 * Back-off tests, run with: node tests/js/backoff.js (or gjs -m)
 */
import {MAX_BACKOFF_SECONDS, isRateLimited, nextDelaySeconds} from '../../lib/backoff.js';

let failed = 0;
function check(name, cond) {
    if (cond) {
        console.log(`ok - ${name}`);
    } else {
        failed += 1;
        console.error(`FAIL - ${name}`);
    }
}

const limited = {status: 'error', error: {message: 'Rate limited (HTTP 429)'}};
const plainHttp = {status: 'error', error: {message: 'HTTP 429'}};
const other = {status: 'error', error: {message: 'HTTP 500'}};
const ok = {status: 'ok', error: null};

check('429 detected in message', isRateLimited(limited) && isRateLimited(plainHttp));
check('other errors and ok are not rate limited',
    !isRateLimited(other) && !isRateLimited(ok) && !isRateLimited(null) && !isRateLimited({}));

check('first 429 doubles the base interval', nextDelaySeconds(300, 300, limited) === 600);
check('further 429s keep doubling', nextDelaySeconds(300, 600, limited) === 1200);
check('doubling is capped at 30 minutes',
    nextDelaySeconds(300, 1200, limited) === MAX_BACKOFF_SECONDS &&
    nextDelaySeconds(300, MAX_BACKOFF_SECONDS, limited) === MAX_BACKOFF_SECONDS);
check('a base interval above the cap is never shortened',
    nextDelaySeconds(3600, 3600, limited) === 3600);
check('success resets to the base interval', nextDelaySeconds(300, 1800, ok) === 300);
check('other errors keep the current delay', nextDelaySeconds(300, 1200, other) === 1200);
check('other errors never go below the base', nextDelaySeconds(300, 60, other) === 300);

const exit = typeof process !== 'undefined'
    ? code => process.exit(code)
    : (await import('system')).default.exit;
exit(failed > 0 ? 1 : 0);
