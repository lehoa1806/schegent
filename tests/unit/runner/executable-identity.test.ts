// FR-R6-F09 T014 & FR-R7-16 (16-16, FR-016) -- executable resolution before spawn.
//
// WHAT THIS PINS:
//   - Delegates to `resolveExecutableCommand` so qualification and launch share one contract;
//   - Explicit strictly-absolute paths are checked directly (regular + X_OK on POSIX, regular file
//     on Win32); explicit relative, drive-relative, and rooted-without-drive paths are refused;
//   - Bare names search strictly-absolute PATH entries only (skipping empty/relative entries);
//   - On Win32, bare names match only spawnable `.com` / `.exe` regular files (never `.cmd`/`.bat`).

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ExecutableAccessProbe } from '../../../src/lib/spawn-command';
import { resolveExecutable } from '../../../src/runner/executable-identity';

let root = '';
let binA = '';
let binB = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'f09-exec-'));
  binA = join(root, 'a');
  binB = join(root, 'b');
  mkdirSync(binA);
  mkdirSync(binB);
  writeFileSync(join(binA, 'plain'), 'not a program', 'utf8');
  chmodSync(join(binA, 'plain'), 0o644);
  writeFileSync(join(binB, 'plain'), '#!/bin/sh\n', 'utf8');
  chmodSync(join(binB, 'plain'), 0o755);
  writeFileSync(join(binA, 'tool'), '#!/bin/sh\n', 'utf8');
  chmodSync(join(binA, 'tool'), 0o755);
  writeFileSync(join(binA, 'noexec'), 'data', 'utf8');
  chmodSync(join(binA, 'noexec'), 0o644);
  mkdirSync(join(binA, 'folder'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeWin32Probe(files: Record<string, 'file' | 'dir'>): ExecutableAccessProbe {
  const table = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  return (candidate) => {
    const kind = table.get(candidate.toLowerCase());
    if (kind === 'file') return 'resolved';
    if (kind === 'dir') return 'not-executable';
    return 'not-found';
  };
}

describe('FR-R6-F09 T014 & 16-16 -- explicit paths', () => {
  it('resolves an executable regular file at an absolute POSIX path', async () => {
    await expect(resolveExecutable(join(binA, 'tool'), '', 'darwin')).resolves.toBe('resolved');
  });

  it('gives not-found for a missing file', async () => {
    await expect(resolveExecutable(join(binA, 'missing'), '', 'darwin')).resolves.toBe('not-found');
  });

  it('gives not-executable for a file without the execute bit', async () => {
    await expect(resolveExecutable(join(binA, 'noexec'), '', 'linux')).resolves.toBe('not-executable');
  });

  it('gives not-executable for a directory', async () => {
    await expect(resolveExecutable(join(binA, 'folder'), '', 'darwin')).resolves.toBe('not-executable');
  });

  it('refuses explicit relative paths even when a matching executable exists relative to cwd', async () => {
    const relToTool = relative(process.cwd(), join(binA, 'tool'));
    await expect(resolveExecutable('./tool', binA, 'darwin')).resolves.toBe('not-found');
    await expect(resolveExecutable(relToTool, binA, 'darwin')).resolves.toBe('not-found');
  });
});

describe('FR-R6-F09 T014 & 16-16 -- bare names search strictly absolute PATH entries only', () => {
  it('finds a bare name on PATH', async () => {
    await expect(resolveExecutable('tool', [binB, binA].join(delimiter), 'darwin')).resolves.toBe('resolved');
  });

  it('skips a non-executable hit and keeps searching', async () => {
    await expect(resolveExecutable('plain', [binA, binB].join(delimiter), 'darwin')).resolves.toBe('resolved');
  });

  it('gives not-executable when every hit lacks the execute bit', async () => {
    await expect(resolveExecutable('noexec', binA, 'darwin')).resolves.toBe('not-executable');
  });

  it('ignores empty and relative PATH entries', async () => {
    const relBinA = relative(process.cwd(), binA);
    await expect(resolveExecutable('tool', `:${relBinA}:.:`, 'darwin')).resolves.toBe('not-found');
    await expect(resolveExecutable('tool', `:${relBinA}:.:${binA}`, 'darwin')).resolves.toBe('resolved');
  });

  it('gives not-found when no PATH entry holds the name, or PATH is empty or absent', async () => {
    await expect(resolveExecutable('absent', [binA, binB].join(delimiter), 'darwin')).resolves.toBe('not-found');
    await expect(resolveExecutable('tool', '', 'darwin')).resolves.toBe('not-found');
    await expect(resolveExecutable('tool', undefined, 'darwin')).resolves.toBe('not-found');
  });

  it('gives not-found for an empty setting', async () => {
    await expect(resolveExecutable('', binA, 'darwin')).resolves.toBe('not-found');
  });
});

describe('16-16 -- win32 matches spawnable .com/.exe files on strictly absolute PATH entries', () => {
  const probe = makeWin32Probe({
    'C:\\binA\\shim.cmd': 'file',
    'C:\\binA\\shim.bat': 'file',
    'C:\\binA\\winny.exe': 'file',
    'C:\\binA\\comtool.com': 'file',
    'C:\\binA\\noexec': 'file',
    'C:\\binA\\folder': 'dir'
  });

  it('resolves bare .exe and .com hits and refuses .cmd/.bat shims', async () => {
    await expect(resolveExecutable('winny', { Path: 'C:\\binA' }, 'win32', probe)).resolves.toBe('resolved');
    await expect(resolveExecutable('comtool', { PATH: 'C:\\binA' }, 'win32', probe)).resolves.toBe('resolved');
    await expect(resolveExecutable('shim', { Path: 'C:\\binA' }, 'win32', probe)).resolves.toBe('not-found');
  });

  it('accepts an existing regular file at a strict absolute win32 path without POSIX X_OK', async () => {
    await expect(resolveExecutable('C:\\binA\\noexec', '', 'win32', probe)).resolves.toBe('resolved');
    await expect(resolveExecutable('C:\\binA\\folder', '', 'win32', probe)).resolves.toBe('not-executable');
  });

  it('refuses relative, drive-relative, and rooted-without-drive win32 paths and PATH entries', async () => {
    await expect(resolveExecutable('.\\winny.exe', { Path: 'C:\\binA' }, 'win32', probe)).resolves.toBe('not-found');
    await expect(resolveExecutable('C:winny.exe', { Path: 'C:\\binA' }, 'win32', probe)).resolves.toBe('not-found');
    await expect(resolveExecutable('\\binA\\winny.exe', { Path: 'C:\\binA' }, 'win32', probe)).resolves.toBe('not-found');
    await expect(resolveExecutable('winny', { Path: '.;C:binA;\\binA' }, 'win32', probe)).resolves.toBe('not-found');
  });

  it('CR-B5: refuses explicit absolute .cmd and .bat paths on win32 as not-executable without probing disk', async () => {
    const spyProbe = vi.fn(probe);
    for (const candidate of [
      'C:\\binA\\shim.cmd',
      'C:\\binA\\shim.bat',
      'C:\\binA\\SHIM.CMD',
      '\\\\server\\share\\bin\\shim.bat'
    ]) {
      await expect(resolveExecutable(candidate, '', 'win32', spyProbe), candidate).resolves.toBe(
        'not-executable'
      );
    }
    expect(spyProbe).not.toHaveBeenCalled();
  });
});
