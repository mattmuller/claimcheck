# Roadmap

Known gaps, taken from the first run on a large repository (22 claims from legal text). Nothing here is built yet.
Each item says what happened and what a fix looks like. Items are in rough order of value.

## Search

- **No-number claims search by words alone.** A claim such as "We count only full days" has no number. The parser reads "1 period" from the word "days" and ranks every `interval '1 day'` line.
  Fix: report no period when the unit has no number, rank by BM25 alone, and print "no value found; searched by words".
- **Bare second and millisecond totals inside strings.** "Kept for 24 hours" is `Max-Age=86400` in a template string.
  Fix: add the plain second and millisecond totals, with and without `_` separators, as search forms for every period.
- **Counts and ordinals are not values.** "At most 20 versions", "the 31st day" and "five wrong attempts" give 0 periods.
  Fix: a count form (number plus noun) and ordinals in `src/parse.ts`, carried through `src/locate.ts`.
- **The index may be rebuilt per claim.** `prepare` took about 11 seconds a claim on a large repository, and `--json` prints nothing until the end.
  Fix: build the index once per run, show progress on stderr, and document the expected time per claim.

## Checks

- **Mutation is numeric or unit words only.** A rule such as "full days only" is `Math.floor`, and `mutatedLine` cannot target it.
  Fix: operator swaps (`floor` and `ceil`, `<` and `<=`, `min` and `max`), and say in `SKILL.md` that a non-numeric token is allowed.
- **A static check for SQL.** The 0.2 runner needs a database. A cheaper, weaker class could mutate the token and run a pattern over the named function.
  It must be reported as its own class, never as PROVEN.

## Setup and reporting

- **Dependencies in a clean checkout.** A check imports the target's real code, and a clean clone of a multi-package repository has no `node_modules` or workspace links.
  Fix: a "multi-package repositories and dependencies" section in `docs/usage.md` (`git worktree add` plus an install), and a warning when a check's imports resolve outside `--repo`.
- **Claims carry no source.** `{ "id", "quote" }` has no place for the document and field a claim came from.
  Fix: pass unknown claim keys through to `result.json` and the report. Add an `extract` command that lists sentences with a number and a unit from `.md` and `.txt`.
- **Hand-verified claims have nowhere to go.** A person who verifies a NOT-CHECKABLE claim by reading cannot record it.
  Fix: an optional `manualReview: { verdict, file, line, by }` in `answer.json`, printed beside NOT-CHECKABLE and marked as a person's reading, not a proof.

## Scope

- **Negative and scope claims.** "We do not send X to Y", "reports are deleted with the account" and "never" claims have no number. A mutated number cannot prove them.
  They need a different proof, such as a call-graph or data-map check. Until then, `docs/when-to-use.md` should list what a privacy notice contains that claimcheck does not cover.
