/**
 * FR-R6-F08 (FR-017, research R10, US3 scenario 4) — the checkpoint pruner never removes a
 * recovery envelope it has not been told is unprotected.
 *
 * Over the per-Run limit, the oldest prefixes are evicted. Their snapshot files go as before;
 * their `.recovery.json` is removed only when a protection predicate is wired and answers
 * `false`. With no predicate the envelope is kept: that is the fail-safe direction.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SanitizedLogger } from '../../../src/lib/logger';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import { RunCheckpointService } from '../../../src/services/run-checkpoint-service';
import { RunMutationLedger } from '../../../src/services/run-mutation-ledger';

const run = promisify(execFile);

/** More than the per-Run limit of 20, so the oldest seeded prefixes are evicted. */
const SEEDED = 25;
/** Seeded names sort before any real `<Date.now()>-<phase>` prefix. */
const SEED_STAMP = '1000000000000';

const RUN: WorkflowRun = {
  id: 'run-a',
  featureId: 'feat-a',
  featureDir: 'specs/001-x',
  status: 'running',
  currentPhase: 'speckit-implement',
  currentIteration: 0,
  startedAt: 1_700_000_000_000,
  lastTransitionAt: 1_700_000_000_000,
  phasesCompleted: [],
  lastError: null,
  delayedRetryCount: 0,
  pendingRetryAt: null,
  pendingRetryCause: null,
  phaseOverrides: [],
  manualPauseAt: null,
  manualPauseCause: null,
  phaseBreakpoints: [],
  resumeTargetPhaseId: null
};

let storageRoot: string;
let workspaceRoot: string;
const logger = { warn: () => undefined } as unknown as SanitizedLogger;

beforeEach(async () => {
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-prune-recovery-store-'));
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-prune-recovery-work-'));
  await run('git', ['init', '-q'], { cwd: workspaceRoot });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: workspaceRoot });
  await run('git', ['config', 'user.name', 'Test'], { cwd: workspaceRoot });
  await run('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: workspaceRoot });
});

afterEach(async () => {
  await fs.rm(storageRoot, { recursive: true, force: true });
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

function ledger(): RunMutationLedger {
  return new RunMutationLedger({
    readDiff: async () =>
      (await run('git', ['diff', '--binary', '--no-ext-diff', 'HEAD'], { cwd: workspaceRoot })).stdout,
    listInFlightRunIds: () => [],
    workspaceRoot
  });
}

function service(predicate?: (runId: string, handoverId: string) => boolean): RunCheckpointService {
  return new RunCheckpointService(storageRoot, workspaceRoot, logger, () => 1, ledger(), predicate);
}

function runRoot(): string {
  return path.join(storageRoot, 'checkpoints', 'run-a');
}

function seededPrefix(index: number): string {
  return `${SEED_STAMP}-p${String(index).padStart(2, '0')}`;
}

/** Writes `SEEDED` prefixes, each with a patch, a manifest and a recovery envelope. */
async function seed(): Promise<void> {
  await fs.mkdir(runRoot(), { recursive: true, mode: 0o700 });
  for (let index = 0; index < SEEDED; index += 1) {
    const prefix = seededPrefix(index);
    await fs.writeFile(path.join(runRoot(), `${prefix}.patch`), '', { mode: 0o600 });
    await fs.writeFile(path.join(runRoot(), `${prefix}.json`), '{}', { mode: 0o600 });
    await fs.writeFile(path.join(runRoot(), `${prefix}.recovery.json`), '{}', { mode: 0o600 });
  }
}

async function present(name: string): Promise<boolean> {
  return fs
    .access(path.join(runRoot(), name))
    .then(() => true)
    .catch(() => false);
}

/** The oldest seeded prefix: evicted by any prune once the count exceeds the limit. */
const OLDEST = seededPrefix(0);
/** The newest seeded prefix: inside the limit, never evicted here. */
const NEWEST = seededPrefix(SEEDED - 1);

describe('checkpoint prune and recovery envelopes (R10)', () => {
  it('keeps every recovery envelope when no predicate is wired, and prunes the other files', async () => {
    await seed();
    await service().checkpoint(RUN, 'speckit-implement');

    expect(await present(`${OLDEST}.patch`)).toBe(false);
    expect(await present(`${OLDEST}.json`)).toBe(false);
    expect(await present(`${OLDEST}.recovery.json`)).toBe(true);
    const envelopes = (await fs.readdir(runRoot())).filter((name) => name.endsWith('.recovery.json'));
    expect(envelopes).toHaveLength(SEEDED);
    expect(await present(`${NEWEST}.patch`)).toBe(true);
  });

  it('keeps an evicted envelope the predicate protects, and asks with the Run and handover segments', async () => {
    await seed();
    const asked: string[] = [];
    await service((runId, handoverId) => {
      asked.push(`${runId}/${handoverId}`);
      return true;
    }).checkpoint(RUN, 'speckit-implement');

    expect(await present(`${OLDEST}.recovery.json`)).toBe(true);
    expect(await present(`${OLDEST}.patch`)).toBe(false);
    expect(asked).toContain(`run-a/${OLDEST}`);
    expect(asked).not.toContain(`run-a/${NEWEST}`);
  });

  it('keeps an evicted envelope when the predicate throws, and the checkpoint still completes', async () => {
    await seed();
    const warnings: string[] = [];
    const recording = { warn: (message: string) => warnings.push(message) } as unknown as SanitizedLogger;
    const throwing = new RunCheckpointService(storageRoot, workspaceRoot, recording, () => 1, ledger(), () => {
      throw new Error('store closed /secret/path');
    });
    await expect(throwing.checkpoint(RUN, 'speckit-implement')).resolves.toBeUndefined();

    expect(await present(`${OLDEST}.recovery.json`)).toBe(true);
    expect(await present(`${OLDEST}.patch`)).toBe(false);
    expect(warnings).toContain('checkpoint prune kept recovery envelope: protection check failed');
    expect(warnings.some((message) => message.includes('/secret/path'))).toBe(false);
  });

  it('removes an evicted envelope the predicate does not protect, and leaves the rest', async () => {
    await seed();
    await service(() => false).checkpoint(RUN, 'speckit-implement');

    expect(await present(`${OLDEST}.recovery.json`)).toBe(false);
    expect(await present(`${OLDEST}.patch`)).toBe(false);
    expect(await present(`${NEWEST}.recovery.json`)).toBe(true);
  });

  it('removes only the envelopes the predicate leaves unprotected', async () => {
    await seed();
    const unprotected = seededPrefix(1);
    await service((_runId, handoverId) => handoverId !== unprotected).checkpoint(RUN, 'speckit-implement');

    expect(await present(`${unprotected}.recovery.json`)).toBe(false);
    expect(await present(`${OLDEST}.recovery.json`)).toBe(true);
  });
});
