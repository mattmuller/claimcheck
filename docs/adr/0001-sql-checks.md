# ADR 0001: check claims enforced in SQL

Status: accepted for 0.2.0. Date: 2026-11-14.

## Context

claimcheck 0.1 runs a TypeScript check, then mutates one token and runs the check again. A claim whose value lives in SQL
(`interval '30 days'` in a function, a cron schedule) ended as NOT-CHECKABLE, because a TypeScript check cannot import it.
First real use on a large repository: 15 of 22 retention and deletion claims ended that way.

## Options

1. **A static check.** Mutate the token and run a regular expression over the function body. It needs no database. It also proves
   little: a pattern that matches text says nothing about what the function does.
2. **A Postgres runner.** Apply the files to a database, run a check written in SQL, mutate the token, run again. It proves behaviour.
   It needs a database, and it runs code.
3. **Do nothing.** Leave these claims NOT-CHECKABLE.

## Decision

Build option 2 as an optional runner, and keep the static check as a roadmap item. A database is the only honest way to say what SQL does.

The runner keeps the 0.1 verdicts and the 0.1 proof. The check passes on the real files, fails on the mutant, and only an
assertion failure counts as a failure.

Five rules keep it safe:

1. **Opt in, local only.** The database comes from `--sql-url` and nowhere else. There is no default and no environment fallback.
   Any host other than `localhost`, `127.0.0.1`, `::1` or a socket path is refused. Every connection field is set explicitly.
2. **No shell.** The runner uses the `pg` driver. It never starts `psql`, so there are no backslash meta-commands. (An early draft used `psql` and a keyword filter.
   A security review showed a filter cannot be the guarantee, so the design changed.) `pg` is the one new dependency, loaded only when `--sql-url` is used.
3. **Always rolls back, and notices when it cannot.** The runner sends `BEGIN`, then each statement alone as a named prepared statement (the server refuses a message with more than one command),
   then `ROLLBACK`, always last. After every statement it probes `pg_current_xact_id()`, `current_user` and `session_user`. A change means a statement ended the transaction or changed role. The run stops and says so.
   The statement scanner stays as a first-line refusal with a clear message. It reads `E''` escapes and dollar quotes as the server does, and is not what the guarantee rests on.
4. **The connection is the boundary.** `SET ROLE` on a superuser session is not a limit, because the script can `RESET ROLE`. So the runner refuses when `session_user` is a superuser,
   belongs to one (checked with `pg_has_role` against every superuser role), has `CREATEROLE`, or holds `pg_read_server_files`, `pg_write_server_files` or `pg_execute_server_program`.
   `--sql-allow-superuser` overrides it, with a loud warning. `--sql-role` stays as an extra layer, with the same limits on that role. The probe also compares `session_user`.
   `COPY` and file and server functions are refused as well.
5. **The mutant lives in memory.** The mutated text goes to the database and nothing is written to the repository.

## Consequences

- A PROVEN SQL claim means: the files, applied to a scratch database, satisfy the check, and a one-unit change to the located value breaks it.
  It does not mean the deployed database matches the files. The docs say so.
- The guard is a lexical scan, not a SQL parser. It errs toward refusing. A script it refuses can be rewritten, or the claim stays NOT-CHECKABLE.
- A scratch database is still real code execution as the user in the URL. The docs say to use a throwaway database.
- The ROLLBACK and probe promises have tests against a stand-in connection that tracks a transaction id and a role. They need no database.
- A statement that commits is detected after it ran, not prevented. The scanner is the only thing that stops it first. That is why the docs say to use a throwaway database.

## Not done

- A real-database test of the runner. It has none, because it would need a database in CI. The "one command per message" rule relies on documented Postgres behaviour and is not tested here.
- Mutating SQL operators (`<` to `<=`) and other non-numeric tokens. See the roadmap.
