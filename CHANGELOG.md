# Changelog

All notable changes to this project are listed here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] - 2026-10-14

### Security

- `execute` now refuses a target file that is untracked, a symlink, or outside the repository. It also refuses an absolute path and a path with `..` in it. Before, a claim answer could point the edit at a file you did not mean. (6879c72)
- `execute` stops with an error that names the file if it cannot restore the edited file. Before, a failed restore could leave a changed line in your code without a clear message. (6879c72)
- `execute` restores the edited file when you press Ctrl+C or the process gets SIGTERM. Before, an interrupted run could leave the mutated line in place. (6879c72)
- Checks now run with a short list of environment variables: `PATH`, `HOME`, temp folders, locale and time zone. A variable with `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL` in its name is never passed on. Before, a check could read your API keys. (6879c72)
- claimcheck removes the gateway key from any output it stores. Before, the key could end up in the `--out` folder. (6879c72)
- `prepare` and the value map skip tracked symlinks and paths that resolve outside the repository. Before, a symlink in the target could make claimcheck read a file elsewhere on your machine. (6879c72)
- Claim ids are validated. Before, an id with path characters could write outside the `--out` folder. (6879c72)
- `CLAIMCHECK_GATEWAY_URL` must use https. Plain http works only for localhost. Before, a model key could travel in clear text. (6879c72)
- Git calls on the target ignore `fsmonitor`, hooks, external diff and textconv settings. Before, a repository's own git configuration could run a program when claimcheck called git. (6879c72)
- `execute` never asks git to compare or restore the file it edits. It saves the file's bytes, writes them back itself, and checks them against git's stored copy without running filters. Before, a repository could define clean or smudge filters that git ran during `execute`. (f127cac)
- Report security problems privately through the advisory page. `SECURITY.md` says how and describes what the tool does to your system. (cb8234b)

### Changed

- Dev tooling moves to vitest 5 and vite 7. `npm audit` now reports 0 problems. (6879c72)
- The skill folder `skills/claimcheck` now carries its own `LICENSE`, `README.md` and `SECURITY.md`. (cb8234b)
- The `--json` example in the README shows version 0.1.1. (6879c72)

## [0.1.0] - 2026-10-14

First release. claimcheck checks a written claim about software against the code. It then proves the check can fail.

- Finds periods and numbers in a claim by rules, including numbers written as words such as "fifteen minutes". (2629ca1)
- Finds candidate code in four layers, without a model: patterns for the number in every unit, built-in synonyms, BM25 over split names, and a value map from the TypeScript compiler. Optional `--model-terms` adds model-suggested words. (93f5885)
- Runs the search patterns in-process, so results match on every machine. (93f5885)
- Never loads a module from the repository under inspection. (07d9277)
- Commands: `prepare` finds candidates, `author` writes the check with a model, `execute` runs the check and mutates one line. (99c15f1, 26f62cf)
- Gives one verdict per claim: PROVEN, CONTRADICTED, NO-TEETH, NOT-LOCATED or NOT-CHECKABLE. (99c15f1)
- Uses exit codes that a script can read: 0 clean, 1 at least one CONTRADICTED or NO-TEETH claim, 2 could not check. `--strict` also fails on NOT-LOCATED and NOT-CHECKABLE. (2629ca1)
- Prints one JSON report with `--json`, or writes it to a file with `--json-file`. (2629ca1)
- Ships an Agent Skill in `skills/claimcheck` that teaches an AI agent the whole loop with no API key. (2629ca1)
- Includes a benchmark in `bench/` with 38 claims about a made-up service. `npm run bench` reproduces the numbers in the README. (93f5885)
- Ships as one bundled file, `dist/cli.js`, run with `npx @mattmuller/claimcheck`. (26f62cf)

[Unreleased]: https://github.com/mattmuller/claimcheck/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/mattmuller/claimcheck/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/mattmuller/claimcheck/releases/tag/v0.1.0
