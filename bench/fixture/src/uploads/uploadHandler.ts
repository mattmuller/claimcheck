import { log } from '../logging/logger';

export const UPLOAD_TIMEOUT_SECONDS = 120;
const CHUNK_TIMEOUT_MS = 20_000;
const MAX_UPLOAD_MB = 50;

// Signed links are handed to browsers; keep them short lived.
const SIGNED_URL_TTL_SECONDS = Number(process.env.SIGNED_URL_TTL_SECONDS ?? 900);

export interface UploadSession {
  id: string;
  startedAt: number;
  lastChunkAt: number;
  bytes: number;
}

export function signedUrlExpiry(now = Date.now()): number {
  return now + SIGNED_URL_TTL_SECONDS * 1000;
}

export function checkSession(session: UploadSession, now = Date.now()): 'ok' | 'slow' | 'timeout' {
  if (now - session.startedAt > UPLOAD_TIMEOUT_SECONDS * 1000) return 'timeout';
  if (now - session.lastChunkAt > CHUNK_TIMEOUT_MS) return 'slow';
  if (session.bytes > MAX_UPLOAD_MB * 1024 * 1024) return 'timeout';
  return 'ok';
}

export function onChunk(session: UploadSession, size: number): void {
  session.lastChunkAt = Date.now();
  session.bytes += size;
  log('debug', `upload ${session.id} received ${size} bytes`);
}
