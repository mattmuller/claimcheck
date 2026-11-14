import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Db, type RunOut, buildStatements, decideSql, guardSql, parseLocalUrl, runStatements, splitStatements } from '../src/sql';
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

type Priv = { su: boolean; cr: boolean; br: boolean; rp: boolean; rf: boolean; wf: boolean; xp: boolean };
const PLAIN: Priv = { su: false, cr: false, br: false, rp: false, rf: false, wf: false, xp: false };

/** A stand-in for a Postgres connection that tracks a transaction id, current_user and session_user. */
function fakeDb(opts: { session?: Partial<Priv>; role?: Partial<Priv> | null; on?: Record<string, (s: { xid: number; user: string; session: string }) => void> } = {}) {
  const state = { xid: 1, user: 'app', session: 'app' };
  const log: { text: string; name?: string; values?: unknown[] }[] = [];
  const db: Db = {
    async query(q) {
      const text = typeof q === 'string' ? q : q.text;
      log.push(typeof q === 'string' ? { text } : { text, name: q.name, values: q.values });
      if (text.startsWith('SELECT pg_current_xact_id')) return { rows: [{ x: String(state.xid), u: state.user, s: state.session }] };
      if (text.includes('rolsuper')) {
        // the session-user query has no parameter; the --sql-role query has one
        const named = typeof q !== 'string' && q.values?.length;
        if (named) return { rows: opts.role === null ? [] : [{ ...PLAIN, ...opts.role }] };
        return { rows: [{ ...PLAIN, ...opts.session }] };
      }
      if (text.startsWith('SET LOCAL ROLE')) { state.user = text.replace('SET LOCAL ROLE ', '').replace(/^"|"$/g, '').replace(/""/g, '"'); return { rows: [] }; }
      const hook = opts.on?.[text];
      if (hook) hook(state);
      return { rows: [] };
    },
  };
  return { db, log, state };
}
const sent = (log: { text: string }[]) => log.map((l) => l.text);

describe('sql: only a local database, only when asked', () => {
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
  it('reads every connection field from the URL', () => {
    expect(parseLocalUrl('postgres://me:s3cret@localhost:5432/app')).toEqual({ host: 'localhost', port: 5432, user: 'me', password: 's3cret', database: 'app' });
  });
  it('stays NOT-CHECKABLE and sends nothing when no runner was given', async () => {
    const repo = tempRepo({ 'db/migrations/1.sql': MIGRATION });
    const d = await decideSql(repo, { file: 'db/migrations/1.sql', line: 4, token: "'30 days'" }, { check: CHECK }, undefined);
    expect(d.class).toBe('NOT-CHECKABLE');
    expect(d.reason).toMatch(/--sql-url/);
  });
});

describe('sql: the scanner refuses early, with a message', () => {
  it('drops a bare BEGIN and COMMIT from a migration', () => {
    const b = buildStatements([{ label: 'm', sql: 'BEGIN;\ncreate table t(i int);\nCOMMIT;\n' }]);
    if ('error' in b) throw new Error(b.error);
    expect(b.statements).toEqual(['create table t(i int);']);
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
    ['hidden after a comment', "-- ok\n/* x */ commit prepared 'y';"],
    ['a backslash command at the start of a line', '\\! echo hi\nselect 1;'],
    ['an E-string that hides a COMMIT from a scanner that ignores backslash escapes', "select E'\\''; commit prepared 'x'; select 'y'"],
    ['COPY to a file', "copy t to '/tmp/out.csv';"],
    ['COPY from a program', "copy t from program 'cat /etc/passwd';"],
    ['COPY with no file words visible', 'copy t (i) to stdout;'],
    ['lo_import', "select lo_import('/etc/passwd');"],
    ['lo_export', "select lo_export(1, '/tmp/x');"],
    ['dblink', "select * from dblink('host=other', 'select 1') as t(i int);"],
    ['dblink_connect', "select dblink_connect('x');"],
    ['pg_read_file', "select pg_read_file('/etc/passwd');"],
    ['pg_read_binary_file', "select pg_read_binary_file('/etc/passwd');"],
    ['pg_ls_dir', "select pg_ls_dir('/');"],
    ['SET ROLE', 'set role postgres;'],
    ['RESET ROLE', 'reset role;'],
    ['SET SESSION AUTHORIZATION', 'set session authorization postgres;'],
    ['set_config for role', "select set_config('role', 'postgres', false);"],
    ['changing standard_conforming_strings', 'set standard_conforming_strings = off;'],
  ])('refuses %s', (_n, sql) => {
    expect(buildStatements([{ label: 'm', sql }])).toHaveProperty('error');
  });
  it('is not fooled by keywords inside a function body, a string or a comment', () => {
    const sql = `create function f() returns void as $$ begin commit; rollback; end; $$ language plpgsql;\nselect 'rollback;';\n-- commit prepared 'x';\n`;
    const g = guardSql(sql);
    if ('error' in g) throw new Error(g.error);
    expect(g.statements[0]).toContain('begin commit; rollback; end;');
    expect(splitStatements(sql).slice(0, 2).map((s) => s.bare.split(' ')[0])).toEqual(['create', 'select']);
  });
  it('reads an E-string the way the server does', () => {
    const parts = splitStatements("select E'it\\'s ; fine'; select 2;");
    expect(parts).toHaveLength(2);
  });
});

describe('sql: a mid-line backslash is inert, because there is no psql', () => {
  it('sends the text to the server unchanged, as one statement', async () => {
    const f = fakeDb();
    const sqlText = 'select 1 \\! echo hi';
    const out = await runStatements(f.db, [sqlText]);
    expect(out.status).toBe('pass');
    expect(sent(f.log)).toContain(sqlText);
  });
  it('never launches a process: the module does not import child_process', () => {
    expect(readFileSync(join(__dirname, '..', 'src', 'sql.ts'), 'utf8')).not.toMatch(/from 'node:child_process'|require\(['"]child_process|spawn\(/);
  });
});

describe('sql: the run is one rolled-back transaction, and notices when it is not', () => {
  it('opens a transaction, sends each statement alone as a named statement, and ends with ROLLBACK', async () => {
    const f = fakeDb();
    const out = await runStatements(f.db, ['create table a(i int)', 'select 1']);
    expect(out.status).toBe('pass');
    expect(f.log[0].text).toBe('BEGIN');
    expect(f.log.at(-1)?.text).toBe('ROLLBACK');
    const mine = f.log.filter((l) => l.name);
    expect(mine.map((l) => l.text)).toEqual(['create table a(i int)', 'select 1']);
    expect(mine.every((l) => Array.isArray(l.values))).toBe(true);
    expect(f.log.filter((l) => l.text === 'ROLLBACK')).toHaveLength(1);
  });
  it('sends ROLLBACK last after an assertion failure and after any other error', async () => {
    for (const code of ['P0004', '42P01']) {
      const f = fakeDb({ on: { boom: () => { throw Object.assign(new Error('x'), { code }); } } });
      const out = await runStatements(f.db, ['select 1', 'boom', 'select 2']);
      expect(out.status).toBe(code === 'P0004' ? 'assertion-fail' : 'crash');
      expect(f.log.at(-1)?.text).toBe('ROLLBACK');
      expect(sent(f.log)).not.toContain('select 2');
    }
  });
  it('detects a statement that ends the transaction, even one the scanner let through', async () => {
    // "select hidden" stands for a COMMIT that got past the scanner: the transaction id changes
    const f = fakeDb({ on: { 'select hidden': (s) => { s.xid += 1; } } });
    const out = await runStatements(f.db, ['select 1', 'select hidden', 'delete from sessions']);
    expect(out.status).toBe('crash');
    expect(out.output).toMatch(/ended the transaction/);
    expect(out.output).toMatch(/statement 2/);
    expect(sent(f.log)).not.toContain('delete from sessions');
    expect(f.log.at(-1)?.text).toBe('ROLLBACK');
  });
  it('detects a role change in the middle of a run', async () => {
    const f = fakeDb({ on: { 'select sneaky': (s) => { s.user = 'postgres'; } } });
    const out = await runStatements(f.db, ['select sneaky', 'select 2']);
    expect(out.status).toBe('crash');
    expect(out.output).toMatch(/changed the role/);
  });
});

describe('sql: the connecting role is the boundary', () => {
  const POWERFUL: [string, Partial<Priv>][] = [
    ['a superuser, or a member of one (the query counts membership)', { su: true }],
    ['a role that can create roles', { cr: true }],
    ['a role that bypasses row security', { br: true }],
    ['a role that can start replication', { rp: true }],
    ['a role that can read server files', { rf: true }],
    ['a role that can write server files', { wf: true }],
    ['a role that can run programs on the server', { xp: true }],
  ];
  it.each(POWERFUL)('refuses a session user that is %s, and runs nothing', async (_n, session) => {
    const f = fakeDb({ session });
    const out = await runStatements(f.db, ['select 1']);
    expect(out.status).toBe('crash');
    expect(out.output).toMatch(/--sql-allow-superuser/);
    expect(out.output).toMatch(/low-privilege/);
    expect(sent(f.log)).not.toContain('select 1');
    expect(f.log.at(-1)?.text).toBe('ROLLBACK');
  });
  it('still refuses a powerful session user when --sql-role names a plain role', async () => {
    const f = fakeDb({ session: { su: true }, role: {} });
    const out = await runStatements(f.db, ['select 1'], { role: 'plain' });
    expect(out.status).toBe('crash');
    expect(sent(f.log)).not.toContain('SET LOCAL ROLE "plain"');
  });
  // The stand-in cannot run SQL, so these pin the query text. Each attribute must be tested through membership.
  it.each([['rolsuper'], ['rolcreaterole'], ['rolbypassrls'], ['rolreplication']])('asks whether the role holds %s directly or through a role it belongs to', async (col) => {
    const f = fakeDb();
    await runStatements(f.db, ['select 1']);
    const q = f.log.find((l) => l.text.includes('rolsuper'))!.text;
    expect(q).toContain(`EXISTS (SELECT 1 FROM pg_roles a WHERE a.${col} AND pg_has_role(r.oid, a.oid, 'member'))`);
  });
  it.each([['pg_read_server_files'], ['pg_write_server_files'], ['pg_execute_server_program']])('asks about membership of %s, and about session_user', async (role) => {
    const f = fakeDb();
    await runStatements(f.db, ['select 1']);
    const q = f.log.find((l) => l.text.includes('rolsuper'))!.text;
    expect(q).toContain(`pg_has_role(r.oid, '${role}', 'member')`);
    expect(q).toContain('r.rolname = session_user');
  });
  it('runs a powerful session user only with the explicit flag', async () => {
    const f = fakeDb({ session: { su: true } });
    expect((await runStatements(f.db, ['select 1'], { allowSuperuser: true })).status).toBe('pass');
  });
  it('switches to the named role before any statement, with the name quoted', async () => {
    const f = fakeDb();
    const out = await runStatements(f.db, ['select 1'], { role: 'check"er' });
    expect(out.status).toBe('pass');
    const t = sent(f.log);
    expect(t.indexOf('SET LOCAL ROLE "check""er"')).toBeGreaterThan(-1);
    expect(t.indexOf('SET LOCAL ROLE "check""er"')).toBeLessThan(t.indexOf('select 1'));
  });
  it.each(POWERFUL)('refuses a named role that is %s, and one that does not exist', async (_n, role) => {
    for (const r of [role, null]) {
      const f = fakeDb({ role: r });
      const out = await runStatements(f.db, ['select 1'], { role: 'r' });
      expect(out.status).toBe('crash');
      expect(sent(f.log)).not.toContain('select 1');
    }
  });
  it('catches RESET ROLE mid-run, the way a script would lift SET ROLE', async () => {
    // a powerful session, allowed by the flag, switched to a plain role; "select reset" stands for a RESET ROLE that got past the scanner
    const f = fakeDb({ session: { su: true }, on: { 'select reset': (s) => { s.user = s.session; } } });
    const out = await runStatements(f.db, ['select reset', 'select 2'], { allowSuperuser: true, role: 'plain' });
    expect(out.status).toBe('crash');
    expect(out.output).toMatch(/changed the role/);
    expect(sent(f.log)).not.toContain('select 2');
  });
  it('catches a change of session_user mid-run', async () => {
    const f = fakeDb({ on: { 'select swap': (s) => { s.session = 'postgres'; } } });
    const out = await runStatements(f.db, ['select swap']);
    expect(out.status).toBe('crash');
    expect(out.output).toMatch(/changed the role/);
  });
});

describe('sql: the mutant is built in memory and the verdict follows the check', () => {
  // a runner that reads the interval out of the statements it is given and applies the claim
  const fakeRunner = (seen: string[][]) => async (statements: string[]): Promise<RunOut> => {
    seen.push(statements);
    const m = statements.join('\n').match(/interval '(\d+) days'/);
    return m && m[1] === '30' ? { status: 'pass', output: '' } : { status: 'assertion-fail', output: 'P0004' };
  };
  const repo = tempRepo({ 'db/migrations/1.sql': MIGRATION });
  const target = { file: 'db/migrations/1.sql', line: 4, token: "'30 days'" };

  it('is PROVEN: passes on the real file, fails on the 31-day mutant, and no file is touched', async () => {
    const seen: string[][] = [];
    const d = await decideSql(repo, target, { check: CHECK }, fakeRunner(seen));
    expect(d.class).toBe('PROVEN');
    expect(seen).toHaveLength(2);
    expect(seen[1].join('\n')).toContain("interval '31 days'");
    expect(readFileSync(join(repo, target.file), 'utf8')).toBe(MIGRATION);
  });
  it('is NO-TEETH when the check passes on the mutant too', async () => {
    expect((await decideSql(repo, target, { check: CHECK }, async () => ({ status: 'pass', output: '' }))).class).toBe('NO-TEETH');
  });
  it('is CONTRADICTED when the check fails on the real file, and never runs a mutant', async () => {
    const seen: string[][] = [];
    const d = await decideSql(repo, target, { check: CHECK }, async (s) => { seen.push(s); return { status: 'assertion-fail', output: '' }; });
    expect(d.class).toBe('CONTRADICTED');
    expect(seen).toHaveLength(1);
  });
  it('is NOT-CHECKABLE when the database errors for any other reason', async () => {
    expect((await decideSql(repo, target, { check: CHECK }, async () => ({ status: 'crash', output: 'relation "sessions" does not exist' }))).class).toBe('NOT-CHECKABLE');
  });
  it('refuses a script that could commit, without calling the database', async () => {
    let called = false;
    const d = await decideSql(repo, target, { check: "commit prepared 'x';" }, async () => { called = true; return { status: 'pass', output: '' }; });
    expect(d.class).toBe('NOT-CHECKABLE');
    expect(called).toBe(false);
  });
  it('refuses files outside the repository', async () => {
    const d = await decideSql(repo, target, { files: ['../x.sql', target.file], check: CHECK }, async () => ({ status: 'pass', output: '' }));
    expect(d.class).toBe('NOT-CHECKABLE');
  });
});
