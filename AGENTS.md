# Instructions for AI coding agents

This file is for any AI coding agent that works in this repository. Humans: read [CONTRIBUTING.md](CONTRIBUTING.md).

## Safety rule

**Never run `execute` against a repository you have not committed.** `execute` edits one line of one file in the target repository to build a mutant. It then writes the original bytes back. It refuses a file with uncommitted changes, so your edits are safe, but an interrupted run can leave the mutated line: check `git status` afterwards. Commit or stash first. Run it on a clean checkout, and never on this repository's working tree while you have unsaved changes.

## Setup and commands

Node 22.12 or newer. Run `npm ci` once.

- `npm run type-check` compiles with no output.
- `npm test` runs vitest.
- `npm run bench` runs the benchmark and rewrites `bench/results.json`.
- `npm run build` bundles `dist/cli.js`.

Run type-check, test and build before you say a change is done.

## Rules, and why

1. **Prove every new test can fail.** Break the code under test, see the test go red, then restore the code. A test that never failed may check nothing.
2. **Do not change benchmark claims or tune a weight to them unless the task says so.** If the numbers in `bench/results.json` move, say so in your report. The README quotes those numbers, and CI compares them.
3. **Keep the project generic.** Use neutral subjects in examples, tests and docs: caches, queues, timeouts, log files. Use no company, product or other project names.
4. **Report security problems through [SECURITY.md](SECURITY.md).** Never write an exploit into an issue, a test name or a commit message.
5. **Do not commit, tag, push or publish unless the task asks for it.** The release workflow publishes. A human pushes the tag.
6. **Write short sentences.** One action per sentence. Active voice. No hedging. Lead with the outcome.

## Repo map

`src/`

- `cli.ts`: command-line entry. Parses arguments, runs `prepare`, `author` and `execute`, sets exit codes, prints `--json`.
- `parse.ts`: finds periods and numbers in a claim, including numbers written as words.
- `locate.ts`: combines the search layers and ranks candidate lines.
- `corpus.ts`: lists the tracked, safe, regular files the search reads.
- `excludes.ts`: paths the search skips (tests, lock files, build output, docs).
- `bm25.ts`: BM25 ranking over split identifier names.
- `terms.ts`: splits identifiers and text into words, and holds the built-in synonym table.
- `expand.ts`: optional model-suggested search words (`--model-terms`) and their cache.
- `graph.ts`: value map built with the TypeScript compiler.
- `prompt.ts`: the prompts sent to the model in `author`.
- `model.ts`: the model call and gateway URL checks.
- `mutate.ts`: edits one token on one line, runs the check, restores the file.
- `verdict.ts`: runs the check and turns results into a verdict.
- `gitutil.ts`: safe git calls and the safe-file test.

Other folders:

- `test/`: vitest tests. `security.test.ts` pins the safety behaviour.
- `bench/`: the search benchmark, its fixture service and `results.json`.
- `scripts/`: CI helpers (`compare-bench.mjs`, `changelog-section.mjs`).
- `skills/claimcheck/`: the Agent Skill for claimcheck itself.
- `.github/`: CI, release workflow, issue and pull request templates.
