import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCorpus } from '../src/corpus';
import { askModel } from '../src/model';
import { withMutation } from '../src/mutate';
import { runCheck } from '../src/verdict';
import { tempRepo } from './helpers';

const TSX = join(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx');
const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const sh = (cwd: string, ...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8' });
const scratch = () => mkdtempSync(join(tmpdir(), 'claimcheck-sec-'));
const FILES = { 'src/a.ts': 'export const TTL = 600;\n' };
const target = (file = 'src/a.ts') => ({ file, line: 1, token: '600' });

describe('withMutation refuses unsafe targets', () => {
  it('an absolute path', async () => {
    const repo = tempRepo(FILES);
    const outside = join(scratch(), 'victim.ts');
    writeFileSync(outside, 'export const TTL = 600;\n');
    const r = await withMutation(repo, target(outside), async () => 1);
    expect('error' in r && r.error).toMatch(/absolute/);
    expect(readFileSync(outside, 'utf8')).toBe('export const TTL = 600;\n');
  });
  it('a ".." segment', async () => {
    const repo = tempRepo(FILES);
    const r = await withMutation(repo, target('src/../src/a.ts'), async () => 1);
    expect('error' in r && r.error).toMatch(/\.\./);
  });
  it('an untracked file', async () => {
    const repo = tempRepo(FILES);
    writeFileSync(join(repo, 'src/new.ts'), 'export const X = 600;\n');
    const r = await withMutation(repo, target('src/new.ts'), async () => 1);
    expect('error' in r && r.error).toMatch(/not tracked/);
    expect(readFileSync(join(repo, 'src/new.ts'), 'utf8')).toBe('export const X = 600;\n');
  });
  it('a tracked symlink, and does not touch what it points at', async () => {
    const outside = join(scratch(), 'victim.ts');
    writeFileSync(outside, 'export const TTL = 600;\n');
    const repo = tempRepo(FILES);
    symlinkSync(outside, join(repo, 'src/link.ts'));
    sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'link');
    const r = await withMutation(repo, target('src/link.ts'), async () => 1);
    expect('error' in r && r.error).toMatch(/symlink/);
    expect(readFileSync(outside, 'utf8')).toBe('export const TTL = 600;\n');
  });
  it('a file reached through a tracked symlinked directory that leaves the repo', async () => {
    const outDir = scratch();
    writeFileSync(join(outDir, 'a.ts'), 'export const TTL = 600;\n');
    const repo = tempRepo(FILES);
    symlinkSync(outDir, join(repo, 'ext'));
    sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'dir link');
    const r = await withMutation(repo, target('ext/a.ts'), async () => 1);
    expect('error' in r).toBe(true);
    expect(readFileSync(join(outDir, 'a.ts'), 'utf8')).toBe('export const TTL = 600;\n');
  });
  it('still mutates and restores an ordinary tracked file', async () => {
    const repo = tempRepo(FILES);
    const r = await withMutation(repo, target(), async () => readFileSync(join(repo, 'src/a.ts'), 'utf8'));
    expect('error' in r).toBe(false);
    if (!('error' in r)) expect(r.result).toContain('601');
    expect(readFileSync(join(repo, 'src/a.ts'), 'utf8')).toBe('export const TTL = 600;\n');
  });
});

describe('restore', () => {
  it('throws loudly, naming the file, when the file cannot be written back', async () => {
    const repo = tempRepo(FILES);
    await expect(withMutation(repo, target(), async () => { chmodSync(join(repo, 'src/a.ts'), 0o444); return 1; })).rejects.toThrow(/could not restore src\/a\.ts/);
    chmodSync(join(repo, 'src/a.ts'), 0o644);
  });
  it('never runs a clean or smudge filter defined by the target repository', async () => {
    const repo = tempRepo({ ...FILES, '.gitattributes': '*.ts filter=trap\n' });
    const marker = join(scratch(), 'filter-ran');
    for (const k of ['clean', 'smudge']) {
      spawnSync('git', ['config', `filter.trap.${k}`, `sh -c 'touch ${marker}; cat'`], { cwd: repo });
    }
    const r = await withMutation(repo, target(), async () => 1);
    expect('error' in r ? r.error : 'ok').toBe('ok');
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(repo, 'src/a.ts'), 'utf8')).toBe('export const TTL = 600;\n');
  });
});

describe('runCheck environment', () => {
  const saved = { ...process.env };
  afterEach(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  const run = (src: string) => {
    const repo = tempRepo(FILES);
    const f = join(scratch(), 'c.check.ts');
    writeFileSync(f, src);
    return runCheck(repo, f);
  };
  it('passes no API key, CLAIMCHECK_ variable or secret-looking variable to the check', async () => {
    process.env.AI_GATEWAY_API_KEY = 'sk-gw-123';
    process.env.CLAIMCHECK_MODEL = 'm-name';
    process.env.MY_SERVICE_TOKEN = 'tok-456';
    process.env.DB_PASSWORD = 'pw-789';
    process.env.CLAIMCHECK_TESTVAR_X = 'x-1';
    const r = await run('console.log(JSON.stringify(process.env));');
    for (const leak of ['sk-gw-123', 'm-name', 'tok-456', 'pw-789', 'x-1']) expect(r.output).not.toContain(leak);
    expect(r.output).toContain('"PATH"');
  });
  it('replaces the gateway key with [redacted] in captured output', async () => {
    process.env.AI_GATEWAY_API_KEY = 'sk-gw-readable-from-disk';
    const repo = tempRepo({ ...FILES, 'k.txt': 'sk-gw-readable-from-disk' });
    const f = join(scratch(), 'c.check.ts');
    writeFileSync(f, `import { readFileSync } from 'node:fs'; console.log('got', readFileSync(${JSON.stringify(join(repo, 'k.txt'))}, 'utf8'));`);
    const r = await runCheck(repo, f);
    expect(r.output).toContain('[redacted]');
    expect(r.output).not.toContain('sk-gw-readable-from-disk');
  });
});

describe('corpus', () => {
  it('skips tracked symlinks and paths that leave the repository', () => {
    const outDir = scratch();
    writeFileSync(join(outDir, 'secret.txt'), 'OUTSIDE_SECRET_VALUE\n');
    const repo = tempRepo({ 'src/a.ts': 'export const TTL = 600;\n' });
    symlinkSync(join(outDir, 'secret.txt'), join(repo, 'link.txt'));
    symlinkSync(outDir, join(repo, 'extdir'));
    sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'links');
    const files = readCorpus(repo).map((f) => f.file);
    expect(files).toContain('src/a.ts');
    expect(files).not.toContain('link.txt');
    expect(files.some((f) => f.startsWith('extdir'))).toBe(false);
  });
});

describe('claim ids', () => {
  it('an id that could escape --out is a usage error (exit 2) naming the id', async () => {
    const dir = scratch();
    const claims = join(dir, 'claims.json');
    writeFileSync(claims, JSON.stringify([{ id: '../../evil', quote: 'x' }]));
    const repo = tempRepo(FILES);
    const r = spawnSync(TSX, [CLI, 'prepare', '--repo', repo, '--claims', claims, '--out', join(dir, 'out')], { encoding: 'utf8', timeout: 60_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('../../evil');
    expect(existsSync(join(dir, 'evil'))).toBe(false);
  });
});

describe('gateway url', () => {
  const saved = { ...process.env };
  afterEach(() => { vi.unstubAllGlobals(); for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  it.each(['http://example.com/v1', 'ftp://example.com', 'http://localhost.evil.example/v1', 'not a url'])('refuses %s before sending the key', async (url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    process.env.AI_GATEWAY_API_KEY = 'k'; process.env.CLAIMCHECK_MODEL = 'm'; process.env.CLAIMCHECK_GATEWAY_URL = url;
    await expect(askModel('hi')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['https://gw.example/v1', 'http://localhost:4000/v1', 'http://127.0.0.1:4000/v1', 'http://[::1]:4000/v1'])('allows %s', async (url) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) });
    vi.stubGlobal('fetch', fetchMock);
    process.env.AI_GATEWAY_API_KEY = 'k'; process.env.CLAIMCHECK_MODEL = 'm'; process.env.CLAIMCHECK_GATEWAY_URL = url;
    await expect(askModel('hi')).resolves.toBe('ok');
  });
});

describe('git hardening', () => {
  it('a hostile repository config (fsmonitor, hooks, textconv) does not run code during mutation', async () => {
    const marks = scratch();
    const repo = tempRepo({ 'src/a.ts': 'export const TTL = 600;\n', '.gitattributes': '*.ts diff=boom\n' });
    const hook = (name: string) => `#!/bin/sh\necho ran > ${join(marks, name)}\nexit 0\n`;
    for (const n of ['fsmon', 'textconv', 'extdiff']) writeFileSync(join(marks, `${n}.sh`), hook(n), { mode: 0o755 });
    mkdirSync(join(repo, '.git/hooks'), { recursive: true });
    writeFileSync(join(repo, '.git/hooks/post-checkout'), hook('posthook'), { mode: 0o755 });
    sh(repo, 'config', 'core.fsmonitor', join(marks, 'fsmon.sh'));
    sh(repo, 'config', 'diff.boom.textconv', join(marks, 'textconv.sh'));
    sh(repo, 'config', 'diff.external', join(marks, 'extdiff.sh'));
    const r = await withMutation(repo, target(), async () => 1);
    expect('error' in r).toBe(false);
    for (const m of ['fsmon', 'textconv', 'extdiff', 'posthook']) expect(existsSync(join(marks, m)), m).toBe(false);
  });
});
