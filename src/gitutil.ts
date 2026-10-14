// Every git call claimcheck makes against a target repository goes through here.
// The target's own config must not be able to run code: no fsmonitor hook, no hooks directory, no external diff or textconv.
// Clean/smudge filters cannot be switched off by name, so claimcheck never asks git to compare or restore a
// working-tree file: it compares raw bytes with the index blob (unchanged()) and restores saved bytes itself.
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
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

/**
 * True when the working-tree file is byte-for-byte the blob git has in the index. No filter, textconv or
 * external diff runs: `ls-files -s` and `hash-object --no-filters` only hash. Any difference, including one
 * a filter would hide (line endings, attributes), counts as changed, so claimcheck refuses rather than guesses.
 */
export function unchanged(repo: string, file: string): boolean {
  const staged = git(repo, ['ls-files', '-s', '--', file]).stdout.trim().split('\n');
  if (staged.length !== 1 || !staged[0]) return false;
  const indexSha = staged[0].split(/\s+/)[1];
  const worktree = git(repo, ['hash-object', '--no-filters', '--', file]);
  return worktree.status === 0 && worktree.stdout.trim() === indexSha;
}

/** The working-tree bytes of a file, read once so they can be written back exactly. */
export function readBytes(repo: string, file: string): Buffer {
  return readFileSync(join(repo, file));
}
