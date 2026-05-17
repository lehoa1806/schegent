// Feature 033 T004 — snapshot-shape regression for the telemetry field.
//
// Asserts that the idle snapshot carries `telemetry: null` and that the
// `WorkflowSnapshot` type compile-checks against
// `{ telemetry: TelemetrySnapshot | null }`. T005 lands the field on the
// shape; this test goes red until then.

import { describe, expect, it } from 'vitest';
import { buildIdleSnapshot, type WorkflowSnapshot } from '../../../../src/ui/sidebar/snapshot';
import type { TelemetrySnapshot } from '../../../../src/telemetry/telemetry-snapshot';

describe('Feature 033 — WorkflowSnapshot.telemetry shape', () => {
  it('idle snapshot exposes telemetry: null', () => {
    const snap = buildIdleSnapshot({ isPrimary: true });
    expect(snap.telemetry).toBeNull();
  });

  it('idle snapshot is frozen with telemetry as an own property', () => {
    const snap = buildIdleSnapshot({ isPrimary: true });
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(snap, 'telemetry')).toBe(true);
  });

  it('type-checks WorkflowSnapshot.telemetry against TelemetrySnapshot | null', () => {
    const snap: WorkflowSnapshot = buildIdleSnapshot({ isPrimary: true });
    const t: TelemetrySnapshot | null = snap.telemetry;
    expect(t).toBeNull();
  });
});
