import { sweepExpired } from './thumbnailCache';
import { log } from '../logging/logger';

const SWEEP_EVERY_MS = 60_000;

export function startCacheSweeper(): () => void {
  const handle = setInterval(() => {
    const removed = sweepExpired();
    if (removed > 0) log('debug', `cache sweep removed ${removed} entries`);
  }, SWEEP_EVERY_MS);
  return () => clearInterval(handle);
}
