// FR-R6-F05 (T024; AC-05, FR-010, FR-011, NFR-002, NFR-004, NFR-005) — the
// recoverable deletion operation and its effect boundary.
//
// Every fault reaches the boundary through the injected `LifecycleFs` or a
// connection that fails one statement. Outcomes are truthful: a target whose
// bytes are still there is `retained`, an absent one is `already-absent` and
// counts as success, and an interrupted operation resumes under its own id.

import { describe, expect, it } from 'vitest';
import type {
  DeletionOperation,
  DeletionTargetOutcomeKind
} from '../../../src/contracts/artifact-lifecycle/lifecycle-types';
import { SWEEP_MAX_REMOVALS_PER_PASS } from '../../../src/contracts/artifact-lifecycle/lifecycle-types';
import {
  ArtifactRecordStore,
  DENY_ALL_ACCESS_POLICY,
  PreviewStore,
  ReferenceStore,
  repairDeletionAccounting,
  type ArtifactLifecycleService,
  type DeletionSelection,
  type LifecycleContext
} from '../../../src/services/artifact-lifecycle';
import type { NodeSqliteConnection } from '../../../src/services/sqlite-store';
import {
  CHECKPOINT_SCAN_ROOT,
  checkpointArtifact,
  checkpointPath,
  FULL,
  fsError,
  lifecycleFixture,
  NOW,
  seedCheckpoint,
  WORKSPACE_ROOT
} from './lifecycle-fixture';

const LEASE_TTL_MARGIN_MS = 10 * 60 * 1000;
const CANCEL_OBSERVATION_LIMIT_MS = 1_000;

async function execute(
  service: ArtifactLifecycleService,
  selection: DeletionSelection = {},
  signal?: AbortSignal
): Promise<DeletionOperation> {
  const preview = service.previewDeletion(selection);
  if (!preview.ok) throw new Error(`preview refused: ${preview.refusal.code}`);
  const result = await service.executeDeletion(
    { ...selection, previewId: preview.value.previewId, confirmation: 'confirmed', authority: FULL },
    signal
  );
  if (!result.ok) throw new Error(`execute refused: ${result.refusal.code}`);
  return result.value;
}

function outcomes(operation: DeletionOperation): Record<string, DeletionTargetOutcomeKind> {
  return Object.fromEntries(operation.targets.map((target) => [target.artifactId ?? '', target.outcome]));
}

/** A connection whose `UPDATE deletion_targets ... 'executing'` write fails with ENOSPC. */
function failingIntentWrites(conn: NodeSqliteConnection): NodeSqliteConnection {
  return new Proxy(conn, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (property !== 'run') return (value as (...args: unknown[]) => unknown).bind(target);
      return (sql: string, ...params: unknown[]) => {
        if (sql.includes('UPDATE deletion_targets') && params.includes('executing')) throw fsError('ENOSPC');
        return (value as (...args: unknown[]) => unknown).apply(target, [sql, ...params]);
      };
    }
  });
}

describe('FR-R6-F05 deletion outcomes (FR-010, FR-011)', () => {
  it('deletes eligible targets and marks their lifecycle rows deleted', async () => {
    const fx = lifecycleFixture();
    const service = fx.build();
    seedCheckpoint(service, fx.fs, 'art-1');
    seedCheckpoint(service, fx.fs, 'art-2');
    const operation = await execute(service);
    expect(operation.state).toBe('completed');
    expect(outcomes(operation)).toEqual({ 'art-1': 'deleted', 'art-2': 'deleted' });
    expect(fx.fs.has(checkpointPath('art-1'))).toBe(false);
    const record = service.getArtifact('art-1');
    expect(record.ok && record.value.availability).toBe('deleted');
    expect(fx.audits.at(-1)).toMatchObject({ operationKind: 'deletion', result: 'completed', counts: { deleted: 2 } });
  });

  it('writes no unlink when persisting the intent fails with ENOSPC', async () => {
    const fx = lifecycleFixture();
    seedCheckpoint(fx.build(), fx.fs, 'art-1');
    const service = fx.build({ conn: failingIntentWrites(fx.conn) });
    const preview = service.previewDeletion({});
    if (!preview.ok) throw new Error('preview refused');
    const result = await service.executeDeletion({ previewId: preview.value.previewId, confirmation: 'confirmed', authority: FULL });
    expect(result.ok ? null : result.refusal.code).toBe('unavailable');
    expect(fx.fs.calls.some(([op]) => op === 'unlink')).toBe(false);
    expect(fx.fs.has(checkpointPath('art-1'))).toBe(true);
  });

  it('maps EACCES to retained and the operation to partial', async () => {
    const fx = lifecycleFixture();
    const service = fx.build();
    seedCheckpoint(service, fx.fs, 'art-1');
    seedCheckpoint(service, fx.fs, 'art-2');
    fx.fs.unlinkHooks.set(checkpointPath('art-2'), () => {
      throw fsError('EACCES');
    });
    const operation = await execute(service);
    expect(operation.state).toBe('partial');
    expect(outcomes(operation)).toEqual({ 'art-1': 'deleted', 'art-2': 'retained' });
    const kept = service.getArtifact('art-2');
    expect(kept.ok && kept.value.availability).toBe('present');
  });

  it('counts a target that is already gone as success', async () => {
    const fx = lifecycleFixture();
    const service = fx.build();
    seedCheckpoint(service, fx.fs, 'art-1');
    seedCheckpoint(service, fx.fs, 'art-2');
    fx.fs.remove(checkpointPath('art-1'));
    fx.fs.unlinkHooks.set(checkpointPath('art-2'), () => {
      fx.fs.remove(checkpointPath('art-2'));
    });
    const operation = await execute(service);
    expect(operation.state).toBe('completed');
    expect(outcomes(operation)).toEqual({ 'art-1': 'already-absent', 'art-2': 'already-absent' });
  });
});

describe('FR-R6-F05 deletion effect boundary (NFR-004, NFR-005, SC-001)', () => {
  it('refuses the remaining targets once the fence no longer names the operation', async () => {
    const fx = lifecycleFixture();
    const service = fx.build();
    seedCheckpoint(service, fx.fs, 'art-1');
    seedCheckpoint(service, fx.fs, 'art-2');
    fx.fs.unlinkHooks.set(checkpointPath('art-1'), () => {
      fx.conn.run(`UPDATE sweep_leases SET holder_id = 'someone-else'`);
    });
    const operation = await execute(service);
    expect(outcomes(operation)).toEqual({ 'art-1': 'deleted', 'art-2': 'refused' });
    expect(operation.targets.at(1)?.reasonCode).toBe('stale-fence');
    expect(fx.fs.has(checkpointPath('art-2'))).toBe(true);
  });

  it('refuses a target whose file became a link between plan and effect', async () => {
    const fx = lifecycleFixture();
    const service = fx.build();
    seedCheckpoint(service, fx.fs, 'art-1');
    seedCheckpoint(service, fx.fs, 'art-2');
    fx.fs.unlinkHooks.set(checkpointPath('art-1'), () => {
      fx.fs.symlink(checkpointPath('art-2'), '/etc/passwd');
    });
    const operation = await execute(service);
    expect(outcomes(operation)).toEqual({ 'art-1': 'deleted', 'art-2': 'refused' });
    expect(operation.targets.at(1)?.reasonCode).toBe('containment-violation');
    expect(fx.fs.unlinked).toEqual([checkpointPath('art-1')]);
  });

  it('refuses a target that became a link to another file inside the root, unlinking neither', async () => {
    const fx = lifecycleFixture();
    const service = fx.build();
    for (const id of ['art-1', 'art-2', 'art-3']) seedCheckpoint(service, fx.fs, id);
    fx.fs.unlinkHooks.set(checkpointPath('art-1'), () => {
      fx.fs.symlink(checkpointPath('art-2'), checkpointPath('art-3'));
    });
    const operation = await execute(service, { artifactIds: ['art-1', 'art-2'] });
    expect(outcomes(operation)).toEqual({ 'art-1': 'deleted', 'art-2': 'refused' });
    expect(operation.targets.at(1)?.reasonCode).toBe('containment-violation');
    expect(fx.fs.unlinked).toEqual([checkpointPath('art-1')]);
    expect(fx.fs.has(checkpointPath('art-3'))).toBe(true);
  });

  it('leaves the targets and state alone once a resumed pass has taken the operation over', async () => {
    const fx = lifecycleFixture();
    const service = fx.build();
    seedCheckpoint(service, fx.fs, 'art-1');
    seedCheckpoint(service, fx.fs, 'art-2');
    fx.fs.unlinkHooks.set(checkpointPath('art-1'), () => {
      fx.conn.run(`UPDATE sweep_leases SET holder_id = 'fence-taken-over'`);
      fx.conn.run(`UPDATE deletion_operations SET fence_token = 'fence-taken-over'`);
    });
    const operation = await execute(service);
    expect(operation.state).toBe('executing');
    expect(outcomes(operation)).toEqual({ 'art-1': 'deleted', 'art-2': 'planned' });
    expect(fx.fs.has(checkpointPath('art-2'))).toBe(true);
    expect(fx.conn.scalar<string>(`SELECT holder_id FROM sweep_leases`)).toBe('fence-taken-over');
  });

  it('refuses a target whose locator is shared with a protected artifact', async () => {
    const fx = lifecycleFixture();
    const service = fx.build();
    seedCheckpoint(service, fx.fs, 'art-1');
    seedCheckpoint(service, fx.fs, 'art-twin', {
      locator: { storageTier: 'workspace_file', uriOrRelpath: '.schegent/checkpoints/run-1/art-1.patch' }
    });
    service.addReference({ artifactId: 'art-twin', ownerType: 'run', ownerId: 'run-1', purpose: 'paused-recovery', protective: true });
    const operation = await execute(service, { artifactIds: ['art-1'] });
    expect(outcomes(operation)).toEqual({ 'art-1': 'refused' });
    expect(operation.targets.at(0)?.reasonCode).toBe('protected-reference');
    expect(fx.fs.has(checkpointPath('art-1'))).toBe(true);
  });

  it.each([
    ['leading ./ alias', './.schegent/checkpoints/run-1/art-1.patch'],
    ['double-slash // alias', '.schegent//checkpoints/run-1//art-1.patch'],
    ['backslash \\ alias', '.schegent\\checkpoints\\run-1\\art-1.patch']
  ])('refuses a target shared with a protected pre-existing row using a %s', async (_label, aliasLocator) => {
    const fx = lifecycleFixture();
    const service = fx.build();
    seedCheckpoint(service, fx.fs, 'art-1');
    seedCheckpoint(service, fx.fs, 'art-twin');
    // Pre-existing DB row with a non-canonical locator pointing to the same file as art-1.
    fx.conn.run(`UPDATE artifact_locations SET uri_or_relpath = ? WHERE artifact_id = 'art-twin'`, aliasLocator);
    service.addReference({ artifactId: 'art-twin', ownerType: 'run', ownerId: 'run-1', purpose: 'paused-recovery', protective: true });

    const operation = await execute(service, { artifactIds: ['art-1'] });
    expect(outcomes(operation)).toEqual({ 'art-1': 'refused' });
    expect(operation.targets.at(0)?.reasonCode).toBe('protected-reference');
    expect(fx.fs.has(checkpointPath('art-1'))).toBe(true);
    expect(fx.fs.unlinked).toEqual([]);
  });

  it('protects never-eligible and live-writer sharers seeded with non-canonical aliases', async () => {
    const fx = lifecycleFixture();
    const service = fx.build();
    seedCheckpoint(service, fx.fs, 'art-audit-target');
    seedCheckpoint(service, fx.fs, 'art-audit-sharer', { storeKind: 'audit' });
    fx.conn.run(
      `UPDATE artifact_locations SET uri_or_relpath = ? WHERE artifact_id = 'art-audit-sharer'`,
      './.schegent/checkpoints/run-1/art-audit-target.patch'
    );

    seedCheckpoint(service, fx.fs, 'art-live-target');
    const liveReg = service.registerArtifact({
      artifactId: 'art-live-sharer',
      ownerRunId: 'run-1',
      sensitivity: 'content',
      retentionClass: 'transcripts-diagnostics-checkpoints-audit-catalog',
      storeKind: 'live-log-segment',
      immutability: 'growing',
      generation: 1,
      extentBytes: 40,
      byteSize: 40,
      mediaType: 'text/plain',
      displayName: 'live-log',
      producerIdentity: 'writer',
      locator: { storageTier: 'workspace_file', uriOrRelpath: '.schegent/checkpoints/run-1/art-live-sharer.patch' }
    });
    expect(liveReg.ok).toBe(true);
    fx.conn.run(
      `UPDATE artifact_locations SET uri_or_relpath = ? WHERE artifact_id = 'art-live-sharer'`,
      '.schegent\\checkpoints//run-1\\art-live-target.patch'
    );

    const operation = await execute(service, { artifactIds: ['art-audit-target', 'art-live-target'] });
    expect(outcomes(operation)).toEqual({
      'art-audit-target': 'refused',
      'art-live-target': 'retained'
    });
    expect(operation.targets.find((target) => target.artifactId === 'art-audit-target')?.reasonCode).toBe('never-eligible');
    expect(operation.targets.find((target) => target.artifactId === 'art-live-target')?.reasonCode).toBe('live-writer');
    expect(fx.fs.has(checkpointPath('art-audit-target'))).toBe(true);
    expect(fx.fs.has(checkpointPath('art-live-target'))).toBe(true);
    expect(fx.fs.unlinked).toEqual([]);
  });

  it('refuses a target outside every declared root before any filesystem call', async () => {
    const fx = lifecycleFixture();
    const service = fx.build();
    seedCheckpoint(service, fx.fs, 'art-out');
    // Registration refuses a traversing locator, so a legacy or damaged row is
    // written directly; the effect boundary must refuse it on its own.
    fx.conn.run(`UPDATE artifact_locations SET uri_or_relpath = '../elsewhere/art-out.patch' WHERE artifact_id = 'art-out'`);
    const operation = await execute(service);
    expect(outcomes(operation)).toEqual({ 'art-out': 'refused' });
    expect(operation.targets.at(0)?.reasonCode).toBe('containment-violation');
    expect(operation.state).toBe('refused');
    expect(fx.fs.touched('/elsewhere/art-out.patch')).toBe(false);
  });

  it('never unlinks a target that became protected during the operation', async () => {
    const fx = lifecycleFixture();
    const service = fx.build();
    seedCheckpoint(service, fx.fs, 'art-1');
    seedCheckpoint(service, fx.fs, 'art-2');
    fx.fs.unlinkHooks.set(checkpointPath('art-1'), () => {
      service.addReference({ artifactId: 'art-2', ownerType: 'run', ownerId: 'run-1', purpose: 'paused-recovery', protective: true });
    });
    const operation = await execute(service);
    expect(outcomes(operation)).toEqual({ 'art-1': 'deleted', 'art-2': 'refused' });
    expect(operation.targets.at(1)?.reasonCode).toBe('protected-reference');
    expect(fx.fs.has(checkpointPath('art-2'))).toBe(true);
  });

  it('plans no protected, pinned-run or audit artifact as a target', () => {
    const fx = lifecycleFixture();
    const service = fx.build({ pinnedRunIds: new Set(['run-2']) });
    seedCheckpoint(service, fx.fs, 'art-free');
    seedCheckpoint(service, fx.fs, 'art-held');
    seedCheckpoint(service, fx.fs, 'art-run', { ownerRunId: 'run-2' });
    seedCheckpoint(service, fx.fs, 'art-audit', { storeKind: 'audit' });
    service.addReference({ artifactId: 'art-held', ownerType: 'run', ownerId: 'run-1', purpose: 'active-recovery', protective: true });
    const preview = service.previewDeletion({});
    if (!preview.ok) throw new Error('preview refused');
    expect(preview.value.summary.affectedCount).toBe(1);
    expect(preview.value.summary.protectedCount).toBe(2);
    const reasons = Object.fromEntries(preview.value.summary.protectedExceptions.map((item) => [item.artifactId, item.reason]));
    expect(reasons).toEqual({
      'art-held': 'preserve-protected',
      'art-run': 'preserve-protected',
      'art-audit': 'preserve-never-eligible'
    });
  });

  it('refuses execution once the selection changed after the preview', async () => {
    const fx = lifecycleFixture();
    const service = fx.build();
    seedCheckpoint(service, fx.fs, 'art-1');
    const preview = service.previewDeletion({});
    if (!preview.ok) throw new Error('preview refused');
    service.addReference({ artifactId: 'art-1', ownerType: 'run', ownerId: 'run-1', purpose: 'paused-recovery', protective: true });
    const result = await service.executeDeletion({ previewId: preview.value.previewId, confirmation: 'confirmed', authority: FULL });
    expect(result.ok ? null : result.refusal.code).toBe('preview-stale');
    expect(fx.fs.unlinked).toEqual([]);
  });
});

describe('FR-R6-F05 deletion passes, cancellation and restart (NFR-002, FR-010)', () => {
  it('needs two passes for 201 targets and resumes under the same operation id', async () => {
    const fx = lifecycleFixture();
    const service = fx.build();
    for (let n = 0; n <= SWEEP_MAX_REMOVALS_PER_PASS; n += 1) seedCheckpoint(service, fx.fs, `art-${String(n).padStart(3, '0')}`);
    const first = await execute(service);
    expect(first.state).toBe('executing');
    expect(first.targets.filter((target) => target.outcome === 'deleted')).toHaveLength(SWEEP_MAX_REMOVALS_PER_PASS);
    const second = await service.reconcileDeletionOperation(first.operationId, FULL);
    if (!second.ok) throw new Error(`reconcile refused: ${second.refusal.code}`);
    expect(second.value.operationId).toBe(first.operationId);
    expect(second.value.state).toBe('completed');
    expect(fx.fs.unlinked).toHaveLength(SWEEP_MAX_REMOVALS_PER_PASS + 1);
    expect(fx.audits.at(-1)).toMatchObject({ operationId: first.operationId, result: 'resumed' });
  });

  it('observes cancellation before the next target, within 1 s', async () => {
    const fx = lifecycleFixture();
    const service = fx.build();
    for (const id of ['art-1', 'art-2', 'art-3']) seedCheckpoint(service, fx.fs, id);
    const controller = new AbortController();
    fx.fs.unlinkHooks.set(checkpointPath('art-1'), () => controller.abort());
    const started = Date.now();
    const operation = await execute(service, {}, controller.signal);
    expect(Date.now() - started).toBeLessThan(CANCEL_OBSERVATION_LIMIT_MS);
    expect(operation.state).toBe('cancelled');
    expect(outcomes(operation)).toEqual({ 'art-1': 'deleted', 'art-2': 'refused', 'art-3': 'refused' });
    expect(fx.fs.unlinked).toEqual([checkpointPath('art-1')]);
  });

  it('resumes an interrupted operation after a restart and reconciles the target left executing', async () => {
    const fx = lifecycleFixture();
    const before = fx.build();
    seedCheckpoint(before, fx.fs, 'art-1');
    seedCheckpoint(before, fx.fs, 'art-2');
    let hung = true;
    fx.fs.unlinkHooks.set(checkpointPath('art-1'), () => (hung ? new Promise<void>(() => undefined) : undefined));
    const preview = before.previewDeletion({});
    if (!preview.ok) throw new Error('preview refused');
    void before.executeDeletion({ previewId: preview.value.previewId, confirmation: 'confirmed', authority: FULL });
    await new Promise((resolve) => setImmediate(resolve));
    const operationId = fx.conn.scalar<string>(`SELECT operation_id FROM deletion_operations`);
    expect(fx.conn.scalar<string>(`SELECT outcome FROM deletion_targets WHERE target_ordinal = 0`)).toBe('executing');

    hung = false;
    const after = fx.build({ nowMs: NOW + LEASE_TTL_MARGIN_MS });
    const resumed = await after.reconcileDeletionOperation(operationId ?? '', FULL);
    if (!resumed.ok) throw new Error(`reconcile refused: ${resumed.refusal.code}`);
    expect(resumed.value.operationId).toBe(operationId);
    expect(resumed.value.state).toBe('completed');
    expect(outcomes(resumed.value)).toEqual({ 'art-1': 'deleted', 'art-2': 'deleted' });
  });

  it('keeps a cancelled resume non-terminal while a target is still left executing', async () => {
    const fx = lifecycleFixture();
    const before = fx.build();
    seedCheckpoint(before, fx.fs, 'art-1');
    seedCheckpoint(before, fx.fs, 'art-2');
    let hung = true;
    fx.fs.unlinkHooks.set(checkpointPath('art-1'), () => (hung ? new Promise<void>(() => undefined) : undefined));
    const preview = before.previewDeletion({});
    if (!preview.ok) throw new Error('preview refused');
    void before.executeDeletion({ previewId: preview.value.previewId, confirmation: 'confirmed', authority: FULL });
    await new Promise((resolve) => setImmediate(resolve));
    const operationId = fx.conn.scalar<string>(`SELECT operation_id FROM deletion_operations`) ?? '';

    hung = false;
    const after = fx.build({ nowMs: NOW + LEASE_TTL_MARGIN_MS });
    const controller = new AbortController();
    controller.abort();
    const cancelled = await after.reconcileDeletionOperation(operationId, FULL, controller.signal);
    if (!cancelled.ok) throw new Error(`reconcile refused: ${cancelled.refusal.code}`);
    expect(cancelled.value.state).toBe('executing');
    expect(outcomes(cancelled.value)).toEqual({ 'art-1': 'executing', 'art-2': 'refused' });

    const finished = await after.reconcileDeletionOperation(operationId, FULL);
    if (!finished.ok) throw new Error(`reconcile refused: ${finished.refusal.code}`);
    expect(outcomes(finished.value)).toEqual({ 'art-1': 'deleted', 'art-2': 'refused' });
    expect(finished.value.state).toBe('partial');
  });

  it('refuses a second sweep while another operation holds the lease', async () => {
    const fx = lifecycleFixture();
    const service = fx.build();
    seedCheckpoint(service, fx.fs, 'art-1');
    seedCheckpoint(service, fx.fs, 'art-2');
    fx.fs.unlinkHooks.set(checkpointPath('art-1'), () => new Promise<void>(() => undefined));
    const first = service.previewDeletion({ artifactIds: ['art-1'] });
    if (!first.ok) throw new Error('preview refused');
    void service.executeDeletion({ artifactIds: ['art-1'], previewId: first.value.previewId, confirmation: 'confirmed', authority: FULL });
    await new Promise((resolve) => setImmediate(resolve));
    const second = service.previewDeletion({ artifactIds: ['art-2'] });
    if (!second.ok) throw new Error('preview refused');
    const result = await service.executeDeletion({
      artifactIds: ['art-2'],
      previewId: second.value.previewId,
      confirmation: 'confirmed',
      authority: FULL
    });
    expect(result.ok ? null : result.refusal.code).toBe('sweep-in-progress');
    expect(fx.fs.has(checkpointPath('art-2'))).toBe(true);
  });

  it('refuses reconciliation without trusted primary authority', async () => {
    const fx = lifecycleFixture();
    const result = await fx.build().reconcileDeletionOperation('op-1', { ...FULL, primary: false });
    expect(result.ok ? null : result.refusal.code).toBe('not-primary-window');
  });
});

describe('FR-R7-16 (16-01) atomic deletion accounting & zero-unlink repair', () => {
  it('rolls back target outcome atomically on availability-update fault and reconciles without a second unlink', async () => {
    const fx = lifecycleFixture();
    const setup = fx.build();
    seedCheckpoint(setup, fx.fs, 'art-1');
    seedCheckpoint(setup, fx.fs, 'art-2');

    let failAvailabilityOnce = true;
    const faultConn = new Proxy(fx.conn, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        if (property !== 'run') return (value as (...args: unknown[]) => unknown).bind(target);
        return (sql: string, ...params: unknown[]) => {
          if (failAvailabilityOnce && sql.includes('UPDATE artifact_lifecycle')) {
            failAvailabilityOnce = false;
            throw new Error('simulated crash between deletion_targets and artifact_lifecycle');
          }
          return (value as (...args: unknown[]) => unknown).apply(target, [sql, ...params]);
        };
      }
    });

    const failingService = fx.build({ conn: faultConn });
    const preview = failingService.previewDeletion({});
    if (!preview.ok) throw new Error('preview refused');

    await expect(
      failingService.executeDeletion({
        previewId: preview.value.previewId,
        confirmation: 'confirmed',
        authority: FULL
      })
    ).rejects.toThrow('simulated crash');

    // The file was unlinked once, while the rolled-back transaction kept target outcome 'executing'
    // and availability 'present' (zero split commit).
    expect(fx.fs.has(checkpointPath('art-1'))).toBe(false);
    expect(fx.fs.calls.filter(([op, target]) => op === 'unlink' && target === checkpointPath('art-1'))).toHaveLength(1);
    const operationId = fx.conn.scalar<string>(`SELECT operation_id FROM deletion_operations`) ?? '';
    expect(
      fx.conn.scalar<string>(`SELECT outcome FROM deletion_targets WHERE operation_id = ? AND target_ordinal = 0`, operationId)
    ).toBe('executing');
    expect(fx.conn.scalar<string>(`SELECT availability FROM artifact_lifecycle WHERE artifact_id = 'art-1'`)).toBe('present');

    // After restart past lease TTL, reconciliation settles art-1 via lstat -> already-absent with zero second unlink.
    const restarted = fx.build({ nowMs: NOW + LEASE_TTL_MARGIN_MS });
    const resumed = await restarted.reconcileDeletionOperation(operationId, FULL);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.state).toBe('completed');
    expect(outcomes(resumed.value)).toEqual({ 'art-1': 'already-absent', 'art-2': 'deleted' });
    expect(fx.fs.calls.filter(([op, target]) => op === 'unlink' && target === checkpointPath('art-1'))).toHaveLength(1);
    expect(fx.conn.scalar<string>(`SELECT availability FROM artifact_lifecycle WHERE artifact_id = 'art-1'`)).toBe('deleted');
    expect(fx.conn.scalar<string>(`SELECT availability FROM artifact_lifecycle WHERE artifact_id = 'art-2'`)).toBe('deleted');
  });

  it('repairs pre-existing present and missing split rows via reconcileDeletionOperation with zero filesystem calls', async () => {
    const fx = lifecycleFixture();
    const service = fx.build();
    seedCheckpoint(service, fx.fs, 'art-present');
    seedCheckpoint(service, fx.fs, 'art-missing');
    fx.fs.remove(checkpointPath('art-present'));
    fx.fs.remove(checkpointPath('art-missing'));

    // Seed a pre-existing completed deletion operation whose targets settled deleted/already-absent
    // while availability was left split at present / missing.
    fx.conn.run(`UPDATE artifact_lifecycle SET availability = 'missing' WHERE artifact_id = 'art-missing'`);
    fx.conn.run(
      `INSERT INTO deletion_operations
         (operation_id, workspace_id, preview_id, state, fence_token, planned_count, created_at_ms, updated_at_ms, finished_at_ms)
       VALUES ('op-split', 'workspace', 'prev-1', 'completed', 'fence-1', 2, ?, ?, ?)`,
      NOW,
      NOW,
      NOW
    );
    fx.conn.run(
      `INSERT INTO deletion_targets (operation_id, target_ordinal, artifact_id, target_key, outcome, reason_code, updated_at_ms)
       VALUES ('op-split', 0, 'art-present', '.schegent/checkpoints/run-1/art-present.patch', 'deleted', NULL, ?),
              ('op-split', 1, 'art-missing', '.schegent/checkpoints/run-1/art-missing.patch', 'already-absent', NULL, ?)`,
      NOW,
      NOW
    );
    fx.fs.calls.length = 0;

    const first = await service.reconcileDeletionOperation('op-split', FULL);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.state).toBe('completed');
    expect(outcomes(first.value)).toEqual({ 'art-present': 'deleted', 'art-missing': 'already-absent' });
    expect(fx.fs.calls).toEqual([]);
    const presentAfter = service.getArtifact('art-present');
    const missingAfter = service.getArtifact('art-missing');
    expect(presentAfter.ok && presentAfter.value.availability).toBe('deleted');
    expect(missingAfter.ok && missingAfter.value.availability).toBe('deleted');
    const revAfterFirst = presentAfter.ok ? presentAfter.value.lifecycleRevision : -1;

    // Repeatable: a second pass makes zero filesystem calls and does not bump revisions again.
    const second = await service.reconcileDeletionOperation('op-split', FULL);
    expect(second.ok).toBe(true);
    expect(fx.fs.calls).toEqual([]);
    const presentAgain = service.getArtifact('art-present');
    expect(presentAgain.ok && presentAgain.value.lifecycleRevision).toBe(revAfterFirst);
  });

  it('bounds repairDeletionAccounting to SWEEP_MAX_REMOVALS_PER_PASS and converges across repeated passes', () => {
    const fx = lifecycleFixture();
    const service = fx.build();
    const total = SWEEP_MAX_REMOVALS_PER_PASS + 5;
    fx.conn.run(
      `INSERT INTO deletion_operations
         (operation_id, workspace_id, preview_id, state, fence_token, planned_count, created_at_ms, updated_at_ms, finished_at_ms)
       VALUES ('op-bulk', 'workspace', 'prev-bulk', 'completed', 'fence-bulk', ?, ?, ?, ?)`,
      total,
      NOW,
      NOW,
      NOW
    );
    for (let i = 0; i < total; i += 1) {
      const id = `bulk-${String(i).padStart(3, '0')}`;
      seedCheckpoint(service, fx.fs, id);
      fx.conn.run(
        `INSERT INTO deletion_targets (operation_id, target_ordinal, artifact_id, target_key, outcome, reason_code, updated_at_ms)
         VALUES ('op-bulk', ?, ?, ?, 'deleted', NULL, ?)`,
        i,
        id,
        `.schegent/checkpoints/run-1/${id}.patch`,
        NOW
      );
    }
    fx.fs.calls.length = 0;

    const ctx: LifecycleContext = {
      deps: {
        conn: fx.conn,
        nowMs: () => NOW,
        fs: fx.fs,
        probe: {
          observe: () => Promise.resolve({ exists: false, sizeBytes: 0, producerIdentity: null, generation: null }),
          digestSha256: () => Promise.resolve(null)
        },
        audit: { recordLifecycleMutation: () => undefined },
        scanRoots: [CHECKPOINT_SCAN_ROOT],
        accessPolicy: DENY_ALL_ACCESS_POLICY,
        resolveOwner: () => 'live',
        workspaceRoot: WORKSPACE_ROOT
      },
      records: new ArtifactRecordStore(fx.conn, () => NOW),
      previews: new PreviewStore(fx.conn, () => NOW, () => 'p'),
      references: new ReferenceStore(fx.conn, () => NOW),
      newId: () => 'id'
    };

    expect(repairDeletionAccounting(ctx)).toEqual({ repaired: SWEEP_MAX_REMOVALS_PER_PASS, capped: true });
    expect(repairDeletionAccounting(ctx)).toEqual({ repaired: 5, capped: false });
    expect(repairDeletionAccounting(ctx)).toEqual({ repaired: 0, capped: false });
    expect(fx.fs.calls).toEqual([]);
  });
});

describe('FR-R7-16 (16-03) pinned path-based removal effect boundary', () => {
  it('executes standing, canonical parent containment, non-following lstat, lease fence, intent write, and canonical unlink in pinned order', async () => {
    const fx = lifecycleFixture();
    // Put an in-root parent symlink alias -> real directory so canonical resolution differs from the raw locator.
    const aliasDir = '/ws/.schegent/checkpoints/run-alias';
    const realDir = '/ws/.schegent/checkpoints/run-real';
    const canonicalFile = `${realDir}/art-order.patch`;
    fx.fs.file(canonicalFile, 40);
    fx.fs.symlink(aliasDir, realDir);

    const trace: string[] = [];
    const tracedConn = new Proxy(fx.conn, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        if (property === 'get') {
          return (sql: string, ...params: unknown[]) => {
            if (sql.includes('FROM sweep_leases WHERE workspace_id = ? AND operation_id = ?')) {
              trace.push('fence');
            }
            return (value as (...args: unknown[]) => unknown).apply(target, [sql, ...params]);
          };
        }
        if (property === 'run') {
          return (sql: string, ...params: unknown[]) => {
            if (sql.includes('UPDATE deletion_targets') && params.includes('executing')) {
              trace.push('intent');
            }
            return (value as (...args: unknown[]) => unknown).apply(target, [sql, ...params]);
          };
        }
        return (value as (...args: unknown[]) => unknown).bind(target);
      }
    });

    const service = fx.build({ conn: tracedConn });
    const reg = service.registerArtifact({
      artifactId: 'art-order',
      ownerRunId: 'run-alias',
      sensitivity: 'content',
      retentionClass: 'transcripts-diagnostics-checkpoints-audit-catalog',
      storeKind: 'checkpoint',
      immutability: 'immutable',
      digest: { algorithm: 'sha256', value: 'a'.repeat(64) },
      byteSize: 40,
      mediaType: 'application/octet-stream',
      displayName: 'checkpoint',
      producerIdentity: 'writer',
      locator: { storageTier: 'workspace_file', uriOrRelpath: '.schegent/checkpoints/run-alias/art-order.patch' }
    });
    expect(reg.ok).toBe(true);

    const preview = service.previewDeletion({ artifactIds: ['art-order'] });
    if (!preview.ok) throw new Error('preview refused');
    // Reset trace after preview and wrap fs calls to observe exact effect-boundary order.
    trace.length = 0;
    const origRealpath = fx.fs.realpath.bind(fx.fs);
    const origLstat = fx.fs.lstat.bind(fx.fs);
    const origUnlink = fx.fs.unlink.bind(fx.fs);
    fx.fs.realpath = async (p: string) => {
      trace.push(`realpath:${p}`);
      return origRealpath(p);
    };
    fx.fs.lstat = async (p: string) => {
      trace.push(`lstat:${p}`);
      return origLstat(p);
    };
    fx.fs.unlink = async (p: string) => {
      trace.push(`unlink:${p}`);
      return origUnlink(p);
    };

    const result = await service.executeDeletion({
      artifactIds: ['art-order'],
      previewId: preview.value.previewId,
      confirmation: 'confirmed',
      authority: FULL
    });
    expect(result.ok && result.value.state).toBe('completed');

    // Pin exact step order and canonical resolved path passed to lstat and unlink.
    const idxRealpathParent = trace.indexOf(`realpath:${aliasDir}`);
    const idxLstatCanonical = trace.indexOf(`lstat:${canonicalFile}`);
    const idxFence = trace.indexOf('fence');
    const idxIntent = trace.indexOf('intent');
    const idxUnlinkCanonical = trace.indexOf(`unlink:${canonicalFile}`);
    expect(idxRealpathParent).toBeGreaterThanOrEqual(0);
    expect(idxLstatCanonical).toBeGreaterThan(idxRealpathParent);
    expect(idxFence).toBeGreaterThan(idxLstatCanonical);
    expect(idxIntent).toBeGreaterThan(idxFence);
    expect(idxUnlinkCanonical).toBeGreaterThan(idxIntent);
    expect(fx.fs.unlinked).toEqual([canonicalFile]);
  });

  it('refuses a target whose parent directory became an escaping symlink before effect, with zero unlinks', async () => {
    const fx = lifecycleFixture();
    const service = fx.build();
    seedCheckpoint(service, fx.fs, 'art-escape');
    // Replace parent directory with a symlink resolving outside declared roots.
    fx.fs.symlink('/ws/.schegent/checkpoints/run-1', '/outside/run-1');

    const operation = await execute(service, { artifactIds: ['art-escape'] });
    expect(operation.state).toBe('refused');
    expect(outcomes(operation)).toEqual({ 'art-escape': 'refused' });
    expect(operation.targets.at(0)?.reasonCode).toBe('containment-violation');
    expect(fx.fs.unlinked).toEqual([]);
  });

  it('refuses non-regular leaves (directory and special file) with containment-violation and zero unlinks', async () => {
    const fx = lifecycleFixture();
    const service = fx.build();
    seedCheckpoint(service, fx.fs, 'art-dir');
    seedCheckpoint(service, fx.fs, 'art-special');

    // Swap planned regular files to a directory and a special ('other') file before effect.
    fx.fs.remove(checkpointPath('art-dir'));
    fx.fs.dir(checkpointPath('art-dir'));
    fx.fs.other(checkpointPath('art-special'));

    const operation = await execute(service, { artifactIds: ['art-dir', 'art-special'] });
    expect(operation.state).toBe('refused');
    expect(outcomes(operation)).toEqual({ 'art-dir': 'refused', 'art-special': 'refused' });
    expect(operation.targets.every((target) => target.reasonCode === 'containment-violation')).toBe(true);
    expect(fx.fs.unlinked).toEqual([]);
  });
});

describe('SR-304-1 / SR-304-2 resolved-path sharer protection and live pinned-run checks', () => {
  type StandingMode = 'protected-ref' | 'pinned-run' | 'audit' | 'live-writer';

  const STANDING_CASES: readonly (readonly [StandingMode, DeletionTargetOutcomeKind, string])[] = [
    ['protected-ref', 'refused', 'protected-reference'],
    ['pinned-run', 'refused', 'protected-reference'],
    ['audit', 'refused', 'never-eligible'],
    ['live-writer', 'retained', 'live-writer']
  ];

  function registerStandingArtifact(
    service: ArtifactLifecycleService,
    artifactId: string,
    ownerRunId: string,
    relpath: string,
    mode: StandingMode
  ): void {
    const input =
      mode === 'live-writer'
        ? {
            ...checkpointArtifact(artifactId, {
              ownerRunId,
              storeKind: 'live-log-segment',
              immutability: 'growing',
              generation: 1,
              extentBytes: 40,
              locator: { storageTier: 'workspace_file', uriOrRelpath: relpath }
            }),
            digest: undefined
          }
        : checkpointArtifact(artifactId, {
            ownerRunId,
            storeKind: mode === 'audit' ? 'audit' : 'checkpoint',
            locator: { storageTier: 'workspace_file', uriOrRelpath: relpath }
          });
    const reg = service.registerArtifact(input);
    expect(reg.ok).toBe(true);
    if (mode === 'protected-ref') {
      service.addReference({
        artifactId,
        ownerType: 'run',
        ownerId: ownerRunId,
        purpose: 'paused-recovery',
        protective: true
      });
    }
  }

  it.each(STANDING_CASES)(
    'refuses deleting an alias target whose in-root parent symlink resolves to a %s canonical sharer',
    async (mode, expectedOutcome, expectedReason) => {
      const fx = lifecycleFixture();
      const realDir = '/ws/.schegent/checkpoints/run-real';
      const aliasDir = '/ws/.schegent/checkpoints/run-alias';
      const canonicalFile = `${realDir}/shared.patch`;
      fx.fs.file(canonicalFile, 40);
      fx.fs.symlink(aliasDir, realDir);

      const service = fx.build({
        pinnedRunIds: mode === 'pinned-run' ? new Set(['run-real']) : new Set<string>()
      });
      registerStandingArtifact(service, 'art-real', 'run-real', '.schegent/checkpoints/run-real/shared.patch', mode);
      const aliasReg = service.registerArtifact(
        checkpointArtifact('art-alias', {
          ownerRunId: 'run-alias',
          locator: { storageTier: 'workspace_file', uriOrRelpath: '.schegent/checkpoints/run-alias/shared.patch' }
        })
      );
      expect(aliasReg.ok).toBe(true);

      const operation = await execute(service, { artifactIds: ['art-alias'] });
      expect(outcomes(operation)).toEqual({ 'art-alias': expectedOutcome });
      expect(operation.targets.at(0)?.reasonCode).toBe(expectedReason);
      expect(fx.fs.unlinked).toEqual([]);
      expect(fx.fs.has(canonicalFile)).toBe(true);
    }
  );

  it.each(STANDING_CASES)(
    'refuses deleting a canonical target shared with a %s artifact registered via an in-root parent symlink',
    async (mode, expectedOutcome, expectedReason) => {
      const fx = lifecycleFixture();
      const realDir = '/ws/.schegent/checkpoints/run-real';
      const aliasDir = '/ws/.schegent/checkpoints/run-alias';
      const canonicalFile = `${realDir}/shared.patch`;
      fx.fs.file(canonicalFile, 40);
      fx.fs.symlink(aliasDir, realDir);

      const service = fx.build({
        pinnedRunIds: mode === 'pinned-run' ? new Set(['run-alias']) : new Set<string>()
      });
      registerStandingArtifact(service, 'art-alias', 'run-alias', '.schegent/checkpoints/run-alias/shared.patch', mode);
      const realReg = service.registerArtifact(
        checkpointArtifact('art-real', {
          ownerRunId: 'run-real',
          locator: { storageTier: 'workspace_file', uriOrRelpath: '.schegent/checkpoints/run-real/shared.patch' }
        })
      );
      expect(realReg.ok).toBe(true);

      const operation = await execute(service, { artifactIds: ['art-real'] });
      expect(outcomes(operation)).toEqual({ 'art-real': expectedOutcome });
      expect(operation.targets.at(0)?.reasonCode).toBe(expectedReason);
      expect(fx.fs.unlinked).toEqual([]);
      expect(fx.fs.has(canonicalFile)).toBe(true);
    }
  );

  it('fails closed when resolving a same-basename in-workspace protected candidate fails with an I/O error', async () => {
    const fx = lifecycleFixture();
    const realFile = '/ws/.schegent/checkpoints/run-real/shared.patch';
    const unreadableDir = '/ws/.schegent/checkpoints/run-unreadable';
    fx.fs.file(realFile, 40);
    fx.fs.dir(unreadableDir);
    const origRealpath = fx.fs.realpath.bind(fx.fs);
    fx.fs.realpath = async (targetPath: string) => {
      if (targetPath === unreadableDir) throw fsError('EACCES');
      return origRealpath(targetPath);
    };

    const service = fx.build();
    const targetReg = service.registerArtifact(
      checkpointArtifact('art-real', {
        ownerRunId: 'run-real',
        locator: { storageTier: 'workspace_file', uriOrRelpath: '.schegent/checkpoints/run-real/shared.patch' }
      })
    );
    expect(targetReg.ok).toBe(true);
    registerStandingArtifact(
      service,
      'art-protected',
      'run-unreadable',
      '.schegent/checkpoints/run-unreadable/shared.patch',
      'protected-ref'
    );

    const operation = await execute(service, { artifactIds: ['art-real'] });
    expect(outcomes(operation)).toEqual({ 'art-real': 'refused' });
    expect(operation.targets.at(0)?.reasonCode).toBe('protected-reference');
    expect(fx.fs.unlinked).toEqual([]);
    expect(fx.fs.has(realFile)).toBe(true);
  });

  it('ignores malformed outside-workspace rows sharing a basename without probing outside the workspace', async () => {
    const fx = lifecycleFixture();
    const service = fx.build();
    const realFile = '/ws/.schegent/checkpoints/run-real/shared.patch';
    fx.fs.file(realFile, 40);
    const targetReg = service.registerArtifact(
      checkpointArtifact('art-real', {
        ownerRunId: 'run-real',
        locator: { storageTier: 'workspace_file', uriOrRelpath: '.schegent/checkpoints/run-real/shared.patch' }
      })
    );
    expect(targetReg.ok).toBe(true);
    seedCheckpoint(service, fx.fs, 'art-malformed', { ownerRunId: 'run-other' });
    fx.conn.run(`UPDATE artifact_locations SET uri_or_relpath = '../outside/shared.patch' WHERE artifact_id = 'art-malformed'`);
    service.addReference({
      artifactId: 'art-malformed',
      ownerType: 'run',
      ownerId: 'run-other',
      purpose: 'paused-recovery',
      protective: true
    });

    const operation = await execute(service, { artifactIds: ['art-real'] });
    expect(outcomes(operation)).toEqual({ 'art-real': 'deleted' });
    expect(fx.fs.has(realFile)).toBe(false);
    expect(fx.fs.touched('/outside')).toBe(false);
    expect(fx.fs.touched('/outside/shared.patch')).toBe(false);
  });

  it('observes a run pinned mid-pass across targets and refuses deleting the newly pinned target (SR-304-2)', async () => {
    const fx = lifecycleFixture();
    const livePinned = new Set<string>();
    const service = fx.build({ pinnedRunIds: () => new Set(livePinned) });
    seedCheckpoint(service, fx.fs, 'art-1', { ownerRunId: 'run-1' });
    seedCheckpoint(service, fx.fs, 'art-2', { ownerRunId: 'run-2' });

    fx.fs.unlinkHooks.set(checkpointPath('art-1', 'run-1'), () => {
      livePinned.add('run-2');
    });

    const operation = await execute(service, { artifactIds: ['art-1', 'art-2'] });
    expect(operation.state).toBe('partial');
    expect(outcomes(operation)).toEqual({ 'art-1': 'deleted', 'art-2': 'refused' });
    expect(operation.targets.find((target) => target.artifactId === 'art-2')?.reasonCode).toBe('protected-reference');
    expect(fx.fs.has(checkpointPath('art-1', 'run-1'))).toBe(false);
    expect(fx.fs.has(checkpointPath('art-2', 'run-2'))).toBe(true);
    expect(fx.fs.unlinked).toEqual([checkpointPath('art-1', 'run-1')]);
  });

  it('observes a run pinned during async target boundary probes before unlinking (SR-304-2)', async () => {
    const fx = lifecycleFixture();
    const livePinned = new Set<string>();
    const service = fx.build({ pinnedRunIds: () => new Set(livePinned) });
    seedCheckpoint(service, fx.fs, 'art-1', { ownerRunId: 'run-1' });

    const targetPath = checkpointPath('art-1', 'run-1');
    const origLstat = fx.fs.lstat.bind(fx.fs);
    fx.fs.lstat = async (p: string) => {
      const result = await origLstat(p);
      if (p === targetPath) livePinned.add('run-1');
      return result;
    };

    const operation = await execute(service, { artifactIds: ['art-1'] });
    expect(operation.state).toBe('refused');
    expect(outcomes(operation)).toEqual({ 'art-1': 'refused' });
    expect(operation.targets.at(0)?.reasonCode).toBe('protected-reference');
    expect(fx.fs.has(targetPath)).toBe(true);
    expect(fx.fs.unlinked).toEqual([]);
  });
});
