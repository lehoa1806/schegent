import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NON_OWNER_BITS, narrowMode, noticeFor } from '../../../src/lib/narrow-mode';

/**
 * Feature 217 (FR-002, FR-003, FR-007) — the single narrowing mechanism.
 *
 * Every assertion reads the mode back from a real filesystem. A mocked `fs` can
 * only prove which arguments were passed; the claims here are what the
 * filesystem now GRANTS, and whose file it was granted on.
 *
 * The one seam is `chmod`, made a no-op on request, to stand in for a platform
 * that accepts a mode change without applying it -- Windows synthesises modes and
 * `chmod` there only toggles the read-only attribute, and some network mounts
 * accept the call and ignore it. Without the seam that branch can only be reached
 * on a machine this gate never runs on.
 */
const seam = vi.hoisted(() => ({ chmodIsNoOp: false }));

vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...real,
    chmod: async (...args: Parameters<typeof real.chmod>) => {
      if (seam.chmodIsNoOp) return;
      await real.chmod(...args);
    }
  };
});

const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIR = 0o700;
const WIDENED_FILE = 0o644;
const WIDENED_DIR = 0o755;

/** POSIX-only: `mode` is not an enforceable concept on Windows. */
const posixOnly = process.platform === 'win32' ? it.skip : it;

const modeOf = async (p: string): Promise<number> => (await fs.lstat(p)).mode & 0o777;

describe('narrowMode — the single narrowing mechanism', () => {
  let base: string;

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-narrow-'));
  });

  afterEach(async () => {
    seam.chmodIsNoOp = false;
    await fs.rm(base, { recursive: true, force: true });
  });

  it('names group and other, all classes, as the bits that must never be set', () => {
    expect(NON_OWNER_BITS).toBe(0o077);
  });

  posixOnly('refuses to act through a symbolic link, and says so (FR-003)', async () => {
    // `chmod` follows a link, so narrowing a symlinked evidence path would change
    // the mode of whatever it points at. The outsider's mode is the whole claim,
    // so it is read from disk rather than inferred from the outcome.
    const outsider = path.join(base, 'outsider.txt');
    await fs.writeFile(outsider, 'not evidence');
    await fs.chmod(outsider, WIDENED_FILE);
    const link = path.join(base, 'audit.log');
    await fs.symlink(outsider, link);

    const outcome = await narrowMode(link, OWNER_ONLY_FILE);

    expect(outcome).toMatchObject({ outcome: 'refused-symlink' });
    expect(await modeOf(outsider), 'the link target is untouched').toBe(WIDENED_FILE);
    expect((await fs.lstat(link)).isSymbolicLink(), 'the link is left in place').toBe(true);
  });

  posixOnly('refuses a symbolic link to a directory the same way', async () => {
    const outsideDir = path.join(base, 'outside');
    await fs.mkdir(outsideDir);
    await fs.chmod(outsideDir, WIDENED_DIR);
    const link = path.join(base, '.schegent');
    await fs.symlink(outsideDir, link);

    expect(await narrowMode(link, OWNER_ONLY_DIR)).toMatchObject({ outcome: 'refused-symlink' });
    expect(await modeOf(outsideDir)).toBe(WIDENED_DIR);
  });

  posixOnly('narrows an existing widened file in place, keeping its inode and its contents (FR-002)', async () => {
    // The audit log is hash-chained: recreating or truncating it to change its
    // mode would break the chain, so "narrowed" must mean the SAME file.
    const file = path.join(base, 'audit.log');
    const contents = '{"seq":1,"hash":"aaa"}\n{"seq":2,"hash":"bbb"}\n';
    await fs.writeFile(file, contents);
    await fs.chmod(file, WIDENED_FILE);
    const before = await fs.lstat(file);

    const outcome = await narrowMode(file, OWNER_ONLY_FILE);

    expect(outcome).toEqual({ outcome: 'narrowed', previousMode: WIDENED_FILE });
    const after = await fs.lstat(file);
    expect(after.mode & 0o777).toBe(OWNER_ONLY_FILE);
    expect(after.ino, 'not recreated').toBe(before.ino);
    expect(after.size, 'not truncated').toBe(before.size);
    expect(await fs.readFile(file, 'utf8')).toBe(contents);
  });

  posixOnly('narrows an existing widened directory', async () => {
    const dir = path.join(base, '.schegent');
    await fs.mkdir(dir);
    await fs.chmod(dir, WIDENED_DIR);

    expect(await narrowMode(dir, OWNER_ONLY_DIR)).toEqual({
      outcome: 'narrowed',
      previousMode: WIDENED_DIR
    });
    expect(await modeOf(dir)).toBe(OWNER_ONLY_DIR);
  });

  posixOnly('leaves an owner-only path alone and reports it already private', async () => {
    const file = path.join(base, 'private.log');
    await fs.writeFile(file, 'x', { mode: OWNER_ONLY_FILE });
    await fs.chmod(file, OWNER_ONLY_FILE);

    expect(await narrowMode(file, OWNER_ONLY_FILE)).toEqual({ outcome: 'already-private' });
    expect(await modeOf(file)).toBe(OWNER_ONLY_FILE);
  });

  posixOnly('never widens: a stricter path stays stricter than what was asked for', async () => {
    const strictDir = path.join(base, 'strict');
    await fs.mkdir(strictDir);
    await fs.chmod(strictDir, 0o500);
    expect(await narrowMode(strictDir, OWNER_ONLY_DIR)).toEqual({ outcome: 'already-private' });
    expect(await modeOf(strictDir), 'not widened to 0700').toBe(0o500);

    // A read-only widened file loses its non-owner bits and gains nothing: the
    // mask only ever clears, so the owner does not acquire a write bit it lacked.
    const readOnly = path.join(base, 'read-only.log');
    await fs.writeFile(readOnly, 'x');
    await fs.chmod(readOnly, 0o444);
    expect(await narrowMode(readOnly, OWNER_ONLY_FILE)).toEqual({
      outcome: 'narrowed',
      previousMode: 0o444
    });
    expect(await modeOf(readOnly)).toBe(0o400);
  });

  posixOnly('clears every non-owner bit even when the mode it is handed keeps some', async () => {
    // `desired` is owner-only at every call site, but nothing in its type says so:
    // a caller declaring `0o644` would otherwise be told `narrowed` while group and
    // other could still read the file.
    const file = path.join(base, 'audit.log');
    await fs.writeFile(file, 'x');
    await fs.chmod(file, WIDENED_DIR);

    expect(await narrowMode(file, WIDENED_FILE)).toEqual({
      outcome: 'narrowed',
      previousMode: WIDENED_DIR
    });
    expect(await modeOf(file)).toBe(OWNER_ONLY_FILE);
  });

  posixOnly('reports a mode change the platform accepted but did not apply, rather than claiming it', async () => {
    const file = path.join(base, 'audit.log');
    await fs.writeFile(file, 'x');
    await fs.chmod(file, WIDENED_FILE);
    seam.chmodIsNoOp = true;

    const outcome = await narrowMode(file, OWNER_ONLY_FILE);

    expect(outcome).toMatchObject({ outcome: 'unsupported', code: 'not-applied' });
    expect(await modeOf(file), 'the seam really did nothing').toBe(WIDENED_FILE);
  });

  it('reports a path it cannot read as unsupported, carrying the errno, and never throws', async () => {
    const outcome = await narrowMode(path.join(base, 'missing.log'), OWNER_ONLY_FILE);
    expect(outcome).toMatchObject({ outcome: 'unsupported', code: 'ENOENT' });
  });
});

describe('noticeFor — the path-free record of what a narrowing did', () => {
  it('records a narrowing with the mode it replaced', () => {
    expect(noticeFor('file', { outcome: 'narrowed', previousMode: WIDENED_FILE })).toEqual({
      scope: 'file',
      outcome: 'narrowed',
      previousMode: WIDENED_FILE
    });
  });

  it('records nothing for a path that was already private', () => {
    expect(noticeFor('directory', { outcome: 'already-private' })).toBeNull();
  });

  it('carries the bounded code of a failure and never its message, which can name the path', () => {
    const notice = noticeFor('directory', {
      outcome: 'unsupported',
      reason: "EACCES: permission denied, chmod '/home/someone/project/.schegent'",
      code: 'EACCES'
    });
    expect(notice).toEqual({ scope: 'directory', outcome: 'unsupported', code: 'EACCES' });
    expect(JSON.stringify(notice)).not.toContain('/home/someone');
  });

  it('records a refused symbolic link without its reason', () => {
    expect(
      noticeFor('file', { outcome: 'refused-symlink', reason: 'the path is a symbolic link' })
    ).toEqual({ scope: 'file', outcome: 'refused-symlink' });
  });
});
