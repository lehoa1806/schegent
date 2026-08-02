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

// Feature 068 — INV-4..INV-9: additive extraction of taskId / phaseId /
// outcome. Audit v3 keeps command detail out of the projection.
// (SC-004 / FR-017).
describe('projectAuditEntry (Feature 068 additive fields)', () => {
  it('projects runner from phase-start payload for Activity Feed attribution', () => {
    const projected = projectAuditEntry(
      entry({ eventType: 'phase-start', payload: { phaseId: 'plan', runner: 'agy' } })
    );
    expect(projected.runner).toBe('agy');
  });

  it('does not project runner from unrelated event types', () => {
    const projected = projectAuditEntry(
      entry({ eventType: 'phase-end', payload: { phaseId: 'plan', runner: 'agy' } })
    );
    expect(projected.runner).toBeUndefined();
  });

  it('extracts taskId from payload.taskId (highest priority)', () => {
    const projected = projectAuditEntry(
      entry({ payload: { taskId: 't-1', taskID: 't-legacy', queueItemId: 'q-1' } })
    );
    expect(projected.taskId).toBe('t-1');
  });

  it('falls back to payload.taskID when payload.taskId is missing', () => {
    const projected = projectAuditEntry(
      entry({ payload: { taskID: 't-legacy', queueItemId: 'q-1' } })
    );
    expect(projected.taskId).toBe('t-legacy');
  });

  it('falls back to payload.queueItemId when payload.taskId/taskID are missing', () => {
    const projected = projectAuditEntry(entry({ payload: { queueItemId: 'q-1' } }));
    expect(projected.taskId).toBe('q-1');
  });

  it('leaves taskId undefined when no payload source is populated', () => {
    const projected = projectAuditEntry(entry({ payload: { summary: 'x' } }));
    expect(projected.taskId).toBeUndefined();
  });

  it('extracts phaseId from payload.phaseId (highest priority)', () => {
    const projected = projectAuditEntry(
      entry({ payload: { phaseId: 'plan', phase: 'tasks' } })
    );
    expect(projected.phaseId).toBe('plan');
  });

  it('falls back to payload.phase when payload.phaseId is absent', () => {
    const projected = projectAuditEntry(
      entry({ payload: { phase: 'tasks' } })
    );
    expect(projected.phaseId).toBe('tasks');
  });

  it('falls back to envelope phase when payload has neither phaseId nor phase', () => {
    const projected = projectAuditEntry(
      entry({ phase: 'speckit-plan', payload: { summary: 'x' } })
    );
    expect(projected.phaseId).toBe('speckit-plan');
  });

  it("leaves phaseId undefined when envelope phase is 'done' and payload has no phase fields", () => {
    const projected = projectAuditEntry(
      entry({ phase: 'done', payload: { summary: 'x' } })
    );
    expect(projected.phaseId).toBeUndefined();
  });

  it("normalizes outcome 'success' to 'success'", () => {
    const projected = projectAuditEntry(entry({ outcome: 'success' }));
    expect(projected.outcome).toBe('success');
  });

  it("normalizes outcome 'failure' to 'error'", () => {
    const projected = projectAuditEntry(entry({ outcome: 'failure' }));
    expect(projected.outcome).toBe('error');
  });

  it("leaves outcome undefined when envelope outcome is 'info'", () => {
    const projected = projectAuditEntry(entry({ outcome: 'info' }));
    expect(projected.outcome).toBeUndefined();
  });

  it("uses host-generated metadata for cli-invocation summaries", () => {
    const projected = projectAuditEntry(
      entry({
        eventType: 'cli-invocation',
        payload: { runner: 'claude', operation: 'phase', permissionMode: 'unrestricted' }
      })
    );
    expect(projected.summary).toContain('claude phase');
    expect(projected.summary).not.toContain('--');
  });

  it('returns a frozen object after additive fields land', () => {
    const projected = projectAuditEntry(
      entry({
        eventType: 'cli-invocation',
        payload: { taskId: 't-1', phaseId: 'plan', runner: 'claude', operation: 'phase' },
        outcome: 'success'
      })
    );
    expect(Object.isFrozen(projected)).toBe(true);
    expect(projected.taskId).toBe('t-1');
    expect(projected.phaseId).toBe('plan');
    expect(projected.outcome).toBe('success');
    expect(projected.summary).toContain('claude phase');
  });
});
