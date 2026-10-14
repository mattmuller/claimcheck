// claimcheck <prepare|execute|author> --repo <path> --claims <json: [{id, quote}]> --out <dir> [--model-terms]
//   prepare: parse + locate; writes <out>/work/<id>/{parse,candidates}.json and author.prompt.txt
//   execute: reads <out>/work/<id>/answer.json, runs the check, the mutant, decides the class
//   author : same as a person filling answer.json, but asks the model named by CLAIMCHECK_MODEL
// Flags: --json (one JSON object on stdout, human lines on stderr), --json-file <path>, --strict, --only <id>
// Exit codes (pytest convention): 0 nothing wrong, 1 a claim looks false (or --strict gap), 2 could not check.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { expandTerms } from './expand';
import { differsMessage, git, unchanged } from './gitutil';
import { locate } from './locate';
import { askModel, modelAvailable } from './model';
import { parsePeriods } from './parse';
import { authorPrompt } from './prompt';
import { type Answer, type Class, decide } from './verdict';

const COMMANDS = ['prepare', 'author', 'execute'];
const CLASSES: Class[] = ['PROVEN', 'CONTRADICTED', 'NO-TEETH', 'NOT-LOCATED', 'NOT-CHECKABLE'];
const [cmd, ...rest] = process.argv.slice(2);
const opt = (k: string) => { const i = rest.indexOf(`--${k}`); return i < 0 ? undefined : rest[i + 1]; };
const flag = (k: string) => rest.includes(`--${k}`);
const asJson = flag('json');
// with --json, stdout carries the report and nothing else
const say = (s: string) => (asJson ? console.error(s) : console.log(s));

const COMMON = `Options:
  --repo <path>        Git repository to check. Default: .
  --claims <file>      JSON file: [{ "id": "...", "quote": "..." }]. Default: claims.json
  --out <dir>          Folder for work files, checks and results. Default: results
  --only <id>          Run one claim id from the claims file
  --json               Print one JSON report on stdout; human lines go to stderr
  --json-file <path>   Also write the JSON report to a file
  -h, --help           Show help`;
const HELP: Record<string, string> = {
  prepare: `Usage: claimcheck prepare [options]

Parse each claim and locate candidate lines. Writes <out>/work/<id>/parse.json,
candidates.json and author.prompt.txt. Edits nothing in the repository.

${COMMON}
  --model-terms        Add model-suggested search words (needs CLAIMCHECK_MODEL)

Exit codes: 0 done, 2 could not check.
`,
  author: `Usage: claimcheck author [options]

Same as prepare, then asks the model named by CLAIMCHECK_MODEL to write
<out>/work/<id>/answer.json. Needs AI_GATEWAY_API_KEY and CLAIMCHECK_MODEL.
Without a model, write each answer.json by hand and run execute.

${COMMON}
  --model-terms        Add model-suggested search words

Exit codes: 0 done, 2 could not check (including no model configured).
`,
  execute: `Usage: claimcheck execute [options]

Read <out>/work/<id>/answer.json, run the check on the real code, then on a
mutant, and decide PROVEN, CONTRADICTED, NO-TEETH, NOT-LOCATED or NOT-CHECKABLE.
Edits a file in the repository to build the mutant and restores it afterwards.
Run it on a clean checkout.

${COMMON}
  --strict             A NOT-LOCATED or NOT-CHECKABLE claim also exits 1

Exit codes: 0 no claim is CONTRADICTED or NO-TEETH, 1 at least one is (or a gap
with --strict), 2 could not check.
`,
};
const USAGE = `claimcheck: turn a written claim about software into a check, then prove the check has teeth.

Usage: claimcheck <command> [options]

Commands:
  prepare    Parse each claim and locate candidate lines
  author     Ask a model to write each answer.json
  execute    Run each check on the real code and on a mutant, then decide

Run "claimcheck <command> --help" for the options of one command.

Options:
  -h, --help           Show help
  -v, --version        Show the version

Exit codes: 0 nothing wrong, 1 a claim looks false (or a gap with --strict), 2 could not check.
`;

class Usage extends Error {}
const fail = (msg: string): never => { throw new Usage(msg); };

function version(): string {
  try { return JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version; } catch { return 'unknown'; }
}

const CLAIM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function loadClaims(path: string): { id: string; quote: string }[] {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return fail(`cannot read claims file ${path}: ${(e as Error).message}`); }
  if (!Array.isArray(parsed) || parsed.some((c) => typeof c?.id !== 'string' || typeof c?.quote !== 'string')) {
    return fail(`claims file ${path} must be a JSON array of { "id": string, "quote": string }`);
  }
  const bad = parsed.find((c) => !CLAIM_ID.test(c.id));
  if (bad) return fail(`invalid claim id ${JSON.stringify(bad.id)} in ${path}: ids must match ${CLAIM_ID} (letters, digits, dot, underscore, hyphen; at most 64)`);
  return parsed;
}

function isDirty(repo: string, file: string): boolean {
  return !unchanged(repo, file);
}

async function run(): Promise<{ report: Record<string, unknown>; exitCode: number }> {
  if (!cmd || !COMMANDS.includes(cmd)) fail(`unknown command ${JSON.stringify(cmd ?? '')}; use one of: ${COMMANDS.join(', ')}; run claimcheck --help`);
  const repo = resolve(opt('repo') ?? '.');
  const out = resolve(opt('out') ?? 'results');
  const only = opt('only');
  const strict = flag('strict');
  if (!existsSync(repo) || git(repo, ['rev-parse', '--show-toplevel']).status !== 0) fail(`--repo ${repo} is not a git repository`);
  const all = loadClaims(resolve(opt('claims') ?? 'claims.json'));
  const claims = all.filter((x) => !only || x.id === only);
  if (only && claims.length === 0) fail(`--only ${only}: no such claim id in the claims file`);
  const w = (id: string, f: string) => { mkdirSync(join(out, 'work', id), { recursive: true }); return join(out, 'work', id, f); };
  const head = { tool: 'claimcheck', version: version(), command: cmd, repo };

  if (cmd === 'execute') {
    const rows: Record<string, unknown>[] = [];
    const errors: string[] = [];
    const summary: Record<string, number> = Object.fromEntries(CLASSES.map((k) => [k, 0]));
    for (const c of claims) {
      const checkFile = join(out, 'checks', `${c.id}.check.ts`);
      const f = w(c.id, 'answer.json');
      let klass: Class; let reason: string; let extra: Record<string, unknown> = {};
      if (!existsSync(f)) {
        klass = 'NOT-CHECKABLE'; reason = 'no answer.json yet';
        say(`${c.id}: no answer.json yet`);
      } else {
        try {
          const answer = JSON.parse(readFileSync(f, 'utf8')) as Answer;
          if (answer.target && !answer.notLocated && !answer.notCheckable && isDirty(repo, answer.target.file)) {
            throw new Error(differsMessage(answer.target.file));
          }
          const res = await decide(repo, checkFile, answer);
          writeFileSync(w(c.id, 'result.json'), JSON.stringify(res, null, 1));
          say(`${c.id}: ${res.class} (${res.located ?? '-'}) ${res.reason}`);
          klass = res.class; reason = res.reason;
          extra = { located: res.located, checkKind: res.checkKind ?? null, mutationDiff: res.mutationDiff ?? null };
        } catch (e) {
          const msg = `${c.id}: could not check: ${(e as Error).message}`;
          say(msg); errors.push(msg);
          rows.push({ id: c.id, quote: c.quote, class: null, reason: msg, located: null, checkKind: null, mutationDiff: null });
          continue;
        }
      }
      summary[klass]++;
      rows.push({ id: c.id, quote: c.quote, class: klass, reason, located: null, checkKind: null, mutationDiff: null, ...extra });
    }
    const gaps = summary['NOT-LOCATED'] + summary['NOT-CHECKABLE'];
    const exitCode = errors.length ? 2 : summary.CONTRADICTED + summary['NO-TEETH'] > 0 || (strict && gaps > 0) ? 1 : 0;
    return { exitCode, report: { ...head, summary: { ...summary, total: claims.length }, exitCode, errors, claims: rows } };
  }

  // prepare and author
  const rows: Record<string, unknown>[] = [];
  let exitCode = 0;
  for (const c of claims) {
    const checkFile = join(out, 'checks', `${c.id}.check.ts`);
    const periods = parsePeriods(c.quote);
    // off by default: on the benchmark the model's extra words did not improve the ranking (see README)
    const extraTerms = flag('model-terms') && modelAvailable() ? await expandTerms(c.quote) : [];
    // with no period found, the word layers still search
    const cands = locate(repo, periods, c.quote, 25, { synonyms: true, bm25: true, graph: true, extraTerms });
    writeFileSync(w(c.id, 'parse.json'), JSON.stringify(periods, null, 1));
    writeFileSync(w(c.id, 'candidates.json'), JSON.stringify(cands, null, 1));
    const prompt = authorPrompt(c.quote, periods, cands, relative(repo, checkFile));
    writeFileSync(w(c.id, 'author.prompt.txt'), prompt);
    say(`${c.id}: ${periods.length} periods, ${cands.length} candidates`);
    rows.push({
      id: c.id, quote: c.quote, periods, promptFile: join(out, 'work', c.id, 'author.prompt.txt'),
      candidates: cands.slice(0, 5).map((k) => ({ file: k.file, line: k.line, text: k.text, why: k.why, score: k.score, usedBy: k.usedBy ?? [] })),
    });
    if (cmd === 'author') {
      if (!modelAvailable()) fail('author needs AI_GATEWAY_API_KEY and CLAIMCHECK_MODEL; or write each answer.json by hand and run execute');
      const raw = await askModel(prompt);
      writeFileSync(w(c.id, 'answer.json'), raw.match(/\{[\s\S]*\}/)?.[0] ?? raw);
    }
  }
  return { exitCode, report: { ...head, exitCode, claims: rows } };
}

async function main() {
  // help and version answer first and touch nothing else
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
    const topic = cmd === 'help' ? rest[0] : undefined;
    process.stdout.write(topic && COMMANDS.includes(topic) ? HELP[topic] : USAGE);
    return;
  }
  if (cmd === '-v' || cmd === '--version') { process.stdout.write(`${version()}\n`); return; }
  if (cmd && COMMANDS.includes(cmd) && (rest.includes('-h') || rest.includes('--help'))) { process.stdout.write(HELP[cmd]); return; }
  if (!cmd) { process.stderr.write(`claimcheck: no command given\n\n${USAGE}`); process.exitCode = 2; return; }
  let result: { report: Record<string, unknown>; exitCode: number };
  try {
    result = await run();
  } catch (e) {
    const msg = e instanceof Usage ? (e as Error).message : `crash: ${(e as Error).message}`;
    console.error(`claimcheck: ${msg}`);
    result = { exitCode: 2, report: { tool: 'claimcheck', version: version(), command: cmd ?? null, exitCode: 2, error: msg, claims: [] } };
  }
  const text = JSON.stringify(result.report, null, 2);
  const jf = opt('json-file');
  if (jf) { mkdirSync(dirname(resolve(jf)), { recursive: true }); writeFileSync(resolve(jf), `${text}\n`); }
  if (asJson) process.stdout.write(`${text}\n`);
  process.exitCode = result.exitCode;
}
main();
