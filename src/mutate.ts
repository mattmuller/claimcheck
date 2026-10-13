// Stage 4 helper: mutate exactly one token on one line, run, restore with git.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Target {
  file: string;
  line: number;
  token: string;
}

function git(repo: string, args: string[]) {
  return spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
}

/** Replace the first number inside the token with number+1. Returns null when the token is not on the line. */
export function mutatedLine(line: string, token: string): { before: string; after: string } | null {
  const at = line.indexOf(token);
  if (at < 0) return null;
  const num = token.match(/\d+(?:\.\d+)?/);
  // no number in the token: swap a unit word for a neighbouring unit instead
  const UNIT_SWAP: [RegExp, string][] = [[/year/, 'month'], [/month/, 'week'], [/week/, 'day'], [/day/, 'hour'], [/hour/, 'minute']];
  const swap = num ? null : UNIT_SWAP.find(([re]) => re.test(token));
  if (!num && !swap) return null;
  const bumped = num ? token.replace(num[0], String(Number(num[0]) + 1)) : token.replace(swap![0], swap![1]);
  return { before: line, after: line.slice(0, at) + bumped + line.slice(at + token.length) };
}

export function withMutation<T>(repo: string, t: Target, run: () => T): { diff: string; result: T } | { error: string } {
  const path = join(repo, t.file);
  if (git(repo, ['diff', '--quiet', '--', t.file]).status !== 0) return { error: `${t.file} has uncommitted changes; refusing to mutate` };
  const lines = readFileSync(path, 'utf8').split('\n');
  const m = lines[t.line - 1] === undefined ? null : mutatedLine(lines[t.line - 1], t.token);
  if (!m) return { error: `token ${JSON.stringify(t.token)} not found (or has no number) on ${t.file}:${t.line}` };
  lines[t.line - 1] = m.after;
  writeFileSync(path, lines.join('\n'));
  try {
    const diff = git(repo, ['diff', '-U0', '--', t.file]).stdout;
    return { diff, result: run() };
  } finally {
    git(repo, ['checkout', '--', t.file]);
  }
}
