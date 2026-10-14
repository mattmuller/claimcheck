import { log } from '../logging/logger';

const poolSettings = {
  max: 20,
  // Connections idle for longer than this are closed to free server slots.
  evictIdleAfterSec: 300,
};

const CONNECT_TIMEOUT_MS = Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 4000);

interface Conn {
  id: number;
  lastUsed: number;
}

const idle: Conn[] = [];

export function reapIdle(now = Date.now()): number {
  const before = idle.length;
  for (let i = idle.length - 1; i >= 0; i--) {
    if (now - idle[i].lastUsed > poolSettings.evictIdleAfterSec * 1000) idle.splice(i, 1);
  }
  const closed = before - idle.length;
  if (closed) log('info', `closed ${closed} idle connections`);
  return closed;
}

export function connectDeadline(now = Date.now()): number {
  return now + CONNECT_TIMEOUT_MS;
}
