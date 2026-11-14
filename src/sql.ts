// Optional SQL checks. A claim enforced in SQL (a retention interval inside a function, a cron job) cannot
// be run as a TypeScript check, so the check is SQL and it runs in a Postgres the user names.
//
// Three promises, each pinned by a test:
//   1. It connects only to the URL passed with --sql-url, only on this machine, and never reads a default.
//   2. Everything it sends runs inside one transaction that ends in ROLLBACK. A bare BEGIN or COMMIT in a
//      migration is dropped. Any other statement that could end the transaction early is refused unsent.
//   3. The mutant is built in memory. No file in the repository is touched.
import { spawn } from 'node:child_process';
import { readBytes } from './gitutil';
import { mutatedLine, refuseTarget } from './mutate';
import { killTree, track, untrack } from './procs';

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

/** Runs one complete script and reports how it ended. Injected in tests. */
export type SqlRunner = (script: string) => Promise<RunOut>;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface Connection { env: Record<string, string> }

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
  const env: Record<string, string> = { PGHOST: socket ?? (u.hostname === '[::1]' ? '::1' : u.hostname) };
  if (u.port) env.PGPORT = u.port;
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (db) env.PGDATABASE = db;
  return { env };
}

interface Statement { text: string; bare: string }

/**
 * Split SQL on top-level semicolons. `bare` is the statement with comments, string literals, quoted
 * identifiers and dollar-quoted bodies blanked, so a keyword inside a function body is never mistaken for a command.
 */
export function splitStatements(sql: string): Statement[] {
  const out: Statement[] = [];
  let text = '';
  let bare = '';
  const push = () => { if (text.trim()) out.push({ text: text.trim(), bare: bare.replace(/\s+/g, ' ').trim().toLowerCase() }); text = ''; bare = ''; };
  let i = 0;
  const copy = (end: number, blank: boolean) => { text += sql.slice(i, end); bare += blank ? ' ' : sql.slice(i, end); i = end; };
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
      let j = i + 1;
      while (j < sql.length) { if (sql[j] === c) { if (sql[j + 1] === c) j += 2; else break; } else j++; }
      copy(Math.min(j + 1, sql.length), true); continue;
    }
    if (c === '$') {
      const tag = /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/.exec(sql.slice(i));
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
const REFUSED = /^(begin|start transaction|commit|end|rollback|abort|savepoint|release|prepare transaction|commit prepared|rollback prepared)\b/;

/**
 * The SQL that may be sent: each statement as written, minus a bare BEGIN or COMMIT (the run supplies its own).
 * Returns a reason instead when the script could end the transaction early or reach outside the database.
 */
export function guardSql(sql: string, label = 'the script'): { sql: string } | { error: string } {
  if (/^[ \t]*\\/m.test(sql)) return { error: `${label} has a psql backslash command; refusing to send it` };
  const kept: string[] = [];
  for (const s of splitStatements(sql)) {
    if (NO_OP.test(s.bare)) continue;
    if (REFUSED.test(s.bare)) return { error: `${label} contains a transaction-control statement (${s.bare.split(' ')[0]}); the run must end in ROLLBACK, so claimcheck refuses it` };
    if (/^copy\b/.test(s.bare) && /\bprogram\b/.test(s.bare)) return { error: `${label} runs COPY ... PROGRAM; refusing to send it` };
    kept.push(s.text);
  }
  return { sql: kept.join('\n') };
}

/** The one script that is sent: it opens a transaction, runs the parts, and always ends with ROLLBACK. */
export function buildScript(parts: { label: string; sql: string }[]): { script: string } | { error: string } {
  const body: string[] = [];
  for (const p of parts) {
    const g = guardSql(p.sql, p.label);
    if ('error' in g) return g;
    body.push(g.sql);
  }
  return { script: `BEGIN;\nSET LOCAL statement_timeout = '30s';\n${body.join('\n')}\nROLLBACK;\n` };
}

const SQL_TIMEOUT_MS = 120_000;

/** Run a script through the `psql` command line with ON_ERROR_STOP. A stopped script leaves an open transaction that the server rolls back. */
export function psqlRunner(conn: Connection, timeoutMs = SQL_TIMEOUT_MS): SqlRunner {
  return (script) => new Promise((resolve) => {
    // a short environment: PATH to find psql, and only the connection settings that were passed in
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ...conn.env };
    const child = spawn('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'], {
      env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    track(child);
    let out = '';
    let timedOut = false;
    const take = (d: Buffer) => { out = (out + d.toString('utf8')).slice(-20_000); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const finish = (code: number | null, extra = '') => {
      clearTimeout(timer);
      untrack(child);
      let output = `${out}${extra}`;
      const pw = conn.env.PGPASSWORD;
      if (pw) output = output.split(pw).join('[redacted]');
      output = output.trim().slice(-2500);
      if (code === 0 && !timedOut) return resolve({ status: 'pass', output });
      // only a failed ASSERT (SQLSTATE P0004) counts as the claim failing; any other error means the check could not run
      resolve({ status: !timedOut && /\bP0004\b/.test(output) ? 'assertion-fail' : 'crash', output });
    };
    child.on('error', (e) => finish(null, (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'psql was not found on PATH' : e.message));
    child.on('close', (code) => finish(code, timedOut ? `\n[timed out after ${timeoutMs} ms]` : ''));
    child.stdin.on('error', () => { /* psql exited early; 'close' reports it */ });
    child.stdin.end(script);
  });
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
  const build = (override?: string) => buildScript([
    ...files.map((f) => ({ label: f, sql: f === target.file && override !== undefined ? override : texts.get(f)! })),
    { label: 'sql.check', sql: part.check },
  ]);

  const real = build();
  if ('error' in real) return { class: 'NOT-CHECKABLE', reason: real.error };
  const realRun = await runner(real.script);
  if (realRun.status === 'crash') return { class: 'NOT-CHECKABLE', reason: 'the SQL check crashed on the real files (not an assertion failure)', realRun };
  if (realRun.status === 'assertion-fail') return { class: 'CONTRADICTED', reason: 'the SQL check fails on the real files', realRun };

  const lines = texts.get(target.file)!.split('\n');
  const m = lines[target.line - 1] === undefined ? null : mutatedLine(lines[target.line - 1], target.token);
  if (!m) return { class: 'NOT-CHECKABLE', reason: `token ${JSON.stringify(target.token)} not found (or has no number) on ${target.file}:${target.line}`, realRun };
  lines[target.line - 1] = m.after;
  const mutant = build(lines.join('\n'));
  if ('error' in mutant) return { class: 'NOT-CHECKABLE', reason: mutant.error, realRun };
  const mutationDiff = `--- a/${target.file}\n+++ b/${target.file}\n@@ -${target.line} +${target.line} @@\n-${m.before}\n+${m.after}\n`;
  const mutantRun = await runner(mutant.script);
  const out = { realRun, mutantRun, mutationDiff };
  if (mutantRun.status === 'assertion-fail') return { ...out, class: 'PROVEN', reason: 'passes on the real files, fails on the mutant (in a transaction that was rolled back)' };
  if (mutantRun.status === 'pass') return { ...out, class: 'NO-TEETH', reason: 'passes on both the real files and the mutant' };
  return { ...out, class: 'NOT-CHECKABLE', reason: 'the mutant made the SQL check crash instead of fail an ASSERT' };
}
