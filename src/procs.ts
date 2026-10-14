// Check processes that are running right now, so a stop signal can end them at once.
// On POSIX each check leads its own process group, and the whole group is killed: a grandchild the check
// started cannot outlive the check or edit the target file after it is restored.
import type { ChildProcess } from 'node:child_process';

const active = new Set<ChildProcess>();

export const track = (c: ChildProcess) => { active.add(c); };
export const untrack = (c: ChildProcess) => { active.delete(c); };

/** SIGKILL a child and, off Windows, every process in its group. Never throws. */
export function killTree(c: ChildProcess): void {
  if (c.pid === undefined) return;
  try {
    if (process.platform === 'win32') c.kill();
    else process.kill(-c.pid, 'SIGKILL');
  } catch { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
}

export function killAll(): void {
  for (const c of active) killTree(c);
  active.clear();
}
