# claimcheck

[![npm version](https://img.shields.io/npm/v/@mattmuller/claimcheck)](https://www.npmjs.com/package/@mattmuller/claimcheck)
[![CI](https://github.com/mattmuller/claimcheck/actions/workflows/ci.yml/badge.svg)](https://github.com/mattmuller/claimcheck/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/npm/l/@mattmuller/claimcheck)](LICENSE)

Checks a written claim about software against the code, then proves the check could have failed.

## Why

- Docs say "logs are kept for 90 days". The code changes. Nobody updates the sentence.
- A test written to back a claim can pass for the wrong reason.
- claimcheck breaks the line the claim depends on (`90` becomes `91`). If the check still passes, it proves nothing and is thrown out.

## Example

Two claims about a small example service. Here `service` is a copy of the example service in `bench/fixture`, in its own git repository. Each claim gets a check. claimcheck runs it on the real code, then on code it has broken on purpose.

```
$ npx @mattmuller/claimcheck execute --repo service --claims claims.json --out results
c1: PROVEN (src/cache/thumbnailCache.ts:3) passes on real code, fails on the mutant
c2: CONTRADICTED (src/jobs/queue.ts:5) the check fails on real code
```

| Claim | The code says | Verdict |
|---|---|---|
| "Cached thumbnails expire after 10 minutes." | `THUMBNAIL_TTL_MS = 10 * MINUTE` | PROVEN |
| "Workers send a heartbeat every 5 seconds." | `HEARTBEAT_INTERVAL_MS = 20 * SECOND` | CONTRADICTED |

The search for the right line was automatic. The two checks were written by hand, as an agent would write them. A model is optional: it can pick the line, write the check and, with `--model-terms`, suggest search words ([Models](docs/models.md)).

Every claim ends in one of five verdicts:

| Verdict | Meaning |
|---|---|
| PROVEN | The check passes on the real code and fails on the broken code. |
| CONTRADICTED | The check fails on the real code: the claim looks false. |
| NO-TEETH | The check passes on both. It is discarded. |
| NOT-LOCATED | No candidate code was found. |
| NOT-CHECKABLE | No reliable result: the claim cannot be written as a check, or the check crashed. |

## Install and first run

You need Node 22 or newer and a git repository. There is nothing to install.

```sh
echo '[{"id":"c1","quote":"Cached thumbnails expire after 10 minutes."}]' > claims.json
npx @mattmuller/claimcheck prepare
```

`prepare` only reads your code. It ranks the lines that could set the value and writes them to `results/work/c1/candidates.json`. On the example service it printed `c1: 1 periods, 18 candidates`. Keep `claims.json` and `results/` out of git.

Next, an agent or a person picks the line and writes a check. The [agent skill](skills/claimcheck/SKILL.md) does this loop for AI coding agents, with no API key. Then `execute` runs the checks and gives the verdicts. See [Usage](docs/usage.md).

## Status

Early research, version 0.2.x. Commands and output will change. On its own benchmark, the search puts the right line in the top 5 for 35 of 35 claims. That benchmark is small and made up. It tests the search, not the verdicts ([details](docs/finding-the-right-line.md)).

`execute` edits one line of your code and restores it. Checks are not sandboxed. Run it on a clean checkout ([Safety](docs/usage.md#safety)).

## Threat model

The code and the SQL that `execute` runs are your own: a check you or your agent wrote, against a repository you chose.
claimcheck contacts **only a database URL you pass with `--sql-url`**, and only on your own machine. It has no default URL and reads no
environment variable for one. SQL checks run through the Postgres driver (no shell, no `psql`), in one transaction that always ends in
`ROLLBACK`, as a plain role. Connect as a dedicated low-privilege role: claimcheck refuses a role with `SUPERUSER`, `CREATEROLE`, `BYPASSRLS` or `REPLICATION`, held directly or through a role it belongs to, and a role that can read files or run programs on the server. They stop if a statement ends the transaction or changes the role. This limits mistakes. It does not make
untrusted code safe: run claimcheck on a repository you do not trust only inside a container. Details: [SQL checks](docs/sql-checks.md#threat-model).

## Learn more

- [How it works](docs/how-it-works.md): the steps, why breaking the code proves the check, what it cannot catch
- [When to use it](docs/when-to-use.md): docs, notices and runbooks that make claims
- [Finding the right line](docs/finding-the-right-line.md): the research and the measurements
- [Models](docs/models.md): where a model helps, and how to skip it
- [Usage](docs/usage.md): commands, options and safety
- [SQL checks](docs/sql-checks.md): claims enforced in SQL, run in a local database that always rolls back
- [Roadmap](docs/roadmap.md): known gaps and what comes next
- [Exit codes and JSON](docs/exit-codes-and-json.md): for scripts and CI
- [Status](docs/status.md), [Contributing](CONTRIBUTING.md), [Security](SECURITY.md), [Changelog](CHANGELOG.md)

## Licence

[MIT](LICENSE)

AI agents: read [AGENTS.md](AGENTS.md).
