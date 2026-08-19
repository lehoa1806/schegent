// FR-R3-012 (T436) — the outer bound on the checkpoint store.
//
// `RunCheckpointService.prune()` bounds one run directory to 20 artifacts and
// is only ever called with the directory of the run that just wrote, so the
// number of run directories under `${globalStorageUri}/checkpoints/` had no
// bound at all. This file pins the three things that now bound it and, just as
// importantly, the three things that must NOT bound it:
//
//   bounds        — age, total bytes, and the recent-run floor between them
//   not bounds    — run lifecycle, artifact kind (a decline marker is an
//                   ordinary artifact), and the per-run budget, which is the
//                   checkpoint service's and is untouched here
//
// Real directories in a real tmpdir, because `measure()` reads `lstat` sizes and
// mtimes and a faked filesystem would be testing the double's arithmetic. The
// byte bound is stated through the injected policy: the shipped one is 256 MiB
// and a test that had to cross it would have to write 256 MiB.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHECKPOINT_MAX_AGE_MS,
  CHECKPOINT_MAX_TOTAL_BYTES,
  CHECKPOINT_RECENT_RUN_FLOOR,
  DEFAULT_CHECKPOINT_RETENTION_POLICY,
  RunCheckpointRetentionService,
  type RunCheckpointRetentionPolicy
} from '../../../src/services/run-checkpoint-retention';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 19, 0, 0, 0);

describe('FR-R3-012 (T436) cross-run checkpoint retention', () => {
  let globalStorageRoot: string;

  beforeEach(async () => {
    globalStorageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-ckpt-store-'));
  });

  afterEach(async () => {
    await fs.rm(globalStorageRoot, { recursive: true, force: true });
  });

  function checkpointsRoot(): string {
    return path.join(globalStorageRoot, 'checkpoints');
  }

  /**
   * One run directory shaped like the real thing: a `.patch` and its `.json`
   * sibling, both stamped `daysOld` before `NOW`. The directory's own mtime is
   * stamped last, because writing into a directory bumps it.
   */
  async function writeRun(
    runId: string,
    daysOld: number,
    options: { bytes?: number; declinedOnly?: boolean; artifacts?: number } = {}
  ): Promise<string> {
    const dir = path.join(checkpointsRoot(), runId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const bytes = options.bytes ?? 64;
    const artifacts = options.artifacts ?? 1;
    const written: string[] = [];
    for (let i = 0; i < artifacts; i += 1) {
      const prefix = `${1_700_000_000_000 + i}-speckit-implement`;
      if (options.declinedOnly) {
        const marker = path.join(dir, `${prefix}.declined.json`);
        await fs.writeFile(marker, JSON.stringify({ restorable: false }), { mode: 0o600 });
        written.push(marker);
      } else {
        const patch = path.join(dir, `${prefix}.patch`);
        const meta = path.join(dir, `${prefix}.json`);
        await fs.writeFile(patch, 'd'.repeat(bytes), { mode: 0o600 });
        await fs.writeFile(meta, '{}', { mode: 0o600 });
        written.push(patch, meta);
      }
    }
    const stamp = new Date(NOW - daysOld * DAY_MS);
    for (const file of written) await fs.utimes(file, stamp, stamp);
    await fs.utimes(dir, stamp, stamp);
    return dir;
  }

  function service(policy?: Partial<RunCheckpointRetentionPolicy>) {
    const warn = vi.fn();
    const info = vi.fn();
    return {
      warn,
      info,
      value: new RunCheckpointRetentionService({
        globalStorageRoot,
        logger: { warn, info },
        now: () => NOW,
        ...(policy ? { policy: { ...DEFAULT_CHECKPOINT_RETENTION_POLICY, ...policy } } : {})
      })
    };
  }

  async function survivors(): Promise<string[]> {
    try {
      return (await fs.readdir(checkpointsRoot())).sort();
    } catch {
      return [];
    }
  }

  describe('the shipped policy', () => {
    it('states both bounds and the floor as named constants', () => {
      expect(CHECKPOINT_MAX_AGE_MS).toBe(14 * DAY_MS);
      expect(CHECKPOINT_MAX_TOTAL_BYTES).toBe(256 * 1024 * 1024);
      expect(CHECKPOINT_RECENT_RUN_FLOOR).toBe(10);
      // The default is what production gets: the service takes no `policy`
      // there, so a drift between the constants and the default would ship a
      // bound nobody wrote down.
      expect(DEFAULT_CHECKPOINT_RETENTION_POLICY).toEqual({
        maxAgeMs: CHECKPOINT_MAX_AGE_MS,
        maxTotalBytes: CHECKPOINT_MAX_TOTAL_BYTES,
        recentRunFloor: CHECKPOINT_RECENT_RUN_FLOOR
      });
    });

    it('is a no-op on a store that has never been written', async () => {
      const svc = service();
      const result = await svc.value.sweep();
      expect(result.removedRunCount).toBe(0);
      expect(result.failures).toBe(0);
      // Absent is the ordinary pre-first-checkpoint state, not a fault, so it
      // must not warn — a warning on every activation of a fresh install is
      // exactly the noise that gets a real one ignored later.
      expect(svc.warn).not.toHaveBeenCalled();
      expect(svc.info).not.toHaveBeenCalled();
    });
  });

  describe('the age bound', () => {
    it('removes run directories past the age bound and keeps the rest', async () => {
      await writeRun('old-a', 40);
      await writeRun('old-b', 15);
      await writeRun('fresh', 13);

      const svc = service();
      const result = await svc.value.sweep();

      expect(await survivors()).toEqual(['fresh']);
      expect(result.removedRunCount).toBe(2);
      expect(result.removedByTrigger.age).toBe(2);
      expect(result.removedByTrigger['total-bytes']).toBe(0);
      expect(result.retainedRunCount).toBe(1);
      expect(result.failures).toBe(0);
    });

    it('keeps a directory exactly at the bound', async () => {
      // `<=` not `<`: a directory whose newest artifact is exactly `maxAgeMs`
      // old has not yet passed the bound. Pinned because flipping the
      // comparison is a one-character change that no other assertion here
      // would catch.
      await writeRun('at-the-bound', 14);
      await service().value.sweep();
      expect(await survivors()).toEqual(['at-the-bound']);
    });

    it('ages a directory on its newest artifact, not its oldest', async () => {
      // A long-lived run writes a checkpoint per Git-capable phase. Judging it
      // on its oldest artifact would reap a run that checkpointed an hour ago
      // because it started three weeks ago.
      const dir = await writeRun('long-run', 40);
      const recent = path.join(dir, `${1_800_000_000_000}-speckit-implement.patch`);
      await fs.writeFile(recent, 'd'.repeat(64), { mode: 0o600 });
      const stamp = new Date(NOW - DAY_MS);
      await fs.utimes(recent, stamp, stamp);

      await service().value.sweep();

      expect(await survivors()).toEqual(['long-run']);
    });

    it('does not delete a run that has just completed', async () => {
      // Retention is age- and volume-based, never lifecycle-based: a completed
      // run's checkpoint is precisely what an operator wants once the run turns
      // out to have gone badly.
      await writeRun('just-finished', 0);
      await service().value.sweep();
      expect(await survivors()).toEqual(['just-finished']);
    });
  });

  describe('the size bound', () => {
    it('removes oldest-first until the store is under the byte bound', async () => {
      await writeRun('size-old', 3, { bytes: 4_096 });
      await writeRun('size-mid', 2, { bytes: 4_096 });
      await writeRun('size-new', 1, { bytes: 4_096 });

      // A bound that two of the three directories cannot fit under, with the
      // floor out of the way so the size pass is what decides.
      const svc = service({ maxTotalBytes: 6_000, recentRunFloor: 0 });
      const result = await svc.value.sweep();

      expect(await survivors()).toEqual(['size-new']);
      expect(result.removedByTrigger['total-bytes']).toBe(2);
      expect(result.removedByTrigger.age).toBe(0);
      expect(result.removedBytes).toBeGreaterThan(0);
    });

    it('stops as soon as the store fits rather than emptying it', async () => {
      await writeRun('keep-old', 3, { bytes: 1_024 });
      await writeRun('keep-new', 1, { bytes: 1_024 });

      const svc = service({ maxTotalBytes: 100_000, recentRunFloor: 0 });
      await svc.value.sweep();

      expect(await survivors()).toEqual(['keep-new', 'keep-old']);
    });
  });

  describe('the recent-run floor', () => {
    it('keeps the newest floor directories however far over the byte bound they are', async () => {
      for (let i = 0; i < 5; i += 1) {
        await writeRun(`recent-${i}`, i, { bytes: 8_192 });
      }

      // Every directory is recent, the store is far over budget, and the floor
      // covers all five: the size pass must find nothing it is allowed to take.
      const svc = service({ maxTotalBytes: 1, recentRunFloor: 5 });
      const result = await svc.value.sweep();

      expect((await survivors()).length).toBe(5);
      expect(result.removedRunCount).toBe(0);
      expect(result.protectedByFloorCount).toBe(5);
    });

    it('reaps only the surplus above the floor', async () => {
      for (let i = 0; i < 5; i += 1) {
        await writeRun(`surplus-${i}`, 5 - i, { bytes: 8_192 });
      }

      const svc = service({ maxTotalBytes: 1, recentRunFloor: 2 });
      await svc.value.sweep();

      // Oldest-first, so `surplus-0` (5 days) through `surplus-2` (3 days) go
      // and the two newest are held by the floor.
      expect(await survivors()).toEqual(['surplus-3', 'surplus-4']);
    });

    it('does not protect against the age bound', async () => {
      // The documented asymmetry, and the one an operator would most likely
      // read as a bug: "recent but over budget" is plausibly still wanted,
      // "old" is the bound saying nobody wants it however few there are. A
      // floor covering both would leave an unreapable residue of ancient diffs.
      await writeRun('ancient', 400, { bytes: 64 });

      const svc = service({ recentRunFloor: 10 });
      const result = await svc.value.sweep();

      expect(await survivors()).toEqual([]);
      expect(result.removedByTrigger.age).toBe(1);
    });
  });

  describe('what retention is not allowed to be clever about', () => {
    it('treats a directory of decline markers as an ordinary artifact', async () => {
      // FR-R3-004's marker is `restorable: false`, which is exactly the field
      // that would tempt a reaper into treating it as disposable. It is the
      // evidence that a checkpoint was declined, so it lives and dies by the
      // same age policy as a snapshot.
      await writeRun('declines-fresh', 1, { declinedOnly: true, artifacts: 3 });
      await writeRun('declines-old', 40, { declinedOnly: true, artifacts: 3 });
      await writeRun('snapshot-fresh', 1);

      await service().value.sweep();

      expect(await survivors()).toEqual(['declines-fresh', 'snapshot-fresh']);
    });

    it('leaves the per-run budget alone', async () => {
      // The per-run bound is `RunCheckpointService.prune()`'s and is unchanged
      // (T435). Retention removes whole run directories or nothing; it never
      // reaches inside one to thin it out.
      const dir = await writeRun('inner', 1, { artifacts: 20 });
      const before = (await fs.readdir(dir)).sort();

      await service().value.sweep();

      expect((await fs.readdir(dir)).sort()).toEqual(before);
      expect(before.length).toBe(40);
    });

    it('leaves a directory it could not measure rather than reaping it on a guess', async () => {
      await writeRun('measurable', 40);
      const svc = service({});
      const real = svc.value as unknown as {
        measure: (t: string) => Promise<unknown>;
      };
      const originalMeasure = real.measure.bind(real);
      real.measure = async (target: string) => {
        if (target.endsWith('unmeasurable')) throw Object.assign(new Error('nope'), { code: 'EIO' });
        return originalMeasure(target);
      };
      await writeRun('unmeasurable', 40);

      const result = await svc.value.sweep();

      expect(await survivors()).toEqual(['unmeasurable']);
      expect(result.failures).toBe(1);
      expect(svc.warn).toHaveBeenCalledWith(
        'checkpoint-retention: scan-run failed',
        expect.objectContaining({ errno: 'EIO' })
      );
    });
  });

  describe('recording and non-fatality', () => {
    it('reports counts, bytes, and the bounds that triggered the reap', async () => {
      await writeRun('reported', 40, { bytes: 4_096 });

      const svc = service();
      await svc.value.sweep();

      expect(svc.info).toHaveBeenCalledTimes(1);
      const [message, fields] = svc.info.mock.calls[0] as [string, Record<string, unknown>];
      expect(message).toBe('checkpoint-retention: sweep complete');
      expect(fields.removedRunCount).toBe(1);
      expect(fields.removedByAge).toBe(1);
      expect(fields.removedByTotalBytes).toBe(0);
      expect(fields.removedBytes as number).toBeGreaterThan(4_000);
      expect(fields.maxAgeMs).toBe(CHECKPOINT_MAX_AGE_MS);
      expect(fields.maxTotalBytes).toBe(CHECKPOINT_MAX_TOTAL_BYTES);
      expect(fields.recentRunFloor).toBe(CHECKPOINT_RECENT_RUN_FLOOR);
      // No path anywhere in the record. A run id is bounded and useful; the
      // store's location names the operator's home directory.
      expect(JSON.stringify(fields)).not.toContain(globalStorageRoot);
    });

    it('says nothing when it removed nothing', async () => {
      await writeRun('quiet', 1);
      const svc = service();
      await svc.value.sweep();
      expect(svc.info).not.toHaveBeenCalled();
      expect(svc.warn).not.toHaveBeenCalled();
    });

    it('warns once and resolves when the checkpoint root cannot be read', async () => {
      await writeRun('present', 1);
      const svc = service();
      const real = svc.value as unknown as {
        fs: { readdir: (t: string, o: unknown) => Promise<unknown> };
      };
      real.fs = {
        ...real.fs,
        readdir: async () => {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
      };

      const result = await svc.value.sweep();

      expect(result.failures).toBe(1);
      expect(result.removedRunCount).toBe(0);
      expect(svc.warn).toHaveBeenCalledTimes(1);
      expect(svc.warn).toHaveBeenCalledWith(
        'checkpoint-retention: scan-root failed',
        expect.objectContaining({ errno: 'EACCES' })
      );
      // Non-fatal is the point: activation scheduled this and must not fail.
      expect(await survivors()).toEqual(['present']);
    });

    it('never rejects, even when the sweep faults in an unanticipated place', async () => {
      const svc = service();
      const real = svc.value as unknown as { measure: unknown; runSweep: unknown };
      real.runSweep = async () => {
        throw new Error('unexpected');
      };
      await expect(svc.value.sweep()).resolves.toMatchObject({ failures: 1 });
      expect(svc.warn).toHaveBeenCalledWith(
        'checkpoint-retention: sweep failed',
        expect.objectContaining({ errno: 'unknown' })
      );
    });

    it('serializes concurrent sweeps so they cannot double-count each other', async () => {
      await writeRun('shared', 40, { bytes: 2_048 });
      const svc = service();

      const [first, second] = await Promise.all([svc.value.sweep(), svc.value.sweep()]);

      // Whichever ran first removed the directory; the other found an empty
      // store. What must not happen is both reporting the same bytes freed.
      expect(first.removedBytes + second.removedBytes).toBe(
        Math.max(first.removedBytes, second.removedBytes)
      );
      expect(await survivors()).toEqual([]);
    });
  });
});
