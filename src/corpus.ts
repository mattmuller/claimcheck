// The searchable text of a repository: every tracked file that survives the excludes, read once per run.
// Searching it in-process, with JavaScript regular expressions, keeps the patterns' meaning the same on
// every machine. `git grep -E` uses the system's POSIX regex library, which on macOS silently treats `\b`
// and `[^\n]` differently, so the same pattern found the line on one machine and nothing on another.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXCLUDE } from './excludes';
import { git, isSafeRegularFile } from './gitutil';

export interface SourceFile { file: string; text: string; lines: string[] }

const MAX_FILE_BYTES = 512 * 1024;
const cache = new Map<string, SourceFile[]>();

export function trackedFiles(repo: string): string[] {
  const r = git(repo, ['ls-files', '-z', '--', '.', ...EXCLUDE], { maxBuffer: 64 * 1024 * 1024, magic: true });
  // a tracked symlink, or a path that resolves outside the repository, is never read
  return (r.stdout || '').split('\0').filter(Boolean).filter((f) => isSafeRegularFile(repo, f));
}

export function readCorpus(repo: string): SourceFile[] {
  const hit = cache.get(repo);
  if (hit) return hit;
  const files: SourceFile[] = [];
  for (const file of trackedFiles(repo)) {
    try {
      const buf = readFileSync(join(repo, file));
      if (buf.length > MAX_FILE_BYTES || buf.includes(0)) continue; // large or binary
      const text = buf.toString('utf8');
      files.push({ file, text, lines: text.split('\n') });
    } catch { /* deleted but still tracked */ }
  }
  cache.set(repo, files);
  return files;
}

export interface Row { file: string; line: number; text: string }

/** Every line matching `pattern` (a JavaScript regular expression source). */
export function grepCorpus(repo: string, pattern: string, flags = ''): Row[] {
  const rx = new RegExp(pattern, flags);
  const rows: Row[] = [];
  for (const f of readCorpus(repo)) {
    f.lines.forEach((l, i) => { if (rx.test(l)) rows.push({ file: f.file, line: i + 1, text: l.trim().slice(0, 240) }); });
  }
  return rows;
}
