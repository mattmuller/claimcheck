# Finding the right line

This page covers the search step: why it matters, what the research said, what was built and what it measured.

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

## What we chose, and why

The usual answer to "search code by meaning" is a vector database of embeddings, or a graph
database of the code. We looked at the research before building either, and built neither:

- **Agents that search well mostly search plainly.** A leading coding agent does not index a code base at
  all; it chooses what to look for and runs a text search, partly because an index goes stale the
  moment the code changes ([a blog post](https://vadim.blog/claude-code-no-indexing/);
  [a second write-up](https://smartscope.blog/en/ai-development/practices/rag-debate-agentic-search-code-exploration/)).
- **Embeddings win on average, not everywhere.** On CoIR, the main code-retrieval benchmark, large
  embedding models beat BM25 overall, but BM25 stays strong where exact names and numbers matter
  ([Li et al., 2024](https://arxiv.org/html/2407.02883v3)). Claims are full of exact numbers.
- **A small graph is enough.** One research agent finds the code a bug report is about with a lightweight
  in-memory graph of files, functions, imports and calls, built per run
  ([Chen et al., ACL 2025](https://aclanthology.org/2025.acl-long.426.pdf)). A second system shows the same
  at line level ([Ouyang et al., 2024](https://arxiv.org/html/2410.14684v1)). A third needs a
  graph database server for the same job ([Liu et al.](https://www.researchgate.net/publication/392505894_CodexGraph_Bridging_Large_Language_Models_and_Code_Repositories_via_Code_Graph_Databases)).
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

## What it measured

`bench/` holds a small made-up service (22 files: TypeScript, JSON, YAML, SQL) and 38 claims about
it, each labelled with the line that sets its value. A separate agent wrote it without seeing the
search code, so the search could not be shaped around it. 35 claims have a right line; 3 describe
something the code does not do. `npm run bench` reproduces every number here.

| Search | Right line first | In the top 5 | In the top 10 | Time, 35 claims |
|---|---|---|---|---|
| First draft, as committed, on macOS | 6% | 6% | 6% | 3.4 s |
| First draft, regex bug fixed | 51% | 69% | 69% | 2.2 s |
| 1. Patterns, in-process | 60% | 74% | 74% | 0.03 s |
| 1–3. + synonyms and BM25 | 74% | 100% | 100% | 0.15 s |
| 1–4. + value map | **77%** | **100%** | **100%** | 1.1 s |
| 1–5. + model-suggested words | 74% | 97% | 100% | 0.7 s |

The first draft used `git grep -E`. On macOS that uses the system's POSIX regex library, which
does not read `\b` (a word boundary) or `[^\n]` the way the patterns meant, so it found almost
nothing and said nothing about it. The benchmark found that on its first run. The second row is
the fair starting point. Every row uses today's claim parser, which also reads numbers written as
words, such as "fifteen minutes" or "half an hour".

By the kind of claim (right line in the top 5, before and after):

| Kind | Example | Fixed first draft | Now |
|---|---|---|---|
| Number and unit together | `LOG_RETENTION_DAYS = 90` | 3 of 3 | 3 of 3 |
| Different words | "given up on after three days" vs `abandonAfterDays: 3` | 2 of 5 | 5 of 5 |
| Different unit | "2 hours" vs `7_200_000` | 4 of 4 | 4 of 4 |
| Built from other constants | `10 * MINUTE` | 5 of 5 | 5 of 5 |
| In a configuration file | `"cooldownMinutes": 90` | 2 of 4 | 4 of 4 |
| Default behind an environment variable | `?? 900` | 3 of 3 | 3 of 3 |
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

## Sources

The claims and their labelled lines are in `bench/claims.json`. Every figure above comes from `bench/results.json`, written by `npm run bench`. Times differ between machines. CI compares the other figures with the committed file.
