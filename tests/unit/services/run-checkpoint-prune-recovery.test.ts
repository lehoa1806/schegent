/**
 * FR-R6-F08 (FR-017, research R10, US3 scenario 4) — the checkpoint pruner never removes a
 * recovery envelope it has not been told is unprotected.
 *
 * Over the per-Run limit, the oldest prefixes are evicted. Their snapshot files go as before;
 * their `.recovery.json` is removed only when a protection predicate is wired and answers
 * `false`. With no predicate the envelope is kept: that is the fail-safe direction.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SanitizedLogger } from '../../../src/lib/logger';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import { assessRecoveryEnvelopeProtection } from '../../../src/services/recovery-handoff';
import { createHandoffStore } from '../../../src/services/recovery-handoff/handoff-store';
import { RunCheckpointService } from '../../../src/services/run-checkpoint-service';
import { RunMutationLedger } from '../../../src/services/run-mutation-ledger';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';

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

  it('never lets >20 hand-* envelope-only prefixes displace newly written checkpoints and reaps them once unowned (16-11)', async () => {
    await fs.mkdir(runRoot(), { recursive: true, mode: 0o700 });
    for (let index = 0; index < 25; index += 1) {
      const id = `hand-${String(index).padStart(2, '0')}`;
      await fs.writeFile(path.join(runRoot(), `${id}.recovery.json`), '{}', { mode: 0o600 });
    }

    // Pass 1: all hand-* envelopes are protected; fresh `17...-<phase>` checkpoint sorts BEFORE
    // `hand-*` lexically yet MUST NOT be displaced.
    await service(() => true).checkpoint(RUN, 'speckit-implement');
    const afterFirst = await fs.readdir(runRoot());
    expect(afterFirst.filter((name) => name.endsWith('.patch'))).toHaveLength(1);
    expect(afterFirst.filter((name) => name.endsWith('.json') && !name.endsWith('.recovery.json'))).toHaveLength(1);
    expect(afterFirst.filter((name) => name.endsWith('.recovery.json'))).toHaveLength(25);

    // Pass 2: once hand-00..hand-04 become unowned, repeated prune reaps them while keeping the fresh checkpoints.
    await service((_runId, handoverId) => Number(handoverId.replace('hand-', '')) >= 5).checkpoint(
      RUN,
      'speckit-implement'
    );
    const afterSecond = await fs.readdir(runRoot());
    expect(afterSecond.filter((name) => name.endsWith('.patch'))).toHaveLength(2);
    expect(afterSecond.filter((name) => name.endsWith('.recovery.json'))).toHaveLength(20);
    expect(await present('hand-00.recovery.json')).toBe(false);
    expect(await present('hand-04.recovery.json')).toBe(false);
    expect(await present('hand-05.recovery.json')).toBe(true);
  });

  it('skips predicate invocations for evicted checkpoints that have no .recovery.json file (16-11)', async () => {
    await fs.mkdir(runRoot(), { recursive: true, mode: 0o700 });
    for (let index = 0; index < 25; index += 1) {
      const prefix = seededPrefix(index);
      await fs.writeFile(path.join(runRoot(), `${prefix}.patch`), '', { mode: 0o600 });
      await fs.writeFile(path.join(runRoot(), `${prefix}.json`), '{}', { mode: 0o600 });
    }
    const asked: string[] = [];
    await service((runId, handoverId) => {
      asked.push(`${runId}/${handoverId}`);
      return false;
    }).checkpoint(RUN, 'speckit-implement');
    expect(asked).toEqual([]);
    expect((await fs.readdir(runRoot())).filter((name) => name.endsWith('.patch'))).toHaveLength(20);
  });

  it('lets a finished checkpoint succeed even if prune throws an I/O error (16-11)', async () => {
    const warnings: string[] = [];
    const recording = { warn: (message: string) => warnings.push(message) } as unknown as SanitizedLogger;
    const svc = new RunCheckpointService(storageRoot, workspaceRoot, recording, () => 1, ledger(), () => false);
    const pruneSpy = vi
      .spyOn(svc as unknown as { prune: (dir: string) => Promise<void> }, 'prune')
      .mockRejectedValueOnce(new Error('EIO on /secret/checkpoints/run-a'));
    try {
      await expect(svc.checkpoint(RUN, 'speckit-implement')).resolves.toBeUndefined();
    } finally {
      pruneSpy.mockRestore();
    }
    const files = await fs.readdir(runRoot());
    expect(files.filter((name) => name.endsWith('.patch'))).toHaveLength(1);
    expect(files.filter((name) => name.endsWith('.json'))).toHaveLength(1);
    expect(warnings).toContain('checkpoint prune failed after checkpoint completed');
    expect(warnings.some((message) => message.includes('/secret/'))).toBe(false);
  });

  it('wires SQLite assessRecoveryEnvelopeProtection across restart for protected, unowned, ambiguous, and lookup-error cases (16-11)', async () => {
    const dbPath = path.join(storageRoot, 'state.db');
    let conn = new NodeSqliteConnection({ databasePath: dbPath });
    const now = 1_800_000_000_000;
    SchemaBootstrapService.bootstrapAndMigrate(conn, () => now);
    const store = createHandoffStore(conn);

    const makeManifest = (artifactId: string) =>
      JSON.stringify({
        version: 1,
        sourceOutcome: { status: 'incomplete', reason: 'work-remaining' },
        frozenDefinitionDigest: 'b'.repeat(64),
        certainty: 'uncertain',
        coverage: 'partial',
        workspace: { entries: [], omittedCount: 0 },
        references: [],
        excluded: [],
        contextId: null,
        envelope: { artifactId, digest: 'a'.repeat(64) }
      });

    // Protected exact envelope: hand-00 under run-a
    store.insertHandoff({
      handoffId: '1'.repeat(64),
      workspaceId: 'ws-1',
      rootExecutionId: 'run-a',
      invocationId: 'inv-0',
      sourceAttemptId: 'att-0',
      legacyProvenance: null,
      nowMs: now
    });
    store.insertRevision({
      handoffId: '1'.repeat(64),
      revisionNo: 1,
      cutoffKey: '1'.repeat(64),
      executionRevision: 'exec-1',
      usageRevision: 0,
      factCutoffMs: now,
      manifestVersion: 1,
      manifestJson: makeManifest('hand-00'),
      manifestDigest: '1'.repeat(64),
      certainty: 'uncertain',
      coverage: 'partial'
    });

    // Lossy collision (ambiguous): hand.01 sanitizes to hand_01 under run-a
    store.insertHandoff({
      handoffId: '2'.repeat(64),
      workspaceId: 'ws-1',
      rootExecutionId: 'run-a',
      invocationId: 'inv-1',
      sourceAttemptId: 'att-1',
      legacyProvenance: null,
      nowMs: now
    });
    store.insertRevision({
      handoffId: '2'.repeat(64),
      revisionNo: 1,
      cutoffKey: '2'.repeat(64),
      executionRevision: 'exec-2',
      usageRevision: 0,
      factCutoffMs: now,
      manifestVersion: 1,
      manifestJson: makeManifest('hand.01'),
      manifestDigest: '2'.repeat(64),
      certainty: 'uncertain',
      coverage: 'partial'
    });

    // Closed handoff (unowned): hand-02 under run-a
    store.insertHandoff({
      handoffId: '3'.repeat(64),
      workspaceId: 'ws-1',
      rootExecutionId: 'run-a',
      invocationId: 'inv-2',
      sourceAttemptId: 'att-2',
      legacyProvenance: null,
      nowMs: now
    });
    store.insertRevision({
      handoffId: '3'.repeat(64),
      revisionNo: 1,
      cutoffKey: '3'.repeat(64),
      executionRevision: 'exec-3',
      usageRevision: 0,
      factCutoffMs: now,
      manifestVersion: 1,
      manifestJson: makeManifest('hand-02'),
      manifestDigest: '3'.repeat(64),
      certainty: 'uncertain',
      coverage: 'partial'
    });
    store.updateHandoff('3'.repeat(64), { state: 'consumed', closedReason: 'delivered' }, now + 1);
    conn.close();

    // Restart: reopen DB and seed 25 envelope-only files (hand-00, hand_01, hand-02, hand-03..hand-24).
    conn = new NodeSqliteConnection({ databasePath: dbPath });
    try {
      await fs.mkdir(runRoot(), { recursive: true, mode: 0o700 });
      const names = ['hand-00', 'hand-02', 'hand-03', 'hand-04', 'hand_01'];
      for (let i = 5; i < 25; i += 1) names.push(`hand-${String(i).padStart(2, '0')}`);
      for (const name of names) {
        await fs.writeFile(path.join(runRoot(), `${name}.recovery.json`), '{}', { mode: 0o600 });
      }

      // Note: ASCII sort places `hand-00`..`hand-04` first (`-` < `_`), and let's put `hand_01`
      // inside the evicted slice by naming newer envelopes `z-hand-*`.
      await fs.writeFile(path.join(runRoot(), 'hand_01.recovery.json'), '{}', { mode: 0o600 });
      for (let i = 0; i < 20; i += 1) {
        await fs.writeFile(path.join(runRoot(), `z-hand-${String(i).padStart(2, '0')}.recovery.json`), '{}', {
          mode: 0o600
        });
      }

      await service(
        (runSegment, handoverSegment) => assessRecoveryEnvelopeProtection(conn, runSegment, handoverSegment).protected
      ).checkpoint(RUN, 'speckit-implement');

      expect(await present('hand-00.recovery.json')).toBe(true); // protected
      expect(await present('hand_01.recovery.json')).toBe(true); // ambiguous (lossy hand.01)
      expect(await present('hand-02.recovery.json')).toBe(false); // closed -> unowned -> reaped
      expect(await present('hand-03.recovery.json')).toBe(false); // never owned -> unowned -> reaped

      // Lookup error (closed conn): fails safe and keeps even an unowned envelope past the cap.
      conn.close();
      await fs.writeFile(path.join(runRoot(), 'a-unowned-after-close.recovery.json'), '{}', { mode: 0o600 });
      await service(
        (runSegment, handoverSegment) => assessRecoveryEnvelopeProtection(conn, runSegment, handoverSegment).protected
      ).checkpoint(RUN, 'speckit-implement');
      expect(await present('a-unowned-after-close.recovery.json')).toBe(true);
    } finally {
      conn.close();
    }
  });
});
