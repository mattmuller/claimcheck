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
2. **Locates** candidate code without a model: the number in every equivalent unit, SQL intervals
   and configuration keys, then a word-ranking search over the code's own names, then a map of how
   values flow between files. See [Finding the right line](#finding-the-right-line).
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
finds values built from other constants or read from configuration. Both are described below.
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

## Finding the right line

Every later step depends on this one. If the line that sets the value is not in the list, the best
check-writer in the world can only answer NOT-LOCATED. The hard part is that code rarely says what
the claim says:

| The claim says | The code says |
|---|---|
| "Idle connections are closed after five minutes." | `evictIdleAfterSec: 300` |
| "Thumbnails expire after 10 minutes." | `THUMBNAIL_TTL_MS = 10 * MINUTE`, with `MINUTE` in another file |
| "Signed links stop working after fifteen minutes." | `Number(process.env.SIGNED_URL_TTL_SECONDS ?? 900)` |
| "Alerts are muted for 90 minutes." | `"cooldownMinutes": 90` in a JSON file read elsewhere |
| "Workers send a heartbeat every 5 seconds." (false) | `HEARTBEAT_INTERVAL_MS = 20 * SECOND` |

The last row matters most. When a claim is false, its number is usually nowhere in the code, so a
search for the number cannot find the line that proves it false.

### What we chose, and why

The usual answer to "search code by meaning" is a vector database of embeddings, or a graph
database of the code. We looked at the research before building either, and built neither:

- **Agents that search well mostly search plainly.** Claude Code does not index a code base at
  all; it chooses what to look for and runs a text search, partly because an index goes stale the
  moment the code changes ([vadim.blog](https://vadim.blog/claude-code-no-indexing/);
  [SmartScope](https://smartscope.blog/en/ai-development/practices/rag-debate-agentic-search-code-exploration/)).
- **Embeddings win on average, not everywhere.** On CoIR, the main code-retrieval benchmark, large
  embedding models beat BM25 overall, but BM25 stays strong where exact names and numbers matter
  ([Li et al., 2024](https://arxiv.org/html/2407.02883v3)). Claims are full of exact numbers.
- **A small graph is enough.** LocAgent finds the code a bug report is about with a lightweight
  in-memory graph of files, functions, imports and calls, built per run
  ([Chen et al., ACL 2025](https://aclanthology.org/2025.acl-long.426.pdf)). RepoGraph shows the same
  at line level ([Ouyang et al., 2024](https://arxiv.org/html/2410.14684v1)). CodexGraph needs a
  Neo4j server for the same job ([Liu et al.](https://www.researchgate.net/publication/392505894_CodexGraph_Bridging_Large_Language_Models_and_Code_Repositories_via_Code_Graph_Databases)).
- **Model-written search terms can help retrieval**
  ([query expansion for code search, 2025](https://www.sciencedirect.com/science/article/abs/pii/S0164121225002511)),
  so we tried it, and kept it only as far as our own measurements supported it (below).

So the search is a ladder. Each rung is cheap and runs in the process. None needs a server, an index on disk or a package the tool did not already have:

1. **Patterns.** The number in every unit, next to a unit word, in a SQL interval, multiplied by
   unit factors, or beside a setting name. These run as JavaScript regular expressions over the
   tracked files, so they mean the same thing on every machine.
2. **Built-in synonyms.** A small table of words that name the same idea in infrastructure code:
   *kept, retain, retention, ttl*; *expire, evict, purge, sweep*; *idle, inactivity, timeout*.
   A synonym counts at half weight, so it can find a line but never outrank the claim's own words.
3. **BM25 over split names.** `evictIdleAfterSec` becomes *evict idle after sec*, so the code's
   names can be compared with the claim's words. Each line is scored with BM25, the ranking formula
   behind most search engines, together with the two lines above it (usually its comment) and the
   words of its file path. It is about 100 lines of code, with no index on disk. BM25 also adds
   lines that match the claim's words but hold a *different* number: that is how a false claim
   finds the line that proves it false.
4. **A value map from the TypeScript compiler.** For TypeScript and JavaScript projects, claimcheck
   asks the TypeScript compiler to work out the
   value of each constant: `10 * MINUTE` across an import, a default behind `process.env.X ?? 900`,
   a property of an imported JSON file, a helper such as `minutes(15)`. A value that equals the
   claim's period is reported at the line holding the number a person would change. It also lists
   where that constant is used, so the check can call the real behaviour. The compiler is
   claimcheck's own copy, which it already had for its own build. It only reads the target's files
   and never loads a module from the target, so preparing a check runs none of the target's code.
5. **Model-suggested words (off by default).** With `--model-terms`, a model lists words a
   programmer might use for the claim's subject. They count at half weight. On our benchmark they
   did not help, so they are not used unless asked for.
6. **Embeddings: not built.** Only worth adding if a benchmark shows a gap the rungs above cannot
   close. This one does not, yet.

### What it measured

`bench/` holds a small made-up service (22 files: TypeScript, JSON, YAML, SQL) and 38 claims about
it, each labelled with the line that sets its value. A separate agent wrote it without seeing the
search code, so the search could not be shaped around it. 35 claims have a right line; 3 describe
something the code does not do. `npm run bench` reproduces every number here.

| Search | Right line first | In the top 5 | In the top 10 | Time, 35 claims |
|---|---|---|---|---|
| First draft, as committed, on macOS | 6% | 6% | 6% | 2.5 s |
| First draft, regex bug fixed | 49% | 63% | 63% | 2.1 s |
| 1. Patterns, in-process | 51% | 69% | 69% | 0.02 s |
| 1–3. + synonyms and BM25 | 71% | 100% | 100% | 0.15 s |
| 1–4. + value map | **74%** | **100%** | **100%** | 1.2 s |
| 1–5. + model-suggested words | 74% | 97% | 100% | 0.9 s |

The first draft used `git grep -E`. On macOS that uses the system's POSIX regex library, which
does not read `\b` (a word boundary) or `[^\n]` the way the patterns meant, so it found almost
nothing and said nothing about it. The benchmark found that on its first run. The second row is
the fair starting point.

By the kind of claim (right line in the top 5, before and after):

| Kind | Example | Fixed first draft | Now |
|---|---|---|---|
| Number and unit together | `LOG_RETENTION_DAYS = 90` | 3 of 3 | 3 of 3 |
| Different words | "given up on after three days" vs `abandonAfterDays: 3` | 1 of 5 | 5 of 5 |
| Different unit | "2 hours" vs `7_200_000` | 4 of 4 | 4 of 4 |
| Built from other constants | `10 * MINUTE` | 5 of 5 | 5 of 5 |
| In a configuration file | `"cooldownMinutes": 90` | 2 of 4 | 4 of 4 |
| Default behind an environment variable | `?? 900` | 2 of 3 | 3 of 3 |
| SQL interval or schedule | `interval '180 days'`, `'*/10 * * * *'` | 2 of 4 | 4 of 4 |
| Same number used elsewhere too | a 30-day period next to a page size of 30 | 3 of 4 | 4 of 4 |
| **False claim** (different value in code) | "every 5 seconds" vs `20 * SECOND` | **0 of 3** | **3 of 3** |

The last row is the reason for the work. Before it, claimcheck could not find the line that makes a
false claim false, so it could only say NOT-LOCATED where it should say CONTRADICTED.

**Read these numbers with care.** The benchmark is small and made up. One setting, the weight
given to BM25, was chosen by trying five values on this benchmark, which flatters the result a
little. The right line is not always first: different wording still ranks it second to fifth, and
a schedule written as a cron expression carries few words to match. The value map is a small
gain here, because most of these values were also findable by words; it matters most when a
value's name shares nothing with the claim. A second benchmark, on real open-source code, is next.

## Does it need an AI model?

Only for one step, and that step can be done by hand.

| Step | How it runs |
|---|---|
| Parse the claim | Rules. No model. |
| Locate candidate code | Patterns, BM25 and the compiler's value map. No model, unless you ask for `--model-terms`. |
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
npm run bench   # the search benchmark in bench/
npm test
```

`prepare` and `author` take `--model-terms` to add model-suggested search words (see above).

`claims.json` is `[{ "id": "...", "quote": "..." }]`. The model is set by `CLAIMCHECK_MODEL`,
called through an OpenAI-compatible endpoint (`CLAIMCHECK_GATEWAY_URL`, key in
`AI_GATEWAY_API_KEY`). Without a model, a person or agent writes each `answer.json` by hand.

`execute` edits files in the target repository to build mutants and restores them with
`git checkout`. Run it on a clean checkout you do not mind being touched.

## Licence

MIT
