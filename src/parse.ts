// Stage 1: pull period expressions out of a claim. Deterministic: number + unit.
export type Unit = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

export interface Period {
  text: string;
  value: number;
  unit: Unit;
}

const UNIT_RE: Record<Unit, string> = {
  second: 'seconds?|secs?',
  minute: 'minutes?|mins?',
  hour: 'hours?|hrs?',
  day: 'days?',
  week: 'weeks?',
  month: 'months?',
  year: 'years?|yrs?',
};

const WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, 'twenty-four': 24, thirty: 30, forty: 40, 'forty-five': 45, 'forty-eight': 48,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, 'a hundred': 100, 'one hundred': 100,
  half: 0.5, 'half an': 0.5, 'half a': 0.5,
};
// longest first, so "twenty-four" wins over "twenty" and "half an" over "an"
const WORD_ALT = Object.keys(WORDS).sort((a, b) => b.length - a.length).join('|');

export function parsePeriods(claim: string): Period[] {
  const out: Period[] = [];
  const seen = new Set<string>();
  for (const [unit, re] of Object.entries(UNIT_RE) as [Unit, string][]) {
    const rx = new RegExp(`\\b(\\d+(?:\\.\\d+)?|${WORD_ALT})[\\s-]+(?:${re})\\b`, 'gi');
    for (const m of claim.matchAll(rx)) {
      const raw = m[1].toLowerCase();
      const value = raw in WORDS ? WORDS[raw] : Number(raw);
      const key = `${value}${unit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text: m[0], value, unit });
    }
  }
  return out;
}

const SECONDS: Record<Unit, number> = {
  second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 30 * 86400, year: 365 * 86400,
};

export interface Equivalent {
  value: number;
  unit: Unit | 'ms';
}

/** The same duration written in other units (integers only). 12 months also counts as 1 year. */
export function equivalents(p: Period): Equivalent[] {
  const out: Equivalent[] = [{ value: p.value, unit: p.unit }];
  const secs = p.value * SECONDS[p.unit];
  for (const u of ['second', 'minute', 'hour', 'day', 'week'] as Unit[]) {
    const v = secs / SECONDS[u];
    if (Number.isInteger(v) && u !== p.unit) out.push({ value: v, unit: u });
  }
  out.push({ value: secs * 1000, unit: 'ms' });
  if (p.unit === 'month' && p.value % 12 === 0) out.push({ value: p.value / 12, unit: 'year' });
  if (p.unit === 'year') {
    out.push({ value: p.value * 12, unit: 'month' }, { value: p.value * 365, unit: 'day' }, { value: p.value * 366, unit: 'day' });
  }
  if (p.unit === 'month') out.push({ value: p.value * 30, unit: 'day' }, { value: p.value * 31, unit: 'day' });
  return out;
}
