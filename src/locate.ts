// Stage 2: deterministic candidate search. No model involved.
import { grepCorpus, type Row } from './corpus';
import { type Index, indexRepo, scoreDoc, search } from './bm25';
import { EXCLUDE } from './excludes';
import { graphCandidates } from './graph';
import { type Equivalent, type Period, equivalents } from './parse';
import { queryTerms, terms } from './terms';

export interface Candidate {
  file: string;
  line: number;
  text: string;
  why: string;
  score: number;
  /** where the located declaration is used: "function (file:line)", up to 5. Set by the value-flow graph. */
  usedBy?: string[];
}

export interface LocateOptions {
  /** built-in synonym table widens the claim's words */
  synonyms?: boolean;
  /** BM25 over split identifiers: a bonus on every candidate, plus lines with no number match */
  bm25?: boolean;
  /** TypeScript value-flow graph: finds `15 * MINUTE` and the like */
  graph?: boolean;
  /** words suggested by a model; used at weak weight only */
  extraTerms?: string[];
}

const UNIT_WORDS: Record<string, string> = {
  second: 'sec|second|SECONDS?', minute: 'min|minute|MINUTES?', hour: 'hour|HOURS?|hrs?',
  day: 'day|DAYS?', week: 'week|WEEKS?', month: 'month|MONTHS?', year: 'year|YEARS?|annual',
  ms: 'ms|millis|MILLIS?',
};
const SEMANTIC = /ttl|window|retention|retain|expir|expire|max_?age|duration|period|deadline|timeout|cooldown|interval|delay|stale/i;

function grep(repo: string, pattern: string): Row[] {
  return grepCorpus(repo, pattern);
}

const STOP = new Set('about after again against before being between could does during each from have having into only other over same should some than that their them then there these they this those through under until upon were what when where which while will with within without would your yours'.split(' '));

/** Content words of the claim, used as a weak signal next to a bare number. */
export function keywords(claim: string): string[] {
  const words = (claim.toLowerCase().match(/[a-z]{5,}/g) ?? []).filter((w) => !STOP.has(w));
  return [...new Set(words)].map((w) => w.slice(0, 6));
}

const COMMENT = /^\s*(\/\/|\*|\/\*|--|#)/;
const NUMERIC = /(?<![\w.$])\d[\d_]*(?:\.\d+)?(?![\w])/;
const DECLARATION = /^\s*(export\s+)?(const|let|var|final|static|public|private|readonly|val|def)\b[^=]*=|^\s*[A-Z_][A-Z0-9_]*\s*[:=]/;
/** A line that sets or holds a value: has a numeric literal or is a declaration. */
export function isValueLine(text: string): boolean {
  return !COMMENT.test(text) && (NUMERIC.test(text) || DECLARATION.test(text));
}

export function locate(repo: string, periods: Period[], claim = '', max = 25, opts: LocateOptions = {}): Candidate[] {
  const useSyn = opts.synonyms !== false;
  const useBm25 = opts.bm25 !== false;
  const useGraph = opts.graph !== false;
  const query = queryTerms(claim, { synonyms: useSyn, extra: opts.extraTerms });
  const byKey = new Map<string, Candidate>();
  const add = (row: { file: string; line: number; text: string }, why: string, score: number) => {
    const key = `${row.file}:${row.line}`;
    const prev = byKey.get(key);
    if (prev) {
      prev.score += score;
      if (!prev.why.includes(why)) prev.why += `; ${why}`;
    } else byKey.set(key, { ...row, why, score });
  };

  for (const p of periods) {
    for (const eq of equivalents(p) as Equivalent[]) {
      const n = String(eq.value);
      const words = UNIT_WORDS[eq.unit];
      const isMs = eq.unit === 'ms';
      // number + unit word on one line, either order: `60 days`, `DAYS = 60`, `days: 60`
      if (!isMs && words) {
        const rx = `(\\b${n}\\b[^\\n]{0,24}(${words})|(${words})[^\\n]{0,24}\\b${n}\\b)`;
        for (const r of grep(repo, rx)) add(r, `${n} near ${eq.unit}`, eq === equivalents(p)[0] ? 6 : 4);
      }
      // raw big numbers: seconds / milliseconds digits, and 1e3 style products
      if (eq.value >= 3600 && (eq.unit === 'second' || isMs)) {
        for (const r of grep(repo, `\\b${n.replace(/(\d)(?=(\d{3})+$)/g, '$1_?')}\\b`)) add(r, `literal ${n} (${eq.unit})`, 5);
      }
    }
    // products of unit factors with the bare number: 60 * 60 * 24 * 60, 24 * 60 * 60 * 1000 ...
    const unitFactors = '(24|60|3600|1000|86400|86_400|7|30|365)';
    const bare = `\\b${p.value}\\b`;
    for (const r of grep(repo, `(${bare}[ ]*\\*[ ]*${unitFactors}|${unitFactors}[ ]*\\*[ ]*${bare})`)) add(r, `${p.value} times a unit factor`, 5);
    // a bare number on a line that also carries a word from the claim (weak: no unit needed)
    const kws = keywords(claim);
    if (kws.length) {
      for (const r of grep(repo, `\\b${p.value}\\b`)) {
        if (kws.some((k) => r.text.toLowerCase().includes(k))) add(r, `${p.value} with a claim word`, 3);
        else if (useSyn && query.length) {
          const own = new Set(terms(r.text));
          const hit = query.find((q) => own.has(q.term));
          if (hit) add(r, `${p.value} with a ${hit.from === 'claim' ? 'claim' : 'related'} word (${hit.term})`, hit.from === 'claim' ? 3 : 2);
        }
      }
    }
    // SQL / cron / config-key style
    for (const r of grep(repo, `interval[ ]+'?${p.value}[ ]+(${UNIT_WORDS[p.unit]})|'${p.value}[ ]+(${UNIT_WORDS[p.unit]})s?'`)) add(r, `sql interval ${p.value}`, 6);
    for (const r of grep(repo, `(max_?age|expires?_?in|retention|ttl|timeout|interval|period)[^\\n]{0,40}\\b${p.value}\\b`)) add(r, `period setting with ${p.value}`, 5);
  }

  if (useGraph) {
    for (const g of graphCandidates(repo, periods)) {
      add(g, g.why, g.score);
      const c = byKey.get(`${g.file}:${g.line}`);
      if (c && g.usedBy.length && !c.usedBy) c.usedBy = g.usedBy;
    }
  }

  const equivalentsOf = periods.flatMap((p) => (equivalents(p) as Equivalent[]).map((e) => ({ value: e.value, p })));
  if (useBm25 && query.length) {
    const index: Index = indexRepo(repo);
    const hits = search(index, query, 300);
    const top = hits[0]?.score ?? 0;
    if (top > 0) {
      // lines that set a value but carry no number from the claim: this is how a false claim finds the line that disagrees
      let extra = 0;
      for (const h of hits) {
        if (extra >= 15) break;
        const key = `${h.file}:${h.line}`;
        if (byKey.has(key) || !isValueLine(h.text)) continue;
        byKey.set(key, { file: h.file, line: h.line, text: h.text, why: '', score: 1 });
        extra++;
      }
      for (const c of byKey.values()) {
        const doc = index.byKey.get(`${c.file}:${c.line}`);
        if (!doc) continue;
        const { score, matched } = scoreDoc(index, doc, query);
        if (score <= 0) continue;
        c.score += 12 * (score / top);
        // a number on the line that is the claim's duration in another unit, backed by matching words (no unit word needed)
        const nums = (c.text.match(/(?<![\w.$])\d[\d_]*(?:\.\d+)?(?![\w])/g) ?? []).map((x) => Number(x.replace(/_/g, '')));
        const eqHit = nums.length && !COMMENT.test(c.text) ? equivalentsOf.find((e) => nums.includes(e.value)) : undefined;
        if (eqHit) { c.score += 3; c.why = c.why ? `${c.why}; holds ${eqHit.value}, ${eqHit.p.text} in another unit` : `holds ${eqHit.value}, ${eqHit.p.text} in another unit`; }
        const note = `words match the claim (BM25 ${score.toFixed(1)}): ${matched.slice(0, 4).join(', ')}`;
        c.why = c.why ? `${c.why}; ${note}` : note;
      }
    }
    for (const [k, c] of byKey) if (!c.why) byKey.delete(k);
  }

  for (const c of byKey.values()) {
    if (SEMANTIC.test(c.text)) { c.score += 3; c.why += '; semantic name'; }
    if (/^\s*(export\s+)?(const|let|var)\s+[A-Z_0-9]+\b/.test(c.text) || /^[A-Z_0-9]+\s*[:=]/.test(c.text)) c.score += 2;
    if (/^\s*(export\s+)?(const|let|var)\s+[A-Z][A-Z_0-9]*(DAYS|HOURS|MONTHS|YEARS|SECONDS|MINUTES|WEEKS|WINDOW|TTL|RETENTION)[A-Z_0-9]*\s*(:[^=]+)?=\s*[\d_]+\s*;?\s*(\/\/.*)?$/.test(c.text)) { c.score += 4; c.why += '; named constant = bare number'; }
    if (COMMENT.test(c.text)) c.score -= 4; // comment line
  }
  // collapse identical lines that repeat across files (copied migrations, mirrored apps): keep the last path and say how many
  const groups = new Map<string, Candidate[]>();
  for (const c of byKey.values()) {
    const k = c.text.replace(/\s+/g, ' ');
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const uniq: Candidate[] = [];
  for (const g of groups.values()) {
    g.sort((a, b) => (a.file < b.file ? 1 : -1));
    const top = g.reduce((a, b) => (b.score > a.score ? b : a));
    if (g.length > 1) top.why += `; identical line also in ${g.length - 1} other place(s): ${g.slice(0, 4).filter((x) => x !== top).map((x) => x.file).join(', ')}`;
    uniq.push(top);
  }
  // keep SQL and application code both visible: separate quotas
  const sorted = uniq.sort((a, b) => b.score - a.score);
  const isSql = (c: Candidate) => /\.sql$/.test(c.file);
  for (const c of sorted) c.score = Math.round(c.score * 100) / 100;
  return [...sorted.filter(isSql).slice(0, Math.ceil(max / 2)), ...sorted.filter((c) => !isSql(c)).slice(0, max)].sort((a, b) => b.score - a.score);
}
