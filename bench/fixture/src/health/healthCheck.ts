import { SECOND } from '../util/time';
import { loadConfig } from '../config/loader';
import { log } from '../logging/logger';

const CHECK_INTERVAL_MS = 30 * SECOND;
const PROBE_TIMEOUT_MS = 3000;

type Probe = () => Promise<void>;

const lastAlert = new Map<string, number>();

async function withTimeout(p: Probe): Promise<boolean> {
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), PROBE_TIMEOUT_MS));
  return Promise.race([p().then(() => true, () => false), timeout]);
}

export function startHealthChecks(probes: Record<string, Probe>): () => void {
  const cooldownMs = loadConfig().alerts.cooldownMinutes * 60_000;
  const handle = setInterval(async () => {
    for (const [name, probe] of Object.entries(probes)) {
      if (await withTimeout(probe)) continue;
      const last = lastAlert.get(name) ?? 0;
      if (Date.now() - last > cooldownMs) {
        lastAlert.set(name, Date.now());
        log('error', `health probe ${name} failed`);
      }
    }
  }, CHECK_INTERVAL_MS);
  return () => clearInterval(handle);
}
