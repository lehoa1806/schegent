// Review gap GC-24 (2026-11-12) — on win32 a bare program name never resolves from the cwd.
//
// WHAT THIS PINS:
//   - libuv on win32 searches the current directory before PATH for a bare name, and every agent
//     CLI and git call spawns with the workspace as its cwd: a `claude.exe` or `git.exe` committed
//     to a repository would run in place of the installed one. npm installs CLIs as `.cmd` shims,
//     which libuv does not try, so the planted file would win even with the real CLI installed;
//   - `spawnCommandFor` resolves a bare name along PATH only, trying `.com` then `.exe` as libuv
//     does, and returns the absolute path; a miss throws an `ENOENT` error naming no directory;
//   - a name with a separator, and every name on another platform, passes through unchanged;
//   - every agent CLI and git spawn site calls it (census below).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnCommandFor } from '../../../src/lib/spawn-command';

let root = '';
let cwdDir = '';
let binA = '';
let binB = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gc24-'));
  cwdDir = join(root, 'workspace');
  binA = join(root, 'a');
  binB = join(root, 'b');
  for (const dir of [cwdDir, binA, binB]) mkdirSync(dir);
  writeFileSync(join(cwdDir, 'claude.exe'), 'planted');
  writeFileSync(join(binA, 'claude.cmd'), 'shim');
  writeFileSync(join(binB, 'claude.exe'), 'real');
  writeFileSync(join(binA, 'git.com'), 'com first');
  writeFileSync(join(binA, 'git.exe'), 'exe second');
  writeFileSync(join(binB, 'tool.v2.exe'), 'dotted');
  mkdirSync(join(binA, 'codex.exe'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function winEnv(...dirs: string[]): NodeJS.ProcessEnv {
  return { Path: dirs.join(';') };
}

describe('GC-24 — win32 bare names resolve along PATH only', () => {
  it('returns the PATH hit, not a file of the same name in the cwd', () => {
    expect(spawnCommandFor('claude', winEnv(binA, binB), 'win32')).toBe(join(binB, 'claude.exe'));
  });

  it('tries .com before .exe in one directory, as libuv does', () => {
    expect(spawnCommandFor('git', winEnv(binA), 'win32')).toBe(join(binA, 'git.com'));
  });

  it('tries the name as given first when it has an extension', () => {
    expect(spawnCommandFor('tool.v2.exe', winEnv(binB), 'win32')).toBe(join(binB, 'tool.v2.exe'));
  });

  it('skips a directory that carries the program name', () => {
    expect(() => spawnCommandFor('codex', winEnv(binA), 'win32')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });

  it('throws ENOENT on a miss and names no directory', () => {
    let caught: unknown;
    try {
      spawnCommandFor('claude', winEnv(binA), 'win32');
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: 'ENOENT' });
    expect(String((caught as Error).message)).not.toContain(root);
  });

  it('throws ENOENT when PATH is empty, rather than falling back to the cwd', () => {
    expect(() => spawnCommandFor('claude', {}, 'win32')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });

  it('reads PATH case-insensitively on win32', () => {
    expect(spawnCommandFor('claude', { PATH: binB }, 'win32')).toBe(join(binB, 'claude.exe'));
  });
});

describe('GC-24 — everything else passes through', () => {
  it('leaves a bare name unchanged off win32', () => {
    expect(spawnCommandFor('claude', { PATH: binB }, 'darwin')).toBe('claude');
    expect(spawnCommandFor('git', { PATH: binB }, 'linux')).toBe('git');
  });

  it('leaves a name with a separator unchanged on win32', () => {
    const explicit = join(binB, 'claude.exe');

    expect(spawnCommandFor(explicit, winEnv(binA), 'win32')).toBe(explicit);
    expect(spawnCommandFor('.\\claude.exe', winEnv(binA), 'win32')).toBe('.\\claude.exe');
  });
});

describe('GC-24 — every agent CLI and git spawn site resolves through it', () => {
  const SITES = [
    'src/runner/claude-cli.ts',
    'src/runner/process-lifecycle-runner.ts',
    'src/runner/cli-version-probe.ts',
    'src/services/acp-runtime/stdio-transport.ts',
    'src/services/backend-capability-service.ts',
    'src/services/execution-lanes/git-runner.ts',
    'src/lib/git-diff-base.ts',
    'src/services/run-checkpoint-service.ts',
    'src/services/workflow-execution/recovery-envelope-builder.ts',
    'src/activation/run-safety-wiring.ts'
  ];

  it.each(SITES)('%s calls spawnCommandFor', (site) => {
    const source = readFileSync(resolve(__dirname, '..', '..', '..', site), 'utf8');

    expect(source).toMatch(/spawnCommandFor\(/);
  });
});
