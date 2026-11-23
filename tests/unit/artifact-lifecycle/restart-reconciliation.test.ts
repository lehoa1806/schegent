// FR-R6-F05 (FR-010, FR-014; contract lifecycle-service.md, mutating operations) —
// `reconcileAfterRestart`, which the host calls at activation before any sweep. It resumes every
// unfinished deletion under its own id and settles every in-flight or ambiguous preservation.

import { describe, expect, it } from 'vitest';
import { classifyExternalArtifactDependencies } from '../../../src/services/sqlite-store';
import { checkpointPath, FULL, lifecycleFixture, NOW, seedCheckpoint, type LifecycleFixture } from './lifecycle-fixture';

const LEASE_TTL_MARGIN_MS = 10 * 60 * 1000;

/** Starts a deletion of `art-1` and `art-2` whose first unlink never settles; returns its id. */
async function interruptedDeletion(fx: LifecycleFixture): Promise<string> {
  const before = fx.build();
  seedCheckpoint(before, fx.fs, 'art-1');
  seedCheckpoint(before, fx.fs, 'art-2');
  let hung = true;
  fx.fs.unlinkHooks.set(checkpointPath('art-1'), () => (hung ? new Promise<void>(() => undefined) : undefined));
  const preview = before.previewDeletion({});
  if (!preview.ok) throw new Error('preview refused');
  void before.executeDeletion({ previewId: preview.value.previewId, confirmation: 'confirmed', authority: FULL });
  await new Promise((resolve) => setImmediate(resolve));
  hung = false;
  return fx.conn.scalar<string>(`SELECT operation_id FROM deletion_operations`) ?? '';
}

function seedInFlightPreservation(fx: LifecycleFixture, operationId: string): void {
  fx.conn.run(
    `INSERT INTO preservation_operations (operation_id, workspace_id, preview_id, state, created_at_ms, updated_at_ms)
     VALUES (?, 'workspace', 'preview-x', 'copying', ?, ?)`,
    operationId,
    NOW,
    NOW
  );
  fx.conn.run(
    `INSERT INTO preservation_targets (operation_id, target_ordinal, source_key, outcome, updated_at_ms)
     VALUES (?, 0, 'phases/alpha/v2.json', 'preserved-in-place', ?)`,
    operationId,
    NOW
  );
}

describe('reconcileAfterRestart', () => {
  it('refuses an untrusted caller before touching any operation', async () => {
    const fx = lifecycleFixture();
    const operationId = await interruptedDeletion(fx);
    const result = await fx.build({ nowMs: NOW + LEASE_TTL_MARGIN_MS }).reconcileAfterRestart({ ...FULL, trusted: false });
    expect(result.ok ? undefined : result.refusal.code).toBe('untrusted-workspace');
    expect(fx.conn.scalar<string>(`SELECT state FROM deletion_operations WHERE operation_id = ?`, operationId)).toBe(
      'executing'
    );
  });

  it('reports nothing when no operation is unfinished', async () => {
    const result = await lifecycleFixture().build().reconcileAfterRestart(FULL);
    expect(result).toEqual({ ok: true, value: { resumedOperations: [], ambiguous: 0, diagnostics: [] } });
  });

  it('resumes an interrupted deletion under its own id once the lease has expired', async () => {
    const fx = lifecycleFixture();
    const operationId = await interruptedDeletion(fx);

    const result = await fx.build({ nowMs: NOW + LEASE_TTL_MARGIN_MS }).reconcileAfterRestart(FULL);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resumedOperations).toEqual([operationId]);
    expect(result.value.ambiguous).toBe(0);
    expect(result.value.diagnostics).toEqual([
      { code: 'reconciled-operation', artifactId: null, detail: 'deletion operation resumed: completed' }
    ]);
    expect(fx.conn.scalar<string>(`SELECT state FROM deletion_operations WHERE operation_id = ?`, operationId)).toBe(
      'completed'
    );
  });

  it('leaves a deletion whose lease is still held to its holder', async () => {
    const fx = lifecycleFixture();
    const operationId = await interruptedDeletion(fx);

    const result = await fx.build().reconcileAfterRestart(FULL);

    expect(result.ok && result.value.resumedOperations).toEqual([]);
    expect(result.ok && result.value.diagnostics).toEqual([
      { code: 'reconciled-operation', artifactId: null, detail: 'deletion operation deferred: sweep-in-progress' }
    ]);
    expect(fx.conn.scalar<string>(`SELECT state FROM deletion_operations WHERE operation_id = ?`, operationId)).toBe(
      'executing'
    );
  });

  it('counts an in-flight preservation as ambiguous, and changes nothing, when no legacy catalog is configured', async () => {
    const fx = lifecycleFixture();
    seedInFlightPreservation(fx, 'pres-1');

    const result = await fx.build().reconcileAfterRestart(FULL);

    expect(result).toEqual({
      ok: true,
      value: {
        resumedOperations: [],
        ambiguous: 1,
        diagnostics: [
          { code: 'ambiguous-preservation', artifactId: null, detail: 'preservation operation unreconciled: unavailable' }
        ]
      }
    });
    expect(fx.conn.scalar<string>(`SELECT state FROM preservation_operations WHERE operation_id = 'pres-1'`)).toBe(
      'copying'
    );
  });

  it('FR-R7-16 (16-01): repairs pre-existing present and missing deletion splits with zero unlinks and restores backup tombstone classification', async () => {
    const fx = lifecycleFixture();
    const service = fx.build();
    seedCheckpoint(service, fx.fs, 'split-present');
    seedCheckpoint(service, fx.fs, 'split-missing');
    fx.fs.remove(checkpointPath('split-present'));
    fx.fs.remove(checkpointPath('split-missing'));
    fx.conn.run(`UPDATE artifact_lifecycle SET availability = 'missing' WHERE artifact_id = 'split-missing'`);
    fx.conn.run(
      `INSERT INTO deletion_operations
         (operation_id, workspace_id, preview_id, state, fence_token, planned_count, created_at_ms, updated_at_ms, finished_at_ms)
       VALUES ('op-pre-split', 'workspace', 'prev-split', 'completed', 'fence-split', 2, ?, ?, ?)`,
      NOW,
      NOW,
      NOW
    );
    fx.conn.run(
      `INSERT INTO deletion_targets (operation_id, target_ordinal, artifact_id, target_key, outcome, reason_code, updated_at_ms)
       VALUES ('op-pre-split', 0, 'split-present', '.schegent/checkpoints/run-1/split-present.patch', 'deleted', NULL, ?),
              ('op-pre-split', 1, 'split-missing', '.schegent/checkpoints/run-1/split-missing.patch', 'already-absent', NULL, ?)`,
      NOW,
      NOW
    );
    fx.fs.calls.length = 0;

    // Before repair, FR-R7-14 backup classification sees both split rows as required-live.
    const beforeDeps = classifyExternalArtifactDependencies(fx.conn);
    expect(beforeDeps.map((dep) => [dep.artifactId, dep.disposition])).toEqual([
      ['split-missing', 'required-live'],
      ['split-present', 'required-live']
    ]);

    const first = await service.reconcileAfterRestart(FULL);
    expect(first).toEqual({
      ok: true,
      value: {
        resumedOperations: [],
        ambiguous: 0,
        diagnostics: [{ code: 'reconciled-operation', artifactId: null, detail: 'deletion accounting repaired: 2' }]
      }
    });
    expect(fx.fs.calls).toEqual([]);
    expect(fx.conn.scalar<string>(`SELECT availability FROM artifact_lifecycle WHERE artifact_id = 'split-present'`)).toBe('deleted');
    expect(fx.conn.scalar<string>(`SELECT availability FROM artifact_lifecycle WHERE artifact_id = 'split-missing'`)).toBe('deleted');
    expect(
      fx.conn.all<{ artifact_id: string; outcome: string }>(
        `SELECT artifact_id, outcome FROM deletion_targets WHERE operation_id = 'op-pre-split' ORDER BY target_ordinal`
      )
    ).toEqual([
      { artifact_id: 'split-present', outcome: 'deleted' },
      { artifact_id: 'split-missing', outcome: 'already-absent' }
    ]);

    // After repair, FR-R7-14 backup classification treats both as tombstoned-deleted.
    const afterDeps = classifyExternalArtifactDependencies(fx.conn);
    expect(afterDeps.map((dep) => [dep.artifactId, dep.disposition])).toEqual([
      ['split-missing', 'tombstoned-deleted'],
      ['split-present', 'tombstoned-deleted']
    ]);

    // Repeating reconcileAfterRestart is a clean zero-FS no-op.
    const second = await service.reconcileAfterRestart(FULL);
    expect(second).toEqual({ ok: true, value: { resumedOperations: [], ambiguous: 0, diagnostics: [] } });
    expect(fx.fs.calls).toEqual([]);
  });
});
