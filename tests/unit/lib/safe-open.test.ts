import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  ensureAnchorWithinRoot,
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
    openWithinRoot(
      root,
      segments,
      createDirs
        ? { flags: 'a', createDirs: true, dirMode: 0o700, fileMode: 0o600 }
        : { flags: 'a', fileMode: 0o600 }
    );

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
      const result = await openWithinRoot(root, segments, {
        flags: 'a',
        createDirs: true,
        dirMode: 0o700,
        fileMode: 0o600
      });
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
      openWithinRoot(
        root,
        ['x.log'],
        // @ts-expect-error -- 'a+' is outside the accepted flags; the runtime refusal is the claim
        { flags: 'a+' }
      )
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
      dirMode: 0o700,
      fileMode: 0o600
    });
    expect(result.outcome).toBe('opened');
    if (result.outcome !== 'opened') return;
    await result.handle.close();
  });

  it('refuses a path outside the root', async () => {
    // The derivation IS the check: `path.relative` yields a `..` prefix and the
    // walk never starts.
    const result = await openWithinRootByPath(root, path.join(outside, 'x.log'), {
      flags: 'a',
      fileMode: 0o600
    });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'escapes-root' });
  });

  it('refuses the root itself, which names no leaf to open', async () => {
    const result = await openWithinRootByPath(root, root, { flags: 'a', fileMode: 0o600 });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'escapes-root' });
  });

  posixOnly('refuses a symlinked component reached by path, exactly as by segments', async () => {
    // The convenience must not have looser rules than the primitive it wraps.
    await fs.symlink(outside, path.join(root, 'linked'));
    const result = await openWithinRootByPath(root, path.join(root, 'linked', 'x.log'), {
      flags: 'a',
      createDirs: true,
      dirMode: 0o700,
      fileMode: 0o600
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

describe('ensureAnchorWithinRoot creates a store anchor beneath a higher trusted root (FR-R3-069)', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-anchor-'));
    root = path.join(base, 'root');
    outside = path.join(base, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
  });

  afterEach(async () => {
    await fs.rm(path.dirname(root), { recursive: true, force: true });
  });

  posixOnly('creates the anchor chain and returns the composed anchor path', async () => {
    const made = await ensureAnchorWithinRoot(root, ['.schegent', 'ownership'], 0o700);
    expect(made.outcome).toBe('ready');
    const anchor = (made as { anchor: string }).anchor;
    expect(anchor).toBe(path.join(root, '.schegent', 'ownership'));
    expect(await fs.readdir(anchor)).toEqual([]);
    expect(((await fs.stat(anchor)).mode) & 0o777).toBe(0o700);
  });

  posixOnly('refuses a symlinked component by name, and creates nothing through it', async () => {
    // The F-01/F-02 shape: the checkout arrives with the store's parent as a
    // link out. The refusal names the link — 'symlink-component' — rather than
    // reporting an I/O error, and the link target stays empty.
    await fs.symlink(outside, path.join(root, '.schegent'));
    const made = await ensureAnchorWithinRoot(root, ['.schegent', 'ownership'], 0o700);
    expect(made).toMatchObject({ outcome: 'refused', reason: 'symlink-component' });
    expect(await fs.readdir(outside)).toEqual([]);
  });

  posixOnly('is safe under concurrent first-creation: every contender lands ready', async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => ensureAnchorWithinRoot(root, ['.schegent', 'ownership'], 0o700))
    );
    expect(outcomes.every((o) => o.outcome === 'ready')).toBe(true);
    expect(await fs.readdir(path.join(root, '.schegent'))).toEqual(['ownership']);
  });

  posixOnly('accepts a pre-existing chain and still hands back the anchor', async () => {
    await fs.mkdir(path.join(root, '.schegent', 'ownership'), { recursive: true, mode: 0o700 });
    const made = await ensureAnchorWithinRoot(root, ['.schegent', 'ownership'], 0o700);
    expect(made.outcome).toBe('ready');
  });

  posixOnly('leaves openWithinRoot untouched: the file walk still never creates its own root', async () => {
    // The primitive's contract boundary, pinned: creating an anchor is THIS
    // function's job; openWithinRoot on a missing chain (no createDirs) still
    // refuses rather than creating.
    const result = await openWithinRoot(path.join(root, 'never-made'), ['a.txt'], {
      flags: 'w',
      fileMode: 0o600
    });
    expect(result.outcome).toBe('refused');
  });

  posixOnly('refuses escape-shaped segments outright', async () => {
    for (const segments of [[], ['..'], ['a', '..', 'b'], ['/abs'], ['a/b']]) {
      expect((await ensureAnchorWithinRoot(root, segments, 0o700)).outcome).toBe('refused');
    }
  });
});

/**
 * Feature 217 (FR-002, FR-004, FR-006) — an open through the helper leaves what
 * it creates or writes owner-only, including paths that existed before it ran.
 *
 * A declared mode only applies when a path is CREATED. Every workspace that
 * predates this feature already has its evidence directory and files, so a
 * helper that only passed the mode to `mkdir`/`open` would leave the measured
 * exposure exactly where it was. The narrowing is what reaches those.
 */
describe('openWithinRoot narrows what it creates or writes to owner-only (feature 217)', () => {
  const OWNER_ONLY_FILE = 0o600;
  const OWNER_ONLY_DIR = 0o700;
  const WIDENED_FILE = 0o644;
  const WIDENED_DIR = 0o755;

  let root: string;

  beforeEach(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-safeopen-modes-'));
    root = path.join(base, 'root');
    await fs.mkdir(root);
  });

  afterEach(async () => {
    await fs.rm(path.dirname(root), { recursive: true, force: true });
  });

  const modeOf = async (p: string): Promise<number> => (await fs.lstat(p)).mode & 0o777;

  const appendOpen = (segments: readonly string[]) =>
    openWithinRoot(root, segments, {
      flags: 'a',
      createDirs: true,
      dirMode: OWNER_ONLY_DIR,
      fileMode: OWNER_ONLY_FILE
    });

  posixOnly('creates every missing directory and the file owner-only, and reports nothing to narrow', async () => {
    const result = await appendOpen(['.schegent', 'sessions', 'audit.log']);
    expect(result.outcome).toBe('opened');
    if (result.outcome !== 'opened') return;
    await result.handle.close();

    expect(await modeOf(path.join(root, '.schegent'))).toBe(OWNER_ONLY_DIR);
    expect(await modeOf(path.join(root, '.schegent', 'sessions'))).toBe(OWNER_ONLY_DIR);
    expect(await modeOf(path.join(root, '.schegent', 'sessions', 'audit.log'))).toBe(
      OWNER_ONLY_FILE
    );
    expect(result.narrowing).toEqual([]);
  });

  posixOnly('narrows an existing widened directory below the root, and never the root itself', async () => {
    // The root is the caller's trust anchor -- the workspace folder, or the OS
    // temp directory for the transcript spool. Changing its mode would be this
    // fix reaching outside the evidence it exists to protect.
    await fs.chmod(root, WIDENED_DIR);
    await fs.mkdir(path.join(root, '.schegent'));
    await fs.chmod(path.join(root, '.schegent'), WIDENED_DIR);

    const result = await appendOpen(['.schegent', 'audit.log']);
    expect(result.outcome).toBe('opened');
    if (result.outcome !== 'opened') return;
    await result.handle.close();

    expect(await modeOf(path.join(root, '.schegent'))).toBe(OWNER_ONLY_DIR);
    expect(await modeOf(root), 'the root is not the helper to change').toBe(WIDENED_DIR);
    expect(result.narrowing).toEqual([
      { scope: 'directory', outcome: 'narrowed', previousMode: WIDENED_DIR }
    ]);
  });

  posixOnly('narrows an existing widened file in place on a writing open (FR-002)', async () => {
    await fs.mkdir(path.join(root, '.schegent'), { mode: OWNER_ONLY_DIR });
    const file = path.join(root, '.schegent', 'audit.log');
    await fs.writeFile(file, 'line\n');
    await fs.chmod(file, WIDENED_FILE);
    const before = await fs.lstat(file);

    const result = await appendOpen(['.schegent', 'audit.log']);
    expect(result.outcome).toBe('opened');
    if (result.outcome !== 'opened') return;
    await result.handle.write('more\n');
    await result.handle.close();

    const after = await fs.lstat(file);
    expect(after.mode & 0o777).toBe(OWNER_ONLY_FILE);
    expect(after.ino, 'narrowed, not recreated').toBe(before.ino);
    expect(await fs.readFile(file, 'utf8'), 'appended to, not truncated').toBe('line\nmore\n');
    expect(result.narrowing).toEqual([
      { scope: 'file', outcome: 'narrowed', previousMode: WIDENED_FILE }
    ]);
  });

  posixOnly('narrows the leaf through openWithinRootByPath as well', async () => {
    const file = path.join(root, 'logs', 'runtime.log');
    await fs.mkdir(path.dirname(file), { mode: OWNER_ONLY_DIR });
    await fs.writeFile(file, '');
    await fs.chmod(file, WIDENED_FILE);

    const result = await openWithinRootByPath(root, file, {
      flags: 'a',
      createDirs: true,
      dirMode: OWNER_ONLY_DIR,
      fileMode: OWNER_ONLY_FILE
    });
    expect(result.outcome).toBe('opened');
    if (result.outcome !== 'opened') return;
    await result.handle.close();

    expect(await modeOf(file)).toBe(OWNER_ONLY_FILE);
  });

  posixOnly('narrows only the leaf when the open does not create directories', async () => {
    // An open with no `createDirs` declares no directory mode, so the directories
    // it merely traverses are not its to change.
    await fs.mkdir(path.join(root, 'store'));
    await fs.chmod(path.join(root, 'store'), WIDENED_DIR);
    const file = path.join(root, 'store', 'catalog.json');
    await fs.writeFile(file, '{}');
    await fs.chmod(file, WIDENED_FILE);

    const result = await openWithinRoot(root, ['store', 'catalog.json'], {
      flags: 'w',
      fileMode: OWNER_ONLY_FILE
    });
    expect(result.outcome).toBe('opened');
    if (result.outcome !== 'opened') return;
    await result.handle.close();

    expect(await modeOf(file)).toBe(OWNER_ONLY_FILE);
    expect(await modeOf(path.join(root, 'store'))).toBe(WIDENED_DIR);
  });

  posixOnly('never changes the mode of what a read-only open reads', async () => {
    await fs.mkdir(path.join(root, 'docs'));
    await fs.chmod(path.join(root, 'docs'), WIDENED_DIR);
    const file = path.join(root, 'docs', 'notes.txt');
    await fs.writeFile(file, 'shared on purpose');
    await fs.chmod(file, WIDENED_FILE);

    const result = await openWithinRoot(root, ['docs', 'notes.txt'], { flags: 'r' });
    expect(result.outcome).toBe('opened');
    if (result.outcome !== 'opened') return;
    await result.handle.close();

    expect(await modeOf(file)).toBe(WIDENED_FILE);
    expect(await modeOf(path.join(root, 'docs'))).toBe(WIDENED_DIR);
    expect(result.narrowing).toEqual([]);
  });

  posixOnly('never widens a directory stricter than the declared mode', async () => {
    await fs.mkdir(path.join(root, 'strict'));
    await fs.writeFile(path.join(root, 'strict', 'audit.log'), '');
    await fs.chmod(path.join(root, 'strict'), 0o500);
    try {
      const result = await openWithinRoot(root, ['strict', 'audit.log'], {
        flags: 'a',
        createDirs: true,
        dirMode: OWNER_ONLY_DIR,
        fileMode: OWNER_ONLY_FILE
      });
      if (result.outcome === 'opened') await result.handle.close();
      expect(await modeOf(path.join(root, 'strict')), 'not widened to 0700').toBe(0o500);
    } finally {
      // Restore write so the teardown can remove it.
      await fs.chmod(path.join(root, 'strict'), OWNER_ONLY_DIR);
    }
  });
});

describe('openWithinRoot requires a mode for any open that can create or write (FR-008, SC-002)', () => {
  it('rejects the omission at the call site, before the code can run', () => {
    // Compile-time assertions: `npm run typecheck` covers this file, and each
    // `@ts-expect-error` fails the build the moment the line it marks compiles.
    // The functions are never called, so nothing here touches the disk.
    const root = os.tmpdir();
    const rejected = [
      // @ts-expect-error -- a writing flag with no fileMode
      () => openWithinRoot(root, ['x'], { flags: 'a' }),
      // @ts-expect-error -- an exclusive create with no fileMode
      () => openWithinRoot(root, ['x'], { flags: 'wx', createDirs: false }),
      // @ts-expect-error -- createDirs with no dirMode
      () => openWithinRoot(root, ['x'], { flags: 'a', createDirs: true, fileMode: 0o600 }),
      // @ts-expect-error -- the by-path form carries the same rule
      () => openWithinRootByPath(root, path.join(root, 'x'), { flags: 'w' })
    ];
    const accepted = [
      () => openWithinRoot(root, ['x'], { flags: 'r' }),
      () => openWithinRoot(root, ['x'], { flags: 'w', fileMode: 0o600 }),
      () =>
        openWithinRootByPath(root, path.join(root, 'x'), {
          flags: 'a',
          createDirs: true,
          dirMode: 0o700,
          fileMode: 0o600
        })
    ];
    expect(rejected).toHaveLength(4);
    expect(accepted).toHaveLength(3);
  });
});
