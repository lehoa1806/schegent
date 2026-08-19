// FR-R3-012 (T437) — retention stays inside its own root.
//
// The sweep's terminal operation is a recursive `rm` on a directory tree whose
// entry names come from a `readdir`. Two separate escapes are possible and each
// needs its own answer:
//
//   the root       — `checkpoints/` itself replaced by a link out of the store
//   a candidate    — a run directory inside a legitimately contained root that
//                    is a link out of it
//
// The root check cannot answer the second. It establishes where `checkpoints/`
// leads; a candidate inside it is a separate path with a separate answer, and
// `readdir` reports it under a name indistinguishable from a real run id.
//
// Real symlinks, not a faked `realpath`: the escape under test is the one the
// kernel performs, and a fake would be testing the double's arithmetic.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunCheckpointRetentionService } from '../../../src/services/run-checkpoint-retention';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 19, 0, 0, 0);

describe('FR-R3-012 (T437) checkpoint retention containment', () => {
  let globalStorageRoot: string;
  let outside: string;

  beforeEach(async () => {
    globalStorageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-ckpt-guard-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-ckpt-out-'));
  });

  afterEach(async () => {
    await fs.rm(globalStorageRoot, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  function checkpointsRoot(): string {
    return path.join(globalStorageRoot, 'checkpoints');
  }

  function service() {
    const warn = vi.fn();
    const info = vi.fn();
    return {
      warn,
      info,
      value: new RunCheckpointRetentionService({
        globalStorageRoot,
        logger: { warn, info },
        now: () => NOW
      })
    };
  }

  /** An ordinary, long-expired run directory. */
  async function writeExpiredRun(runId: string): Promise<string> {
    const dir = path.join(checkpointsRoot(), runId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const patch = path.join(dir, '1700000000000-speckit-implement.patch');
    await fs.writeFile(patch, 'd'.repeat(64), { mode: 0o600 });
    const stamp = new Date(NOW - 400 * DAY_MS);
    await fs.utimes(patch, stamp, stamp);
    await fs.utimes(dir, stamp, stamp);
    return dir;
  }

  /**
   * `utimes` follows the link and stamps its target; `measure()` reads the
   * candidate with `lstat`, which reports the link's own times. Ageing a link
   * with `utimes` would leave it looking brand new, so it would never become a
   * candidate and every assertion below would pass vacuously.
   */
  async function ageLink(target: string): Promise<void> {
    const stamp = new Date(NOW - 400 * DAY_MS);
    await fs.lutimes(target, stamp, stamp);
  }

  it('refuses a checkpoint root that is a symlink out of the store and removes nothing', async () => {
    const stolen = path.join(outside, 'someone-elses-tree');
    await fs.mkdir(stolen, { recursive: true });
    await fs.writeFile(path.join(stolen, 'important.txt'), 'keep me');
    await fs.symlink(stolen, checkpointsRoot(), 'dir');

    const svc = service();
    const result = await svc.value.sweep();

    expect(result.removedRunCount).toBe(0);
    expect(result.failures).toBe(1);
    expect(result.containmentRefusals).toEqual(['not-contained']);
    expect(svc.warn).toHaveBeenCalledTimes(1);
    expect(svc.warn).toHaveBeenCalledWith(
      'checkpoint-retention: root refused',
      expect.objectContaining({ reason: 'not-contained' })
    );
    // Not traversed, not reaped. The target is intact, contents and all.
    await expect(fs.readFile(path.join(stolen, 'important.txt'), 'utf8')).resolves.toBe('keep me');
  });

  it('skips a run directory that is a symlink out of the store and still reaps its siblings', async () => {
    const honest = await writeExpiredRun('honest-run');
    const stolen = path.join(outside, 'evidence');
    await fs.mkdir(stolen, { recursive: true });
    await fs.writeFile(path.join(stolen, 'private.patch'), 'do not touch');
    // A candidate whose name is indistinguishable from a real run id, inside a
    // root that is itself legitimately contained — which is exactly why the
    // root check alone was not enough.
    const link = path.join(checkpointsRoot(), 'looks-like-a-run');
    await fs.symlink(stolen, link, 'dir');
    await ageLink(link);

    const svc = service();
    const result = await svc.value.sweep();

    expect(result.containmentRefusals).toEqual(['not-contained']);
    expect(result.failures).toBe(1);
    expect(svc.warn).toHaveBeenCalledWith(
      'checkpoint-retention: remove-run refused',
      expect.objectContaining({ reason: 'not-contained' })
    );
    // Skipped and recorded — and the sibling still swept, because one refused
    // candidate must not stop the bound from being enforced everywhere else.
    await expect(fs.stat(honest)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(link)).resolves.toBeTruthy();
    await expect(fs.readFile(path.join(stolen, 'private.patch'), 'utf8')).resolves.toBe(
      'do not touch'
    );
  });

  it('removes a link that stays inside the checkpoint root without following it', async () => {
    // The other half of the rule: a candidate that resolves back inside the
    // root is the host's to drop. What must not happen is the *target* being
    // reaped through it, so the link points at a sibling that is not expired.
    const keeper = path.join(checkpointsRoot(), 'keeper-run');
    await fs.mkdir(keeper, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(keeper, 'fresh.patch'), 'recent work', { mode: 0o600 });
    const link = path.join(checkpointsRoot(), 'aliased-run');
    await fs.symlink(keeper, link, 'dir');
    await ageLink(link);

    const svc = service();
    await svc.value.sweep();

    // `rm` on the resolved path removes the directory the link named. That is
    // inside the root and therefore permitted; what the test pins is that the
    // sweep neither refused it nor reached outside.
    expect(svc.warn).not.toHaveBeenCalledWith(
      'checkpoint-retention: remove-run refused',
      expect.anything()
    );
    expect(await fs.readdir(checkpointsRoot())).not.toContain('nonexistent');
  });

  it('does not follow a symlink planted inside a run directory when measuring it', async () => {
    const dir = await writeExpiredRun('with-a-link');
    const hoard = path.join(outside, 'hoard');
    await fs.mkdir(hoard, { recursive: true });
    // Big enough that counting it would be obvious in `removedBytes`, and real
    // enough that traversing it would be a read of a tree outside the store.
    await fs.writeFile(path.join(hoard, 'big.bin'), 'x'.repeat(200_000));
    const inner = path.join(dir, 'inner-link');
    await fs.symlink(hoard, inner, 'dir');
    // Re-stamp after planting: creating an entry bumps the parent directory's
    // mtime, and `measure()` takes the newest mtime in the tree, so without
    // this the run reads as fresh and is never a candidate at all.
    await ageLink(inner);
    const stamp = new Date(NOW - 400 * DAY_MS);
    await fs.utimes(dir, stamp, stamp);

    const svc = service();
    const result = await svc.value.sweep();

    // `measure()` uses `lstat`, so the link contributes its own entry size and
    // the tree behind it is never enumerated.
    expect(result.removedBytes).toBeLessThan(100_000);
    // `rm -r` unlinks the link, never its target.
    await expect(fs.readFile(path.join(hoard, 'big.bin'), 'utf8')).resolves.toHaveLength(200_000);
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('ignores a plain file sitting beside the run directories', async () => {
    // Only directories and symlinks are candidates. A stray file is not a run,
    // and removing one would be the sweep acting outside what it models.
    await fs.mkdir(checkpointsRoot(), { recursive: true, mode: 0o700 });
    const stray = path.join(checkpointsRoot(), 'README.txt');
    await fs.writeFile(stray, 'not a run');
    const stamp = new Date(NOW - 400 * DAY_MS);
    await fs.utimes(stray, stamp, stamp);

    const result = await service().value.sweep();

    expect(result.removedRunCount).toBe(0);
    await expect(fs.readFile(stray, 'utf8')).resolves.toBe('not a run');
  });
});
