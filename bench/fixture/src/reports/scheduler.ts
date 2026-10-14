import { WEEK, MINUTE } from '../util/time';
import { log } from '../logging/logger';

const DEFAULT_PAGE_SIZE = 30;
const REPORT_LOOKBACK_MS = 2 * WEEK;

// Required in production; see config/.env.example.
const MAX_RUNTIME_MINUTES = parseInt(process.env.REPORT_MAX_RUNTIME_MINUTES ?? '', 10);
const RETRY_DELAY_MIN = parseInt(process.env.REPORT_RETRY_DELAY_MIN ?? '8', 10);

export interface ReportWindow {
  from: number;
  to: number;
}

export function currentWindow(now = Date.now()): ReportWindow {
  return { from: now - REPORT_LOOKBACK_MS, to: now };
}

export async function runReport(
  build: (w: ReportWindow, page: number, size: number) => Promise<boolean>,
): Promise<void> {
  const controller = new AbortController();
  const killer = setTimeout(() => controller.abort(), MAX_RUNTIME_MINUTES * MINUTE);
  let page = 0;
  try {
    while (!controller.signal.aborted && (await build(currentWindow(), page, DEFAULT_PAGE_SIZE))) page++;
  } finally {
    clearTimeout(killer);
  }
}

export function retryAt(now = Date.now()): number {
  log('info', `report failed, retrying in ${RETRY_DELAY_MIN} minutes`);
  return now + RETRY_DELAY_MIN * MINUTE;
}
