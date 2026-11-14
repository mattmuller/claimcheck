# SQL checks

Use a SQL check when the claim is enforced in SQL, and a TypeScript check cannot import the code. An example is
"Sessions expire after 30 days", where the rule is `interval '30 days'` inside a `purge_sessions()` function.

The check runs in a **local** Postgres that you name. It runs inside one transaction that always ends in `ROLLBACK`.
The mutant is built in memory, so no file in your repository changes.

## What you need

- A local database you can write to and throw away. A scratch database or a local container is fine.
- `--sql-url postgres://user:password@localhost:5432/scratch` on `execute`.
- A dedicated low-privilege role to connect as. It must not be a superuser, belong to a superuser role, have `CREATEROLE`,
  or hold `pg_read_server_files`, `pg_write_server_files` or `pg_execute_server_program`. The connection is the security boundary.
- Optional: `--sql-role <role>`, an extra layer. The run does `SET LOCAL ROLE` to it. The same limits apply to that role.
  It is not a boundary on its own, because a script that runs `RESET ROLE` would lift it. The probe below catches that.

claimcheck connects to nothing else. It has no default URL and reads no environment variable for one.
It refuses any host that is not `localhost`, `127.0.0.1`, `::1` or a socket path.

claimcheck checks the session user first. If it is too powerful, it refuses to run and says why.
`--sql-allow-superuser` runs anyway and prints a warning. The SQL then has the full power of that role: it can read and write server files, run programs and commit data. Use it only on a database you can lose.

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
BEGIN
SET LOCAL standard_conforming_strings = on
SET LOCAL statement_timeout = '30s'
SET LOCAL ROLE <role>            -- only when --sql-role is given (an extra layer)
<each statement of each file, one at a time>
<each statement of the check, one at a time>
ROLLBACK                         -- always sent, last, whatever happened
```

It runs twice: once on the real files, once with the target line mutated.

- **No shell.** The Postgres driver (`pg`) sends the SQL. `psql` is never started, so a backslash meta-command is only text that the server rejects.
- **One command per message.** Each statement goes as a named prepared statement. The server refuses a message that holds more than one command.
- **A probe after every statement.** claimcheck reads `pg_current_xact_id()`, `current_user` and `session_user` after each statement. If any changed, a statement ended the
  transaction or switched role. The run stops, says which statement, and says its changes may have been committed.

## Threat model

The SQL is yours, and claimcheck only ever contacts the database URL you pass. The rest limits damage from a mistake:

| Risk | What stops it |
|---|---|
| A script commits its changes | The scanner refuses `COMMIT` and its relatives before sending. The probe catches any that get past the scanner. The scanner is a first-line refusal with a clear message, not the guarantee |
| Hidden commands in quoting tricks | The scanner reads `E'...'` escapes, dollar quotes and nested comments as the server does. The probe covers what it misses |
| Reading or writing server files, running programs | `COPY`, `lo_import`, `lo_export`, `dblink*`, `pg_read_file`, `pg_read_binary_file`, `pg_ls_*` are refused. The connecting role must have no file or program privileges, and the run refuses a role that is a superuser, belongs to one or can create roles |
| A script lifting its own privileges | The connecting role is plain, so there is nothing to lift to. `SET ROLE`, `RESET ROLE`, `SET SESSION AUTHORIZATION` and `set_config` are refused as well, and the probe checks `current_user` and `session_user` after every statement |
| A connection to another machine | Only a local URL is accepted. Every connection field is set explicitly, so `PG*` environment variables cannot redirect it |

Not covered: SQL that builds a command as a string and runs it (`EXECUTE` in a function) can hide a file function from the scanner. The low-privilege role is what stops it. That is why the role matters.
A committed change cannot be undone by claimcheck. Use a throwaway database.

## What it does not prove

- **A deployed database.** The check proves what your files define. It does not prove that a migration ran in production, or that a scheduled job fires.
- **Isolation.** The script is code, and it runs with the privileges of the role you give. Use a throwaway database. Do not point it at data you care about, even locally.
- **Side effects outside the transaction.** Sequences advance, and extensions or other statements that act outside a transaction are not undone. A scratch database makes this harmless.
