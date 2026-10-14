import { loadConfig } from '../config/loader';
import { nextDelay, shouldRetry } from '../jobs/retryPolicy';
import { log } from '../logging/logger';

const PAYLOAD_RETAIN_DAYS = 7;

const delivery = {
  // After this long without a success we stop trying and park the delivery.
  abandonAfterDays: 3,
};

export interface Delivery {
  id: string;
  url: string;
  firstAttemptAt: number;
  attempts: number;
}

export async function deliver(d: Delivery, body: string): Promise<boolean> {
  const cfg = loadConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.webhooks.requestTimeoutSeconds * 1000);
  try {
    const res = await fetch(d.url, { method: 'POST', body, signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function scheduleRetry(d: Delivery, now = Date.now()): number | null {
  if (now - d.firstAttemptAt > delivery.abandonAfterDays * 86_400_000) {
    log('warn', `delivery ${d.id} abandoned`);
    return null;
  }
  if (!shouldRetry(d.attempts)) return null;
  return now + nextDelay(d.attempts);
}

export function payloadExpired(storedAt: number, now = Date.now()): boolean {
  return now - storedAt > PAYLOAD_RETAIN_DAYS * 86_400_000;
}
