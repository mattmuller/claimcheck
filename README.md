# claimcheck

> **Early draft.** This is research code under active development. The interface, verdicts and
> results will change. Do not rely on it yet, and run it only on code you are happy to have copied
> and executed.

READMEs, runbooks, comments and design notes make claims about how code behaves: "cache entries
expire after 10 minutes", "a request times out after 30 seconds", "log files rotate every 7 days",
"retries stop after 5 attempts". claimcheck checks a claim against the code and proves its own check
is meaningful.

For each claim it:

1. **Parses** the claim. Periods and numbers are found by rules, not by a model.
2. **Locates** candidate code by rules first: the number in every equivalent unit, constant names,
   SQL intervals, cron schedules and configuration keys. A model may only rank what was found.
3. **Writes a check**: a small executable test that exercises the located code, not just its literal.
   This is the only step that uses an AI model, and a person can do it instead. The model also picks
   which located line is the right one and names the value on it.
4. **Proves the check has teeth**: it mutates exactly the located token (60 becomes 61), reruns the
   check, and restores the file. A check that still passes on the mutant proves nothing.
5. **Gives a verdict** from a fixed set:

| Verdict | Meaning |
|---|---|
| PROVEN | The check passes on the real code and fails on the mutant. |
| CONTRADICTED | The check fails on the real code: the claim looks false. |
| NO-TEETH | The check passes on both. It is discarded. |
| NOT-LOCATED | No candidate code was found. |
| NOT-CHECKABLE | The claim cannot be expressed as an executable check. |

## When would you use it?

Anywhere a document makes a promise that the code has to keep. The more people rely on the
document, and the less they can see the code, the more a wrong sentence costs.

| Where the claim is written | Example claim | Why checking it matters |
|---|---|---|
| Privacy notices and data-retention statements | "Server logs are kept for 90 days." | Data protection law requires these statements to be accurate. A regulator, auditor or customer reads the notice, never the code. |
| Terms of service and service-level documents | "Uploads larger than 50 MB are rejected." "A request times out after 30 seconds." | Users and customers act on these terms, and a contract that does not match the product is a dispute waiting to happen. |
| Security and compliance pages | "Idle sessions end after 15 minutes." | Auditors and security questionnaires take these as evidence. A drifted setting turns a true answer into a false one. |
| API reference documentation | "Each client may send 100 requests per minute." "Results come back in pages of 50." | Integrators build to the documented numbers. A silent change breaks them. |
| Runbooks and operations guides | "Backups run every 6 hours and the newest 30 are kept." | People make recovery decisions from runbooks during an incident, the worst time to find out they are wrong. |
| Documentation written by AI agents | Any of the above, drafted by an agent from the code | An agent can describe code confidently and wrongly. A claim it cannot prove is a claim a person should read. |
| Before a release, in CI | The same claims, re-run on every change | A setting changed in code months after the document was written is the usual way these drift. |

It is most useful where the claim is a number with a unit: a period, a limit, a size or a count.
It cannot yet check claims without one, such as "passwords are stored hashed".

## How it works, step by step

One claim, followed through every step: **"Server logs are kept for 90 days."**

**1. Parse (rules, no model).** Regular expressions find every number with a unit, including
words such as "ninety" or "a year". This claim gives one period: 90 days.

**2. Work out every way the code could write it (rules, no model).** Code rarely says "90 days".
The same period is listed in every unit that gives a whole number: 90 days, 2,160 hours,
129,600 minutes, 7,776,000 seconds and 7,776,000,000 milliseconds.

**3. Search the code (rules, no model).** `git grep` looks for each form, and scores every hit:

| Pattern found | Example it matches | Score |
|---|---|---|
| The number next to a unit word | `LOG_RETENTION_DAYS = 90`, `days: 90` | high |
| A SQL interval | `interval '90 days'` | high |
| A large literal in seconds or milliseconds | `7776000`, `7_776_000_000` | medium |
| The number multiplied by unit factors | `90 * 24 * 60 * 60 * 1000` | medium |
| A setting name with the number | `retention: 90`, `max_age=90` | medium |
| The bare number on a line that shares a word with the claim | `const logs = 90` | low |

Tests, lock files, JSON, snapshots and documentation are skipped, so the search finds code, not
other descriptions of the code. The result is a short ranked list of lines. Nothing here guesses.

**4. Choose the line and write a check (the one model step).** The model, or a person, gets the
claim and the ranked lines and does three things:
- picks the line that really sets the period, or answers "not located" if none does. A line that
  only happens to hold the same number must be rejected;
- writes a small test that calls the code which uses that value, rather than just reading the
  constant. For this claim: create a log entry, move the clock to day 89 and check it is still
  there, then to day 91 and check it is gone;
- names the exact text on that line to change, for example `90`.

**5. Run the check on the real code (plain code, no model).** Only a failed assertion counts as
the claim being wrong. If the check crashes for any other reason (an import error, a missing
database), the claim is marked NOT-CHECKABLE, never CONTRADICTED.

**6. Break the code on purpose and run the check again (plain code, no model).** The named text
is changed on that one line only, `90` to `91`, the check runs again, and the file is restored.
Nothing else in the code base is touched.

**7. Decide (plain code, no model).**

| Real code | Broken code | Verdict |
|---|---|---|
| passes | fails | **PROVEN**: the check depends on exactly the value the claim is about. |
| fails | (not run) | **CONTRADICTED**: the code does not do what the claim says. |
| passes | passes | **NO-TEETH**: the check never looked at that value, so it proves nothing. |
| crashes | (any) | **NOT-CHECKABLE** |

### Why breaking the code proves the check

A check can pass for the wrong reason. Suppose the model writes `assert.equal(90, 90)`, or
tests a different setting that also happens to be 90. Both pass on the real code. But when `90`
becomes `91` on the located line, both still pass, so the claim is marked NO-TEETH and thrown out.
Only a check that really reads the located value fails on the broken copy. The model can propose
a check, but only the code's own behaviour can make a claim PROVEN.

### What it cannot catch yet

A check can still depend on the right value and test the wrong thing. For example, it might check
that logs are deleted after 90 days when the claim said they are *kept* for 90 days. A second,
independent review step for this is planned. Claims with no number in them, such as "passwords
are stored hashed", are out of scope for now.

## Does it need an AI model?

Only for one step, and that step can be done by hand.

| Step | How it runs |
|---|---|
| Parse the claim | Rules. No model. |
| Locate candidate code | Rules. No model. |
| Choose the line and write the check | A model, **or** a person or agent session writing `answer.json` by hand. It picks one of the located lines, names the value to change, and writes the check. |
| Mutate and rerun | Plain code. No model. |
| Verdict | Plain code. No model. |

A model cannot produce a PROVEN on its own: the check must also fail when the located code is
broken. A check that never touches that code passes on the mutant and is thrown out as NO-TEETH.
A check can still test the wrong thing and pass both rules, which is why a second, independent
review step is planned.

## Status

Early research. A first spike on 20 hand-labelled claims about time periods gave 11 PROVEN and
5 CONTRADICTED, with no claim labelled false marked PROVEN. Its two wrong verdicts were claims
with two parts, where the check covered only one part.

## Use

```sh
npm install
npx tsx src/cli.ts prepare --repo <path> --claims claims.json --out results
npx tsx src/cli.ts author  --repo <path> --claims claims.json --out results   # needs a model, see below
npx tsx src/cli.ts execute --repo <path> --claims claims.json --out results
```

`claims.json` is `[{ "id": "...", "quote": "..." }]`. The model is set by `CLAIMCHECK_MODEL`,
called through an OpenAI-compatible endpoint (`CLAIMCHECK_GATEWAY_URL`, key in
`AI_GATEWAY_API_KEY`). Without a model, a person or agent writes each `answer.json` by hand.

`execute` edits files in the target repository to build mutants and restores them with
`git checkout`. Run it on a clean checkout you do not mind being touched.

## Licence

MIT
