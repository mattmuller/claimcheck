import { shouldRotate } from './rotation';

// Lines are buffered so we do not hit the disk for every message.
const FLUSH_INTERVAL_MS = 5000;
const MAX_BUFFERED_LINES = 200;

type Level = 'debug' | 'info' | 'warn' | 'error';

const buffer: string[] = [];
let openedAt = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

export function log(level: Level, message: string): void {
  buffer.push(`${new Date().toISOString()} ${level} ${message}`);
  if (buffer.length >= MAX_BUFFERED_LINES) flush();
}

export function flush(): void {
  if (buffer.length === 0) return;
  if (shouldRotate(openedAt, Date.now())) {
    openedAt = Date.now();
  }
  process.stdout.write(buffer.splice(0).join('\n') + '\n');
}

export function startLogger(): void {
  timer = setInterval(flush, FLUSH_INTERVAL_MS);
}

export function stopLogger(): void {
  if (timer) clearInterval(timer);
  flush();
}
