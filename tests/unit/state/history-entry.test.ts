// US5 / FR-029: HistoryEntry must persist a sanitized full original
// description so rerun-from-history is faithful, and legacy entries (written
// under STATE_SCHEMA_VERSION 1, before the field existed) must be migrated
// forward with `originalDescription === undefined` so the rerun control can
// disable itself with the canonical tooltip.

import { describe, it, expect } from 'vitest';
import {
  buildHistoryEntry,
  ensureHistoryEntry,
  DESCRIPTION_PREVIEW_MAX,
  type HistoryEntry
} from '../../../src/state/history-entry';
import { SanitizedLogger } from '../../../src/lib/logger';

const logger = new SanitizedLogger();

describe('buildHistoryEntry — sanitized originalDescription (US5 / FR-029)', () => {
  it('persists the full sanitized original description', () => {
    const description =
      'Investigate cache invalidation when the upstream API rotates its session-id cookie ' +
      'after a 401 response and the client retries with a stale auth header.';
    const entry = buildHistoryEntry({
      runId: 'run-1',
      featureId: 'feat-1',
      description,
      terminalStatus: 'completed',
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_001_500,
      logger
    });
    expect(entry.originalDescription).toBe(description);
    // and the preview is independently truncated
    expect(entry.descriptionPreview.length).toBeLessThanOrEqual(DESCRIPTION_PREVIEW_MAX);
  });

  it('redacts token-shaped strings inside originalDescription before persistence', () => {
    const dirty =
      'I tested with sk-ant-api03-' + 'X'.repeat(60) + ' and it failed.';
    const entry = buildHistoryEntry({
      runId: 'run-2',
      featureId: 'feat-2',
      description: dirty,
      terminalStatus: 'failed',
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_001_000,
      lastErrorSummary: 'auth failure',
      logger
    });
    expect(entry.originalDescription).toBeDefined();
    expect(entry.originalDescription!).not.toContain('sk-ant-api03-XXXXXXXXXX');
    expect(entry.originalDescription!).toContain('[REDACTED]');
  });

  it('still persists originalDescription when description is short', () => {
    const description = 'tiny';
    const entry = buildHistoryEntry({
      runId: 'run-3',
      featureId: 'feat-3',
      description,
      terminalStatus: 'completed',
      startedAt: 0,
      completedAt: 100,
      logger
    });
    expect(entry.originalDescription).toBe('tiny');
    expect(entry.descriptionPreview).toBe('tiny');
  });
});

describe('ensureHistoryEntry — forward migration of legacy entries (US5 / FR-029)', () => {
  it('preserves originalDescription when present in raw', () => {
    const raw: Partial<HistoryEntry> = {
      runId: 'run-1',
      featureId: 'feat-1',
      descriptionPreview: 'preview',
      originalDescription: 'full original description goes here',
      terminalStatus: 'completed',
      startedAt: '2026-05-10T00:00:00.000Z',
      completedAt: '2026-05-10T00:00:01.000Z',
      durationMs: 1_000,
      lastErrorSummary: null,
      auditLogPointer: 'runId:run-1'
    };
    const entry = ensureHistoryEntry(raw);
    expect(entry).not.toBeNull();
    expect(entry!.originalDescription).toBe('full original description goes here');
  });

  it('legacy entries without the field migrate forward with originalDescription === undefined', () => {
    // Simulates a HistoryEntry persisted under STATE_SCHEMA_VERSION 1, which
    // did not store `originalDescription`. The migration must not invent a
    // value and must not attempt to rehydrate from the audit log — the rerun
    // control will disable itself for these entries.
    const legacyRaw = {
      runId: 'legacy-1',
      featureId: 'feat-legacy-1',
      descriptionPreview: 'legacy preview only',
      terminalStatus: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1_000,
      lastErrorSummary: null,
      auditLogPointer: 'runId:legacy-1'
    };
    const entry = ensureHistoryEntry(legacyRaw);
    expect(entry).not.toBeNull();
    expect(entry!.originalDescription).toBeUndefined();
    // confirms the field is genuinely absent (vs stored as null/empty-string)
    expect(Object.prototype.hasOwnProperty.call(entry, 'originalDescription')).toBe(false);
  });

  it('non-string originalDescription is treated as missing (no coercion)', () => {
    const raw = {
      runId: 'run-bad',
      featureId: 'feat-bad',
      descriptionPreview: '',
      originalDescription: 123 as unknown,
      terminalStatus: 'completed',
      startedAt: '2026-05-10T00:00:00.000Z',
      completedAt: '2026-05-10T00:00:01.000Z',
      durationMs: 1_000,
      lastErrorSummary: null,
      auditLogPointer: 'runId:run-bad'
    };
    const entry = ensureHistoryEntry(raw);
    expect(entry).not.toBeNull();
    expect(entry!.originalDescription).toBeUndefined();
  });

  it('forward migration does not attempt audit-log rehydration', () => {
    // Pure-input → pure-output: ensureHistoryEntry must not perform any I/O
    // such as reading .schegent/audit.log to backfill the field.
    // We assert the function signature: it accepts a single `raw: unknown`
    // and is synchronous. Any audit-log access would require an extra
    // dependency parameter or a Promise return type.
    expect(typeof ensureHistoryEntry).toBe('function');
    expect(ensureHistoryEntry.length).toBe(1);
    // returns synchronously — no Promise
    const out = ensureHistoryEntry({
      runId: 'r',
      featureId: 'f',
      descriptionPreview: '',
      terminalStatus: 'completed',
      startedAt: '2026-05-10T00:00:00.000Z',
      completedAt: '2026-05-10T00:00:01.000Z',
      durationMs: 0,
      lastErrorSummary: null,
      auditLogPointer: 'runId:r'
    });
    expect(out).not.toBeNull();
    expect(out instanceof Promise).toBe(false);
  });
});
