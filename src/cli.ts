// claimcheck <prepare|execute|author> --repo <path> --claims <json: [{id, quote}]> --out <dir> [--model-terms]
//   prepare: parse + locate; writes <out>/work/<id>/{parse,candidates}.json and author.prompt.txt
//   execute: reads <out>/work/<id>/answer.json, runs the check, the mutant, decides the class
//   author : same as a person filling answer.json, but asks the model named by CLAIMCHECK_MODEL
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expandTerms } from './expand';
import { locate } from './locate';
import { askModel, modelAvailable } from './model';
import { parsePeriods } from './parse';
import { authorPrompt } from './prompt';
import { type Answer, decide } from './verdict';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (k: string) => { const i = rest.indexOf(`--${k}`); return i < 0 ? undefined : rest[i + 1]; };
const repo = resolve(opt('repo') ?? '.');
const out = resolve(opt('out') ?? 'results');
const only = opt('only');
const claims: { id: string; quote: string }[] = JSON.parse(readFileSync(resolve(opt('claims') ?? 'claims.json'), 'utf8'));
const w = (id: string, f: string) => { mkdirSync(join(out, 'work', id), { recursive: true }); return join(out, 'work', id, f); };

async function main() {
for (const c of claims.filter((x) => !only || x.id === only)) {
  const checkFile = join(out, 'checks', `${c.id}.check.ts`);
  if (cmd === 'prepare' || cmd === 'author') {
    const periods = parsePeriods(c.quote);
    // off by default: on the benchmark the model's extra words did not improve the ranking (see README)
    const extraTerms = rest.includes('--model-terms') && modelAvailable() ? await expandTerms(c.quote) : [];
    // with no period found, the word layers still search
    const cands = locate(repo, periods, c.quote, 25, { synonyms: true, bm25: true, graph: true, extraTerms });
    writeFileSync(w(c.id, 'parse.json'), JSON.stringify(periods, null, 1));
    writeFileSync(w(c.id, 'candidates.json'), JSON.stringify(cands, null, 1));
    const prompt = authorPrompt(c.quote, periods, cands, relative(repo, checkFile));
    writeFileSync(w(c.id, 'author.prompt.txt'), prompt);
    console.log(`${c.id}: ${periods.length} periods, ${cands.length} candidates`);
    if (cmd === 'author') {
      if (!modelAvailable()) { console.error('no AI_GATEWAY_API_KEY / CLAIMCHECK_MODEL: answer.json must be written by hand'); continue; }
      const raw = await askModel(prompt);
      writeFileSync(w(c.id, 'answer.json'), raw.match(/\{[\s\S]*\}/)?.[0] ?? raw);
    }
  } else if (cmd === 'execute') {
    const f = w(c.id, 'answer.json');
    if (!existsSync(f)) { console.log(`${c.id}: no answer.json yet`); continue; }
    const res = decide(repo, checkFile, JSON.parse(readFileSync(f, 'utf8')) as Answer);
    writeFileSync(w(c.id, 'result.json'), JSON.stringify(res, null, 1));
    console.log(`${c.id}: ${res.class} (${res.located ?? '-'}) ${res.reason}`);
  }
}
}
main().catch((e) => { console.error(e); process.exit(1); });
