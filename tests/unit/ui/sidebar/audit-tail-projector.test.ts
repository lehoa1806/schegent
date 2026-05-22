// Feature 064 — T008 — pins the additive contract for
// `projectAuditEntry()`: every projected `AuditTailEntry` carries
// `runId` (byte-for-byte from `AuditEntry.runId`) and `scope`
// (`classifyAuditEvent(eventType)`). Pre-existing projected fields
// are unchanged, the returned object is frozen, and the
// `AUDIT_TAIL_MAX` ring-buffer cap remains 50 (FR-012).
//
// Addresses C2: a `queue-cleared-all` projected entry carries a
// non-empty `runId` and is classified `'system'` (FR-004 + FR-015 at
// the projection boundary).

import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '../../../../src/audit/audit-entry';
import { projectAuditEntry } from '../../../../src/ui/sidebar/audit-tail-projector';
import { AUDIT_TAIL_MAX } from '../../../../src/ui/sidebar/snapshot';

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 'entry-1',
    timestamp: '2026-05-22T12:00:00.000Z',
    runId: 'run-abc',
    phase: 'speckit-plan',
    iteration: 1,
    eventType: 'phase-start',
    payload: { summary: 'starting plan' },
    outcome: 'info',
    ...overrides
  };
}

describe('projectAuditEntry (Feature 064 T008)', () => {
  it('copies runId byte-for-byte from AuditEntry.runId', () => {
    const e = entry({ runId: '01HABCD-EXAMPLE-RUN-1234' });
    const projected = projectAuditEntry(e);
    expect(projected.runId).toBe('01HABCD-EXAMPLE-RUN-1234');
  });

  it("scope equals classifyAuditEvent(entry.eventType) for task events", () => {
    const projected = projectAuditEntry(entry({ eventType: 'phase-start' }));
    expect(projected.scope).toBe('task');
  });

  it('scope equals "system" for system-classified events', () => {
    const projected = projectAuditEntry(entry({ eventType: 'queue-renamed' }));
    expect(projected.scope).toBe('system');
  });

  it('returns a frozen object', () => {
    const projected = projectAuditEntry(entry());
    expect(Object.isFrozen(projected)).toBe(true);
  });

  it('preserves the existing projected fields (id, timestamp, phase, category, summary)', () => {
    const e = entry({
      id: 'entry-7',
      timestamp: '2026-05-22T12:34:56.000Z',
      phase: 'speckit-tasks',
      iteration: 2,
      eventType: 'phase-end',
      payload: { summary: 'done' }
    });
    const projected = projectAuditEntry(e);
    expect(projected.id).toBe('entry-7');
    expect(projected.timestamp).toBe('2026-05-22T12:34:56.000Z');
    expect(projected.phase).toBe('speckit-tasks');
    expect(projected.category).toBe('phase-transition');
    expect(projected.summary).toContain('phase-end speckit-tasks#2');
  });

  it("AUDIT_TAIL_MAX remains 50 and is not changed by Feature 064 (FR-012)", () => {
    expect(AUDIT_TAIL_MAX).toBe(50);
  });

  it("queue-cleared-all projects with non-empty runId and scope === 'system' (FR-004 + FR-015, C2)", () => {
    const e = entry({
      runId: 'run-clean-all-1',
      eventType: 'queue-cleared-all',
      phase: 'done',
      payload: {
        summary: 'queue cleared',
        removedPending: 3,
        removedInFlight: 1,
        pauseStateCleared: true,
        runnerState: 'acked',
        watchdogBackoffCleared: false
      }
    });
    const projected = projectAuditEntry(e);
    expect(projected.runId).toBe('run-clean-all-1');
    expect(projected.runId.length).toBeGreaterThan(0);
    expect(projected.scope).toBe('system');
  });

  it("warning lifecycle event projects as task scope (LIFECYCLE_EVENT_TYPES partial)", () => {
    const projected = projectAuditEntry(entry({ eventType: 'warning' }));
    expect(projected.scope).toBe('task');
  });

  it("pause lifecycle event projects as system scope (LIFECYCLE_EVENT_TYPES partial)", () => {
    const projected = projectAuditEntry(entry({ eventType: 'pause' }));
    expect(projected.scope).toBe('system');
  });
});
