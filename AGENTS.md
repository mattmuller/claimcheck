# Instructions for AI coding agents

This file is for any AI agent that uses claimcheck or works in this repository. Humans: read [README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

Part 1 covers using the tool. Part 2 covers changing this repository.

## Part 1: using claimcheck

### What it does

claimcheck checks a written claim that contains a number with a unit (a period, a limit, a size or a count) against the code. It proves each check can fail by breaking one line. It cannot check a claim without a number, such as "passwords are stored hashed".

### Use the skill

`skills/claimcheck/SKILL.md` teaches an agent the whole loop. Read it before you run anything. The agent is the model, so no API key is needed. Copy or link the folder `skills/claimcheck` into your skills directory.

### Commands

Node 22 or newer. Run `npx @mattmuller/claimcheck <command>`. From a clone, run `npm ci`, then `npx tsx src/cli.ts <command>`.

| Command | Input | Writes | Edits the repo |
|---|---|---|---|
| `prepare` | `--claims` file | `<out>/work/<id>/parse.json`, `candidates.json`, `author.prompt.txt` | No |
| `author` | same, plus `CLAIMCHECK_MODEL` and `AI_GATEWAY_API_KEY` | the same files, plus `answer.json` from the model | No |
| `execute` | `--claims` file and an `answer.json` per claim | `<out>/work/<id>/result.json`, `<out>/checks/<id>.check.ts` | Yes, one line, restored afterwards |

Options: `--repo <path>` (default `.`), `--claims <file>` (default `claims.json`), `--out <dir>` (default `results`), `--only <id>`, `--json`, `--json-file <path>`. `execute` also takes `--strict`. `prepare` and `author` also take `--model-terms`. `claimcheck --help`, `claimcheck <command> --help` and `claimcheck --version` print help and the version.

`claims.json` is `[{ "id": "c1", "quote": "Cached thumbnails expire after 10 minutes." }]`. An id uses letters, digits, dot, underscore and hyphen, at most 64 characters, and starts with a letter or digit. Copy each sentence exactly. Use one fact per claim.

The `answer.json` shape is in `skills/claimcheck/SKILL.md`. Every option is in the table in [docs/usage.md](docs/usage.md#options).

### Exit codes

- `execute` returns 0 when no claim is CONTRADICTED or NO-TEETH, 1 when at least one is, and 2 when it could not check. With `--strict`, a NOT-LOCATED or NOT-CHECKABLE claim also gives 1. `prepare` and `author` return 0 or 2.
- On 2, read the messages and fix the setup. Most go to stderr. Per-claim `execute` errors go to stdout, or to stderr with `--json`. A 2 is not a verdict.
- A claim with no `answer.json` yet is reported as NOT-CHECKABLE.

### JSON

- Add `--json` to get one JSON object on stdout. Human lines go to stderr. `--json-file <path>` writes the same object to a file.
- Top level: `tool`, `version`, `command`, `repo`, `exitCode`, `claims`. `execute` adds `summary` and `errors`. A run that could not start has `error` and an empty `claims`.
- `execute` claim rows: `id`, `quote`, `class`, `reason`, `located`, `checkKind`, `mutationDiff`.
- `prepare` claim rows: `id`, `quote`, `periods`, `promptFile`, and the top 5 `candidates`.
- The full shape, with an example, is in [docs/exit-codes-and-json.md](docs/exit-codes-and-json.md).

### SQL checks

When the value lives in SQL and the user gives you a local database URL, use `checkKind: "sql"` and run `execute --sql-url <url>`. Never ask for, guess or reuse a database URL the user did not give you. Connect as a dedicated low-privilege role. See [docs/sql-checks.md](docs/sql-checks.md).

### Limits

- The target must be a git repository, and the file to mutate must be tracked.
- The search skips tests, lock files, snapshots, build output and documentation.
- A check is not sandboxed. It runs as you. For a repository you do not trust, run claimcheck in a container or as a throwaway user.
- Checks see a short list of environment variables. Names with `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL` are never passed on.
- A check can pass both runs and still test the wrong thing. Read the check before you trust a PROVEN.

### Do not

- Run `execute` only on a clean checkout. It refuses a file that differs from the git index in any byte. On Windows, run `git config core.autocrlf false` and make a fresh checkout, because `core.autocrlf=true` rewrites line endings and the file no longer matches.
- Do not run `execute` on a tree with uncommitted changes. Commit first. It edits one line of one file and writes the original bytes back afterwards.
- Do not report NO-TEETH, NOT-LOCATED or NOT-CHECKABLE as true. Say "not verified".
- Do not mock a database, network or clock service to get a result. Answer `notCheckable` and say what is missing.
- Do not soften a check to turn CONTRADICTED into PROVEN.
- Do not commit the `--out` folder. It can hold output from the code under test.
- After an interrupted run, run `git status` in the target. A `kill -9` can leave the mutated line behind.

## Part 2: working in this repository

### Safety rule

**Never run `execute` against a repository you have not committed.** `execute` edits one line of one file in the target repository to build a mutant. It then writes the original bytes back. It refuses a file with uncommitted changes, so your edits are safe, but an interrupted run can leave the mutated line: check `git status` afterwards. Commit or stash first. Run it on a clean checkout, and never on this repository's working tree while you have unsaved changes.

### Setup and commands

Node 22.12 or newer. Run `npm ci` once.

- `npm run type-check` compiles with no output.
- `npm test` runs vitest.
- `npm run bench` runs the benchmark and rewrites `bench/results.json`.
- `npm run build` bundles `dist/cli.js`.

Run type-check, test and build before you say a change is done. The folder map is in [CONTRIBUTING.md](CONTRIBUTING.md#repo-map).

### Rules, and why

1. **Prove every new test can fail.** Break the code under test, see the test go red, then restore the code. A test that never failed may check nothing.
2. **Do not change benchmark claims or tune a weight to them unless the task says so.** If the numbers in `bench/results.json` move, say so in your report. [docs/finding-the-right-line.md](docs/finding-the-right-line.md) quotes those numbers, and CI compares them.
3. **Keep the project generic.** Use neutral subjects in examples, tests and docs: caches, queues, timeouts, log files. Use no company, product or other project names.
4. **Report security problems through [SECURITY.md](SECURITY.md).** Never write an exploit into an issue, a test name or a commit message.
5. **Do not commit, tag, push or publish unless the task asks for it.** The release workflow publishes. A human pushes the tag.
6. **Write short sentences.** One action per sentence. Active voice. No hedging. Lead with the outcome.
