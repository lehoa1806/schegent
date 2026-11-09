// FR-R6-F05 (T025; AC-08, FR-020) — storage pressure.
//
// Over the target with only protected content, the report shows the pressure
// and the protected bytes, nothing is reclaimable, and no deletion target is
// planned: recovery dependencies are never evicted. Admission falls to the
// shared F02 pin-quota check and F03 backpressure.

import { describe, expect, it } from 'vitest';
import type { StoragePressureReport } from '../../../src/contracts/artifact-lifecycle/lifecycle-types';
import type { ArtifactLifecycleService } from '../../../src/services/artifact-lifecycle';
import { CHECKPOINT_CLASS, lifecycleFixture, seedCheckpoint } from './lifecycle-fixture';

function report(service: ArtifactLifecycleService): StoragePressureReport {
  const result = service.getPressureReport();
  if (!result.ok) throw new Error(`pressure refused: ${result.refusal.code}`);
  return result.value;
}

describe('FR-R6-F05 storage pressure (FR-020)', () => {
  it('reports pressure with only protected content, plans no target, and defers to shared admission', () => {
    const fx = lifecycleFixture();
    const service = fx.build({ storageTargetBytes: 50, pinnedRunIds: new Set(['run-2']) });
    seedCheckpoint(service, fx.fs, 'art-held');
    seedCheckpoint(service, fx.fs, 'art-run', { ownerRunId: 'run-2' });
    service.addReference({ artifactId: 'art-held', ownerType: 'run', ownerId: 'run-1', purpose: 'active-recovery', protective: true });

    const value = report(service);
    expect(value.totalBytes).toBe(80);
    expect(value.overTarget).toBe(true);
    expect(value.targetBytes).toBe(50);
    expect(value.perClass).toEqual([
      { retentionClass: CHECKPOINT_CLASS, totalBytes: 80, reclaimableBytes: 0, protectedBytes: 80 }
    ]);
    expect(value.admission.behavior).toBe('shared-admission');
    expect(value.admission.evictsRecoveryDependencies).toBe(false);
    expect(value.admission.settlementReservePreserved).toBe(true);
    expect(value.admission.sharedAdmission).toContain('checkPinQuotaAdmission');
    expect(value.admission.sharedAdmission).toContain('backpressure');

    const preview = service.previewDeletion({});
    if (!preview.ok) throw new Error('preview refused');
    expect(preview.value.summary.affectedCount).toBe(0);
    expect(preview.value.summary.protectedCount).toBe(2);
    expect(preview.value.summary.protectedBytes).toBe(80);
    expect(fx.fs.unlinked).toEqual([]);
  });

  it('reclaims eligible content only when some is reclaimable', () => {
    const fx = lifecycleFixture();
    const service = fx.build({ storageTargetBytes: 50 });
    seedCheckpoint(service, fx.fs, 'art-free');
    seedCheckpoint(service, fx.fs, 'art-held');
    service.addReference({ artifactId: 'art-held', ownerType: 'run', ownerId: 'run-1', purpose: 'paused-recovery', protective: true });
    const value = report(service);
    expect(value.admission.behavior).toBe('reclaim-eligible-only');
    expect(value.perClass.at(0)).toMatchObject({ reclaimableBytes: 40, protectedBytes: 40 });
  });

  it('admits under the target and reports no target when none is configured', () => {
    const fx = lifecycleFixture();
    const under = fx.build({ storageTargetBytes: 1_000 });
    seedCheckpoint(under, fx.fs, 'art-free');
    expect(report(under)).toMatchObject({ overTarget: false, admission: { behavior: 'admit' } });
    expect(report(fx.build())).toMatchObject({ targetBytes: null, overTarget: false });
  });
});
