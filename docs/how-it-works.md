# How claimcheck works

This page follows one claim through every step. It also says why breaking the code proves the check, and what the tool cannot catch.

READMEs, runbooks, comments and design notes make claims about how code behaves: "cache entries
expire after 10 minutes", "a request times out after 30 seconds", "log files rotate every 7 days",
"retries stop after 5 attempts". claimcheck checks a claim against the code and proves its own check
is meaningful.

For each claim it:

1. **Parses** the claim. Periods and numbers are found by rules, not by a model.
2. **Locates** candidate code without a model: the number in every equivalent unit, SQL intervals
   and configuration keys, then a word-ranking search over the code's own names, then a map of how
   values flow between files. See [Finding the right line](finding-the-right-line.md).
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

## How it works, step by step

One claim, followed through every step: **"Server logs are kept for 90 days."**

**1. Parse (rules, no model).** Regular expressions find every number with a unit, including
words such as "ninety" or "a year". This claim gives one period: 90 days.

**2. Work out every way the code could write it (rules, no model).** Code rarely says "90 days".
The same period is listed in every unit that gives a whole number: 90 days, 2,160 hours,
129,600 minutes, 7,776,000 seconds and 7,776,000,000 milliseconds.

**3. Search the code (no model).** Three layers each add and rank lines. First, patterns look for
each form and score every hit:

| Pattern found | Example it matches | Score |
|---|---|---|
| The number next to a unit word | `LOG_RETENTION_DAYS = 90`, `days: 90` | high |
| A SQL interval | `interval '90 days'` | high |
| A large literal in seconds or milliseconds | `7776000`, `7_776_000_000` | medium |
| The number multiplied by unit factors | `90 * 24 * 60 * 60 * 1000` | medium |
| A setting name with the number | `retention: 90`, `max_age=90` | medium |
| The bare number on a line that shares a word with the claim | `const logs = 90` | low |

Then a word-ranking search finds lines whose names mean what the claim means, and a value map
finds values built from other constants or read from configuration. Both are described in [Finding the right line](finding-the-right-line.md).
Tests, lock files, snapshots, build output and documentation are skipped, so the search finds code,
not other descriptions of the code. Configuration files (JSON, YAML, `.env` examples) are searched.
The result is a short ranked list of lines, each with the reason it was found.

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

## Why breaking the code proves the check

A check can pass for the wrong reason. Suppose the model writes `assert.equal(90, 90)`, or
tests a different setting that also happens to be 90. Both pass on the real code. But when `90`
becomes `91` on the located line, both still pass, so the claim is marked NO-TEETH and thrown out.
Only a check that really reads the located value fails on the broken copy. The model can propose
a check, but only the code's own behaviour can make a claim PROVEN.

## What it cannot catch yet

A check can still depend on the right value and test the wrong thing. For example, it might check
that logs are deleted after 90 days when the claim said they are *kept* for 90 days. A second,
independent review step for this is planned. Claims with no number in them, such as "passwords
are stored hashed", are out of scope for now.
