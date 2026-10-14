import { readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MINUTE } from '../util/time';
import { log } from '../logging/logger';

// Run often enough that the temp volume never fills up between passes.
const CLEANUP_INTERVAL_MS = 30 * MINUTE;

const options = {
  dir: '/var/tmp/uploads',
  sweepOlderThanHours: 6,
};

export async function cleanTempFiles(now = Date.now()): Promise<number> {
  const cutoff = now - options.sweepOlderThanHours * 60 * 60 * 1000;
  let removed = 0;
  for (const name of await readdir(options.dir)) {
    const path = join(options.dir, name);
    const info = await stat(path);
    if (info.mtimeMs < cutoff) {
      await rm(path, { force: true });
      removed++;
    }
  }
  log('info', `temp cleaner removed ${removed} files`);
  return removed;
}

export function startTempCleaner(): () => void {
  const handle = setInterval(() => void cleanTempFiles(), CLEANUP_INTERVAL_MS);
  return () => clearInterval(handle);
}
