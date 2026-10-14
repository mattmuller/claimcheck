# Changelog

All notable changes to this project are listed here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.2] - 2026-10-14

### Added

- `claimcheck --help`, `-h` and `help` print the commands and options. `claimcheck <command> --help` prints the options and exit codes of one command, and does nothing else.
- `claimcheck --version` and `-v` print the version.

### Changed

- An unknown command, or no command, now points you to `claimcheck --help`. The exit code is still 2.

## [0.1.1] - 2026-10-14

### Security

- `execute` now refuses a target file that is untracked, a symlink, or outside the repository. It also refuses an absolute path and a path with `..` in it. Before, a claim answer could point the edit at a file you did not mean. (6879c72)
- `execute` stops with an error that names the file if it cannot restore the edited file. Before, a failed restore could leave a changed line in your code without a clear message. (6879c72)
- `execute` restores the edited file when you press Ctrl+C or the process gets SIGTERM. Before, an interrupted run could leave the mutated line in place. (6879c72)
- Checks now run with a short list of environment variables: `PATH`, `HOME`, temp folders, locale and time zone. A variable with `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL` in its name is never passed on. `NODE_OPTIONS` is not passed either. Before, a check could read your API keys from its environment variables, and `NODE_OPTIONS` could load code into the check's node process. (6879c72)
- claimcheck removes the gateway key from any output it stores. Before, the key could end up in the `--out` folder. (6879c72)
- `prepare` and the value map skip tracked symlinks and paths that resolve outside the repository. Before, a symlink in the target could make claimcheck read a file elsewhere on your machine. (6879c72)
- Claim ids are validated. Before, an id with path characters could write outside the `--out` folder. (6879c72)
- `CLAIMCHECK_GATEWAY_URL` must use https. Plain http works only for localhost. Before, a model key could travel in clear text. (6879c72)
- Git calls on the target ignore `fsmonitor`, hooks, external diff and textconv settings. Before, a repository's own git configuration could run a program when claimcheck called git. (6879c72)
- `execute` never asks git to compare or restore the file it edits. It saves the file's bytes, writes them back itself, and checks them against git's stored copy without running filters. Before, a repository could define clean or smudge filters that git ran during `execute`. (f127cac)
- `execute` also restores the edited file on SIGHUP and SIGQUIT, not only Ctrl+C and SIGTERM. Before, closing the terminal could leave the mutated line in place. SIGKILL cannot be caught, so a `kill -9` can still leave it: run `git status` in the target after a hard kill.
- Checks run asynchronously, each in its own process group. A stop signal or the 120 s timeout kills the whole group, then restores the file. Before, a stop waited for the check to finish, and a process the check started could outlive it and edit the file again. Where the group cannot be used (Windows), only the check itself is killed.
- Git calls use `--literal-pathspecs`. Before, a target such as `src/*.ts` was read as a pattern and could name a different file than the one that was mutated.
- Path checks use `path.relative` instead of a string prefix on the real path. Before, a prefix test could mis-judge a path that is not inside the repository.
- When the file differs from the git index, the refusal says it differs byte-for-byte and names the likely causes (uncommitted edits, line-ending conversion such as `core.autocrlf`, clean/smudge filters). `execute` needs a checkout whose working files match the index exactly. Before, the message said only "uncommitted changes".
- The value-map step reads files through a compiler host that refuses any path whose real path is outside the repository. Before, a `tsconfig` `paths` entry or a relative import could make it read a file elsewhere on your machine.
- The restore refuses to write through a path that a check replaced with a symlink, and stops with an error that names the file. Before, it wrote the saved bytes through the link.
- A check is not sandboxed. It is code, often written by a model that read the target repository, running as you with your files within reach. For code you do not trust, run claimcheck in a container or as a throwaway user. `SECURITY.md` now says so.
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

[Unreleased]: https://github.com/mattmuller/claimcheck/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/mattmuller/claimcheck/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/mattmuller/claimcheck/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/mattmuller/claimcheck/releases/tag/v0.1.0
