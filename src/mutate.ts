// Stage 4 helper: mutate exactly one token on one line, run, restore with git.
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { git } from './gitutil';

export interface Target {
  file: string;
  line: number;
  token: string;
}

/** Replace the first number inside the token with number+1. Returns null when the token is not on the line. */
export function mutatedLine(line: string, token: string): { before: string; after: string } | null {
  const at = line.indexOf(token);
  if (at < 0) return null;
  const num = token.match(/\d+(?:\.\d+)?/);
  // no number in the token: swap a unit word for a neighbouring unit instead
  const UNIT_SWAP: [RegExp, string][] = [[/year/, 'month'], [/month/, 'week'], [/week/, 'day'], [/day/, 'hour'], [/hour/, 'minute']];
  const swap = num ? null : UNIT_SWAP.find(([re]) => re.test(token));
  if (!num && !swap) return null;
  const bumped = num ? token.replace(num[0], String(Number(num[0]) + 1)) : token.replace(swap![0], swap![1]);
  return { before: line, after: line.slice(0, at) + bumped + line.slice(at + token.length) };
}

/** Why this file may not be mutated, or null when it may. Checked before anything is written. */
export function refuseTarget(repo: string, file: string): string | null {
  if (typeof file !== 'string' || file === '') return 'the target file is empty; refusing to mutate';
  if (isAbsolute(file) || /^[A-Za-z]:/.test(file) || file.startsWith('/') || file.startsWith('\\')) {
    return `${file} is an absolute path; refusing to mutate (targets must be relative paths inside the repository)`;
  }
  if (file.split(/[\\/]/).includes('..')) return `${file} contains a ".." segment; refusing to mutate`;
  if (git(repo, ['ls-files', '--error-unmatch', '--', file]).status !== 0) return `${file} is not tracked by git; refusing to mutate`;
  let st;
  try { st = lstatSync(join(repo, file)); } catch { return `${file} does not exist; refusing to mutate`; }
  if (st.isSymbolicLink()) return `${file} is a symlink; refusing to mutate`;
  if (!st.isFile()) return `${file} is not a regular file; refusing to mutate`;
  try {
    const root = realpathSync(repo);
    if (!realpathSync(join(repo, file)).startsWith(root + sep)) return `${file} resolves outside the repository; refusing to mutate`;
  } catch { return `${file} cannot be resolved inside the repository; refusing to mutate`; }
  return null;
}

function restore(repo: string, file: string): void {
  const r = git(repo, ['checkout', '--', file]);
  if (r.status !== 0) {
    throw new Error(`claimcheck could not restore ${file} (git checkout exited ${r.status}). The file in ${repo} is still MUTATED. Run: git -C ${repo} checkout -- ${file}`);
  }
}

export function withMutation<T>(repo: string, t: Target, run: () => T): { diff: string; result: T } | { error: string } {
  const refused = refuseTarget(repo, t.file);
  if (refused) return { error: refused };
  const path = join(repo, t.file);
  if (git(repo, ['diff', '--quiet', '--', t.file]).status !== 0) return { error: `${t.file} has uncommitted changes; refusing to mutate` };
  const lines = readFileSync(path, 'utf8').split('\n');
  const m = lines[t.line - 1] === undefined ? null : mutatedLine(lines[t.line - 1], t.token);
  if (!m) return { error: `token ${JSON.stringify(t.token)} not found (or has no number) on ${t.file}:${t.line}` };
  lines[t.line - 1] = m.after;
  // Ctrl-C or a kill must not leave the target edited. The handler runs once the blocking run() returns.
  const onSignal = (sig: NodeJS.Signals) => {
    try { restore(repo, t.file); } catch (e) { console.error(`claimcheck: ${(e as Error).message}`); }
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  const onInt = () => onSignal('SIGINT');
  const onTerm = () => onSignal('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  writeFileSync(path, lines.join('\n'));
  try {
    const diff = git(repo, ['diff', '-U0', '--', t.file]).stdout;
    return { diff, result: run() };
  } finally {
    try { restore(repo, t.file); } finally {
      // A signal that arrived while run() blocked is delivered on the next loop turn. Keep the handlers
      // briefly, or the signal is swallowed and the process carries on.
      setTimeout(() => { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); }, 100).unref();
    }
  }
}
