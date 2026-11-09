// FR-R6-F05 (FR-005, T016) — the checkpoint sweeper's pin hook.
//
// `RunCheckpointRetentionService` has accepted `isPinnedRun` since F27 but no
// production caller passed one, so a paused run's checkpoint aged out after 14
// days. The wiring now passes `recoveryPinnedRunPredicate(getRunMap)`, the same
// predicate this file builds the service with. Real directories in a real
// tmpdir, as in the service's own suite, because the sweep reads mtimes.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  recoveryPinnedRunIds,
  recoveryPinnedRunPredicate
} from '../../../src/services/artifact-lifecycle/run-recovery-pins';
import { RunCheckpointRetentionService } from '../../../src/services/run-checkpoint-retention';
import type { WorkflowRunStatus } from '../../../src/state/workflow-run';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 9, 0, 0, 0);
const OLD_DAYS = 30;

interface RunStub {
  readonly id: string;
  readonly status: WorkflowRunStatus;
}

describe('FR-R6-F05 checkpoint pin wiring (FR-005)', () => {
  let globalStorageRoot: string;

  beforeEach(async () => {
    globalStorageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-f05-pins-'));
  });

  afterEach(async () => {
    await fs.rm(globalStorageRoot, { recursive: true, force: true });
  });

  async function writeRun(runId: string, daysOld: number): Promise<void> {
    const dir = path.join(globalStorageRoot, 'checkpoints', runId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const patch = path.join(dir, '1700000000000-speckit-implement.patch');
    await fs.writeFile(patch, 'd'.repeat(64), { mode: 0o600 });
    const stamp = new Date(NOW - daysOld * DAY_MS);
    await fs.utimes(patch, stamp, stamp);
    await fs.utimes(dir, stamp, stamp);
  }

  async function survivors(): Promise<string[]> {
    return (await fs.readdir(path.join(globalStorageRoot, 'checkpoints'))).sort();
  }

  function retention(runs: Record<string, RunStub | undefined>): RunCheckpointRetentionService {
    return new RunCheckpointRetentionService({
      globalStorageRoot,
      logger: { info: vi.fn(), warn: vi.fn() },
      now: () => NOW,
      isPinnedRun: recoveryPinnedRunPredicate(() => runs)
    });
  }

  it('pins the ids of non-terminal runs only', () => {
    const runs: RunStub[] = [
      { id: 'run-a', status: 'running' },
      { id: 'run-b', status: 'paused' },
      { id: 'run-c', status: 'completed' },
      { id: 'run-d', status: 'failed' },
      { id: 'run-e', status: 'canceled' }
    ];
    expect(recoveryPinnedRunIds(runs)).toEqual(new Set(['run-a', 'run-b']));
  });

  it('keeps a paused run checkpoint older than 14 days and removes a completed run one', async () => {
    await writeRun('paused-run', OLD_DAYS);
    await writeRun('done-run', OLD_DAYS);
    const svc = retention({
      'paused-run': { id: 'paused-run', status: 'paused' },
      'done-run': { id: 'done-run', status: 'completed' }
    });
    const result = await svc.sweep();
    expect(result.removedRunCount).toBe(1);
    expect(await survivors()).toEqual(['paused-run']);
  });

  it('reads the run map at sweep time, so a run that pauses after construction is protected', async () => {
    await writeRun('late-pause', OLD_DAYS);
    const runs: Record<string, RunStub | undefined> = {};
    const svc = retention(runs);
    runs['late-pause'] = { id: 'late-pause', status: 'paused' };
    const result = await svc.sweep();
    expect(result.removedRunCount).toBe(0);
    expect(await survivors()).toEqual(['late-pause']);
  });
});
