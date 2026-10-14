-- Nightly and periodic maintenance, run by pg_cron.
select cron.schedule(
  'purge-old-events',
  '0 3 * * *',
  $$delete from events where created_at < now() - interval '180 days'$$
);

select cron.schedule(
  'requeue-stuck-jobs',
  '*/10 * * * *',
  $$update jobs set claimed_at = null where claimed_at < now() - interval '1 hour'$$
);
