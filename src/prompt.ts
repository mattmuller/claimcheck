import type { Candidate } from './locate';
import type { Period } from './parse';

/** One prompt covers ranking and check-writing. It carries the claim and the located candidates only. */
export function authorPrompt(claim: string, periods: Period[], cands: Candidate[], checkPath: string): string {
  const list = cands.map((c, i) => `${i}. ${c.file}:${c.line}  [score ${c.score}; ${c.why}]\n     ${c.text}`).join('\n');
  return `You verify written claims about software against its source code.

CLAIM:
${claim}

PERIODS FOUND IN THE CLAIM: ${periods.map((p) => p.text).join(' | ') || '(none)'}

CANDIDATE CODE (found by text search, ranked by a heuristic; the heuristic can be wrong):
${list || '(none)'}

Do this in order.
1. Say in one phrase what the period applies to (the subject).
2. Read the candidates in the repository and decide which line, if any, sets the period the claim talks about.
   If none does, answer notLocated. Do not pick a line only because it holds the same number.
   Check that the code means what the claim means, in every part of the claim, not only the number.
3. Write a small executable check, a TypeScript file run with "npx tsx". It will be saved at ${checkPath}.
   It must import the located code and call the function that uses the value; prefer behaviour to reading a constant.
   Use node:assert. It must throw an AssertionError when the claim does not hold, exit 0 when it holds,
   and assert every part of the claim that code can show (the number, the unit, what starts the period,
   what happens at the end, who it applies to). If a part of the claim has no matching code, the check must fail on it.
   Use relative imports from the check file's location. Run it yourself with "npx tsx ${checkPath}" before you answer.
   If the code under test cannot be imported or run without a database, a network, or secrets, do not fake it.
   Answer notCheckable with the reason.
4. Name the token to mutate: the exact text on the located line that carries the value (for example "60" or "'14 days'").
   Mutating it must change what your check sees. Nothing else will be mutated.

ANSWER with one JSON object, and nothing else:
{"subject": "...", "target": {"file": "path", "line": 12, "token": "60"} | null,
 "notLocated": false | "reason", "notCheckable": false | "reason",
 "checkKind": "behavioural" | "literal", "checkSource": "full source of the check file",
 "notes": "what you decided and why"}`;
}
