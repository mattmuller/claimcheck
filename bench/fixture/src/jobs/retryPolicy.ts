import { SECOND } from '../util/time';

export const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 10 * SECOND;
// Never wait longer than this between attempts, however many have failed.
const MAX_BACKOFF_MS = 7_200_000;

/** Exponential backoff with full jitter. */
export function nextDelay(attempt: number, random = Math.random): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

export function shouldRetry(attempt: number): boolean {
  return attempt < MAX_ATTEMPTS;
}
