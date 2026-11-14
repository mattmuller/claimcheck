import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type RunOut, buildScript, decideSql, guardSql, parseLocalUrl, psqlRunner, splitStatements } from '../src/sql';
import { tempRepo } from './helpers';

const MIGRATION = `-- sessions
create or replace function purge_sessions() returns void as $$
begin
  delete from sessions where created_at < now() - interval '30 days';
end;
$$ language plpgsql;
`;
const CHECK = `do $$ begin
  assert (select prosrc from pg_proc where proname = 'purge_sessions') like '%interval ''30 days''%', 'sessions are purged after 30 days';
end $$;`;

describe('sql: only a local database, only when asked (promise 1)', () => {
  it('accepts localhost, loopback and a socket path', () => {
    for (const u of ['postgres://u:p@localhost:5432/db', 'postgresql://127.0.0.1/db', 'postgres://[::1]:5433/db', 'postgres:///db?host=/var/run/postgresql']) {
      expect('error' in parseLocalUrl(u)).toBe(false);
    }
  });
  it('refuses any other host, and any other scheme', () => {
    for (const u of ['postgres://db.example.com/x', 'postgres://10.0.0.5/x', 'postgres://localhost.example.com/x', 'postgres://localhost@evil.example/x', 'postgres:///x?host=db.example.com', 'http://localhost/x', 'not a url']) {
      expect(parseLocalUrl(u), u).toHaveProperty('error');
    }
  });
  it('keeps the password out of the command line', () => {
    const c = parseLocalUrl('postgres://me:s3cret@localhost:5432/app');
    expect(c).toEqual({ env: { PGHOST: 'localhost', PGPORT: '5432', PGUSER: 'me', PGPASSWORD: 's3cret', PGDATABASE: 'app' } });
  });
  it('stays NOT-CHECKABLE and sends nothing when no runner was given', async () => {
    const repo = tempRepo({ 'db/migrations/1.sql': MIGRATION });
    const d = await decideSql(repo, { file: 'db/migrations/1.sql', line: 4, token: "'30 days'" }, { check: CHECK }, undefined);
    expect(d.class).toBe('NOT-CHECKABLE');
    expect(d.reason).toMatch(/--sql-url/);
  });
});

describe('sql: every script ends in ROLLBACK (promise 2)', () => {
  it('wraps the parts in BEGIN ... ROLLBACK', () => {
    const b = buildScript([{ label: 'm', sql: MIGRATION }, { label: 'c', sql: CHECK }]);
    if ('error' in b) throw new Error(b.error);
    expect(b.script.startsWith('BEGIN;\n')).toBe(true);
    expect(b.script.trimEnd().endsWith('ROLLBACK;')).toBe(true);
    expect(b.script.match(/^ROLLBACK;$/gm)).toHaveLength(1);
  });
  it('drops a bare BEGIN and COMMIT from a migration, so its COMMIT cannot persist anything', () => {
    const b = buildScript([{ label: 'm', sql: `BEGIN;\ncreate table t(i int);\nCOMMIT;\n` }]);
    if ('error' in b) throw new Error(b.error);
    expect(b.script).not.toMatch(/commit/i);
    expect(b.script.match(/\bBEGIN\b/gi)).toHaveLength(1);
  });
  it.each([
    ['commit prepared', "commit prepared 'x';"],
    ['rollback', 'create table a(i int); rollback;'],
    ['savepoint', 'savepoint s;'],
    ['release', 'release savepoint s;'],
    ['begin with options', 'begin isolation level serializable;'],
    ['start transaction', 'start transaction read write;'],
    ['abort', 'abort;'],
    ['prepare transaction', "prepare transaction 'x';"],
    ['a backslash command', '\\! echo hi\nselect 1;'],
    ['copy program', "copy t to program 'cat';"],
    ['hidden after a comment', '-- ok\n/* x */ commit prepared \'y\';'],
  ])('refuses %s before anything is sent', (_n, sql) => {
    expect(buildScript([{ label: 'm', sql }])).toHaveProperty('error');
  });
  it('is not fooled by keywords inside a function body, a string or a comment', () => {
    const sql = `create function f() returns void as $$ begin commit; rollback; end; $$ language plpgsql;\nselect 'rollback;';\n-- commit prepared 'x';\n`;
    const g = guardSql(sql);
    if ('error' in g) throw new Error(g.error);
    expect(g.sql).toContain('begin commit; rollback; end;'); // the body is sent untouched
    expect(splitStatements(sql).slice(0, 2).map((s) => s.bare.split(' ')[0])).toEqual(['create', 'select']);
  });
  it('sends exactly the built script to psql, with the password only in the environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-fakepsql-'));
    const sink = join(dir, 'stdin.txt');
    const envSink = join(dir, 'env.txt');
    const fake = join(dir, 'psql');
    writeFileSync(fake, `#!/bin/sh\ncat > ${sink}\nenv | grep -E '^(PG|AI_GATEWAY)' > ${envSink}\necho "args: $@" >> ${envSink}\n`);
    chmodSync(fake, 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${dir}:${saved}`;
    process.env.AI_GATEWAY_API_KEY = 'leak-me';
    try {
      const run = psqlRunner({ env: { PGHOST: 'localhost', PGPASSWORD: 'pw1' } });
      const script = 'BEGIN;\nselect 1;\nROLLBACK;\n';
      const out = await run(script);
      expect(out.status).toBe('pass');
      expect(readFileSync(sink, 'utf8')).toBe(script);
      const env = readFileSync(envSink, 'utf8');
      expect(env).toMatch(/PGPASSWORD=pw1/);
      expect(env).not.toMatch(/leak-me/);
      expect(env).not.toMatch(/pw1.*args|args:.*pw1/);
    } finally {
      process.env.PATH = saved;
      delete process.env.AI_GATEWAY_API_KEY;
    }
  });
});

describe('sql: the mutant is built in memory and the verdict follows the check', () => {
  // a runner that reads the interval out of the script it is given and applies the claim
  const fakeDb = (seen: string[]): ((s: string) => Promise<RunOut>) => async (script) => {
    seen.push(script);
    const m = script.match(/interval '(\d+) days'/);
    return m && m[1] === '30' ? { status: 'pass', output: '' } : { status: 'assertion-fail', output: 'ERROR:  P0004: assertion failed' };
  };
  const repo = tempRepo({ 'db/migrations/1.sql': MIGRATION });
  const target = { file: 'db/migrations/1.sql', line: 4, token: "'30 days'" };

  it('is PROVEN: passes on the real file, fails on the 31-day mutant, and every script rolled back', async () => {
    const seen: string[] = [];
    const d = await decideSql(repo, target, { check: CHECK }, fakeDb(seen));
    expect(d.class).toBe('PROVEN');
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("interval '31 days'");
    for (const s of seen) expect(s.trimEnd().endsWith('ROLLBACK;')).toBe(true);
    expect(readFileSync(join(repo, target.file), 'utf8')).toBe(MIGRATION); // no file was touched
  });
  it('is NO-TEETH when the check passes on the mutant too', async () => {
    const d = await decideSql(repo, target, { check: CHECK }, async () => ({ status: 'pass', output: '' }));
    expect(d.class).toBe('NO-TEETH');
  });
  it('is CONTRADICTED when the check fails on the real file, and never runs a mutant', async () => {
    const seen: string[] = [];
    const d = await decideSql(repo, { ...target, token: "'30 days'" }, { check: CHECK }, async (s) => { seen.push(s); return { status: 'assertion-fail', output: '' }; });
    expect(d.class).toBe('CONTRADICTED');
    expect(seen).toHaveLength(1);
  });
  it('is NOT-CHECKABLE when the database errors for any other reason', async () => {
    const d = await decideSql(repo, target, { check: CHECK }, async () => ({ status: 'crash', output: 'ERROR: relation "sessions" does not exist' }));
    expect(d.class).toBe('NOT-CHECKABLE');
  });
  it('refuses a script that could commit, without calling the database', async () => {
    let called = false;
    const d = await decideSql(repo, target, { check: "commit prepared 'x';" }, async () => { called = true; return { status: 'pass', output: '' }; });
    expect(d.class).toBe('NOT-CHECKABLE');
    expect(called).toBe(false);
  });
  it('refuses files outside the repository and untracked files', async () => {
    const d = await decideSql(repo, target, { files: ['../x.sql', target.file], check: CHECK }, async () => ({ status: 'pass', output: '' }));
    expect(d.class).toBe('NOT-CHECKABLE');
  });
});
