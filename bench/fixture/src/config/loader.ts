import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ServiceConfig {
  webhooks: { requestTimeoutSeconds: number; maxPayloadKb: number };
  alerts: { cooldownMinutes: number; channel: string };
  shutdown: { gracePeriodSeconds: number };
}

let cached: ServiceConfig | undefined;

export function loadConfig(): ServiceConfig {
  if (cached) return cached;
  const base = join(__dirname, '..', '..', 'config');
  const json = JSON.parse(readFileSync(join(base, 'default.json'), 'utf8'));
  // service.yaml is parsed by the deploy tooling and injected as SERVICE_YAML_JSON.
  const yaml = JSON.parse(process.env.SERVICE_YAML_JSON ?? '{}');
  cached = { ...json, shutdown: { ...(yaml.shutdown ?? {}) } } as ServiceConfig;
  return cached;
}
