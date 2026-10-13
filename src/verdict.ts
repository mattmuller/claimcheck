import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Target, withMutation } from './mutate';

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

export function runCheck(repo: string, checkFile: string): RunOut {
  const r = spawnSync('npx', ['tsx', checkFile], { cwd: repo, encoding: 'utf8', timeout: 120_000 });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().slice(-2500);
  if (r.status === 0) return { status: 'pass', output };
  // only an AssertionError counts as the claim failing; anything else means the check could not run
  return { status: /AssertionError/.test(output) ? 'assertion-fail' : 'crash', output };
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

export function decide(repo: string, checkFile: string, a: Answer): Result {
  const base = { located: a.target ? `${a.target.file}:${a.target.line}` : null, subject: a.subject, notes: a.notes };
  if (a.notLocated) return { ...base, class: 'NOT-LOCATED', reason: a.notLocated };
  if (a.notCheckable) return { ...base, class: 'NOT-CHECKABLE', reason: a.notCheckable };
  if (!a.target || !a.checkSource) return { ...base, class: 'NOT-LOCATED', reason: 'no target or check in the answer' };
  mkdirSync(dirname(checkFile), { recursive: true });
  writeFileSync(checkFile, a.checkSource);
  const common = { ...base, checkKind: a.checkKind, checkSource: a.checkSource };

  const real = runCheck(repo, checkFile);
  if (real.status === 'crash') return { ...common, class: 'NOT-CHECKABLE', reason: 'the check crashed on real code (not an assertion failure)', realRun: real };
  if (real.status === 'assertion-fail') return { ...common, class: 'CONTRADICTED', reason: 'the check fails on real code', realRun: real };

  const m = withMutation(repo, a.target, () => runCheck(repo, checkFile));
  if ('error' in m) return { ...common, class: 'NOT-CHECKABLE', reason: m.error, realRun: real };
  const mutant = m.result;
  const out = { ...common, realRun: real, mutantRun: mutant, mutationDiff: m.diff };
  if (mutant.status === 'assertion-fail') return { ...out, class: 'PROVEN', reason: 'passes on real code, fails on the mutant' };
  if (mutant.status === 'pass') return { ...out, class: 'NO-TEETH', reason: 'passes on both real code and mutant' };
  return { ...out, class: 'NOT-CHECKABLE', reason: 'the mutant made the check crash instead of fail an assertion' };
}
