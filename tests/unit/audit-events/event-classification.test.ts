// Feature 064 — T007 — exhaustive classifier test. Pins the
// `classifyAuditEvent` mapping for every literal in
// `ALL_AUDIT_EVENT_TYPES`, and uses a TS `never` exhaustiveness
// assertion so that adding a new audit-event literal without
// classifying it fails `tsc` (satisfies FR-014 and SC-006).
//
// The classification table mirrors
// specs/064-system-tab-audit-split/contracts/audit-event-classification.md.
// If that contract changes, this test MUST be updated in the same
// change.

import { describe, expect, it } from 'vitest';
import {
  ALL_AUDIT_EVENT_TYPES,
  SYSTEM_SCOPED_EVENT_TYPES,
  classifyAuditEvent,
  type AuditEventType,
  type AuditScope
} from '../../../src/contracts/audit-events';

const EXPECTED_SCOPE: Readonly<Record<AuditEventType, AuditScope>> = {
  // Phase lifecycle (task)
  'phase-start': 'task',
  'phase-end': 'task',
  // Runner-level work (task)
  'cli-invocation': 'task',
  'file-write': 'task',
  'runner-probe-failed': 'task',
  // Loop control (task)
  'loop-iteration': 'task',
  // Lifecycle — split between system (pause/resume) and task (warning/error/cancel)
  pause: 'system',
  resume: 'system',
  warning: 'task',
  error: 'task',
  cancel: 'task',
  // CLI monitor (task)
  'monitor-invocation-started': 'task',
  'monitor-stdout-line': 'task',
  'monitor-stderr-line': 'task',
  'monitor-progress': 'task',
  'monitor-stall': 'task',
  'monitor-rate-limited': 'task',
  'monitor-invocation-completed': 'task',
  'monitor-invocation-failed': 'task',
  'monitor-invocation-canceled': 'task',
  'monitor-invocation-summary': 'task',
  // Audit pipeline housekeeping (system)
  'audit-rotated': 'system',
  'audit-retention-applied': 'system',
  'audit-hydration-warning': 'system',
  'audit-schema-warning': 'system',
  'session-retention-applied': 'system',
  // Retry-condition decision (task)
  'phase.retry_evaluated': 'task',
  // Delayed retry (system)
  'retry-scheduled': 'system',
  'retry-manual': 'system',
  'retry-recovered': 'system',
  'queue-paused': 'system',
  // Phase control (task)
  'phase-pause-requested': 'task',
  'phase-paused': 'task',
  'phase-resumed': 'task',
  'phase-restarted': 'task',
  'phase-skipped': 'task',
  'phase-disabled': 'task',
  'phase-enabled': 'task',
  'phase-removed': 'task',
  // Queue control / task lifecycle / scheduling (system)
  'queue-created': 'system',
  'queue-renamed': 'system',
  'queue-deleted': 'system',
  'queue-resumed': 'system',
  'queue-settings-saved': 'system',
  'task-modified': 'system',
  'task-removed': 'system',
  'task-reordered': 'system',
  'task-moved': 'system',
  'task-canceled': 'system',
  'task-restarted-from-canceled': 'system',
  'task-enqueued': 'system',
  'schedule-set': 'system',
  'schedule-cleared': 'system',
  'schedule-fired': 'system',
  // Phase messaging (task)
  'phase-message-emitted': 'task',
  'phase-message-truncated': 'task',
  'phase-message-invalid': 'task',
  // Fatal signature (task)
  'fatal-signature-matched': 'task',
  // Auto-compact override (task)
  'auto-compact-override-applied': 'task',
  // Wake-up daemon (system)
  'wakeup-daemon-installed': 'system',
  'wakeup-daemon-updated': 'system',
  'wakeup-daemon-uninstalled': 'system',
  'wakeup-daemon-install-failed': 'system',
  'wakeup-workspace-roots-updated': 'system',
  'wakeup-daemon-uninstall-failed-on-deactivate': 'system',
  // Phase log IPC (task)
  'phase-log-read': 'task',
  'phase-log-tail-started': 'task',
  'phase-log-tail-stopped': 'task',
  // Phase breakpoints (task)
  'phase-breakpoint-set': 'task',
  'phase-breakpoint-cleared': 'task',
  'phase-breakpoint-fired': 'task',
  // State migration / repair (system)
  'state-migrated': 'system',
  'workflow-run-repaired': 'system',
  // Workspace / trust gates (system)
  'multi-root.warning-shown': 'system',
  'trust.capability-denied': 'system',
  // Queue full reset (system)
  'queue-cleared-all': 'system',
  // Feature 065 — scheduled-start lifecycle / idle-pending (system)
  'scheduled-start-armed': 'system',
  'scheduled-start-fired': 'system',
  'scheduled-start-canceled': 'system',
  'scheduled-start-superseded': 'system',
  'scheduled-start-horizon-rejected': 'system',
  'scheduled-start-past-timestamp-coerced-to-now': 'system',
  'idle-pending-entered': 'system',
  'idle-pending-exited': 'system',
  'automation-enqueue-no-start-mode': 'system',
  // Feature 065 / BUG-006 — system-armed scheduled-restore on retry-cap rate-limit
  'system-pause-scheduled-restore': 'system',
  'system-pause-restore-unavailable': 'system',
  // Feature 065 — v6 → v7 state migration (system)
  'state-migrated-v6-to-v7': 'system',
  // Feature 072 — task-level execution lifecycle (task)
  'task-execution-started': 'task',
  'task-execution-ended': 'task',
  'task-execution-paused': 'task',
  'phase-jumped': 'task',
  // Feature 076 — optional-phase continuation is task-scoped.
  'phase-optional-failure-continued': 'task',
  'backend-ping': 'system',
  // Feature 073 — Metrics Dashboard adoption tracking; not tied to a
  // specific workflow run (system)
  'metrics-view-opened': 'system',
  // Feature 084 — Phase exchange is a catalog operation, not part of any
  // workflow run (system). A refused import is recorded so a blocked import is
  // distinguishable from one that never happened (FR-049).
  'process-exchange-export': 'system',
  'process-exchange-import-refused': 'system',
  // Feature 085 — a committed package import is likewise a catalog write that
  // belongs to no run. It exists because a package lands in two layers that can
  // succeed independently, so the catalog alone no longer says what happened
  // (FR-061).
  'process-exchange-import-committed': 'system'
};

function assertExhaustive(value: never): never {
  throw new Error(`Unclassified audit event type: ${String(value)}`);
}

describe('classifyAuditEvent (Feature 064 T007)', () => {
  it('classifies every literal in ALL_AUDIT_EVENT_TYPES', () => {
    for (const evt of ALL_AUDIT_EVENT_TYPES) {
      const expected = EXPECTED_SCOPE[evt];
      expect(classifyAuditEvent(evt)).toBe(expected);
    }
  });

  it('partitions ALL_AUDIT_EVENT_TYPES into task ∪ system with no overlap', () => {
    const taskEvents = new Set<string>();
    const systemEvents = new Set<string>();
    for (const evt of ALL_AUDIT_EVENT_TYPES) {
      const scope = classifyAuditEvent(evt);
      if (scope === 'task') taskEvents.add(evt);
      else systemEvents.add(evt);
    }
    const union = new Set<string>([...taskEvents, ...systemEvents]);
    expect(union.size).toBe(ALL_AUDIT_EVENT_TYPES.length);
    for (const evt of ALL_AUDIT_EVENT_TYPES) {
      expect(union.has(evt)).toBe(true);
    }
    // No overlap.
    for (const evt of taskEvents) {
      expect(systemEvents.has(evt)).toBe(false);
    }
  });

  it('SYSTEM_SCOPED_EVENT_TYPES equals the set of system-classified events', () => {
    const expectedSystem = new Set<string>();
    for (const evt of ALL_AUDIT_EVENT_TYPES) {
      if (EXPECTED_SCOPE[evt] === 'system') expectedSystem.add(evt);
    }
    for (const evt of expectedSystem) {
      expect(SYSTEM_SCOPED_EVENT_TYPES.has(evt as AuditEventType)).toBe(true);
    }
    expect(SYSTEM_SCOPED_EVENT_TYPES.size).toBe(expectedSystem.size);
  });

  it("defaults unknown event types to 'task' (FR-011)", () => {
    expect(classifyAuditEvent('definitely-not-a-known-event-type')).toBe('task');
    expect(classifyAuditEvent('')).toBe('task');
  });

  it('queue-cleared-all is always system-scoped (FR-015)', () => {
    expect(classifyAuditEvent('queue-cleared-all')).toBe('system');
  });

  it('build-time exhaustiveness: switch over AuditEventType covers every literal', () => {
    // Adding a new entry to ALL_AUDIT_EVENT_TYPES without classifying it
    // here MUST cause `tsc` to fail because the default branch would
    // receive a non-`never` type. The runtime assertion serves as a
    // belt-and-suspenders backstop if a non-literal value sneaks past
    // tsc (it cannot, but the runtime check documents intent).
    const all: readonly AuditEventType[] = ALL_AUDIT_EVENT_TYPES;
    for (const evt of all) {
      switch (evt) {
        case 'phase-start':
        case 'phase-end':
        case 'cli-invocation':
        case 'file-write':
        case 'loop-iteration':
        case 'pause':
        case 'resume':
        case 'warning':
        case 'error':
        case 'cancel':
        case 'monitor-invocation-started':
        case 'monitor-stdout-line':
        case 'monitor-stderr-line':
        case 'monitor-progress':
        case 'monitor-stall':
        case 'monitor-rate-limited':
        case 'monitor-invocation-completed':
        case 'monitor-invocation-failed':
        case 'monitor-invocation-canceled':
        case 'monitor-invocation-summary':
        case 'audit-rotated':
        case 'audit-retention-applied':
        case 'audit-hydration-warning':
        case 'audit-schema-warning':
        case 'session-retention-applied':
        case 'phase.retry_evaluated':
        case 'retry-scheduled':
        case 'retry-manual':
        case 'retry-recovered':
        case 'queue-paused':
        case 'phase-pause-requested':
        case 'phase-paused':
        case 'phase-resumed':
        case 'phase-restarted':
        case 'phase-skipped':
        case 'phase-disabled':
        case 'phase-enabled':
        case 'phase-removed':
        case 'queue-created':
        case 'queue-renamed':
        case 'queue-deleted':
        case 'queue-resumed':
        case 'queue-settings-saved':
        case 'task-modified':
        case 'task-removed':
        case 'task-reordered':
        case 'task-moved':
        case 'task-canceled':
        case 'task-restarted-from-canceled':
        case 'task-enqueued':
        case 'schedule-set':
        case 'schedule-cleared':
        case 'schedule-fired':
        case 'phase-message-emitted':
        case 'phase-message-truncated':
        case 'phase-message-invalid':
        case 'fatal-signature-matched':
        case 'auto-compact-override-applied':
        case 'wakeup-daemon-installed':
        case 'wakeup-daemon-updated':
        case 'wakeup-daemon-uninstalled':
        case 'wakeup-daemon-install-failed':
        case 'wakeup-workspace-roots-updated':
        case 'wakeup-daemon-uninstall-failed-on-deactivate':
        case 'phase-log-read':
        case 'phase-log-tail-started':
        case 'phase-log-tail-stopped':
        case 'phase-breakpoint-set':
        case 'phase-breakpoint-cleared':
        case 'phase-breakpoint-fired':
        case 'state-migrated':
        case 'workflow-run-repaired':
        case 'multi-root.warning-shown':
        case 'trust.capability-denied':
        case 'queue-cleared-all':
        case 'scheduled-start-armed':
        case 'scheduled-start-fired':
        case 'scheduled-start-canceled':
        case 'scheduled-start-superseded':
        case 'scheduled-start-horizon-rejected':
        case 'scheduled-start-past-timestamp-coerced-to-now':
        case 'idle-pending-entered':
        case 'idle-pending-exited':
        case 'automation-enqueue-no-start-mode':
        case 'system-pause-scheduled-restore':
        case 'system-pause-restore-unavailable':
        case 'state-migrated-v6-to-v7':
        case 'task-execution-started':
        case 'task-execution-ended':
        case 'task-execution-paused':
        case 'runner-probe-failed':
        case 'phase-jumped':
        case 'phase-optional-failure-continued':
        case 'backend-ping':
        case 'metrics-view-opened':
        case 'process-exchange-export':
        case 'process-exchange-import-refused':
        case 'process-exchange-import-committed': {
          const scope = classifyAuditEvent(evt);
          expect(scope === 'task' || scope === 'system').toBe(true);
          break;
        }
        default:
          assertExhaustive(evt);
      }
    }
  });
});
