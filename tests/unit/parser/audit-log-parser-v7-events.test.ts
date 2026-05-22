// Feature 065 (T021) — Verifies that the structured audit-log line parser
// preserves the ten new feature-065 event-type literals AND continues to
// warn-and-preserve unknown event types (per CLAUDE.md hard rule
// "Never drop unknown audit event types from the parser; warn and preserve").
//
// Strategy:
//   - Build a JSONL line for each new event-type literal and assert the
//     parser returns a complete `AuditEntry` with no `warning`.
//   - Build a JSONL line with a synthetic unknown event-type literal and
//     assert the parser preserves the record AND emits a warning.

import { describe, it, expect } from 'vitest';
import { parseAuditLogLineDetailed } from '../../../src/parser/audit-log-parser';
import {
  SCHEDULE_EVENT_TYPES,
  MIGRATION_V7_EVENT_TYPES
} from '../../../src/contracts/audit-events';

function jsonline(eventType: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'audit-1',
    timestamp: '2026-01-15T10:00:00.000Z',
    runId: 'run-1',
    phase: 'scheduled-start',
    iteration: 0,
    eventType,
    outcome: 'info',
    payload: { queueId: 'default', ...extra }
  });
}

describe('Feature 065 — audit-log parser preserves feature-065 event types', () => {
  for (const eventType of SCHEDULE_EVENT_TYPES) {
    it(`recognizes ${eventType} as a known event type (no warning)`, () => {
      const result = parseAuditLogLineDetailed(jsonline(eventType));
      expect(result.entry).not.toBeNull();
      expect(result.entry?.eventType).toBe(eventType);
      expect(result.warning).toBeUndefined();
    });
  }

  for (const eventType of MIGRATION_V7_EVENT_TYPES) {
    it(`recognizes ${eventType} as a known event type (no warning)`, () => {
      const result = parseAuditLogLineDetailed(jsonline(eventType));
      expect(result.entry).not.toBeNull();
      expect(result.entry?.eventType).toBe(eventType);
      expect(result.warning).toBeUndefined();
    });
  }

  it('warn-and-preserves an unknown event type (CLAUDE.md hard rule)', () => {
    const result = parseAuditLogLineDetailed(jsonline('synthetic-unknown-event'));
    // The record is preserved (entry is non-null) but the parser emits a
    // warning so the operator can investigate the unrecognized type.
    expect(result.entry).not.toBeNull();
    expect(result.entry?.eventType).toBe('synthetic-unknown-event');
    expect(result.warning).toMatch(/unknown eventType.*preserving record/i);
  });
});
