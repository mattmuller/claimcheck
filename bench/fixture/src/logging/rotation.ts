import { HOUR } from '../util/time';

/** How often the active log file is closed and a fresh one is opened. */
export const ROTATE_INTERVAL_MS = 6 * HOUR;

export const LOG_RETENTION_DAYS = 90;

export interface ArchivePolicy {
  compressAfterDays: number;
  maxFiles: number;
}

export const archivePolicy: ArchivePolicy = {
  compressAfterDays: 7,
  maxFiles: 30,
};

export function shouldRotate(openedAt: number, now: number): boolean {
  return now - openedAt >= ROTATE_INTERVAL_MS;
}

export function isExpired(fileMtime: number, now: number): boolean {
  const ageDays = (now - fileMtime) / (24 * 60 * 60 * 1000);
  return ageDays > LOG_RETENTION_DAYS;
}

export function shouldCompress(fileMtime: number, now: number): boolean {
  const ageDays = (now - fileMtime) / (24 * 60 * 60 * 1000);
  return ageDays >= archivePolicy.compressAfterDays;
}
