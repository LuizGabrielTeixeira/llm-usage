/*
 * claudeRoute tests, run with: node tests/js/claude-gate.js (or gjs -m)
 */
import {claudeRoute} from '../../lib/claudeGate.js';

let failed = 0;
function check(name, cond) {
    if (cond) {
        console.log(`ok - ${name}`);
    } else {
        failed += 1;
        console.error(`FAIL - ${name}`);
    }
}

check('both off -> off', claudeRoute({oauthEnabled: false, firefoxEnabled: false}) === 'off');
check('firefox only -> firefox', claudeRoute({oauthEnabled: false, firefoxEnabled: true}) === 'firefox');
check('oauth on -> oauth', claudeRoute({oauthEnabled: true, firefoxEnabled: false}) === 'oauth');
check('oauth wins when both on', claudeRoute({oauthEnabled: true, firefoxEnabled: true}) === 'oauth');

const exit = typeof process !== 'undefined'
    ? code => process.exit(code)
    : (await import('system')).default.exit;
exit(failed > 0 ? 1 : 0);
