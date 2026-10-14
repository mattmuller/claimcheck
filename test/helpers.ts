import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Make a throwaway git repo from { path: contents }. */
export function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'claimcheck-test-'));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  const run = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  run('init', '-q');
  run('add', '-A');
  run('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'x');
  return dir;
}
