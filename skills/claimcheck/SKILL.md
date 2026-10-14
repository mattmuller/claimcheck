---
name: claimcheck
description: Checks written claims about software (a number of seconds, minutes, days, a size or a count) against the real code, and proves each check could fail. Use this whenever a user asks whether a README, runbook, privacy notice, terms page, API doc, design note or code comment still matches the code, wants claims with numbers verified before a release, or asks "is it really 10 minutes?" about something a document promises. Also use it to audit documentation an agent just wrote. You do the judging yourself, so no API key is needed.
---

# claimcheck

claimcheck takes a claim such as "Cached thumbnails expire after 10 minutes." and decides whether the
code does that. The tool finds candidate lines and runs the checks. You, the agent, are the model:
you choose the line and write the check. The tool then breaks that line on purpose to prove the check
depends on it.

Run it from the claimcheck folder: `npx tsx src/cli.ts <command> ...`. Below, `CC` stands for that.

## The loop

Set `REPO` (the project to inspect), `OUT` (a scratch folder outside REPO) and `CLAIMS` (`$OUT/claims.json`).

1. **Write `claims.json`**: `[{ "id": "c1", "quote": "Cached thumbnails expire after 10 minutes." }]`.
   Copy each sentence exactly. One fact per claim. Split "X after 5 minutes and Y after 2 hours".
2. **Prepare**: `CC prepare --repo $REPO --claims $CLAIMS --out $OUT --json`.
   Read the JSON from stdout. Per claim you get the periods found and the top 5 candidates.
   The full list of 25 is in `$OUT/work/<id>/candidates.json`. The prompt is `$OUT/work/<id>/author.prompt.txt`.
3. **For each claim, decide** (read `author.prompt.txt` first, then open the candidate files):
   - Which line sets the value the claim talks about? Read the code around it, not only the line.
   - If no candidate sets it, the answer is `notLocated`. Do not stretch.
   - If the claim needs a database, network or secret to run, the answer is `notCheckable`.
4. **Write a behavioural check**: a TypeScript file that imports the real code and calls the function
   that uses the value. Assert with `node:assert`. Run it yourself with `npx tsx <file>` from REPO. Save a copy at `$OUT/checks/<id>.check.ts`; `execute` writes the same file from `checkSource`.
5. **Name the token**: the exact text on that line that carries the value, such as `600` or `'14 days'`.
6. **Write `$OUT/work/<id>/answer.json`** (shape below).
7. **Commit REPO**. `execute` refuses to mutate a file with uncommitted changes.
8. **Execute**: `CC execute --repo $REPO --claims $CLAIMS --out $OUT --json`. Read the verdicts.
9. **Report** each claim: id, verdict, the located `file:line`, and the reason. For CONTRADICTED, say
   what the code does instead (read `realRun.output` in `work/<id>/result.json`).

Use `--only <id>` to rerun one claim. Use `--strict` when a gap must fail the run.

## answer.json

```json
{ "subject": "thumbnail cache lifetime",
  "target": { "file": "src/cache/thumbnailCache.ts", "line": 3, "token": "10" },
  "notLocated": false, "notCheckable": false,
  "checkKind": "behavioural",
  "checkSource": "import assert from 'node:assert';\n...",
  "notes": "why this line" }
```

For no line: `"target": null, "notLocated": "what you looked for and did not find"`.
For no possible check: `"notCheckable": "why"`. `file` is relative to REPO. `line` starts at 1.

## Rules, and why they exist

- **Only an `AssertionError` counts as the claim being wrong.** The tool treats any other crash
  (bad import, missing module) as NOT-CHECKABLE. A broken check must never convict the code.
  So use `assert`, and make the check run clean before you save it.
- **Import absolute paths.** The check file is saved in `$OUT/checks/`, not inside REPO, so a relative
  import such as `../src/x` will not resolve. Import `<REPO>/src/x` as a full path.
- **Never fake a database, network or clock service to get a result.** A mock that returns what the
  claim expects proves only that the mock is right. If the code cannot run without one, answer
  `notCheckable` and say what is missing. A pure helper, a config loader or a timer is fine to call.
- **Reject a line that only shares the number.** A `3` in a probe timeout does not set a retry
  period of three days. The search ranks numbers highly, so the first candidate is often a decoy.
  If the line does not mean what the claim means, in every part, answer `notLocated`.
- **Check the whole claim, not just the number.** Unit, what starts the period, who it applies to.
  "Kept for 90 days" is not "deleted after 90 days". If a part has no matching code, the check must fail on it.
- **Call the code, do not read the constant.** A check that only asserts the constant's value tests
  the constant, not the behaviour the claim describes. Call the function that consumes the value, with
  an input just before and just after the boundary (`10 min - 1 ms` is kept, `10 min + 1 ms` is gone).
- **Write the check as plain CommonJS-safe TypeScript.** No top-level `await`: the file is not in a
  module package, so `tsx` rejects it. Wrap async work in `(async () => { ... })()`. Use `await import()`
  inside it when you must clear an environment variable first (`delete process.env.X`) so the
  code's own default is what you test.
- **The check must read the named token.** The tool changes only that token (`600` becomes `601`) and
  reruns. If the check still passes, the verdict is NO-TEETH: the check never looked at that value.
  Pick the token that the behaviour really depends on, and pick a boundary input that notices a change of one.
- **A false claim is a result, not a failure.** If the code says 20 seconds and the claim says 5,
  write the check that asserts 5 seconds and let it fail. That gives CONTRADICTED. Do not soften
  the assertion to make it pass. Do not answer `notLocated` when you found the line that disproves it.
- **Never edit the target code, and never run `execute` yourself on a dirty tree.** The tool mutates
  and restores files with git. Edits you leave behind will be thrown away or will block the run.

## Verdicts and exit codes

| Verdict | Meaning | What you tell the user |
|---|---|---|
| PROVEN | Check passes on real code, fails on the mutant | The claim holds, and here is the line |
| CONTRADICTED | Check fails on real code | The claim looks false, and here is what the code does |
| NO-TEETH | Check passes on both | Not verified. Fix the check, then rerun |
| NOT-LOCATED | No line sets this value | Not verified. A person must read it |
| NOT-CHECKABLE | Cannot run as a check | Not verified. State why |

Exit codes of `execute`: `0` no CONTRADICTED or NO-TEETH, `1` at least one of those (or a gap with
`--strict`), `2` could not check (bad arguments, missing claims file, not a git repo, dirty target).
On `2`, read the one-line message on stderr and fix the setup. Do not treat it as a verdict.

Do not report NO-TEETH, NOT-LOCATED or NOT-CHECKABLE as "true". Say "not verified".
Before you give a NO-TEETH claim up, try once to improve the check: call the code with an input
that sits right at the boundary, then rerun that claim with `--only`.
