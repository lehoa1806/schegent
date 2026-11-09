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
import type { ArtifactLifecycleService, DeletionSelection } from '../../../src/services/artifact-lifecycle';
import type { NodeSqliteConnection } from '../../../src/services/sqlite-store';
import {
  checkpointPath,
  FULL,
  fsError,
  lifecycleFixture,
  NOW,
  seedCheckpoint
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
