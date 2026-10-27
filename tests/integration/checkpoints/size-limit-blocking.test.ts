// FR-R4-F01 (spec 239, US6, T066, FR-028, SC-007, contract K2, hard rule 59) — a checkpoint that
// cannot be taken because the tree is too large says so, and still blocks.
//
// Both capture failures used to throw the same bare `Error('checkpoint-unavailable')`, so an
// operator whose Git-capable phase was blocked could not tell a 25 MiB binary from a git that
// would not start. `maxBuffer` overflow is now its own typed reason on its own stream (the diff's
// 20 MiB, the porcelain status's 1 MiB), the Phase STAYS blocked (a checkpoint that cannot be
// taken is not a decline), and the reason reaches the Run's `lastError` through the existing
// start-failure path, with the `checkpoint-unavailable` prefix kept for anything matching on it.
//
// The real `RunDriver` and `RunCheckpointService` on a real repository
// (`driver-harness.ts`). The CLI is a gate the test steps, so "no backend CLI is spawned" is read
// off the invocations the runner actually saw.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyStartFailure } from '../../../src/controller/start-failure-classification';
import {
  CheckpointUnavailableError,
  type CheckpointUnavailableReason
} from '../../../src/services/run-checkpoint-service';
import {
  GIT_PHASE_ID,
  QUEUE_A,
  git,
  makeDriveHarness,
  type CheckpointDriveHarness
} from './driver-harness';

let h: CheckpointDriveHarness;

beforeEach(async () => {
  h = await makeDriveHarness();
});

afterEach(async () => {
  await h.dispose();
});

/** A tracked file whose diff against the base is over the 20 MiB `maxBuffer`. */
async function trackHugeFile(): Promise<void> {
  await fs.writeFile(path.join(h.workspaceRoot, 'huge.bin.txt'), 'x'.repeat(21 * 1024 * 1024), 'utf8');
  await git('git', ['add', '-A'], { cwd: h.workspaceRoot });
}

/** Untracked entries whose porcelain status is over the 1 MiB `maxBuffer`. */
async function leaveManyUntrackedFiles(): Promise<void> {
  const body = 'u';
  const pad = 'p'.repeat(190);
  const writes: Promise<void>[] = [];
  for (let index = 0; index < 6_000; index += 1) {
    const name = `u${String(index).padStart(5, '0')}${pad}.txt`;
    writes.push(fs.writeFile(path.join(h.workspaceRoot, name), body, 'utf8'));
    if (writes.length === 250) await Promise.all(writes.splice(0));
  }
  await Promise.all(writes);
}

/** Drive the Run to the Git-capable Phase with `arrange` applied just before it. */
async function driveToGitPhase(arrange: () => Promise<void>): Promise<unknown> {
  const started = h.start(QUEUE_A, 'run-big', { writes: false });
  const outcome = started.completed.then(
    () => 'finished',
    (error: unknown) => error
  );
  await h.atGate('run-big', 'write-work');
  await arrange();
  h.step('run-big');
  await h.atGate('run-big', 'settle');
  h.step('run-big');
  return outcome;
}

describe.each([
  ['diff-size-limit', trackHugeFile],
  ['status-size-limit', leaveManyUntrackedFiles]
] as const)('a tree over the %s', (reason: CheckpointUnavailableReason, arrange) => {
  it('blocks the Git-capable Phase with a typed error that names the reason', async () => {
    const error = await driveToGitPhase(arrange);

    expect(error).toBeInstanceOf(CheckpointUnavailableError);
    expect((error as CheckpointUnavailableError).reason).toBe(reason);
    expect((error as Error).message).toBe(`checkpoint-unavailable: ${reason}`);
    // The blocked Phase was never dispatched: no backend CLI was spawned for it.
    expect(h.invocations.map((invocation) => invocation.phase)).toEqual(['write-work', 'settle']);
    expect(h.invocations.some((invocation) => invocation.phase === GIT_PHASE_ID)).toBe(false);
  });

  it('writes no snapshot and no decline marker: a checkpoint that cannot be taken is not a decline', async () => {
    await driveToGitPhase(arrange);

    expect(await h.artifacts('run-big')).toEqual([]);
  });

  it('reaches the Run\'s lastError, with the prefix kept, through the start-failure path', async () => {
    const error = await driveToGitPhase(arrange);

    const report = classifyStartFailure(error, 'feature-1', (raw) => raw);

    expect(report.message).toBe(`checkpoint-unavailable: ${reason}`);
    expect(report.message.startsWith('checkpoint-unavailable')).toBe(true);
  });

  it('logs the reason and no path', async () => {
    await driveToGitPhase(arrange);

    const lines = h.warnings.filter((line) => line.startsWith('checkpoint failed'));
    expect(lines).toEqual([`checkpoint failed; Git-capable phase blocked: ${reason}`]);
    for (const line of h.warnings) {
      expect(line).not.toContain(h.workspaceRoot);
      expect(line).not.toContain(h.storageRoot);
    }
  });
});
