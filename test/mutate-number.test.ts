import { describe, expect, it } from 'vitest';
import { bumpNumber, mutatedLine } from '../src/mutate';

describe('mutate: a numeric literal is one number (CC8)', () => {
  it('adds one to the whole literal and keeps the separators', () => {
    expect(bumpNumber('86_400_000')).toBe('86_400_001');
    expect(bumpNumber('1_000')).toBe('1_001');
    expect(bumpNumber('999_999')).toBe('1_000_000');
    expect(bumpNumber('60')).toBe('61');
    expect(bumpNumber('1.5')).toBe('2.5');
    expect(bumpNumber('1_000.25')).toBe('1_001.25');
  });
  it('mutates the literal in place, never one digit group of it', () => {
    expect(mutatedLine('const TTL_MS = 86_400_000;', '86_400_000')?.after).toBe('const TTL_MS = 86_400_001;');
    expect(mutatedLine('const N = 1_000;', '1_000')?.after).toBe('const N = 1_001;');
    expect(mutatedLine("interval '14 days'", "'14 days'")?.after).toBe("interval '15 days'");
  });
});
