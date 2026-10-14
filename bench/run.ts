// Locate benchmark. Copies bench/fixture to a temp git repo, runs every claim in bench/claims.json through
// each locate configuration and reports hit@1/5/10 and mean reciprocal rank, overall and per kind.
//   npm run bench
// Model-suggested terms: used when CLAIMCHECK_MODEL + AI_GATEWAY_API_KEY are set (filling bench/.cache/terms.json),
// or when that cache file already holds an entry for every claim, so the numbers reproduce without a key.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedTerms, expandTerms } from '../src/expand';
import { locate } from '../src/locate';
import { modelAvailable } from '../src/model';
import { parsePeriods } from '../src/parse';
import { locate as locateOriginal, setPortableGrep } from './locate-original';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = 'bench/fixture';
const cachePath = join(here, '.cache', 'terms.json');
interface Claim { id: string; quote: string; gold: string[]; kind: string }
const claims: Claim[] = JSON.parse(readFileSync(join(here, 'claims.json'), 'utf8'));

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}
const repo = mkdtempSync(join(tmpdir(), 'claimcheck-bench-'));
cpSync(resolve(here, 'fixture'), repo, { recursive: true });
git(repo, 'init', '-q');
git(repo, 'add', '-A');
git(repo, '-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', 'commit', '-q', '-m', 'fixture');

const rel = (g: string) => g.replace(new RegExp(`^${FIXTURE}/`), '');
const gold = new Map(claims.map((c) => [c.id, new Set(c.gold.map(rel))]));

type Fn = (c: Claim, extra: string[]) => { file: string; line: number }[];
const configs: { name: string; run: Fn; model?: boolean }[] = [
  { name: 'original (git grep)', run: (c) => { setPortableGrep(false); return locateOriginal(repo, parsePeriods(c.quote), c.quote, 25); } },
  { name: 'original (regex fixed)', run: (c) => { setPortableGrep(true); return locateOriginal(repo, parsePeriods(c.quote), c.quote, 25); } },
  { name: 'rules', run: (c) => locate(repo, parsePeriods(c.quote), c.quote, 25, { synonyms: false, bm25: false, graph: false }) },
  { name: '+synonyms+bm25', run: (c) => locate(repo, parsePeriods(c.quote), c.quote, 25, { synonyms: true, bm25: true, graph: false }) },
  { name: '+graph', run: (c) => locate(repo, parsePeriods(c.quote), c.quote, 25, { synonyms: true, bm25: true, graph: true }) },
  { name: '+model terms', model: true, run: (c, extra) => locate(repo, parsePeriods(c.quote), c.quote, 25, { synonyms: true, bm25: true, graph: true, extraTerms: extra }) },
];

interface Stat { n: number; hit1: number; hit5: number; hit10: number; mrr: number }
const empty = (): Stat => ({ n: 0, hit1: 0, hit5: 0, hit10: 0, mrr: 0 });
const pct = (x: number, n: number) => (n ? `${((100 * x) / n).toFixed(0)}%` : '-');

async function main() {
  const withGold = claims.filter((c) => (gold.get(c.id)?.size ?? 0) > 0);
  const noPeriod = claims.filter((c) => parsePeriods(c.quote).length === 0);
  const noPeriodGold = withGold.filter((c) => parsePeriods(c.quote).length === 0);

  const modelOk = modelAvailable() || claims.every((c) => cachedTerms(c.quote, cachePath));
  const extra = new Map<string, string[]>();
  if (modelOk) for (const c of claims) extra.set(c.id, await expandTerms(c.quote, { cachePath }));

  const results: Record<string, { overall: Stat; byKind: Record<string, Stat>; ms: number }> = {};
  const perClaim: Record<string, Record<string, number | null>> = {};
  for (const cfg of configs) {
    if (cfg.model && !modelOk) continue;
    const overall = empty();
    const byKind: Record<string, Stat> = {};
    const t0 = Date.now();
    for (const c of withGold) {
      // locate runs even when parse found no period: the word layers can still find the line
      const list = cfg.run(c, extra.get(c.id) ?? []);
      const g = gold.get(c.id) as Set<string>;
      const at = list.findIndex((x) => g.has(`${x.file}:${x.line}`));
      const rank = at < 0 ? null : at + 1;
      (perClaim[c.id] ??= {})[cfg.name] = rank;
      for (const s of [overall, (byKind[c.kind] ??= empty())]) {
        s.n++;
        if (rank !== null) {
          if (rank <= 1) s.hit1++;
          if (rank <= 5) s.hit5++;
          if (rank <= 10) s.hit10++;
          s.mrr += 1 / rank;
        }
      }
    }
    results[cfg.name] = { overall, byKind, ms: Date.now() - t0 };
  }

  const names = Object.keys(results);
  const row = (label: string, pick: (n: string) => Stat) =>
    `| ${label} | ${names.map((n) => { const s = pick(n); return `${pct(s.hit1, s.n)} / ${pct(s.hit5, s.n)} / ${pct(s.hit10, s.n)} / ${s.n ? (s.mrr / s.n).toFixed(2) : '-'}`; }).join(' | ')} |`;
  const kinds = [...new Set(withGold.map((c) => c.kind))];
  console.log(`\nClaims: ${claims.length} (${withGold.length} with a gold line; ${claims.length - withGold.length} have none and are not scored)`);
  console.log(`Claims where parse found no period: ${noPeriod.length} of ${claims.length} (${noPeriodGold.length} of them have a gold line and count as misses)`);
  if (!modelOk) console.log('Model terms: skipped (no CLAIMCHECK_MODEL / AI_GATEWAY_API_KEY and no complete bench/.cache/terms.json)');
  console.log('\nCell = hit@1 / hit@5 / hit@10 / MRR\n');
  console.log(`| kind (n) | ${names.join(' | ')} |\n|---|${names.map(() => '---').join('|')}|`);
  console.log(row(`**all** (${withGold.length})`, (n) => results[n].overall));
  for (const k of kinds) console.log(row(`${k} (${withGold.filter((c) => c.kind === k).length})`, (n) => results[n].byKind[k] ?? empty()));
  console.log(`\nTime per configuration (ms, ${withGold.length} claims): ${names.map((n) => `${n} ${results[n].ms}`).join(', ')}`);
  console.log('\nPer-claim rank of the first gold line (- = not in the top 25)\n');
  console.log(`| id | kind | ${names.join(' | ')} |\n|---|---|${names.map(() => '---').join('|')}|`);
  for (const c of withGold) console.log(`| ${c.id} | ${c.kind} | ${names.map((n) => perClaim[c.id][n] ?? '-').join(' | ')} |`);

  writeFileSync(join(here, 'results.json'), `${JSON.stringify({ claims: claims.length, scored: withGold.length, noPeriod: noPeriod.length, noPeriodWithGold: noPeriodGold.length, results, perClaim }, null, 1)}\n`);
}
main().catch((e) => { console.error(e); process.exit(1); });
