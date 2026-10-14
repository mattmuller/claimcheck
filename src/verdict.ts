import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { type Target, withMutation } from './mutate';
import { killTree, track, untrack } from './procs';

export type Class = 'PROVEN' | 'CONTRADICTED' | 'NO-TEETH' | 'NOT-LOCATED' | 'NOT-CHECKABLE';

export interface Answer {
  subject?: string;
  target: Target | null;
  notLocated: false | string;
  notCheckable: false | string;
  checkKind?: 'behavioural' | 'literal';
  checkSource?: string;
  notes?: string;
}

export interface RunOut {
  status: 'pass' | 'assertion-fail' | 'crash';
  output: string;
}

// claimcheck's own tsx, run with the current node: no npx, no install in the target repo
function tsxCli(): string {
  const pkgPath = createRequire(import.meta.url).resolve('tsx/package.json');
  const bin = JSON.parse(readFileSync(pkgPath, 'utf8')).bin;
  return join(dirname(pkgPath), typeof bin === 'string' ? bin : bin.tsx);
}

const ENV_ALLOW = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ', 'SystemRoot', 'ComSpec', 'PATHEXT'];
const SENSITIVE = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

/** The environment a check runs in: a short allow-list, never an API key or anything that looks like a secret. */
export function checkEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of ENV_ALLOW) {
    const v = env[name];
    if (v === undefined || SENSITIVE.test(name) || name.startsWith('CLAIMCHECK_')) continue;
    out[name] = v;
  }
  return out;
}

/** Replace the gateway key, if it appears in captured output, before the output is stored. */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = env.AI_GATEWAY_API_KEY;
  return key ? text.split(key).join('[redacted]') : text;
}

export const CHECK_TIMEOUT_MS = 120_000;

/** Run a check asynchronously in its own process group. A timeout or a stop signal kills the whole group. */
export function runCheck(repo: string, checkFile: string, timeoutMs = CHECK_TIMEOUT_MS): Promise<RunOut> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli(), checkFile], {
      cwd: repo, env: checkEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    track(child);
    let out = '';
    let timedOut = false;
    const take = (d: Buffer) => { out = (out + d.toString('utf8')).slice(-20_000); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    // 'exit', not 'close': a grandchild holding the pipes would delay 'close' forever. Kill the group, then the pipes close.
    child.on('exit', () => killTree(child));
    const finish = (status: number | null, extra = '') => {
      clearTimeout(timer);
      untrack(child);
      const output = redact(`${out}${extra}`).trim().slice(-2500);
      if (status === 0 && !timedOut) return resolve({ status: 'pass', output });
      // only an AssertionError counts as the claim failing; anything else means the check could not run
      resolve({ status: !timedOut && /AssertionError/.test(output) ? 'assertion-fail' : 'crash', output });
    };
    child.on('error', (e) => finish(null, e.message));
    child.on('close', (code) => finish(code, timedOut ? `\n[timed out after ${timeoutMs} ms]` : ''));
  });
}

export interface Result {
  class: Class;
  reason: string;
  located: string | null;
  checkKind?: string;
  checkSource?: string;
  mutationDiff?: string;
  realRun?: RunOut;
  mutantRun?: RunOut;
  subject?: string;
  notes?: string;
}

export async function decide(repo: string, checkFile: string, a: Answer): Promise<Result> {
  const base = { located: a.target ? `${a.target.file}:${a.target.line}` : null, subject: a.subject, notes: a.notes };
  if (a.notLocated) return { ...base, class: 'NOT-LOCATED', reason: a.notLocated };
  if (a.notCheckable) return { ...base, class: 'NOT-CHECKABLE', reason: a.notCheckable };
  if (!a.target || !a.checkSource) return { ...base, class: 'NOT-LOCATED', reason: 'no target or check in the answer' };
  mkdirSync(dirname(checkFile), { recursive: true });
  writeFileSync(checkFile, a.checkSource);
  const common = { ...base, checkKind: a.checkKind, checkSource: a.checkSource };

  const real = await runCheck(repo, checkFile);
  if (real.status === 'crash') return { ...common, class: 'NOT-CHECKABLE', reason: 'the check crashed on real code (not an assertion failure)', realRun: real };
  if (real.status === 'assertion-fail') return { ...common, class: 'CONTRADICTED', reason: 'the check fails on real code', realRun: real };

  const m = await withMutation(repo, a.target, () => runCheck(repo, checkFile));
  if ('error' in m) return { ...common, class: 'NOT-CHECKABLE', reason: m.error, realRun: real };
  const mutant = m.result;
  const out = { ...common, realRun: real, mutantRun: mutant, mutationDiff: m.diff };
  if (mutant.status === 'assertion-fail') return { ...out, class: 'PROVEN', reason: 'passes on real code, fails on the mutant' };
  if (mutant.status === 'pass') return { ...out, class: 'NO-TEETH', reason: 'passes on both real code and mutant' };
  return { ...out, class: 'NOT-CHECKABLE', reason: 'the mutant made the check crash instead of fail an assertion' };
}
