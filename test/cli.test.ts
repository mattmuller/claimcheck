import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempRepo } from './helpers';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const TSX = join(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx');

// Two claims about a tiny module: the first is true (10 minutes), the second is false (code says 20 seconds).
const FILES = {
  'src/cache.ts': 'export const TTL_SECONDS = 600;\nexport const BEAT_SECONDS = 20;\nexport const ttl = () => TTL_SECONDS;\nexport const beat = () => BEAT_SECONDS;\n',
};
const check = (repo: string, fn: string, expected: number) =>
  `import assert from 'node:assert';\nimport { ${fn} } from '${join(repo, 'src/cache')}';\nassert.strictEqual(${fn}(), ${expected});\n`;

function setup(make: (repo: string) => Record<string, unknown>) {
  const repo = tempRepo(FILES);
  const answers = make(repo);
  const out = mkdtempSync(join(tmpdir(), 'claimcheck-out-'));
  const claims = Object.keys(answers).map((id) => ({ id, quote: `claim ${id}` }));
  const claimsFile = join(out, 'claims.json');
  writeFileSync(claimsFile, JSON.stringify(claims));
  for (const [id, a] of Object.entries(answers)) {
    mkdirSync(join(out, 'work', id), { recursive: true });
    writeFileSync(join(out, 'work', id, 'answer.json'), JSON.stringify(a));
  }
  return { repo, out, claimsFile };
}
const cli = (args: string[]) => spawnSync(TSX, [CLI, ...args], { encoding: 'utf8', timeout: 180_000 });
const execArgs = (s: ReturnType<typeof setup>, ...more: string[]) => ['execute', '--repo', s.repo, '--claims', s.claimsFile, '--out', s.out, ...more];

const proven = (repo: string) => ({ target: { file: 'src/cache.ts', line: 1, token: '600' }, notLocated: false, notCheckable: false, checkKind: 'behavioural', checkSource: check(repo, 'ttl', 600) });
const contradicted = (repo: string) => ({ target: { file: 'src/cache.ts', line: 2, token: '20' }, notLocated: false, notCheckable: false, checkKind: 'behavioural', checkSource: check(repo, 'beat', 5) });
const notLocated = { target: null, notLocated: 'nothing sets this', notCheckable: false };

describe('execute exit codes', () => {
  it('0 when every claim is PROVEN', () => {
    const r = cli(execArgs(setup((r) => ({ a: proven(r) })), '--json'));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).summary.PROVEN).toBe(1);
  });
  it('1 when a claim is CONTRADICTED', () => {
    const r = cli(execArgs(setup((r) => ({ a: proven(r), b: contradicted(r) })), '--json'));
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).summary.CONTRADICTED).toBe(1);
  });
  it('0 for NOT-LOCATED, but 1 with --strict', () => {
    const s = setup((r) => ({ a: proven(r), b: notLocated }));
    expect(cli(execArgs(s)).status).toBe(0);
    expect(cli(execArgs(s, '--strict')).status).toBe(1);
  });
  it('a claim with no answer.json counts as NOT-CHECKABLE', () => {
    const s = setup((r) => ({ a: proven(r) }));
    writeFileSync(s.claimsFile, JSON.stringify([{ id: 'a', quote: 'x' }, { id: 'z', quote: 'y' }]));
    const r = cli(execArgs(s, '--json'));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).summary['NOT-CHECKABLE']).toBe(1);
    expect(cli(execArgs(s, '--strict')).status).toBe(1);
  });
  it('2 when the claims file is missing', () => {
    const s = setup((r) => ({ a: proven(r) }));
    const r = cli(['execute', '--repo', s.repo, '--claims', join(s.out, 'nope.json'), '--out', s.out]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/cannot read claims file/);
  });
  it('2 for an unknown command and for a repo that is not a git repo', () => {
    expect(cli(['frobnicate']).status).toBe(2);
    const s = setup((r) => ({ a: proven(r) }));
    const notGit = mkdtempSync(join(tmpdir(), 'claimcheck-nogit-'));
    expect(cli(['execute', '--repo', notGit, '--claims', s.claimsFile, '--out', s.out]).status).toBe(2);
  });
  it('2 when the target file has uncommitted changes', () => {
    const s = setup((r) => ({ a: proven(r) }));
    writeFileSync(join(s.repo, 'src/cache.ts'), `${FILES['src/cache.ts']}// edited\n`);
    expect(cli(execArgs(s)).status).toBe(2);
  });
});

describe('JSON report', () => {
  it('has the documented shape, keeps stdout clean, and writes --json-file', () => {
    const s = setup((r) => ({ a: proven(r), b: contradicted(r) }));
    const file = join(s.out, 'report.json');
    const r = cli(execArgs(s, '--json', '--json-file', file));
    const j = JSON.parse(r.stdout); // throws if anything but the object is on stdout
    expect(j).toMatchObject({ tool: 'claimcheck', command: 'execute', exitCode: 1, summary: { PROVEN: 1, CONTRADICTED: 1, total: 2 } });
    expect(Object.keys(j.claims[0])).toEqual(expect.arrayContaining(['id', 'quote', 'class', 'reason', 'located', 'checkKind', 'mutationDiff']));
    expect(j.claims[0]).toMatchObject({ id: 'a', class: 'PROVEN', located: 'src/cache.ts:1' });
    expect(j.claims[0].mutationDiff).toMatch(/601/);
    expect(r.stderr).toMatch(/a: PROVEN/);
    expect(JSON.parse(require('node:fs').readFileSync(file, 'utf8')).exitCode).toBe(1);
  });
  it('prepare lists periods and at most 5 candidates', () => {
    const s = setup((r) => ({}));
    writeFileSync(s.claimsFile, JSON.stringify([{ id: 'a', quote: 'The cache entry lives for 10 minutes.' }]));
    const r = cli(['prepare', '--repo', s.repo, '--claims', s.claimsFile, '--out', s.out, '--json']);
    expect(r.status).toBe(0);
    const c = JSON.parse(r.stdout).claims[0];
    expect(c.periods[0].value).toBe(10);
    expect(c.candidates.length).toBeLessThanOrEqual(5);
    expect(c.candidates[0]).toMatchObject({ file: 'src/cache.ts', line: 1 });
    expect(Object.keys(c.candidates[0])).toEqual(expect.arrayContaining(['text', 'why', 'score', 'usedBy']));
  });
});

describe('help and version', () => {
  const pkgVersion = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version;
  it.each([[[]], [['-h']], [['--help']], [['help']]])('usage for %j lists all three commands', (args) => {
    const r = cli(args);
    const text = args.length ? r.stdout : r.stderr;
    expect(r.status).toBe(args.length ? 0 : 2);
    for (const c of ['prepare', 'author', 'execute']) expect(text).toContain(c);
    expect(text).toContain('--version');
  });
  it.each(['-v', '--version'])('%s prints the bare version', (f) => {
    const r = cli([f]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${pkgVersion}\n`);
  });
  it.each(['prepare', 'author', 'execute'])('%s --help prints its flags and does not touch the repo', (c) => {
    const s = setup((r) => ({ a: proven(r) }));
    const r = cli([c, '--repo', s.repo, '--claims', s.claimsFile, '--out', join(s.out, 'never'), '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`claimcheck ${c}`);
    expect(r.stdout).toContain('--repo');
    expect(existsSync(join(s.out, 'never'))).toBe(false);
    expect(spawnSync('git', ['status', '--porcelain'], { cwd: s.repo, encoding: 'utf8' }).stdout).toBe('');
  });
  it('execute help lists --strict', () => expect(cli(['execute', '-h']).stdout).toContain('--strict'));
  it('unknown command exits 2 and points at --help', () => {
    const r = cli(['frobnicate']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('run claimcheck --help');
  });
});
