import { startLogger, stopLogger } from './logging/logger';
import { startCacheSweeper } from './cache/sweeper';
import { startTempCleaner } from './uploads/tempCleaner';
import { startHealthChecks } from './health/healthCheck';
import { loadConfig } from './config/loader';

const stops = [
  startCacheSweeper(),
  startTempCleaner(),
  startHealthChecks({ db: async () => {}, queue: async () => {} }),
];
startLogger();

process.on('SIGTERM', () => {
  const grace = loadConfig().shutdown.gracePeriodSeconds;
  setTimeout(() => process.exit(1), grace * 1000).unref();
  stops.forEach((stop) => stop());
  stopLogger();
});
