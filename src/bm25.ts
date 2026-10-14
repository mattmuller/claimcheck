// In-process BM25 over the code lines of a repository. One document = a line, the two lines above it
// (usually the comment that explains it) and the words of its file path. No index on disk, no dependency.
import { readCorpus } from './corpus';
import { type QueryTerm, splitWords, terms } from './terms';

export const K1 = 1.2;
export const B = 0.75;

export interface Doc {
  file: string;
  line: number;
  text: string;
  tf: Map<string, number>;
  len: number;
}

export interface Hit extends Doc {
  score: number;
  /** the query terms that matched, strongest first */
  matched: string[];
}

export interface Index {
  docs: Doc[];
  df: Map<string, number>;
  avgLen: number;
  byKey: Map<string, Doc>;
}

const MAX_LINE = 400;


/** Build documents from already-read text. Exposed so tests can index without git. */
export function buildIndex(files: { file: string; text: string }[]): Index {
  const docs: Doc[] = [];
  for (const f of files) {
    const lines = f.text.split('\n');
    const pathWords = splitWords(f.file);
    for (let i = 0; i < lines.length; i++) {
      const own = lines[i].trim();
      if (!own || own.length > MAX_LINE) continue;
      const ctx = [lines[i - 2] ?? '', lines[i - 1] ?? '', own].join(' ').slice(0, 1200);
      const tf = new Map<string, number>();
      let len = 0;
      for (const t of [...terms(ctx), ...terms(pathWords.join(' '))]) {
        tf.set(t, (tf.get(t) ?? 0) + 1);
        len++;
      }
      if (len === 0) continue;
      docs.push({ file: f.file, line: i + 1, text: own.slice(0, 240), tf, len });
    }
  }
  const df = new Map<string, number>();
  let total = 0;
  for (const d of docs) {
    total += d.len;
    for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const byKey = new Map(docs.map((d) => [`${d.file}:${d.line}`, d]));
  return { docs, df, avgLen: docs.length ? total / docs.length : 1, byKey };
}

export function indexRepo(repo: string): Index {
  return buildIndex(readCorpus(repo));
}

export function idf(index: Index, term: string): number {
  const n = index.docs.length;
  const df = index.df.get(term) ?? 0;
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

export function scoreDoc(index: Index, doc: Doc, query: QueryTerm[]): { score: number; matched: string[] } {
  let score = 0;
  const matched: { t: string; s: number }[] = [];
  for (const q of query) {
    const f = doc.tf.get(q.term);
    if (!f) continue;
    const s = q.weight * idf(index, q.term) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.len) / index.avgLen)));
    score += s;
    matched.push({ t: q.term, s });
  }
  return { score, matched: matched.sort((a, b) => b.s - a.s).map((m) => m.t) };
}

/** Every document that matches at least one query term, best first. */
export function search(index: Index, query: QueryTerm[], limit = 200): Hit[] {
  const out: Hit[] = [];
  for (const d of index.docs) {
    const { score, matched } = scoreDoc(index, d, query);
    if (score > 0) out.push({ ...d, score, matched });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
