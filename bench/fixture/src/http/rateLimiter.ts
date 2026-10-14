import { log } from '../logging/logger';

export const WINDOW_MS = 5 * 60 * 1000;
export const MAX_REQUESTS = 100;
const PENALTY_BOX_MINUTES = 30;

const hits = new Map<string, number[]>();
const blockedUntil = new Map<string, number>();

export function allow(clientId: string, now = Date.now()): boolean {
  const until = blockedUntil.get(clientId);
  if (until !== undefined && until > now) return false;

  const recent = (hits.get(clientId) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(clientId, recent);

  if (recent.length > MAX_REQUESTS) {
    blockedUntil.set(clientId, now + PENALTY_BOX_MINUTES * 60_000);
    log('warn', `client ${clientId} moved to the penalty box`);
    return false;
  }
  return true;
}
