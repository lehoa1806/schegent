// Feature 065 (T016) — Focused classification + uniqueness tests for the
// ten new audit-event literals introduced by the enqueue/start-separation
// feature. The exhaustive classifier check across ALL_AUDIT_EVENT_TYPES
// lives in event-classification.test.ts; this file pins the feature-065
// surface specifically and provides a compile-time exhaustiveness check
// so adding a new schedule/migration event without classifying it fails
// `tsc`.

import { describe, expect, it } from 'vitest';
import {
  SCHEDULE_EVENT_TYPES,
  MIGRATION_V7_EVENT_TYPES,
  ALL_AUDIT_EVENT_TYPES,
  classifyAuditEvent
} from '../../../src/contracts/audit-events';

type ScheduleOrMigrationEvent =
  | (typeof SCHEDULE_EVENT_TYPES)[number]
  | (typeof MIGRATION_V7_EVENT_TYPES)[number];

function assertScheduleOrMigrationSystem(event: ScheduleOrMigrationEvent): void {
  // Compile-time exhaustiveness: every literal must be handled. Adding a
  // new event-type literal without an arm here fails `tsc`.
  switch (event) {
    case 'scheduled-start-armed':
    case 'scheduled-start-fired':
    case 'scheduled-start-canceled':
    case 'scheduled-start-superseded':
    case 'scheduled-start-horizon-rejected':
    case 'scheduled-start-past-timestamp-coerced-to-now':
    case 'automation-enqueue-no-start-mode':
    case 'idle-pending-entered':
    case 'idle-pending-exited':
    case 'state-migrated-v6-to-v7':
      expect(classifyAuditEvent(event)).toBe('system');
      return;
    default: {
      const _exhaustive: never = event;
      throw new Error(`unclassified event: ${String(_exhaustive)}`);
    }
  }
}

describe('Feature 065 — schedule/migration audit-event classification', () => {
  it('classifies every SCHEDULE_EVENT_TYPES member as system', () => {
    for (const eventType of SCHEDULE_EVENT_TYPES) {
      assertScheduleOrMigrationSystem(eventType);
    }
  });

  it('classifies every MIGRATION_V7_EVENT_TYPES member as system', () => {
    for (const eventType of MIGRATION_V7_EVENT_TYPES) {
      assertScheduleOrMigrationSystem(eventType);
    }
  });

  it('lists each schedule / migration literal exactly once in ALL_AUDIT_EVENT_TYPES', () => {
    const all = [...ALL_AUDIT_EVENT_TYPES];
    const counts = new Map<string, number>();
    for (const event of all) {
      counts.set(event, (counts.get(event) ?? 0) + 1);
    }
    for (const event of [...SCHEDULE_EVENT_TYPES, ...MIGRATION_V7_EVENT_TYPES]) {
      expect(counts.get(event)).toBe(1);
    }
  });

  it('exposes every FR-023 literal via SCHEDULE_EVENT_TYPES / MIGRATION_V7_EVENT_TYPES', () => {
    const expected: ScheduleOrMigrationEvent[] = [
      'scheduled-start-armed',
      'scheduled-start-fired',
      'scheduled-start-canceled',
      'scheduled-start-superseded',
      'scheduled-start-horizon-rejected',
      'automation-enqueue-no-start-mode',
      'scheduled-start-past-timestamp-coerced-to-now',
      'idle-pending-entered',
      'idle-pending-exited',
      'state-migrated-v6-to-v7'
    ];
    const surface = new Set<string>([
      ...SCHEDULE_EVENT_TYPES,
      ...MIGRATION_V7_EVENT_TYPES
    ]);
    for (const literal of expected) {
      expect(surface.has(literal)).toBe(true);
    }
  });
});
