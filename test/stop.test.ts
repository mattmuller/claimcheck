// Stop signals, process groups, restore refusal, path checks, literal pathspecs, host bounds.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { graphCandidates } from '../src/graph';
import { isInside } from '../src/gitutil';
import { parsePeriods } from '../src/parse';
import { withMutation } from '../src/mutate';
import { runCheck } from '../src/verdict';
import { tempRepo } from './helpers';

const ROOT = join(import.meta.dirname, '..');
const scratch = () => mkdtempSync(join(tmpdir(), 'claimcheck-stop-'));
const ORIG = 'export const TTL = 600;\n';
const FILES = { 'src/a.ts': ORIG };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (f: string, ms = 30_000) => { const end = Date.now() + ms; while (!existsSync(f)) { if (Date.now() > end) throw new Error(`timeout waiting for ${f}`); await sleep(50); } };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const exited = (c: ChildProcess) => new Promise<number | null>((r) => c.on('exit', (code, sig) => r(code ?? (sig ? 1 : null))));

/** A driver that mutates src/a.ts and runs a check that signals `started` then sleeps (and optionally leaves a grandchild). */
function setup(opts: { grandchild?: boolean; sleepMs?: number } = {}) {
  const repo = tempRepo(FILES);
  const dir = scratch();
  const started = join(dir, 'started');
  const gcPid = join(dir, 'gc.pid');
  const check = join(dir, 'c.check.ts');
  writeFileSync(check, `import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
${opts.grandchild ? `const g = spawn('sleep', ['300'], { stdio: 'ignore' }); g.unref(); writeFileSync(${JSON.stringify(gcPid)}, String(g.pid));` : ''}
writeFileSync(${JSON.stringify(started)}, '1');
setTimeout(() => {}, ${opts.sleepMs ?? 8000});
`);
  const driver = join(dir, 'driver.mts');
  writeFileSync(driver, `import { withMutation } from ${JSON.stringify(join(ROOT, 'src/mutate.ts'))};
import { runCheck } from ${JSON.stringify(join(ROOT, 'src/verdict.ts'))};
await withMutation(${JSON.stringify(repo)}, { file: 'src/a.ts', line: 1, token: '600' }, () => runCheck(${JSON.stringify(repo)}, ${JSON.stringify(check)}));
`);
  return { repo, dir, started, gcPid, driver, check };
}

describe('stop signals restore the file at once', () => {
  it.each([['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129], ['SIGQUIT', 131]] as const)('%s 1 s into an 8 s check restores within 2 s and exits %i', async (sig, code) => {
    const s = setup();
    const child = spawn(process.execPath, ['--import', 'tsx', s.driver], { cwd: ROOT, stdio: 'ignore' });
    const done = exited(child);
    await waitFor(s.started);
    await sleep(1000);
    expect(readFileSync(join(s.repo, 'src/a.ts'), 'utf8')).toContain('601');
    const t0 = Date.now();
    child.kill(sig);
    const status = await done;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(status).toBe(code);
    expect(readFileSync(join(s.repo, 'src/a.ts'), 'utf8')).toBe(ORIG);
  }, 60_000);

  it('leaves no grandchild alive after a stop signal', async () => {
    const s = setup({ grandchild: true });
    const child = spawn(process.execPath, ['--import', 'tsx', s.driver], { cwd: ROOT, stdio: 'ignore' });
    const done = exited(child);
    await waitFor(s.started);
    const pid = Number(readFileSync(s.gcPid, 'utf8'));
    expect(alive(pid)).toBe(true);
    child.kill('SIGTERM');
    await done;
    await sleep(300);
    expect(alive(pid)).toBe(false);
    expect(readFileSync(join(s.repo, 'src/a.ts'), 'utf8')).toBe(ORIG);
  }, 60_000);

  it('through the tsx dev wrapper (tsx src/cli.ts) the file is restored and no grandchild survives', async () => {
    const s = setup({ grandchild: true });
    const out = join(s.dir, 'out');
    mkdirSync(join(out, 'work/c1'), { recursive: true });
    // The real check passes only if it also passes on unmutated code, so it must finish: use a short, separate real run first.
    const claims = join(s.dir, 'claims.json');
    writeFileSync(claims, JSON.stringify([{ id: 'c1', quote: 'x' }]));
    // The check sleeps long enough to be interrupted in both the real run and the mutant run.
    const src = readFileSync(s.check, 'utf8').replace('setTimeout(() => {}, 8000);', "if (readFileSync(" + JSON.stringify(join(s.repo, 'src/a.ts')) + ", 'utf8').includes('601')) setTimeout(() => {}, 30000);").replace("import { spawn }", "import { readFileSync } from 'node:fs';\nimport { spawn }");
    writeFileSync(join(out, 'work/c1/answer.json'), JSON.stringify({ target: { file: 'src/a.ts', line: 1, token: '600' }, notLocated: false, notCheckable: false, checkKind: 'behavioural', checkSource: src }));
    const child = spawn(join(ROOT, 'node_modules/.bin/tsx'), [join(ROOT, 'src/cli.ts'), 'execute', '--repo', s.repo, '--claims', claims, '--out', out], { cwd: ROOT, stdio: 'ignore' });
    const done = exited(child);
    // the real run is quick; the mutant run writes `started` again, so wait until the file is mutated
    const end = Date.now() + 40_000;
    while (!readFileSync(join(s.repo, 'src/a.ts'), 'utf8').includes('601')) { if (Date.now() > end) throw new Error('never mutated'); await sleep(50); }
    await sleep(1000);
    const pid = Number(readFileSync(s.gcPid, 'utf8'));
    child.kill('SIGTERM');
    await done;
    await sleep(500);
    expect(readFileSync(join(s.repo, 'src/a.ts'), 'utf8')).toBe(ORIG);
    expect(alive(pid)).toBe(false);
  }, 90_000);
});

describe('runCheck process group', () => {
  it('a timeout kills the check and its grandchild', async () => {
    const s = setup({ grandchild: true, sleepMs: 60_000 });
    const r = await runCheck(s.repo, s.check, 2500);
    expect(r.status).toBe('crash');
    const pid = Number(readFileSync(s.gcPid, 'utf8'));
    await sleep(300);
    expect(alive(pid)).toBe(false);
  }, 60_000);
  it('a check that exits normally leaves no grandchild behind', async () => {
    const s = setup({ grandchild: true, sleepMs: 1 });
    const r = await runCheck(s.repo, s.check);
    expect(r.status).toBe('pass');
    await sleep(300);
    expect(alive(Number(readFileSync(s.gcPid, 'utf8')))).toBe(false);
  }, 60_000);
  it('does not pass NODE_OPTIONS to the check', async () => {
    const saved = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--max-old-space-size=123';
    try {
      const repo = tempRepo(FILES);
      const f = join(scratch(), 'c.check.ts');
      writeFileSync(f, 'console.log("NO=" + process.env.NODE_OPTIONS);');
      expect((await runCheck(repo, f)).output).toContain('NO=undefined');
    } finally { if (saved === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = saved; }
  });
});

describe('restore refuses to write through a swapped path', () => {
  it('a check that replaces the file with a symlink: loud error, victim untouched', async () => {
    const victim = join(scratch(), 'victim.txt');
    writeFileSync(victim, 'VICTIM\n');
    const repo = tempRepo(FILES);
    await expect(withMutation(repo, { file: 'src/a.ts', line: 1, token: '600' }, async () => {
      unlinkSync(join(repo, 'src/a.ts'));
      symlinkSync(victim, join(repo, 'src/a.ts'));
      return 1;
    })).rejects.toThrow(/refuses to restore src\/a\.ts.*no longer a regular file/);
    expect(readFileSync(victim, 'utf8')).toBe('VICTIM\n');
  });
});

describe('isInside', () => {
  it('rejects the root itself, parents, siblings and absolute results', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true);
    expect(isInside('/a/b', '/a/b/..c')).toBe(true);
    for (const p of ['/a/b', '/a', '/a/bc', '/a/b/../x', '/x']) expect(isInside('/a/b', p), p).toBe(false);
  });
});

describe('literal pathspecs', () => {
  it.skipIf(process.platform === 'win32')('a target named like a glob does not match a tracked file', async () => {
    const repo = tempRepo(FILES);
    writeFileSync(join(repo, 'src/*.ts'), ORIG); // untracked, same bytes as the tracked file the glob would match
    const r = await withMutation(repo, { file: 'src/*.ts', line: 1, token: '600' }, async () => 1);
    expect('error' in r && r.error).toMatch(/not tracked/);
    expect(readFileSync(join(repo, 'src/*.ts'), 'utf8')).toBe(ORIG);
  });
});

describe('refusal says why the file differs', () => {
  it('CRLF in the working tree against LF in the index names byte-for-byte and autocrlf', async () => {
    const repo = tempRepo(FILES);
    writeFileSync(join(repo, 'src/a.ts'), ORIG.replace('\n', '\r\n'));
    const r = await withMutation(repo, { file: 'src/a.ts', line: 1, token: '600' }, async () => 1);
    expect('error' in r && r.error).toMatch(/byte-for-byte/);
    expect('error' in r && r.error).toMatch(/core\.autocrlf/);
  });
});

describe('graph stays inside the repository', () => {
  it('a relative import to a file outside the repo never contributes a candidate', () => {
    const outer = scratch();
    writeFileSync(join(outer, 'x.ts'), 'export const MINS = 15;\n');
    const repo = tempRepo({ 'src/a.ts': `import { MINS } from ${JSON.stringify(join(outer, 'x'))};\nexport const TTL = MINS * 60 * 1000;\n` });
    expect(graphCandidates(repo, parsePeriods('Entries live for 15 minutes.'))).toEqual([]);
    const inside = tempRepo({ 'src/x.ts': 'export const MINS = 15;\n', 'src/a.ts': "import { MINS } from './x';\nexport const TTL = MINS * 60 * 1000;\n" });
    expect(graphCandidates(inside, parsePeriods('Entries live for 15 minutes.')).length).toBeGreaterThan(0);
  });
  it('a tsconfig paths entry that leads outside the repo never contributes a candidate', () => {
    const outer = scratch();
    writeFileSync(join(outer, 'x.ts'), 'export const MINS = 15;\n');
    const repo = tempRepo({
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@ext/*': [`${outer}/*`] } } }),
      'src/a.ts': "import { MINS } from '@ext/x';\nexport const TTL = MINS * 60 * 1000;\n",
    });
    expect(graphCandidates(repo, parsePeriods('Entries live for 15 minutes.'))).toEqual([]);
  });
});
