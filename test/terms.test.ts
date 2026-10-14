import { describe, expect, it } from 'vitest';
import { queryTerms, splitWords, stem, synonyms, terms } from '../src/terms';

describe('splitWords', () => {
  it('splits camelCase, PascalCase, snake_case, kebab-case and digits', () => {
    expect(splitWords('logRetentionDays')).toEqual(['log', 'retention', 'days']);
    expect(splitWords('LOG_RETENTION_DAYS')).toEqual(['log', 'retention', 'days']);
    expect(splitWords('log-retention-days')).toEqual(['log', 'retention', 'days']);
    expect(splitWords('HTTPServerTimeout')).toEqual(['http', 'server', 'timeout']);
    expect(splitWords('maxAge2')).toEqual(['max', 'age', '2']);
  });
  it('joins numeric separators', () => {
    expect(splitWords('86_400')).toEqual(['86400']);
  });
});

describe('stem', () => {
  it('makes related forms meet', () => {
    const s = (w: string) => stem(w);
    expect(new Set(['expire', 'expires', 'expired', 'expiry', 'expiration'].map(s)).size).toBe(1);
    expect(new Set(['log', 'logs', 'logging', 'logged'].map(s)).size).toBe(1);
    expect(s('days')).toBe(s('day'));
  });
  it('leaves short words, numbers and -ss/-us words alone', () => {
    expect(stem('ttl')).toBe('ttl');
    expect(stem('90')).toBe('90');
    expect(stem('class')).toBe('class');
    expect(stem('status')).toBe('status');
  });
});

describe('queryTerms', () => {
  it('weights the claim at 1 and synonyms below it, and drops numbers', () => {
    const q = queryTerms('Server logs are kept for 90 days.');
    const w = (t: string) => q.find((x) => x.term === t)?.weight;
    expect(w(stem('logs'))).toBe(1);
    expect(w(stem('retention'))).toBeLessThan(1); // a synonym of "kept"
    expect(w(stem('retention'))).toBeGreaterThan(0);
    expect(q.some((x) => /^\d/.test(x.term))).toBe(false);
    expect(q.every((x) => !['the', 'are', 'for'].includes(x.term))).toBe(true);
  });
  it('can switch synonyms off and add model words at weak weight', () => {
    const off = queryTerms('Logs are kept for 90 days.', { synonyms: false });
    expect(off.every((x) => x.from === 'claim')).toBe(true);
    const extra = queryTerms('Logs are kept', { synonyms: false, extra: ['purgeAfter'] });
    expect(extra.find((x) => x.term === stem('purge'))?.from).toBe('model');
  });
  it('a claim word is never replaced by a weaker synonym of another word', () => {
    const q = queryTerms('delete and expire');
    expect(q.find((x) => x.term === stem('delete'))?.weight).toBe(1);
  });
  it('synonyms never include the word itself', () => {
    expect(synonyms(stem('timeout'))).not.toContain(stem('timeout'));
    expect(terms('The Cache is stale')).toContain(stem('stale'));
  });
});
