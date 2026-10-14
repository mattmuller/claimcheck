# Contributing

Thank you for helping. This page tells you how to set up, which commands to run, and the rules each change must follow.

## Set up

You need Node 22.12 or newer.

```sh
git clone https://github.com/mattmuller/claimcheck.git
cd claimcheck
npm ci
```

## Commands

| Command | What it does |
|---|---|
| `npm run type-check` | Runs the TypeScript compiler with no output. |
| `npm test` | Runs the test suite with vitest. |
| `npm run bench` | Runs the search benchmark and rewrites `bench/results.json`. |
| `npm run build` | Bundles `src/cli.ts` into `dist/cli.js`. |

Run type-check, test and build before you open a pull request. CI runs them on Node 22 and 24.

## House rules

**1. Prove every new test can fail.** Break the code the test covers. Run the test. See it go red. Restore the code. A test that has never failed may check nothing, and claimcheck itself exists to catch that mistake. Write "yes" in the pull request template when you did this.

**2. Do not change the benchmark claims, and do not tune a weight to them, without saying so in the PR.** The numbers in the README come from `bench/`. A weight chosen by trying values on the same claims flatters the result. CI compares the hit and MRR numbers with the committed `bench/results.json` and fails when they differ. If your change moves them on purpose, commit the new `bench/results.json` and explain why in the description.

**3. Keep the project generic.** Examples, claims, fixtures and docs use neutral subjects such as caches, queues, timeouts and log files. Use no company, product or other project names. This keeps the tool and its documentation usable by anyone.

**4. Send security reports through [SECURITY.md](SECURITY.md), not issues.** A public issue shows an attack before there is a fix. Use the private advisory page that file links to.

## Writing style

Write short sentences. Put one action in each sentence. Use the active voice. Say "will" or "must", not "may" or "should". Lead with the outcome.

## Releasing

Only a maintainer releases. The steps are:

1. Bump `version` in `package.json` (run `npm version <x.y.z> --no-git-tag-version`).
2. Move the "Unreleased" entries in `CHANGELOG.md` under a new `## [x.y.z] - date` heading. Update the links at the bottom.
3. Commit and merge to `main`.
4. Tag the commit `vX.Y.Z` and push the tag.

The release workflow does the rest. It checks that the tag equals the package version, runs the tests, builds, publishes to npm with provenance, and creates the GitHub release from that version's changelog section. The workflow uses npm trusted publishing, so no npm token is stored.
