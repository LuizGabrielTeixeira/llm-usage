/*
 * activeAccessWarnings tests, run with: node tests/js/access-warnings.js (or gjs -m)
 */
import {activeAccessWarnings} from '../../lib/accessWarnings.js';

let failed = 0;
function check(name, cond) {
    if (cond) {
        console.log(`ok - ${name}`);
    } else {
        failed += 1;
        console.error(`FAIL - ${name}`);
    }
}

const on = keys => key => keys.includes(key);

check('nothing on -> no warnings', activeAccessWarnings('claude', on([])).length === 0);
check('claude oauth on -> one warning with its key',
    activeAccessWarnings('claude', on(['claude-oauth-enabled'])).map(w => w.key).join() === 'claude-oauth-enabled');
check('claude both on -> two warnings',
    activeAccessWarnings('claude', on(['claude-oauth-enabled', 'claude-firefox-enabled'])).length === 2);
check('mistral firefox on -> one warning',
    activeAccessWarnings('mistral', on(['mistral-firefox-enabled'])).length === 1);
check('another provider\'s option is ignored',
    activeAccessWarnings('mistral', on(['claude-oauth-enabled'])).length === 0);
check('unknown provider -> no warnings', activeAccessWarnings('codex', () => true).length === 0);

const exit = typeof process !== 'undefined'
    ? code => process.exit(code)
    : (await import('system')).default.exit;
exit(failed > 0 ? 1 : 0);
