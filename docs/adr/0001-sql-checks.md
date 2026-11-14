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

Four rules keep it safe:

1. **Opt in, local only.** The database comes from `--sql-url` and nowhere else. There is no default and no environment fallback.
   Any host other than `localhost`, `127.0.0.1`, `::1` or a socket path is refused.
2. **Always rolls back.** All SQL runs in one transaction built by claimcheck: `BEGIN`, the files, the check, `ROLLBACK`. Before sending,
   it drops a bare `BEGIN` or `COMMIT` and refuses any other transaction control, any psql backslash command and `COPY ... PROGRAM`.
   The scan ignores comments, strings, quoted names and dollar-quoted bodies.
3. **The mutant lives in memory.** The mutated text goes to the database and nothing is written to the repository. The git-restore step of 0.1 is not needed.
4. **No new dependency.** The runner calls the `psql` command line. The password goes to `psql` in the environment, never on the command line.

## Consequences

- A PROVEN SQL claim means: the files, applied to a scratch database, satisfy the check, and a one-unit change to the located value breaks it.
  It does not mean the deployed database matches the files. The docs say so.
- The guard is a lexical scan, not a SQL parser. It errs toward refusing. A script it refuses can be rewritten, or the claim stays NOT-CHECKABLE.
- A scratch database is still real code execution as the user in the URL. The docs say to use a throwaway database.
- The ROLLBACK promise has tests. They check that every script sent ends in `ROLLBACK`, and that each refused statement is refused before the runner is called.
  They use a fake runner and a fake `psql`, so they need no database.

## Not done

- A real-database test of the rollback. The runner has no such test, because it would need a database in CI.
- Mutating SQL operators (`<` to `<=`) and other non-numeric tokens. See the roadmap.
