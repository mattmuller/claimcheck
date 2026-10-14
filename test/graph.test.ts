import { describe, expect, it } from 'vitest';
import { graphCandidates } from '../src/graph';
import { parsePeriods } from '../src/parse';
import { tempRepo } from './helpers';

const find = (files: Record<string, string>, claim: string) => graphCandidates(tempRepo(files), parsePeriods(claim));
const best = (hits: ReturnType<typeof find>) => [...hits].sort((a, b) => b.score - a.score)[0];

describe('graph: constant folding', () => {
  it('folds a product of imported constants and points at the tunable literal', () => {
    const hits = find({
      'src/time.ts': 'export const SECOND = 1000;\nexport const MINUTE = 60 * SECOND;\n',
      'src/cache.ts': "import { MINUTE } from './time';\n\nexport const CACHE_TTL = 15 * MINUTE;\n",
    }, 'Cache entries live for 15 minutes.');
    const b = best(hits);
    expect(b.file).toBe('src/cache.ts');
    expect(b.line).toBe(3);
    expect(b.why).toMatch(/900000 ms = 15 minutes via CACHE_TTL = 15 \* MINUTE/);
  });

  it('understands numeric separators', () => {
    const hits = find({ 'src/a.ts': 'export const WINDOW = 15 * 60_000;\n' }, 'The window is 15 minutes.');
    expect(best(hits).line).toBe(1);
  });

  it('reports the literal in another file when the unit factor is local', () => {
    const hits = find({
      'src/limits.ts': 'export const TTL_MINUTES = 15;\n',
      'src/use.ts': "import { TTL_MINUTES } from './limits';\nexport const TTL = TTL_MINUTES * 60 * 1000;\n",
    }, 'Entries live for 15 minutes.');
    const b = best(hits);
    expect(b.file).toBe('src/limits.ts');
    expect(hits.some((h) => h.file === 'src/use.ts' && h.line === 2)).toBe(true);
    expect(b.usedBy.join(' ')).toContain('TTL');
  });

  it('folds an env default and names the variable', () => {
    for (const expr of ["Number(process.env.SESSION_SECONDS ?? '900')", 'parseInt(process.env.SESSION_SECONDS || "900", 10)', 'Number(process.env.SESSION_SECONDS) || 900']) {
      const hits = find({ 'src/s.ts': `export const SESSION = ${expr};\n` }, 'Sessions last 15 minutes.');
      expect(best(hits)?.why, expr).toMatch(/env SESSION_SECONDS/);
    }
  });

  it('folds a call to a one-line helper', () => {
    const hits = find({
      'src/h.ts': 'export const minutes = (n: number) => n * 60_000;\nexport function hours(n: number) { return n * minutes(60); }\n',
      'src/c.ts': "import { hours } from './h';\nexport const EXPIRY = hours(2);\n",
    }, 'Links expire after 2 hours.');
    const b = best(hits);
    expect(b.file).toBe('src/c.ts');
    expect(b.why).toMatch(/7200000 ms = 2 hours/);
  });

  it('follows a JSON property imported into code', () => {
    const hits = find({
      'config/limits.json': '{ "cache": { "minutes": 15 } }\n',
      'src/c.ts': "import limits from '../config/limits.json';\nexport const TTL = limits.cache.minutes * 60 * 1000;\n",
    }, 'Cache entries live for 15 minutes.');
    expect(hits.some((h) => h.file === 'config/limits.json' && h.line === 1)).toBe(true);
  });

  it('follows an enum member and an object property', () => {
    const hits = find({
      'src/e.ts': 'enum Mins { Short = 5, Long = 15 }\nconst cfg = { ttl: Mins.Long * 60 };\nexport default cfg;\n',
    }, 'The ttl is 15 minutes.');
    expect(hits.some((h) => h.file === 'src/e.ts' && h.line === 1)).toBe(true);
  });

  it('survives a cycle and finds nothing for an unknowable value', () => {
    const hits = find({ 'src/c.ts': 'export const A: number = B + 1;\nexport const B: number = A * 60;\nexport const C = Number(process.env.NOPE);\n' }, 'It lasts 15 minutes.');
    expect(hits).toEqual([]);
  });

  it('does not report a value that differs from the claim', () => {
    const hits = find({ 'src/a.ts': 'export const TTL = 20 * 60 * 1000;\n' }, 'The ttl is 15 minutes.');
    expect(hits).toEqual([]);
  });

  it('records where the value is used', () => {
    const hits = find({
      'src/a.ts': 'export const TTL = 15 * 60 * 1000;\n',
      'src/b.ts': "import { TTL } from './a';\nexport function refreshCache() {\n  return setTimeout(() => {}, TTL);\n}\n",
    }, 'Cache refreshes every 15 minutes.');
    expect(best(hits).usedBy.join(' ')).toContain('refreshCache');
  });

  it('returns nothing, quietly, for a repository without code', () => {
    expect(find({ 'a.txt': 'hello\n' }, 'It lasts 15 minutes.')).toEqual([]);
  });
});
