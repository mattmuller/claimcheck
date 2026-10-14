import { describe, expect, it } from 'vitest';
import { locate } from '../src/locate';
import { parsePeriods } from '../src/parse';
import { tempRepo } from './helpers';

describe('locate: generic excludes', () => {
  const repo = tempRepo({
    'config/app.json': '{ "logRetentionDays": 90 }\n',
    'config/app.yaml': 'log_retention_days: 90\n',
    'package.json': '{ "x": "90 days" }\n',
    'docs/readme.md': 'Logs are kept 90 days\n',
    'tests/a.ts': 'const logRetentionDays = 90;\n',
    'dist/a.js': 'const logRetentionDays = 90;\n',
  });
  it('searches JSON and YAML but not docs, tests, build output or manifests', () => {
    const files = locate(repo, parsePeriods('Logs are kept for 90 days.'), 'Logs are kept for 90 days.', 25, { graph: false })
      .map((c) => c.file);
    expect(files).toContain('config/app.json');
    expect(files).toContain('config/app.yaml');
    for (const f of ['package.json', 'docs/readme.md', 'tests/a.ts', 'dist/a.js']) expect(files).not.toContain(f);
  });
  it('finds a line that sets a different value (false claim) through words alone', () => {
    const r = tempRepo({ 'src/a.ts': '// how long logs are kept\nexport const logRetentionDays = 30;\nexport const other = 5;\n' });
    const top = locate(r, parsePeriods('Server logs are kept for 90 days.'), 'Server logs are kept for 90 days.')[0];
    expect(top.file).toBe('src/a.ts');
    expect(top.line).toBe(2);
    expect(top.why).toMatch(/BM25/);
  });
  it('switches layers off', () => {
    const r = tempRepo({ 'src/a.ts': 'export const logRetentionDays = 30;\n' });
    const c = 'Server logs are kept for 90 days.';
    expect(locate(r, parsePeriods(c), c, 25, { bm25: false, graph: false, synonyms: false })).toEqual([]);
  });
});

describe('locate: rules alone, on every platform', () => {
  // The rules use \b and [^\n]. `git grep -E` on macOS reads both differently and found nothing;
  // the search now runs in-process with JavaScript regular expressions.
  it('finds a constant next to its unit word with every word layer off', () => {
    const r = tempRepo({ 'src/a.ts': 'export const LOG_RETENTION_DAYS = 90;\nexport const PAGE = 900;\n' });
    const c = 'Server logs are kept for 90 days.';
    const top = locate(r, parsePeriods(c), c, 25, { bm25: false, graph: false, synonyms: false })[0];
    expect(`${top.file}:${top.line}`).toBe('src/a.ts:1');
  });
});
