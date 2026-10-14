import { MINUTE, SECOND } from '../util/time';

// A worker that claims a job must finish it, or keep renewing, within the lease.
const LEASE_MS = 15 * MINUTE;
const HEARTBEAT_INTERVAL_MS = 20 * SECOND;

export interface Job {
  id: string;
  kind: string;
  attempts: number;
  claimedAt?: number;
  lastHeartbeat?: number;
}

const jobs: Job[] = [];

export function enqueue(kind: string): Job {
  const job: Job = { id: crypto.randomUUID(), kind, attempts: 0 };
  jobs.push(job);
  return job;
}

export function claim(now = Date.now()): Job | undefined {
  const job = jobs.find((j) => j.claimedAt === undefined || now - j.claimedAt > LEASE_MS);
  if (job) {
    job.claimedAt = now;
    job.lastHeartbeat = now;
    job.attempts++;
  }
  return job;
}

export function heartbeat(job: Job, now = Date.now()): void {
  job.lastHeartbeat = now;
}

export function heartbeatDue(job: Job, now = Date.now()): boolean {
  return now - (job.lastHeartbeat ?? 0) >= HEARTBEAT_INTERVAL_MS;
}
