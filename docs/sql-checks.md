# SQL checks

Use a SQL check when the claim is enforced in SQL, and a TypeScript check cannot import the code. An example is
"Sessions expire after 30 days", where the rule is `interval '30 days'` inside a `purge_sessions()` function.

The check runs in a **local** Postgres that you name. It runs inside one transaction that always ends in `ROLLBACK`.
The mutant is built in memory, so no file in your repository changes.

## What you need

- `psql` on your `PATH`.
- A local database you can write to and throw away. A scratch database or a local container is fine.
- `--sql-url postgres://user:password@localhost:5432/scratch` on `execute`.

claimcheck connects to nothing else. It has no default URL and reads no environment variable for one.
It refuses any host that is not `localhost`, `127.0.0.1`, `::1` or a socket path.

## The answer

Set `checkKind` to `"sql"`. Put the SQL in `sql`. `target` names the token to mutate, as for any other check.

```json
{ "subject": "session lifetime",
  "target": { "file": "db/migrations/003_sessions.sql", "line": 6, "token": "'30 days'" },
  "notLocated": false, "notCheckable": false,
  "checkKind": "sql",
  "sql": {
    "files": ["db/migrations/003_sessions.sql"],
    "check": "do $$ begin assert (select prosrc from pg_proc where proname = 'purge_sessions') like '%interval ''30 days''%', 'sessions are purged after 30 days'; end $$;"
  } }
```

- `files` are the tracked SQL files to apply, in order. They must include the target file. The default is the target file alone.
- `check` is SQL that fails with `ASSERT` when the claim does not hold. Only an assertion failure (SQLSTATE `P0004`)
  counts as the claim being wrong. Any other error means the check could not run, and the verdict is NOT-CHECKABLE.
- A stronger check calls the function. Insert a row dated 29 days ago and one dated 31 days ago, call `purge_sessions()`, and assert on what is left.

## What runs

```
BEGIN;
SET LOCAL statement_timeout = '30s';
<each file, in order>
<the check>
ROLLBACK;
```

It runs twice: once on the real files, once with the target line mutated.

## What it refuses

claimcheck refuses a script before it sends anything when the script could end the transaction early or reach outside the database:

- `COMMIT`, `ROLLBACK`, `ABORT`, `SAVEPOINT`, `RELEASE`, `PREPARE TRANSACTION`, `COMMIT PREPARED`, or a `BEGIN` or `START TRANSACTION` with options.
- A psql backslash command, such as `\!`.
- `COPY ... PROGRAM`.

A bare `BEGIN;` or `COMMIT;` in a migration is dropped, so a migration written for a deploy tool still runs.
Keywords inside function bodies, strings and comments do not count.

## What it does not prove

- **A deployed database.** The check proves what your files define. It does not prove that a migration ran in production, or that a scheduled job fires.
- **Isolation.** The script is code, and it runs as the user in your URL. Use a throwaway database. Do not point it at data you care about, even locally.
- **Side effects outside the transaction.** Sequences advance, and extensions or other statements that act outside a transaction are not undone. A scratch database makes this harmless.
