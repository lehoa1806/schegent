import { describe, it, expect } from 'vitest';
import { RESERVED_METRIC_KEYS } from '../../../src/audit/audit-entry';
import type { AuditEntry } from '../../../src/audit/audit-entry';

// Feature 010 — co-maintenance test for RESERVED_METRIC_KEYS subset (a).
// If you add a new top-level field to `AuditEntry`, you MUST add it to
// RESERVED_METRIC_KEYS in src/audit/audit-entry.ts; this test will fail
// otherwise. Subset (b) (well-known payload names) is best-effort and is
// not asserted here.
describe('RESERVED_METRIC_KEYS (010 co-maintenance)', () => {
  it('includes every top-level envelope field of AuditEntry', () => {
    const reference: AuditEntry = {
      id: '',
      timestamp: '',
      runId: '',
      phase: 'speckit-specify',
      iteration: 0,
      eventType: 'phase-start',
      payload: {},
      outcome: 'info',
      schemaVersion: 0,
      correlationId: ''
    };
    for (const key of Object.keys(reference)) {
      expect(
        RESERVED_METRIC_KEYS.has(key),
        `RESERVED_METRIC_KEYS missing envelope field '${key}' — ` +
          'update src/audit/audit-entry.ts when adding new AuditEntry fields.'
      ).toBe(true);
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(RESERVED_METRIC_KEYS)).toBe(true);
  });
});
