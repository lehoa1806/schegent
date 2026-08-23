import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { openWithinRoot } from '../../../src/lib/safe-open';

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
