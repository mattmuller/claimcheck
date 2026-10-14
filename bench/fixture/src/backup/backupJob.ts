import { log } from '../logging/logger';

const SHARD_COUNT = 30;
const BACKUP_RETENTION_DAYS = 30;
const VERIFY_TIMEOUT_MINUTES = 45;

export interface BackupSet {
  id: string;
  createdAt: number;
  verified: boolean;
}

export function shardFor(key: string): number {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) % SHARD_COUNT;
  return h;
}

export function expiredBackups(sets: BackupSet[], now = Date.now()): BackupSet[] {
  const cutoff = now - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return sets.filter((s) => s.createdAt < cutoff);
}

export async function verifyBackup(set: BackupSet, run: () => Promise<boolean>): Promise<boolean> {
  const limit = VERIFY_TIMEOUT_MINUTES * 60 * 1000;
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), limit));
  const ok = await Promise.race([run(), timeout]);
  log(ok ? 'info' : 'error', `backup ${set.id} verification ${ok ? 'passed' : 'failed'}`);
  return ok;
}
