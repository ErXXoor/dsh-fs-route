// Verify placeholder round-trip in the route module.
import { placeholderPath, parsePlaceholder, parseAnyRoute, routeRoot } from '../lib/route.js';

let pass = 0, fail = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); ok ? pass++ : fail++; };

console.log('routeRoot:', routeRoot());

const remote = '/home/user/project';
const ph = placeholderPath('gpu', remote);
console.log('placeholder:', ph);

check('placeholder is host-absolute', /^[A-Za-z]:[\\/]/.test(ph) || ph.startsWith('/'), ph);
check('placeholder contains route dir', ph.includes('dsh-fs-route-workspaces'));

const back = parsePlaceholder(ph);
check('placeholder round-trips', back !== null && back.alias === 'gpu' && back.path === remote,
  JSON.stringify(back));

// fs path.isAbsolute must accept it — that is what the workspace controller checks.
check('path.isAbsolute accepts it', (await import('node:path')).isAbsolute(ph));

// Root-level remote dir.
const rootPh = placeholderPath('gpu', '/');
check('root placeholder round-trips', JSON.stringify(parsePlaceholder(rootPh)) === JSON.stringify({ alias: 'gpu', path: '/' }),
  rootPh);

// parseAnyRoute covers all three spellings.
const viaSsh = parseAnyRoute('ssh://gpu' + remote);
check('parseAnyRoute ssh://', viaSsh?.path === remote);
const viaPh = parseAnyRoute(ph);
check('parseAnyRoute placeholder', viaPh?.path === remote);
const displaced = parseAnyRoute('C:\\some\\dir\\ssh://gpu' + remote);
check('parseAnyRoute displaced', displaced?.path === remote);

// A plain local path stays local.
check('local path not routed', parseAnyRoute('C:\\Users\\x') === null);
check('posix local not routed (no alias)', parseAnyRoute('/tmp/x') === null);

// Project-root discovery walks up from a routed cwd and probes
// `<root>/.git`; the first segment there is `.git`, which is syntactically a
// valid alias. Membership filtering keeps it a local probe instead of a bogus
// ssh://.git route (this broke a real turn).
const known = (a) => a === 'gpu';
check('root-local .git not a route', parseAnyRoute(placeholderPath('.git', '/x'), known) === null,
  placeholderPath('.git', '/x'));
check('root-local .git not a route (unfiltered would match)', parsePlaceholder(placeholderPath('.git', '/x')) !== null);
check('known alias still routes', parseAnyRoute(ph, known)?.alias === 'gpu');

// Same membership rule for a marker one level up.
check('AGENTS.md at root stays local', parseAnyRoute(placeholderPath('AGENTS.md', '/x'), known) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
