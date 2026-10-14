// Optional: ask the model which words a programmer might use for the claim's subject.
// The answer only widens the search at a weak weight (see queryTerms). With no model configured this
// returns an empty list and nothing else changes. The key is read by model.ts and never printed here.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { askModel, modelAvailable } from './model';

const memory = new Map<string, string[]>();

export function expandPrompt(claim: string): string {
  return `A written claim about software says:

"${claim}"

List 10 to 20 single words or identifier fragments that a programmer might use in code, config keys or comments
for the SUBJECT of this claim (what the number is the limit, age, delay or size of). Include common abbreviations
and verb/noun variants. Do not include the number, units of time, or generic words like "value" or "config".
Answer with a JSON array of strings and nothing else.`;
}

export function parseTerms(raw: string): string[] {
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter((s) => s.length > 1 && s.length <= 40).slice(0, 20);
  } catch { return []; }
}

function readCache(path: string): Record<string, string[]> {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}; } catch { return {}; }
}

/** Cached lookup only: never calls the model. */
export function cachedTerms(claim: string, cachePath: string): string[] | undefined {
  return readCache(cachePath)[claim];
}

/** Model-suggested search words for a claim; [] when no model is set or the call fails. Cached per claim. */
export async function expandTerms(claim: string, opts: { cachePath?: string } = {}): Promise<string[]> {
  const hit = memory.get(claim) ?? (opts.cachePath ? cachedTerms(claim, opts.cachePath) : undefined);
  if (hit) { memory.set(claim, hit); return hit; }
  if (!modelAvailable()) return [];
  try {
    const out = parseTerms(await askModel(expandPrompt(claim)));
    memory.set(claim, out);
    if (opts.cachePath && out.length) {
      const all = readCache(opts.cachePath);
      all[claim] = out;
      mkdirSync(dirname(opts.cachePath), { recursive: true });
      writeFileSync(opts.cachePath, `${JSON.stringify(all, null, 1)}\n`);
    }
    return out;
  } catch (e) {
    console.error(`claimcheck: model search terms unavailable (${(e as Error).message.slice(0, 120)})`);
    return [];
  }
}
