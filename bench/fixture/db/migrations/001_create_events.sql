-- Append-only event log plus request de-duplication keys.
create table events (
  id          bigserial primary key,
  kind        text        not null,
  payload     jsonb       not null,
  created_at  timestamptz not null default now()
);

create index events_created_at_idx on events (created_at);

create table request_keys (
  key         text primary key,
  response    jsonb,
  expires_at  timestamptz not null default now() + interval '48 hours'
);
