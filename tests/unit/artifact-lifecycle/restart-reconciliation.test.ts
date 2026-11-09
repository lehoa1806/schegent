// FR-R6-F05 (FR-010, FR-014; contract lifecycle-service.md, mutating operations) —
// `reconcileAfterRestart`, which the host calls at activation before any sweep. It resumes every
// unfinished deletion under its own id and settles every in-flight or ambiguous preservation.

import { describe, expect, it } from 'vitest';
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
});
