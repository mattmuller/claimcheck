# Usage

You need Node 22 or newer and a git repository to check.

```sh
npx @mattmuller/claimcheck prepare --repo <path> --claims claims.json --out results
npx @mattmuller/claimcheck author  --repo <path> --claims claims.json --out results   # needs a model, see models.md
npx @mattmuller/claimcheck execute --repo <path> --claims claims.json --out results
```

From a clone, run `npm install`, then use `npx tsx src/cli.ts <command> ...` in place of the
`npx @mattmuller/claimcheck <command> ...` above. `npm run bench` runs the search benchmark in
`bench/`; `npm test` runs the tests.

Run `npx @mattmuller/claimcheck --help` for the commands, `<command> --help` for the options of one command, and `--version` for the version.

`prepare` and `author` take `--model-terms` to add model-suggested search words (see [Finding the right line](finding-the-right-line.md#what-we-chose-and-why)).
## Options

| Option | Commands | Meaning |
|---|---|---|
| `--repo <path>` | all | Git repository to check. Default: `.` |
| `--claims <file>` | all | JSON file: `[{ "id": "...", "quote": "..." }]`. Default: `claims.json` |
| `--out <dir>` | all | Folder for work files, checks and results. Default: `results` |
| `--only <id>` | all | Run one claim id from the claims file |
| `--json` | all | Print one JSON report on stdout. Human lines go to stderr |
| `--json-file <path>` | all | Also write the JSON report to a file |
| `--model-terms` | `prepare`, `author` | Add model-suggested search words (needs both `CLAIMCHECK_MODEL` and `AI_GATEWAY_API_KEY`; with only one set, it adds nothing) |
| `--exclude <glob>` | `prepare`, `author` | Leave out files that match a git glob, such as `legacy/**`. Repeat it for more. Adds to the built-in list |
| `--no-default-excludes` | `prepare`, `author` | Drop the built-in exclude list. Only `--exclude` globs apply |
| `--strict` | `execute` | A NOT-LOCATED or NOT-CHECKABLE claim also exits 1 |
| `--sql-url <url>` | `execute` | Run SQL checks in this local Postgres. No default, no environment fallback. See [SQL checks](sql-checks.md) |
| `--sql-role <role>` | `execute` | Run SQL checks as this plain role (`SET LOCAL ROLE`) |
| `--sql-allow-superuser` | `execute` | Run SQL checks even when the role is a superuser or can read files or run programs on the server |
| `-h`, `--help` | all | Show help |
| `-v`, `--version` | none | Show the version |

These come from `claimcheck <command> --help`; the help text names only `CLAIMCHECK_MODEL`, but the model step reads both variables (`src/model.ts`). Exit codes are in [Exit codes and JSON](exit-codes-and-json.md).

## What the search leaves out

The search skips files that never set live behaviour: dependencies, build output, tests, docs and lock files
(see the list in `src/excludes.ts`), plus SQL undo scripts (`*.down.sql`, `rollback/`), schema dumps
(`*schema_reference*.sql`), ad-hoc `scripts/*.sql` and seed data (`seed*.sql`). Add your own with
`--exclude`. A migration whose function a later migration redefines stays in the list, ranked low, with the reason in `why`.

## Claims and the model

`claims.json` is `[{ "id": "...", "quote": "..." }]`. The model is set by `CLAIMCHECK_MODEL`,
called through a compatible model endpoint (`CLAIMCHECK_GATEWAY_URL`, key in
`AI_GATEWAY_API_KEY`). Without a model, a person or agent writes each `answer.json` by hand.

## Agents

**Use it from an AI agent.** `skills/claimcheck/SKILL.md` teaches AI coding agents that read
the Agent Skills format the whole loop. The agent is the model, so no API key is needed. Copy or link
the folder `skills/claimcheck` into the agent's skills directory.

## Safety

`execute` edits files in the target repository to build mutants and writes the original
bytes back afterwards. Run it on a clean checkout you do not mind being touched.

The working file must match the git index byte-for-byte. Uncommitted edits, line-ending
conversion (`core.autocrlf=true` on Windows) and clean/smudge filters all make it differ, and
`execute` then refuses. On Windows run `git config core.autocrlf false` and check out again.

A check is not sandboxed: it is code (often written by a model that read the target repository)
running as you. For a repository you do not trust, run claimcheck in a container or as a throwaway
user. See [SECURITY.md](../SECURITY.md).
