import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionArtifactRetentionService } from '../../../../src/services/session-retention/session-artifact-retention-service';

/**
 * FR-R3-050 / M-12 — a sweep must not delete an active run's pending transcript.
 *
 * Default-mode (errors-only) transcripts stage in a SHARED directory:
 * `sessions/.pending/raw-<runId>.log`. Retention derived a candidate group's key
 * from the directory entry's name, so the whole staging area became one group
 * keyed by the literal string `.pending` — and `sweep()` is handed real Run IDs,
 * which can never contain a directory name. The group was therefore unprotectable,
 * and an age or byte-pressure sweep took every active transcript in one pass.
 *
 * Measured before the fix on a realistic root: two candidate groups, one of them
 * `.pending` holding three transcripts, of which two belonged to running runs.
 *
 * The failure is silent. Nothing throws; the absence is discovered later by
 * someone looking for a transcript after an incident. So these assertions are
 * about what SURVIVES, which is the only observable the defect touches.
 */
describe('pending transcripts are attributed to their run (M-12)', () => {
  let workspaceRoot: string;
  const now = new Date('2026-08-01T00:00:00.000Z');

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-pending-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  /** Stage a default-mode transcript for `runId`, aged `ageDays` old. */
  async function stagePending(runId: string, bytes: number, ageDays: number): Promise<string> {
    const pending = path.join(workspaceRoot, '.schegent', 'sessions', '.pending');
    await fs.mkdir(pending, { recursive: true });
    const file = path.join(pending, `raw-${runId}.log`);
    await fs.writeFile(file, 'r'.repeat(bytes));
    const stamp = new Date(now.getTime() - ageDays * 24 * 60 * 60 * 1000);
    await fs.utimes(file, stamp, stamp);
    await fs.utimes(pending, stamp, stamp);
    return file;
  }

  function service(maxAgeDays: number, maxBytes: number) {
    const warn = vi.fn();
    const append = vi.fn();
    return {
      warn,
      value: new SessionArtifactRetentionService({
        workspaceRoot,
        now: () => now,
        policy: () => ({ maxAgeMs: maxAgeDays * 24 * 60 * 60 * 1000, maxBytes }),
        logger: { warn },
        audit: { append } as never
      })
    };
  }

  const exists = async (p: string): Promise<boolean> =>
    fs.access(p).then(() => true, () => false);

  it('protects an active run and prunes its inactive sibling in the same directory', async () => {
    const active = await stagePending('active-run', 32, 40);
    const inactive = await stagePending('inactive-run', 32, 40);
    const { value } = service(30, 1024 * 1024);

    // Only the active run is protected. Protection is per RUN, so the sibling in
    // the same shared directory must still be prunable — blanket immunity for the
    // directory would be a different bug in the other direction.
    await value.sweep(new Set(['active-run']));

    expect(await exists(active)).toBe(true);
    expect(await exists(inactive)).toBe(false);
  });

  it('produces one candidate group per pending transcript, not one for the directory', async () => {
    await stagePending('run-b', 32, 40);
    await stagePending('run-c', 32, 40);
    await stagePending('run-d', 32, 40);
    const { value } = service(30, 1024 * 1024);

    // With all three protected, nothing may be pruned. Under the directory-keyed
    // grouping the protected set could not name the group at all, so all three
    // went.
    await value.sweep(new Set(['run-b', 'run-c', 'run-d']));

    const pending = path.join(workspaceRoot, '.schegent', 'sessions', '.pending');
    const survivors = await fs.readdir(pending).catch(() => [] as string[]);
    expect(survivors.length).toBe(3);
  });

  it('keeps a per-run directory keyed by its own name', async () => {
    // The `??` fallback this fix narrows is load-bearing for the always-mode
    // layout, where a directory IS a run. That case must keep working: the bug was
    // a SHARED directory reaching the same branch.
    const sessions = path.join(workspaceRoot, '.schegent', 'sessions');
    const runDir = path.join(sessions, 'always-run', 'diagnostics');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'stream.jsonl'), 'd'.repeat(32));
    const stamp = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);
    for (const target of [path.join(sessions, 'always-run'), runDir]) {
      await fs.utimes(target, stamp, stamp);
    }
    const { value } = service(30, 1024 * 1024);

    await value.sweep(new Set(['always-run']));

    expect(await exists(path.join(sessions, 'always-run'))).toBe(true);
  });

  it('does not attribute an unparseable staging entry to another run', async () => {
    const survivor = await stagePending('real-run', 32, 40);
    const pending = path.join(workspaceRoot, '.schegent', 'sessions', '.pending');
    const stray = path.join(pending, 'not-a-transcript.txt');
    await fs.writeFile(stray, 'x');
    const stamp = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);
    await fs.utimes(stray, stamp, stamp);
    const { value } = service(30, 1024 * 1024);

    // `real-run` is protected. The stray entry must not inherit that protection by
    // being grouped with it, and must not cause `real-run`'s file to be pruned.
    await value.sweep(new Set(['real-run']));

    expect(await exists(survivor)).toBe(true);
  });
});
