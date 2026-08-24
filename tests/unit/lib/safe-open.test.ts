import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  ensureDirWithinRoot,
  openWithinRoot,
  openWithinRootByPath,
  segmentsUnderRoot
} from '../../../src/lib/safe-open';

/**
 * FR-R3-053 — every assertion here drives the real filesystem with real
 * symlinks. A mocked `fs` would prove the argument shape, not the refusal: the
 * whole claim is about what the kernel does when a component is a link.
 */
const posixOnly = process.platform === 'win32' ? it.skip : it;

describe('openWithinRoot refuses a symlink at any component', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-safeopen-'));
    root = path.join(base, 'root');
    outside = path.join(base, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
  });

  afterEach(async () => {
    await fs.rm(path.dirname(root), { recursive: true, force: true });
  });

  const open = (segments: readonly string[], createDirs = true) =>
    openWithinRoot(root, segments, { flags: 'a', createDirs, dirMode: 0o700 });

  posixOnly('opens and writes through a clean path', async () => {
    const result = await open(['.schegent', 'audit.log']);
    expect(result.outcome).toBe('opened');
    if (result.outcome !== 'opened') return;
    await result.handle.write('line\n');
    await result.handle.close();
    expect(await fs.readFile(path.join(root, '.schegent', 'audit.log'), 'utf8')).toBe('line\n');
  });

  posixOnly('refuses a symlinked intermediate directory', async () => {
    await fs.symlink(outside, path.join(root, '.schegent'));
    const result = await open(['.schegent', 'audit.log']);
    expect(result).toMatchObject({ outcome: 'refused', reason: 'symlink-component' });
    // The point of the refusal: nothing was created through the link.
    expect(await fs.readdir(outside)).toEqual([]);
  });

  posixOnly('refuses a symlinked leaf', async () => {
    await fs.mkdir(path.join(root, '.schegent'));
    const target = path.join(outside, 'stolen.log');
    await fs.writeFile(target, '');
    await fs.symlink(target, path.join(root, '.schegent', 'audit.log'));
    const result = await open(['.schegent', 'audit.log']);
    expect(result).toMatchObject({ outcome: 'refused', reason: 'symlink-leaf' });
    expect(await fs.readFile(target, 'utf8')).toBe('');
  });

  posixOnly('refuses a leaf that is not a regular file', async () => {
    await fs.mkdir(path.join(root, '.schegent'), { recursive: true });
    await fs.mkdir(path.join(root, '.schegent', 'audit.log'));
    const result = await open(['.schegent', 'audit.log']);
    // EISDIR, reported as `io-failed`: the kernel refuses the write-mode open
    // before the `fstat` guard is reached. Asserted precisely rather than as a
    // bare "refused", so the reason cannot drift without this noticing.
    expect(result).toMatchObject({ outcome: 'refused', reason: 'io-failed', errno: 'EISDIR' });
  });

  it('refuses traversal, absolute, and empty segments without touching disk', async () => {
    for (const segments of [
      ['..', 'escape.log'],
      ['.schegent', '..', '..', 'escape.log'],
      [path.join(path.sep, 'etc', 'passwd')],
      ['.schegent', ''],
      []
    ]) {
      const result = await openWithinRoot(root, segments, { flags: 'a', createDirs: true });
      expect(result).toMatchObject({ outcome: 'refused', reason: 'escapes-root' });
    }
  });

  posixOnly('refuses when an intermediate component is a regular file', async () => {
    await fs.writeFile(path.join(root, '.schegent'), 'not a directory');
    const result = await open(['.schegent', 'audit.log']);
    expect(result).toMatchObject({ outcome: 'refused', reason: 'not-a-directory' });
  });

  posixOnly('does not create directories when not asked to', async () => {
    const result = await open(['.schegent', 'audit.log'], false);
    expect(result).toMatchObject({ outcome: 'refused', errno: 'ENOENT' });
    await expect(fs.readdir(path.join(root, '.schegent'))).rejects.toThrow();
  });

  posixOnly('rejects a flags value it cannot translate, rather than guessing', async () => {
    await expect(
      openWithinRoot(root, ['x.log'], { flags: 'a+' })
    ).rejects.toThrow(/unsupported flags/);
  });
});

describe('openWithinRootByPath derives the segments and keeps the same rules', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-bypath-'));
    root = path.join(base, 'root');
    outside = path.join(base, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
  });

  afterEach(async () => {
    await fs.rm(path.dirname(root), { recursive: true, force: true });
  });

  posixOnly('opens a path under the root', async () => {
    const result = await openWithinRootByPath(root, path.join(root, 'a', 'b.log'), {
      flags: 'a',
      createDirs: true,
      dirMode: 0o700
    });
    expect(result.outcome).toBe('opened');
    if (result.outcome !== 'opened') return;
    await result.handle.close();
  });

  it('refuses a path outside the root', async () => {
    // The derivation IS the check: `path.relative` yields a `..` prefix and the
    // walk never starts.
    const result = await openWithinRootByPath(root, path.join(outside, 'x.log'), { flags: 'a' });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'escapes-root' });
  });

  it('refuses the root itself, which names no leaf to open', async () => {
    const result = await openWithinRootByPath(root, root, { flags: 'a' });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'escapes-root' });
  });

  posixOnly('refuses a symlinked component reached by path, exactly as by segments', async () => {
    // The convenience must not have looser rules than the primitive it wraps.
    await fs.symlink(outside, path.join(root, 'linked'));
    const result = await openWithinRootByPath(root, path.join(root, 'linked', 'x.log'), {
      flags: 'a',
      createDirs: true
    });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'symlink-component' });
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('reports segments under the root, and null for anything else', () => {
    expect(segmentsUnderRoot(root, path.join(root, 'a', 'b'))).toEqual(['a', 'b']);
    expect(segmentsUnderRoot(root, root)).toBeNull();
    expect(segmentsUnderRoot(root, path.join(outside, 'a'))).toBeNull();
  });
});

describe('ensureDirWithinRoot makes a directory without inventing a file', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-ensuredir-'));
    root = path.join(base, 'root');
    outside = path.join(base, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
  });

  afterEach(async () => {
    await fs.rm(path.dirname(root), { recursive: true, force: true });
  });

  posixOnly('creates the chain and leaves it EMPTY', async () => {
    // The whole reason this exists. Spelling "make this directory" as "open a
    // marker inside it" put a stray dotfile in every checkpoint and diagnostics
    // directory, and broke listings that assert their exact contents.
    const ready = await ensureDirWithinRoot(root, ['checkpoints', 'run-1'], 0o700);
    expect(ready.outcome).toBe('ready');
    const made = path.join(root, 'checkpoints', 'run-1');
    expect(await fs.readdir(made)).toEqual([]);
    expect((await fs.stat(made)).mode & 0o777).toBe(0o700);
  });

  posixOnly('is idempotent', async () => {
    await ensureDirWithinRoot(root, ['a', 'b'], 0o700);
    expect((await ensureDirWithinRoot(root, ['a', 'b'], 0o700)).outcome).toBe('ready');
    expect(await fs.readdir(path.join(root, 'a', 'b'))).toEqual([]);
  });

  posixOnly('refuses a symlinked component, and creates nothing through it', async () => {
    await fs.symlink(outside, path.join(root, 'linked'));
    const ready = await ensureDirWithinRoot(root, ['linked', 'deep'], 0o700);
    expect(ready).toMatchObject({ outcome: 'refused', reason: 'symlink-component' });
    expect(await fs.readdir(outside)).toEqual([]);
  });

  posixOnly('refuses when a component is a regular file', async () => {
    await fs.writeFile(path.join(root, 'a-file'), 'x');
    const ready = await ensureDirWithinRoot(root, ['a-file', 'deep'], 0o700);
    expect(ready).toMatchObject({ outcome: 'refused', reason: 'not-a-directory' });
  });

  it('refuses traversal and empty segment lists without touching disk', async () => {
    for (const segments of [[], ['..'], ['a', '..'], ['']]) {
      expect(await ensureDirWithinRoot(root, segments, 0o700)).toMatchObject({
        outcome: 'refused',
        reason: 'escapes-root'
      });
    }
  });
});
