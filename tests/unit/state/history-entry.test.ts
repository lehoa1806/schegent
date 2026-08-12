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
import type { RunOutputRecord } from '../../../src/contracts/run-results';
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

// Feature 091 (T005, US1) — FR-010: what a Run recorded must survive the trip
// through history, because that is what a later Run's reference is resolved
// against.
//
// The `ensureHistoryEntry` half is the higher-value one. A normaliser that
// silently drops the new field passes every write-side test and still empties
// the record on the next read, and nothing else in the suite would notice.

describe('runOutputs survives the history round trip (Feature 091, FR-010)', () => {
  const RECORDED: readonly RunOutputRecord[] = [
    { name: 'report', status: 'resolved', reference: 'out/report.md' },
    { name: 'summary', status: 'unresolved' }
  ];

  function built(runOutputs?: readonly RunOutputRecord[]): HistoryEntry {
    return buildHistoryEntry({
      runId: 'run-outputs-1',
      featureId: 'feat-outputs-1',
      description: 'a run that declared outputs',
      terminalStatus: 'completed',
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_001_000,
      logger,
      ...(runOutputs !== undefined ? { runOutputs } : {})
    });
  }

  it('buildHistoryEntry carries the records through unchanged', () => {
    expect(built(RECORDED).runOutputs).toEqual(RECORDED);
  });

  it('buildHistoryEntry omits the field entirely when the Run recorded nothing', () => {
    const entry = built();
    expect(entry.runOutputs).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(entry, 'runOutputs')).toBe(false);
  });

  it('ensureHistoryEntry preserves the records across a read cycle', () => {
    const entry = ensureHistoryEntry(JSON.parse(JSON.stringify(built(RECORDED))));
    expect(entry).not.toBeNull();
    expect(entry!.runOutputs).toEqual(RECORDED);
  });

  it('an unresolved record keeps having no reference after the read cycle', () => {
    // The absent key is what makes `prior-output-not-found` reachable (FR-012).
    // A normaliser that filled it with '' or null would make an unlocatable
    // output look locatable to the resolver.
    const entry = ensureHistoryEntry(JSON.parse(JSON.stringify(built(RECORDED))));
    const summary = entry!.runOutputs!.find((record) => record.name === 'summary');
    expect(summary).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(summary, 'reference')).toBe(false);
  });

  it('an entry written without the field reads back without it', () => {
    // Every entry written before this feature. "Recorded nothing" must not
    // become "recorded an empty list", because the two answer FR-011
    // differently one layer up.
    const legacyRaw = {
      runId: 'legacy-outputs',
      featureId: 'feat-legacy-outputs',
      descriptionPreview: 'written before 091',
      terminalStatus: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1_000,
      lastErrorSummary: null,
      auditLogPointer: 'runId:legacy-outputs'
    };
    const entry = ensureHistoryEntry(legacyRaw);
    expect(entry).not.toBeNull();
    expect(entry!.runOutputs).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(entry, 'runOutputs')).toBe(false);
  });

  it('a non-array runOutputs is treated as missing rather than coerced', () => {
    const entry = ensureHistoryEntry({
      runId: 'run-bad-outputs',
      featureId: 'feat-bad-outputs',
      descriptionPreview: '',
      runOutputs: 'out/report.md' as unknown,
      terminalStatus: 'completed',
      startedAt: '2026-05-10T00:00:00.000Z',
      completedAt: '2026-05-10T00:00:01.000Z',
      durationMs: 1_000,
      lastErrorSummary: null,
      auditLogPointer: 'runId:run-bad-outputs'
    });
    expect(entry).not.toBeNull();
    expect(entry!.runOutputs).toBeUndefined();
  });
});
