import { describe, expect, it } from 'vitest';
import { parsePeriods } from '../src/parse';

const read = (c: string) => parsePeriods(c).map((p) => [p.value, p.unit]);

describe('parsePeriods: numbers written as words', () => {
  it('reads teens, tens and compound words', () => {
    expect(read('Links stop working after fifteen minutes.')).toEqual([[15, 'minute']]);
    expect(read('Kept for twenty-four hours.')).toEqual([[24, 'hour']]);
    expect(read('Archived after forty-five days.')).toEqual([[45, 'day']]);
  });
  it('reads "half an hour" as half an hour, not one hour', () => {
    expect(read('Locked out for half an hour.')).toEqual([[0.5, 'hour']]);
  });
  it('still reads digits and "an hour"', () => {
    expect(read('Retries stop after an hour; logs flush every 5 seconds.')).toEqual([[5, 'second'], [1, 'hour']]);
  });
});
