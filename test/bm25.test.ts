import { describe, expect, it } from 'vitest';
import { buildIndex, idf, search } from '../src/bm25';
import { queryTerms } from '../src/terms';

const index = buildIndex([
  { file: 'src/retention.ts', text: '// how long we keep logs\nexport const logRetentionDays = 30;\nexport const pageSize = 30;\n' },
  { file: 'src/other.ts', text: 'export const colour = "red";\nexport const retries = 3;\nfunction run() { return 1; }\n' },
  { file: 'src/more.ts', text: 'item a = 1;\nitem b = 2;\nitem c = 3;\nitem d = 4;\n' },
]);

describe('bm25', () => {
  it('ranks the line with the claim words above lines without them', () => {
    const hits = search(index, queryTerms('Server logs are kept for 30 days.'));
    expect(hits[0].file).toBe('src/retention.ts');
    expect(hits[0].line).toBe(2);
    const other = hits.find((h) => h.file === 'src/other.ts');
    expect(!other || other.score < hits[0].score).toBe(true);
  });
  it('uses the comment above and the file path as part of the line', () => {
    const hit = search(index, queryTerms('how long we keep', { synonyms: false })).find((h) => h.line === 2 && h.file === 'src/retention.ts');
    expect(hit).toBeDefined();
  });
  it('gives rare words more weight than common ones (IDF)', () => {
    expect(idf(index, 'retent')).toBeGreaterThan(idf(index, 'item'));
    // the unusual word decides the order even when a common word matches more lines
    const hits = search(index, [{ term: 'item', weight: 1, from: 'claim' }, { term: 'retent', weight: 1, from: 'claim' }]);
    expect(hits[0].file).toBe('src/retention.ts');
  });
  it('scores nothing when no query word occurs', () => {
    expect(search(index, queryTerms('zebra quagga', { synonyms: false }))).toEqual([]);
  });
});
