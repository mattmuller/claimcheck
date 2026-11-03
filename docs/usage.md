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
| `--strict` | `execute` | A NOT-LOCATED or NOT-CHECKABLE claim also exits 1 |
| `-h`, `--help` | all | Show help |
| `-v`, `--version` | none | Show the version |

These come from `claimcheck <command> --help`; the help text names only `CLAIMCHECK_MODEL`, but the model step reads both variables (`src/model.ts`). Exit codes are in [Exit codes and JSON](exit-codes-and-json.md).

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
