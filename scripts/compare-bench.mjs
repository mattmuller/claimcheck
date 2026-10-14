// Compares the hit and MRR numbers of two bench result files. Timings are ignored.
// Usage: node scripts/compare-bench.mjs <committed.json> <fresh.json>
// The "original (git grep)" row is skipped: it depends on the operating system's regex library.
import { readFileSync } from 'node:fs';

const SKIPPED = new Set(['original (git grep)']);
const FIELDS = ['n', 'hit1', 'hit5', 'hit10', 'mrr'];
const [, , committedPath, freshPath] = process.argv;
if (!committedPath || !freshPath) {
  console.error('usage: node scripts/compare-bench.mjs <committed.json> <fresh.json>');
  process.exit(2);
}
const committed = JSON.parse(readFileSync(committedPath, 'utf8'));
const fresh = JSON.parse(readFileSync(freshPath, 'utf8'));
const problems = [];
const same = (a, b) => Math.abs(a - b) < 1e-9;

for (const key of ['claims', 'scored', 'noPeriod', 'noPeriodWithGold']) {
  if (committed[key] !== fresh[key]) problems.push(`${key}: committed ${committed[key]}, fresh ${fresh[key]}`);
}
for (const name of Object.keys(committed.results)) {
  if (SKIPPED.has(name)) continue;
  const a = committed.results[name];
  const b = fresh.results[name];
  if (!b) { problems.push(`row missing in fresh run: ${name}`); continue; }
  const groups = [['overall', a.overall, b.overall], ...Object.keys(a.byKind).map((k) => [`kind ${k}`, a.byKind[k], b.byKind[k]])];
  for (const [label, x, y] of groups) {
    if (!y) { problems.push(`${name} / ${label}: missing in fresh run`); continue; }
    for (const f of FIELDS) if (!same(x[f], y[f])) problems.push(`${name} / ${label} / ${f}: committed ${x[f]}, fresh ${y[f]}`);
  }
}
for (const name of Object.keys(fresh.results)) {
  if (!SKIPPED.has(name) && !committed.results[name]) problems.push(`row missing in committed file: ${name}`);
}
if (problems.length) {
  console.error('bench numbers differ from the committed bench/results.json:');
  for (const p of problems) console.error(`  ${p}`);
  console.error('If the change is intended, run "npm run bench", commit bench/results.json and say so in the PR.');
  process.exit(1);
}
console.log('bench numbers match the committed bench/results.json');
