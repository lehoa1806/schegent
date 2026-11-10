// FR-R6-F09 T014 -- executable resolution before spawn (research R8, FR-008).
//
// WHAT THIS PINS: a path with a separator is checked as given; a bare name is searched along
// PATH, and on win32 the PATHEXT extensions are tried; a hit must be a regular file with execute
// permission (existence only on win32); a missing file is `not-found`; a non-executable regular
// file and a directory are `not-executable`. The result is a closed word, never a path.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  writeFileSync(join(binA, 'winny.CMD'), '@echo off\n', 'utf8');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('FR-R6-F09 T014 -- a path with a separator is checked as given', () => {
  it('resolves an executable regular file', async () => {
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

  it('never searches PATH for a path with a separator', async () => {
    await expect(resolveExecutable('./tool', binA, 'darwin')).resolves.toBe('not-found');
  });
});

describe('FR-R6-F09 T014 -- a bare name is searched along PATH', () => {
  it('finds a bare name on PATH', async () => {
    await expect(resolveExecutable('tool', [binB, binA].join(delimiter), 'darwin')).resolves.toBe('resolved');
  });

  it('skips a non-executable hit and keeps searching', async () => {
    await expect(resolveExecutable('plain', [binA, binB].join(delimiter), 'darwin')).resolves.toBe('resolved');
  });

  it('gives not-executable when every hit lacks the execute bit', async () => {
    await expect(resolveExecutable('noexec', binA, 'darwin')).resolves.toBe('not-executable');
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

describe('FR-R6-F09 T014 -- win32 tries PATHEXT and checks existence only', () => {
  it('finds a bare name through a PATHEXT extension', async () => {
    await expect(resolveExecutable('winny', binA, 'win32', '.EXE;.CMD')).resolves.toBe('resolved');
  });

  it('accepts an existing file without the execute bit', async () => {
    await expect(resolveExecutable(join(binA, 'noexec'), '', 'win32')).resolves.toBe('resolved');
  });

  it('gives not-found when no extension matches', async () => {
    await expect(resolveExecutable('winny', binA, 'win32', '.EXE;.BAT')).resolves.toBe('not-found');
  });
});
