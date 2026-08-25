import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { openWithinRoot, refusesLeafAsReparsePoint } from '../../../src/lib/safe-open';

/**
 * FR-R3-083 (T1132-T1136) — the leaf check Windows never had.
 *
 * THE HOLE THIS CLOSES
 *
 * `walkDirectories` `lstat`s every DIRECTORY component and the leaf is opened
 * `O_NOFOLLOW`. `O_NOFOLLOW` does not exist on Windows and Node's constant is
 * `0` there, so the leaf open FOLLOWED whatever the entry pointed at and nothing
 * looked. A symlink or junction at the last component -- the one being written to
 * -- redirected the bytes out of the workspace, with no race required.
 *
 * WHAT IS STILL OPEN AFTER THIS
 *
 * Only the two reparse kinds `lstat` reports as links -- symlink and junction --
 * are reachable. Other tags (cloud placeholders, dedup, app-exec links) look like
 * ordinary files to Node, and telling them apart needs a native call. That question
 * was decided, once, in `docs/architecture/native-binding-decision.md`: the answer
 * is no, so this is a PERMANENT limit and this suite must not be read as covering
 * more than the two kinds it names.
 *
 * The classification is asserted on every platform, because the arrangement can
 * only be created on some of them. The Windows fixture that creates a real
 * junction is `tests/unit/platform/windows-reparse.test.ts`, and it is UNRUN on
 * this cycle's platform -- `docs/operations/platform-observation-record.md` says
 * so rather than letting these unit assertions read as a Windows result.
 */
describe('reparse-point leaf classification (FR-R3-083)', () => {
  it('refuses a link-like leaf', () => {
    expect(refusesLeafAsReparsePoint({ isSymbolicLink: () => true })).toBe(true);
  });

  it('does not refuse an ordinary leaf', () => {
    expect(refusesLeafAsReparsePoint({ isSymbolicLink: () => false })).toBe(false);
  });

  it('is asked only where O_NOFOLLOW is absent, and that gate lives at the call site', () => {
    // The predicate answers "is this leaf link-like?"; whether to ASK is the
    // caller's decision, and on a platform with a real O_NOFOLLOW the kernel has
    // already refused atomically. Asserted against the source because the condition
    // is a platform constant -- there is no way to observe both branches in one
    // process, and an earlier draft that passed the platform in as a parameter made
    // one condition into two that could drift.
    const source = readFileSync(
      resolve(__dirname, '..', '..', '..', 'src', 'lib', 'safe-open.ts'),
      'utf8'
    );
    expect(source).toContain('if (NOFOLLOW === 0) {');
    const guarded = source.slice(source.indexOf('if (NOFOLLOW === 0) {'));
    expect(guarded.slice(0, 600)).toContain('refusesLeafAsReparsePoint(leafStat)');
  });
});

describe('the POSIX leaf path is unchanged (FR-020, SC-006)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'safe-open-reparse-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it.runIf(process.platform !== 'win32')(
    'still reports a symlinked leaf as symlink-leaf, not as reparse-point-leaf',
    async () => {
      // The distinction FR-017 requires. On POSIX the kernel refuses atomically and
      // the answer must stay `symlink-leaf`; a reader seeing `reparse-point-leaf`
      // here would be told the weaker check answered when the stronger one did.
      await fs.writeFile(path.join(root, 'real.txt'), 'x');
      await fs.symlink(path.join(root, 'real.txt'), path.join(root, 'link.txt'));
      const result = await openWithinRoot(root, ['link.txt'], { flags: 'r' });
      expect(result.outcome).toBe('refused');
      if (result.outcome === 'refused') expect(result.reason).toBe('symlink-leaf');
    }
  );

  it.runIf(process.platform !== 'win32')(
    'still refuses a symlinked component as symlink-component',
    async () => {
      await fs.mkdir(path.join(root, 'real-dir'));
      await fs.symlink(path.join(root, 'real-dir'), path.join(root, 'linked-dir'));
      const result = await openWithinRoot(root, ['linked-dir', 'f.txt'], { flags: 'r' });
      expect(result.outcome).toBe('refused');
      if (result.outcome === 'refused') expect(result.reason).toBe('symlink-component');
    }
  );

  it('opens an ordinary contained leaf, so the check is not refusing everything', async () => {
    // Non-vacuity. A leaf check that refused every open would pass both assertions
    // above while breaking every sink in the product.
    await fs.writeFile(path.join(root, 'plain.txt'), 'x');
    const result = await openWithinRoot(root, ['plain.txt'], { flags: 'r' });
    expect(result.outcome).toBe('opened');
    if (result.outcome === 'opened') await result.handle.close();
  });

  it('creates a leaf that does not exist yet, so ENOENT is not read as a refusal', async () => {
    // The `wx`/`a`/`w` case: on a platform without O_NOFOLLOW the new lstat sees
    // ENOENT, which is the ordinary state of a file about to be created. Reading it
    // as a refusal would break every exclusive create, including the mount probe's.
    const result = await openWithinRoot(root, ['fresh.txt'], { flags: 'wx' });
    expect(result.outcome).toBe('opened');
    if (result.outcome === 'opened') await result.handle.close();
  });
});
