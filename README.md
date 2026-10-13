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
   This is the only step that uses an AI model, and a person can do it instead.
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

## Does it need an AI model?

Only for one step, and that step can be done by hand.

| Step | How it runs |
|---|---|
| Parse the claim | Rules. No model. |
| Locate candidate code | Rules. No model. |
| Write the check | A model, **or** a person or agent session writing `answer.json` by hand. |
| Mutate and rerun | Plain code. No model. |
| Verdict | Plain code. No model. |

The guarantee does not depend on the model. A model can write a weak check, but a weak check
passes on the mutant too and is thrown out as NO-TEETH. It cannot produce a PROVEN on its own.

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
