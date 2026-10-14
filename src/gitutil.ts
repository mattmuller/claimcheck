// Every git call claimcheck makes against a target repository goes through here.
// The target's own config must not be able to run code: no fsmonitor hook, no hooks directory, no external diff or textconv.
import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

export const GIT_HARDEN = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];

export function gitArgs(args: string[]): string[] {
  const extra = args[0] === 'diff' ? ['--no-ext-diff', '--no-textconv'] : [];
  return [...GIT_HARDEN, ...(extra.length ? [args[0], ...extra, ...args.slice(1)] : args)];
}

export function git(repo: string, args: string[], opts: { maxBuffer?: number } = {}) {
  return spawnSync('git', gitArgs(args), { cwd: repo, encoding: 'utf8', ...opts });
}

/** True for a regular file that is not a symlink and whose real path stays inside the repository. */
export function isSafeRegularFile(repo: string, file: string): boolean {
  try {
    const p = join(repo, file);
    const st = lstatSync(p);
    if (st.isSymbolicLink() || !st.isFile()) return false;
    const root = realpathSync(repo);
    return realpathSync(p).startsWith(root + sep);
  } catch {
    return false;
  }
}
