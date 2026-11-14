// Optional SQL checks. A claim enforced in SQL (a retention interval inside a function, a cron job) cannot
// be run as a TypeScript check, so the check is SQL and it runs in a Postgres the user names.
//
// The SQL is the user's own. What this file guarantees, and how:
//   1. It connects only to the URL passed with --sql-url, only on this machine, and never reads a default.
//   2. It talks to the server through the `pg` driver. There is no shell and no psql, so there are no
//      backslash meta-commands. Each statement is sent alone, with a named prepared statement (the extended
//      protocol), which the server refuses if it holds more than one command.
//   3. Everything runs in one transaction that ends in ROLLBACK. After every statement a probe checks that the
//      transaction id and the role are unchanged. A statement that ended the transaction is detected, the
//      run stops and says so. The scanner below is only a first-line refusal with a clear message: it is
//      not what the guarantee rests on.
//   4. The connecting role is the boundary: a superuser, a member of one, a role that can create roles, or one that
//      can read files or run programs on the server is refused unless the user passes an explicit flag.
//   5. The mutant is built in memory. No file in the repository is touched.
import { readBytes } from './gitutil';
import { mutatedLine, refuseTarget } from './mutate';

export interface RunOut {
  status: 'pass' | 'assertion-fail' | 'crash';
  output: string;
}

export interface SqlAnswerPart {
  /** repo-relative SQL files applied in order inside the transaction; defaults to [target.file] */
  files?: string[];
  /** SQL that raises an ASSERT failure (SQLSTATE P0004) when the claim does not hold */
  check: string;
}

/** Runs the statements, in order, in one rolled-back transaction, and reports how it ended. Injected in tests. */
export type SqlRunner = (statements: string[]) => Promise<RunOut>;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface Connection { host: string; port?: number; user?: string; password?: string; database?: string }

/** Accepts a postgres URL for this machine only. Anything else is refused with the reason. */
export function parseLocalUrl(raw: string): Connection | { error: string } {
  let u: URL;
  try { u = new URL(raw); } catch { return { error: '--sql-url is not a valid URL' }; }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return { error: '--sql-url must start with postgres:// or postgresql://' };
  // a unix socket is named with ?host=/path and has no host in the URL
  const socket = u.searchParams.get('host');
  const host = socket ?? u.hostname;
  const local = socket ? socket.startsWith('/') && u.hostname === '' : LOCAL_HOSTS.has(u.hostname.toLowerCase());
  if (!local) return { error: `--sql-url host ${JSON.stringify(host)} is not this machine; claimcheck only connects to a local database (localhost, 127.0.0.1, ::1 or a socket path)` };
  const conn: Connection = { host: socket ?? (u.hostname === '[::1]' ? '::1' : u.hostname) };
  if (u.port) conn.port = Number(u.port);
  if (u.username) conn.user = decodeURIComponent(u.username);
  if (u.password) conn.password = decodeURIComponent(u.password);
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (db) conn.database = db;
  return conn;
}

interface Statement { text: string; bare: string }

/**
 * Split SQL on top-level semicolons. `bare` is the statement with comments, string literals, quoted
 * identifiers and dollar-quoted bodies blanked, so a keyword inside a function body is never mistaken for a command.
 * Escape strings (E'...') honour backslash escapes, as the server does.
 */
export function splitStatements(sql: string): Statement[] {
  const out: Statement[] = [];
  let text = '';
  let bare = '';
  const push = () => { if (text.trim()) out.push({ text: text.trim(), bare: bare.replace(/\s+/g, ' ').trim().toLowerCase() }); text = ''; bare = ''; };
  let i = 0;
  const copy = (end: number, blank: boolean) => { text += sql.slice(i, end); bare += blank ? ' ' : sql.slice(i, end); i = end; };
  const word = /[A-Za-z0-9_$\u0080-￿]/;
  while (i < sql.length) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') { const e = sql.indexOf('\n', i); copy(e < 0 ? sql.length : e, true); continue; }
    if (two === '/*') {
      let depth = 0; let j = i;
      do {
        if (sql.startsWith('/*', j)) { depth++; j += 2; } else if (sql.startsWith('*/', j)) { depth--; j += 2; } else j++;
      } while (depth > 0 && j < sql.length);
      copy(j, true); continue;
    }
    if (c === "'" || c === '"') {
      const prev = i > 0 ? sql[i - 1] : '';
      const before = i > 1 ? sql[i - 2] : '';
      // E'...' : a backslash escapes the next character
      const escape = c === "'" && /[eE]/.test(prev) && !word.test(before);
      let j = i + 1;
      while (j < sql.length) {
        if (escape && sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === c) { if (sql[j + 1] === c) j += 2; else break; } else j++;
      }
      copy(Math.min(j + 1, sql.length), true); continue;
    }
    if (c === '$' && !(i > 0 && word.test(sql[i - 1]))) {
      const tag = /^\$[A-Za-z_\u0080-￿]?[A-Za-z0-9_\u0080-￿]*\$/.exec(sql.slice(i));
      if (tag) {
        const e = sql.indexOf(tag[0], i + tag[0].length);
        copy(e < 0 ? sql.length : e + tag[0].length, true); continue;
      }
    }
    if (c === ';') { text += c; i++; push(); continue; }
    copy(i + 1, false);
  }
  push();
  return out;
}

const NO_OP = /^(begin|start transaction|commit|end)( work| transaction)?\s*;?$/;
const TX_CONTROL = /^(begin|start transaction|commit|end|rollback|abort|savepoint|release|prepare transaction|commit prepared|rollback prepared)\b/;
// a role or session-authorization change would lift the privilege limit
const ROLE_CHANGE = /^(set|reset)\b.*\b(role|session authorization|standard_conforming_strings)\b|^reset (all|session authorization|role)\b|\bset_config\s*\(/;
// reaches files, programs or other servers; matched on the raw text, strings included, so it errs toward refusing
const OUTSIDE = /\b(lo_import|lo_export|dblink\w*|pg_read_file|pg_read_binary_file|pg_ls_\w+|pg_stat_file|pg_file_\w+)\b/i;

/**
 * First-line refusal, with a clear message. It is NOT the safety guarantee: the run itself checks that the
 * transaction and the role survive every statement, and the role has no file or program privileges.
 * Returns each statement as written, minus a bare BEGIN or COMMIT (the run supplies its own).
 */
export function guardSql(sql: string, label = 'the script'): { statements: string[] } | { error: string } {
  // psql is never used, so a backslash command would only be a syntax error; refuse it anyway for a clear message
  if (/^[ \t]*\\/m.test(sql)) return { error: `${label} has a psql backslash command; claimcheck does not run psql` };
  const kept: string[] = [];
  for (const s of splitStatements(sql)) {
    if (NO_OP.test(s.bare)) continue;
    if (TX_CONTROL.test(s.bare)) return { error: `${label} contains a transaction-control statement (${s.bare.split(' ')[0]}); the run must end in ROLLBACK, so claimcheck refuses it` };
    if (ROLE_CHANGE.test(s.bare)) return { error: `${label} changes the role or a string-parsing setting; refusing to run it` };
    if (/^copy\b/.test(s.bare)) return { error: `${label} runs COPY, which can read or write files and programs; refusing to run it` };
    if (OUTSIDE.test(s.text)) return { error: `${label} calls a function that reaches files or other servers (${OUTSIDE.exec(s.text)![1]}); refusing to run it` };
    kept.push(s.text);
  }
  return { statements: kept };
}

/** The statements that will be sent: each part, guarded, in order. The runner adds BEGIN and ROLLBACK. */
export function buildStatements(parts: { label: string; sql: string }[]): { statements: string[] } | { error: string } {
  const all: string[] = [];
  for (const p of parts) {
    const g = guardSql(p.sql, p.label);
    if ('error' in g) return g;
    all.push(...g.statements);
  }
  return { statements: all };
}

/** The part of a database connection the runner needs. `pg` clients fit it. */
export interface Db { query(q: string | { text: string; values?: unknown[]; name?: string }): Promise<{ rows: Record<string, unknown>[] }> }

export interface RunOptions {
  /** run as this role, set with SET LOCAL ROLE. An extra layer only: the connecting role is the boundary */
  role?: string;
  /** run even when the connecting role is a superuser, belongs to one, can create roles, or can read files or run programs on the server */
  allowSuperuser?: boolean;
}

const quoteIdent = (x: string) => `"${x.replace(/"/g, '""')}"`;
const PROBE = 'SELECT pg_current_xact_id()::text AS x, current_user::text AS u, session_user::text AS s';
// A role is too powerful when it is a superuser, belongs to one, can create roles, or can touch the server's files or programs.
const PRIVILEGE_SELECT = `SELECT r.rolsuper OR EXISTS (SELECT 1 FROM pg_roles s WHERE s.rolsuper AND pg_has_role(r.oid, s.oid, 'member')) AS su,
  r.rolcreaterole AS cr,
  pg_has_role(r.oid, 'pg_read_server_files', 'member') AS rf,
  pg_has_role(r.oid, 'pg_write_server_files', 'member') AS wf,
  pg_has_role(r.oid, 'pg_execute_server_program', 'member') AS xp
FROM pg_roles r WHERE r.rolname = `;
const tooPowerful = (row: Record<string, unknown>) => !!(row.su || row.cr || row.rf || row.wf || row.xp);

/**
 * Run statements on one connection inside BEGIN ... ROLLBACK. The rollback is always sent, last, whatever
 * happened. The connection itself is the security boundary: the session user must be a plain role.
 * SET ROLE is only an extra layer, because a script that can run RESET ROLE would lift it. After every
 * statement a probe confirms the same transaction, current_user and session_user are still in force.
 */
export async function runStatements(db: Db, statements: string[], opts: RunOptions = {}): Promise<RunOut> {
  const done = (status: RunOut['status'], output: string): RunOut => ({ status, output: output.slice(0, 2500) });
  try {
    await db.query('BEGIN');
    // the string settings that decide how the scanner and the server read quotes are pinned
    await db.query('SET LOCAL standard_conforming_strings = on');
    await db.query("SET LOCAL statement_timeout = '30s'");
    if (!opts.allowSuperuser) {
      const row = (await db.query(`${PRIVILEGE_SELECT}session_user`)).rows[0];
      if (!row || tooPowerful(row)) {
        return done('crash', 'the connecting (session) role is a superuser, belongs to one, can create roles, or can read files or run programs on the server. The SQL could lift any limit set inside the session, so claimcheck refuses. Connect as a dedicated low-privilege role, or pass --sql-allow-superuser to run anyway (the SQL then has the full power of that role)');
      }
    }
    if (opts.role) {
      const row = (await db.query({ text: `${PRIVILEGE_SELECT}$1`, values: [opts.role] })).rows[0];
      if (!row) return done('crash', `role ${JSON.stringify(opts.role)} does not exist`);
      if (!opts.allowSuperuser && tooPowerful(row)) return done('crash', `role ${JSON.stringify(opts.role)} is a superuser, belongs to one, can create roles, or can read files or run programs on the server; pick a plain role`);
      await db.query(`SET LOCAL ROLE ${quoteIdent(opts.role)}`);
    }
    const base = (await db.query(PROBE)).rows[0];
    for (let i = 0; i < statements.length; i++) {
      try {
        // a named statement uses the extended protocol, so the server refuses text that holds more than one command
        await db.query({ text: statements[i], name: `cc_${i}`, values: [] });
      } catch (e) {
        const err = e as { code?: string; message?: string };
        const msg = `statement ${i + 1}: ${err.message ?? String(e)}`;
        return done(err.code === 'P0004' ? 'assertion-fail' : 'crash', `${err.code ?? 'error'}: ${msg}`);
      }
      let now: Record<string, unknown> | undefined;
      try { now = (await db.query(PROBE)).rows[0]; } catch { now = undefined; }
      if (!now || now.x !== base.x || now.u !== base.u || now.s !== base.s) {
        return done('crash', `statement ${i + 1} ended the transaction or changed the role (the probe no longer matches). Its changes may have been committed to the database. Run stopped.`);
      }
    }
    return done('pass', '');
  } catch (e) {
    return done('crash', (e as Error).message);
  } finally {
    try { await db.query('ROLLBACK'); } catch { /* the connection is closing anyway */ }
  }
}

/** A runner backed by the `pg` driver, connected to the one local database the user named. */
export function pgRunner(conn: Connection, opts: RunOptions = {}): SqlRunner {
  return async (statements) => {
    if (opts.allowSuperuser) {
      console.error('claimcheck: WARNING --sql-allow-superuser is set. The SQL runs with the full power of the connecting role: it can read and write server files, run programs, and change or commit data. Use a throwaway database you can lose.');
    }
    const pg = (await import('pg')).default;
    // every field is set here so the driver's PG* environment fallbacks never pick another host
    const client = new pg.Client({
      host: conn.host, port: conn.port ?? 5432, user: conn.user, password: conn.password, database: conn.database,
      connectionTimeoutMillis: 10_000, query_timeout: 120_000, ssl: false,
    });
    try {
      await client.connect();
    } catch (e) {
      const pw = conn.password;
      const m = (e as Error).message;
      return { status: 'crash', output: `could not connect: ${pw ? m.split(pw).join('[redacted]') : m}` };
    }
    try { return await runStatements(client as unknown as Db, statements, opts); } finally { await client.end().catch(() => {}); }
  };
}

export interface SqlDecision {
  class: 'PROVEN' | 'CONTRADICTED' | 'NO-TEETH' | 'NOT-CHECKABLE';
  reason: string;
  realRun?: RunOut;
  mutantRun?: RunOut;
  mutationDiff?: string;
}

/** Decide a SQL claim: the check must pass on the real files and fail on a mutant built in memory. */
export async function decideSql(
  repo: string,
  target: { file: string; line: number; token: string },
  part: SqlAnswerPart | undefined,
  runner: SqlRunner | undefined,
): Promise<SqlDecision> {
  if (!part || typeof part.check !== 'string' || !part.check.trim()) return { class: 'NOT-CHECKABLE', reason: 'a SQL answer needs sql.check' };
  if (!runner) return { class: 'NOT-CHECKABLE', reason: 'a SQL check needs --sql-url <postgres url for a local database>; claimcheck never connects without it' };
  const files = part.files?.length ? part.files : [target.file];
  if (!files.includes(target.file)) return { class: 'NOT-CHECKABLE', reason: `sql.files must include the target file ${target.file}` };
  const texts = new Map<string, string>();
  for (const f of files) {
    const refused = refuseTarget(repo, f);
    if (refused) return { class: 'NOT-CHECKABLE', reason: refused.replace('refusing to mutate', 'refusing to read') };
    texts.set(f, readBytes(repo, f).toString('utf8'));
  }
  const build = (override?: string) => buildStatements([
    ...files.map((f) => ({ label: f, sql: f === target.file && override !== undefined ? override : texts.get(f)! })),
    { label: 'sql.check', sql: part.check },
  ]);

  const real = build();
  if ('error' in real) return { class: 'NOT-CHECKABLE', reason: real.error };
  const realRun = await runner(real.statements);
  if (realRun.status === 'crash') return { class: 'NOT-CHECKABLE', reason: 'the SQL check crashed on the real files (not an assertion failure)', realRun };
  if (realRun.status === 'assertion-fail') return { class: 'CONTRADICTED', reason: 'the SQL check fails on the real files', realRun };

  const lines = texts.get(target.file)!.split('\n');
  const m = lines[target.line - 1] === undefined ? null : mutatedLine(lines[target.line - 1], target.token);
  if (!m) return { class: 'NOT-CHECKABLE', reason: `token ${JSON.stringify(target.token)} not found (or has no number) on ${target.file}:${target.line}`, realRun };
  lines[target.line - 1] = m.after;
  const mutant = build(lines.join('\n'));
  if ('error' in mutant) return { class: 'NOT-CHECKABLE', reason: mutant.error, realRun };
  const mutationDiff = `--- a/${target.file}\n+++ b/${target.file}\n@@ -${target.line} +${target.line} @@\n-${m.before}\n+${m.after}\n`;
  const mutantRun = await runner(mutant.statements);
  const out = { realRun, mutantRun, mutationDiff };
  if (mutantRun.status === 'assertion-fail') return { ...out, class: 'PROVEN', reason: 'passes on the real files, fails on the mutant (in a transaction that was rolled back)' };
  if (mutantRun.status === 'pass') return { ...out, class: 'NO-TEETH', reason: 'passes on both the real files and the mutant' };
  return { ...out, class: 'NOT-CHECKABLE', reason: 'the mutant made the SQL check crash instead of fail an ASSERT' };
}
