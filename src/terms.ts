// Words, not strings. Code writes `logRetentionDays`, `LOG_RETENTION_DAYS` or `log-retention-days`;
// a claim writes "logs are kept for 90 days". Both are turned into the same small vocabulary here,
// so the ranking in bm25.ts can compare them. No model, no dictionary file, no dependency.

/** Split identifiers and text into lower-case words: camelCase, PascalCase, snake_case, kebab-case, digits. */
export function splitWords(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[A-Za-z][A-Za-z0-9]*|\d[\d_]*(?:\.\d+)?/g) ?? []) {
    if (/^\d/.test(raw)) { out.push(raw.replace(/_/g, '')); continue; }
    // HTTPServerTimeout -> HTTP Server Timeout; maxAge2 -> max Age 2
    for (const part of raw.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/)) {
      if (part) out.push(part.toLowerCase());
    }
  }
  return out;
}

/** A light suffix stemmer. Enough to make "expires", "expired" and "expiry" meet; not a linguist. */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (/^\d/.test(w) || w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('ss') || w.endsWith('us') || w.endsWith('is')) { /* keep: "class", "status", "basis" */ }
  else if (w.endsWith('s') && w.length > 3) w = w.slice(0, -1);
  for (const suf of ['ation', 'ition', 'ing', 'ed', 'er', 'ion', 'ly', 'y', 'e']) {
    if (w.endsWith(suf) && w.length - suf.length >= 4) {
      w = w.slice(0, -suf.length);
      // logging -> logg -> log, stopped -> stopp -> stop (but keep "ll" and "ss": "call", "pass")
      if (/([b-df-hj-np-tv-z])\1$/.test(w) && !/(ll|ss|ff|zz)$/.test(w)) w = w.slice(0, -1);
      break;
    }
  }
  return w;
}

const STOP = new Set(
  ('a about after again against all also an and any are as at be been before being between both but by can could did do does ' +
    'doing during each every few for from further had has have having how if in into is it its itself just more most must no ' +
    'nor not of off on once only or other our out over own same shall should so some such than that the their them then there ' +
    'these they this those through to too under until up upon very was we were what when where which while who whom why will ' +
    'with within without would you your const let var export import return function new true false null undefined').split(' '),
);

/** Content words of a sentence or a line of code, stemmed, stop words removed. Numbers are kept. */
export function terms(text: string): string[] {
  return splitWords(text).filter((w) => !STOP.has(w)).map(stem);
}

// Words that name the same idea in infrastructure code. Each group is one idea; a claim word pulls in
// the rest of its group as weaker query terms. Kept generic on purpose: no product vocabulary.
const GROUPS: string[][] = [
  ['keep', 'kept', 'retain', 'retention', 'persist', 'preserve', 'hold', 'lifetime', 'age', 'ttl'],
  ['expire', 'expiry', 'expiration', 'stale', 'evict', 'purge', 'prune', 'delete', 'remove', 'cleanup', 'clean', 'sweep', 'gc', 'rotate', 'discard', 'drop', 'ttl'],
  ['timeout', 'deadline', 'abort', 'idle', 'inactive', 'inactivity', 'hang', 'wait'],
  ['limit', 'max', 'maximum', 'cap', 'quota', 'ceiling', 'threshold', 'budget'],
  ['minimum', 'min', 'least', 'floor'],
  ['retry', 'attempt', 'tries', 'backoff', 'redeliver', 'resend', 'again'],
  ['interval', 'every', 'period', 'frequency', 'cadence', 'schedule', 'cron', 'poll', 'tick', 'heartbeat'],
  ['delay', 'pause', 'sleep', 'cooldown', 'grace', 'later', 'wait'],
  ['connection', 'conn', 'socket', 'keepalive', 'session', 'pool'],
  ['log', 'logging', 'audit', 'trace'],
  ['backup', 'snapshot', 'dump', 'archive'],
  ['upload', 'file', 'attachment', 'blob', 'payload', 'size', 'bytes'],
  ['cache', 'cached', 'memo', 'memoize'],
  ['rate', 'throttle', 'request', 'window', 'bucket', 'burst'],
  ['report', 'digest', 'summary', 'export'],
  ['temp', 'tmp', 'temporary', 'scratch'],
  ['health', 'healthcheck', 'probe', 'ping', 'liveness', 'readiness'],
  ['webhook', 'callback', 'hook', 'delivery', 'deliver', 'notify', 'notification'],
  ['job', 'task', 'worker', 'queue'],
  ['token', 'link', 'url', 'signed'],
];

const SYN = new Map<string, Set<string>>();
for (const g of GROUPS) {
  const stems = g.map(stem);
  for (const s of stems) {
    const set = SYN.get(s) ?? new Set<string>();
    for (const o of stems) if (o !== s) set.add(o);
    SYN.set(s, set);
  }
}

/** Stems that name the same idea as `stemmed`, from the built-in table. Never includes the word itself. */
export function synonyms(stemmed: string): string[] {
  return [...(SYN.get(stemmed) ?? [])];
}

export interface QueryTerm { term: string; weight: number; from: 'claim' | 'synonym' | 'model' }

/**
 * The words a line of code should share with a claim. The claim's own words count fully; a synonym
 * or a model-suggested word counts at `weakWeight`, so it can find the line but never outrank a line
 * that uses the claim's own words.
 */
export function queryTerms(claim: string, opts: { synonyms?: boolean; extra?: string[]; weakWeight?: number } = {}): QueryTerm[] {
  const weak = opts.weakWeight ?? 0.5;
  const out = new Map<string, QueryTerm>();
  const put = (term: string, weight: number, from: QueryTerm['from']) => {
    const prev = out.get(term);
    if (!prev || prev.weight < weight) out.set(term, { term, weight, from });
  };
  const own = terms(claim).filter((t) => !/^\d/.test(t)); // numbers are matched by the rules, not by words
  for (const t of own) put(t, 1, 'claim');
  if (opts.synonyms !== false) for (const t of own) for (const s of synonyms(t)) put(s, weak, 'synonym');
  for (const e of opts.extra ?? []) for (const t of terms(e)) if (!/^\d/.test(t)) put(t, weak, 'model');
  return [...out.values()];
}
