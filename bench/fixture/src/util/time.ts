// Shared time constants. Everything in the service is measured in milliseconds
// unless the identifier says otherwise.
export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function daysAgo(days: number, now = Date.now()): number {
  return now - days * DAY;
}
