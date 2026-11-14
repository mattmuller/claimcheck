import { afterEach, describe, expect, it } from 'vitest';
import { configureExcludes } from '../src/excludes';
import { locate } from '../src/locate';
import { parsePeriods } from '../src/parse';
import { tempRepo } from './helpers';

const find = (repo: string, claim: string, max = 25) => locate(repo, parsePeriods(claim), claim, max, { graph: false });

afterEach(() => configureExcludes());

describe('locate: files that never set live behaviour are left out (CC5)', () => {
  const repo = tempRepo({
    'db/migrations/001_a.sql': "create function purge() returns void as $$ delete from t where age > interval '30 days'; $$ language sql;\n",
    'db/migrations/001_a.down.sql': "-- undo\ndelete from t where age > interval '30 days';\n",
    'db/rollback/undo.sql': "select interval '30 days';\n",
    'db/schema_reference.sql': "select interval '30 days';\n",
    'db/seed.sql': "insert into t values (interval '30 days');\n",
    'scripts/adhoc.sql': "select interval '30 days';\n",
    'src/keep.ts': 'export const SESSION_DAYS = 30;\n',
    'src/rollback/window.ts': 'export const ROLLBACK_SESSION_DAYS = 30;\n',
  });
  const claim = 'Sessions expire after 30 days.';
  it('ignores undo scripts, schema dumps, seed data and ad-hoc scripts by default', () => {
    const files = find(repo, claim).map((c) => c.file);
    expect(files).toContain('db/migrations/001_a.sql');
    expect(files).toContain('src/keep.ts');
    expect(files).toContain('src/rollback/window.ts'); // application code in a folder named rollback is kept
    for (const f of ['db/migrations/001_a.down.sql', 'db/rollback/undo.sql', 'db/schema_reference.sql', 'db/seed.sql', 'scripts/adhoc.sql']) {
      expect(files).not.toContain(f);
    }
  });
  it('takes extra globs, and can drop the defaults', () => {
    configureExcludes(['src/**']);
    expect(find(repo, claim).map((c) => c.file)).not.toContain('src/keep.ts');
    configureExcludes(['src/**'], false);
    const files = find(repo, claim).map((c) => c.file);
    expect(files).toContain('db/seed.sql');
    expect(files).not.toContain('src/keep.ts');
  });
  it('ranks a migration below the later migration that redefines its function', () => {
    const r = tempRepo({
      'db/migrations/001_old.sql': "create or replace function purge() returns void as $$\ndelete from t where age > interval '30 days';\n$$ language sql;\n",
      'db/migrations/002_new.sql': "create or replace function purge() returns void as $$\ndelete from t where age > interval '60 days';\n$$ language sql;\n",
      'db/migrations/003_other.sql': "create function other() returns void as $$\ndelete from u where age > interval '30 days';\n$$ language sql;\n",
    });
    const hits = find(r, claim);
    const old = hits.find((c) => c.file.endsWith('001_old.sql'))!;
    const other = hits.find((c) => c.file.endsWith('003_other.sql'))!;
    expect(old.why).toMatch(/superseded: purge is redefined in db\/migrations\/002_new\.sql/);
    expect(other.why).not.toMatch(/superseded/);
    expect(old.score).toBeLessThan(other.score);
  });
});

describe('locate: live application code ranks above SQL for the same value (CC4)', () => {
  const files: Record<string, string> = {
    'src/refund.ts': 'export const ORDER_CANCEL_DAYS = 14;\n',
  };
  for (let i = 0; i < 6; i++) files[`db/migrations/00${i}_x.sql`] = `create function f${i}() returns void as $$ select interval '14 days'; $$ language sql;\n`;
  const repo = tempRepo(files);
  it('puts the named constant first, ahead of bare interval literals', () => {
    const top = find(repo, 'Orders can be cancelled within 14 days.')[0];
    expect(top.file).toBe('src/refund.ts');
    expect(top.why).toMatch(/shares a claim word/);
  });
});

describe('locate: the candidate list never exceeds max (CC9)', () => {
  it('returns at most max candidates, with SQL and code both present', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) {
      files[`db/migrations/0${i}_x.sql`] = `create function f${i}() returns void as $$ select interval '14 days' + interval '${i} seconds'; $$ language sql;\n`;
      files[`src/c${i}.ts`] = `export const RETRY_DAYS_${i} = 14; // ${i}\n`;
    }
    const out = find(tempRepo(files), 'Records are kept 14 days.');
    expect(out.length).toBeLessThanOrEqual(25);
    expect(out.some((c) => c.file.endsWith('.sql'))).toBe(true);
    expect(out.some((c) => c.file.endsWith('.ts'))).toBe(true);
    expect(find(tempRepo(files), 'Records are kept 14 days.', 10).length).toBeLessThanOrEqual(10);
  });
});

describe('locate: numeric literals with underscores (CC8)', () => {
  it('finds 1_000 for a claim of 1000 seconds', () => {
    const r = tempRepo({ 'src/poll.ts': 'export const POLL_SECONDS = 1_000;\n' });
    const top = find(r, 'The worker polls every 1000 seconds.')[0];
    expect(top?.file).toBe('src/poll.ts');
    expect(top?.why).toMatch(/1000 near second/); // found by the number rule, not by words alone
  });
  it('finds 86_400_000 for a claim of 24 hours', () => {
    const r = tempRepo({ 'src/ttl.ts': 'export const TTL_MS = 86_400_000;\n' });
    expect(find(r, 'Sessions last 24 hours.')[0]?.file).toBe('src/ttl.ts');
  });
});
