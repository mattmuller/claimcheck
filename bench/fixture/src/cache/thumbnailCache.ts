import { MINUTE } from '../util/time';

const THUMBNAIL_TTL_MS = 10 * MINUTE;
const MAX_THUMBNAILS = 500;
// Browsers may reuse a stale thumbnail for this many seconds while we refetch.
const STALE_WHILE_REVALIDATE_SECONDS = 30;

interface Entry {
  bytes: Uint8Array;
  storedAt: number;
}

const entries = new Map<string, Entry>();

export function putThumbnail(key: string, bytes: Uint8Array, now = Date.now()): void {
  if (entries.size >= MAX_THUMBNAILS) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(key, { bytes, storedAt: now });
}

export function getThumbnail(key: string, now = Date.now()): Uint8Array | undefined {
  const hit = entries.get(key);
  if (!hit) return undefined;
  if (now - hit.storedAt > THUMBNAIL_TTL_MS) {
    entries.delete(key);
    return undefined;
  }
  return hit.bytes;
}

export function cacheControlHeader(): string {
  return `public, max-age=${THUMBNAIL_TTL_MS / 1000}, stale-while-revalidate=${STALE_WHILE_REVALIDATE_SECONDS}`;
}

export function sweepExpired(now = Date.now()): number {
  let removed = 0;
  for (const [key, entry] of entries) {
    if (now - entry.storedAt > THUMBNAIL_TTL_MS) {
      entries.delete(key);
      removed++;
    }
  }
  return removed;
}
