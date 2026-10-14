// Stage 4 helper: mutate exactly one token on one line, run, restore with git.
import { lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { differsMessage, git, isInside, readBytes, unchanged } from './gitutil';
import { killAll } from './procs';

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
    if (!isInside(root, realpathSync(join(repo, file)))) return `${file} resolves outside the repository; refusing to mutate`;
  } catch { return `${file} cannot be resolved inside the repository; refusing to mutate`; }
  return null;
}

function restore(repo: string, file: string, original: Buffer): void {
  const path = join(repo, file);
  // A check may have swapped the file for a symlink. Never write through one.
  let st;
  try { st = lstatSync(path); } catch { st = null; }
  if (!st || st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`claimcheck refuses to restore ${file}: it is no longer a regular file (a check replaced or removed it). The file in ${repo} may be MUTATED or gone. Inspect it with: git -C ${repo} status -- ${file}`);
  }
  try {
    if (!isInside(realpathSync(repo), realpathSync(path))) throw new Error('it now resolves outside the repository');
  } catch (e) {
    throw new Error(`claimcheck refuses to restore ${file}: ${(e as Error).message}. The file in ${repo} may still be MUTATED.`);
  }
  // Write the saved bytes back ourselves: `git checkout` would run the target's smudge filter.
  try {
    writeFileSync(path, original);
  } catch (e) {
    throw new Error(`claimcheck could not restore ${file} (${(e as Error).message}). The file in ${repo} is still MUTATED. Restore it with: git -C ${repo} checkout -- ${file}`);
  }
  if (!unchanged(repo, file)) {
    throw new Error(`claimcheck could not restore ${file}: it no longer matches the committed version. The file in ${repo} may still be MUTATED. Check it with: git -C ${repo} diff -- ${file}`);
  }
}

const SIGNALS: [NodeJS.Signals, number][] = [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129], ['SIGQUIT', 131]];

export async function withMutation<T>(repo: string, t: Target, run: () => Promise<T>): Promise<{ diff: string; result: T } | { error: string }> {
  const refused = refuseTarget(repo, t.file);
  if (refused) return { error: refused };
  const path = join(repo, t.file);
  if (!unchanged(repo, t.file)) return { error: differsMessage(t.file) };
  const original = readBytes(repo, t.file);
  const lines = original.toString('utf8').split('\n');
  const m = lines[t.line - 1] === undefined ? null : mutatedLine(lines[t.line - 1], t.token);
  if (!m) return { error: `token ${JSON.stringify(t.token)} not found (or has no number) on ${t.file}:${t.line}` };
  lines[t.line - 1] = m.after;
  // A stop signal ends the running check (whole process group) first, then restores, then exits. SIGKILL cannot be caught.
  const handlers = SIGNALS.map(([sig, code]) => {
    const h = () => {
      killAll();
      try { restore(repo, t.file, original); } catch (e) { console.error(`claimcheck: ${(e as Error).message}`); }
      process.exit(code);
    };
    process.on(sig, h);
    return [sig, h] as const;
  });
  writeFileSync(path, lines.join('\n'));
  try {
    // Our own one-line diff: `git diff` would run the target's clean filter.
    const diff = `--- a/${t.file}\n+++ b/${t.file}\n@@ -${t.line} +${t.line} @@\n-${m.before}\n+${m.after}\n`;
    return { diff, result: await run() };
  } finally {
    try { killAll(); restore(repo, t.file, original); } finally {
      for (const [sig, h] of handlers) process.off(sig, h);
    }
  }
}
