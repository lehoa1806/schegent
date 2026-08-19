// US5 / FR-029: a sanitized full original description must survive a completed
// run so rerun-from-history is faithful, and legacy entries (written under
// STATE_SCHEMA_VERSION 1, before the field existed) must be migrated forward
// with `originalDescription === undefined` so the rerun control can disable
// itself with the canonical tooltip.
//
// FR-R3-010 (T405) moved *where* the full text lives — out of the memento entry
// and onto disk beside the run's other evidence — without changing that it must
// exist. `buildHistoryEntry` now returns it alongside the entry rather than
// inside it, so the FR-029 requirement is asserted on `fullDescription` and the
// entry is asserted to have stopped carrying it.

import { describe, it, expect } from 'vitest';
import {
  buildAuditLogPointer,
  buildHistoryEntry,
  ensureHistoryEntry,
  parseAuditLogPointer,
  withDescriptionRef,
  DESCRIPTION_PREVIEW_MAX,
  type HistoryEntry
} from '../../../src/state/history-entry';
import type { RunOutputRecord } from '../../../src/contracts/run-results';
import { SanitizedLogger } from '../../../src/lib/logger';

const logger = new SanitizedLogger();

/**
 * The partition every read in this file is performed against.
 *
 * `ensureHistoryEntry` takes it because the map key is the only place the queue
 * association is recorded (FR-R3-010 T402), so a normaliser has to be told
 * which partition the row came out of.
 */
const QUEUE = 'queue-under-test';

describe('buildHistoryEntry — sanitized full description (US5 / FR-029, FR-R3-010)', () => {
  it('returns the full sanitized original description for the caller to store', () => {
    const description =
      'Investigate cache invalidation when the upstream API rotates its session-id cookie ' +
      'after a 401 response and the client retries with a stale auth header.';
    const built = buildHistoryEntry({
      runId: 'run-1',
      featureId: 'feat-1',
      description,
      terminalStatus: 'completed',
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_001_500,
      logger
    });
    expect(built.fullDescription).toBe(description);
    // and the preview is independently truncated
    expect(built.entry.descriptionPreview.length).toBeLessThanOrEqual(DESCRIPTION_PREVIEW_MAX);
  });

  it('no longer puts the full description in the memento entry', () => {
    // FR-R3-010: the entry is rewritten whole on every completion, so an
    // unbounded field on it makes the cost of recording a run a function of the
    // *content* of the 50 runs before it. The field is not merely absent — it
    // must be genuinely unset, since a `''` would read as an empty description
    // rather than as one stored elsewhere.
    const built = buildHistoryEntry({
      runId: 'run-1b',
      featureId: 'feat-1b',
      description: 'a'.repeat(4_000),
      terminalStatus: 'completed',
      startedAt: 0,
      completedAt: 1,
      logger
    });
    expect(built.entry.originalDescription).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(built.entry, 'originalDescription')).toBe(false);
    // The length is kept so the UI can say how much text it is not showing
    // without a filesystem round trip.
    expect(built.entry.descriptionLength).toBe(4_000);
  });

  it('redacts token-shaped strings before the text leaves the builder', () => {
    const dirty =
      'I tested with sk-ant-api03-' + 'X'.repeat(60) + ' and it failed.';
    const built = buildHistoryEntry({
      runId: 'run-2',
      featureId: 'feat-2',
      description: dirty,
      terminalStatus: 'failed',
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_001_000,
      lastErrorSummary: 'auth failure',
      logger
    });
    // The sanitize-once invariant makes this the only place redaction happens,
    // so a secret surviving here reaches disk verbatim.
    expect(built.fullDescription).not.toContain('sk-ant-api03-XXXXXXXXXX');
    expect(built.fullDescription).toContain('[REDACTED]');
  });

  it('returns the description unchanged when it is shorter than the preview cap', () => {
    const built = buildHistoryEntry({
      runId: 'run-3',
      featureId: 'feat-3',
      description: 'tiny',
      terminalStatus: 'completed',
      startedAt: 0,
      completedAt: 100,
      logger
    });
    expect(built.fullDescription).toBe('tiny');
    expect(built.entry.descriptionPreview).toBe('tiny');
    expect(built.entry.descriptionLength).toBe(4);
  });

  it('the builder never claims a reference the caller has not yet earned', () => {
    // A `descriptionRef` asserts that something is retrievable. The builder
    // runs before the write, so it cannot know — stamping one there and hoping
    // is how a record comes to point at nothing.
    const built = buildHistoryEntry({
      runId: 'run-4',
      featureId: 'feat-4',
      description: 'whatever',
      terminalStatus: 'completed',
      startedAt: 0,
      completedAt: 1,
      logger
    });
    expect(built.entry.descriptionRef).toBeUndefined();

    const stamped = withDescriptionRef(built.entry, '.schegent/history/run-4.txt');
    expect(stamped.descriptionRef).toBe('.schegent/history/run-4.txt');

    // A failed write leaves the entry exactly as it was, not carrying a null.
    const unstamped = withDescriptionRef(built.entry, null);
    expect(unstamped).toBe(built.entry);
  });
});

// FR-R3-010 (T407) — the pointer format has one writer and one reader, and the
// reader tolerates exactly the legacy shapes that shipped before it existed.

describe('auditLogPointer format (FR-R3-010 T407)', () => {
  it('round-trips a run id', () => {
    const pointer = buildAuditLogPointer('run-abc');
    expect(pointer).toBe('runId:run-abc');
    expect(parseAuditLogPointer(pointer)).toEqual({ runId: 'run-abc' });
  });

  it('refuses the legacy shapes rather than guessing a run id from them', () => {
    // Fixtures written before the format was pinned carried a path and an empty
    // string. Both parse to `null`, which the resolver reports as
    // *unaddressable* — a different answer from "the evidence expired", and
    // collapsing the two would tell an operator their evidence had aged out
    // when in fact it was never addressable.
    expect(parseAuditLogPointer('.schegent/audit.log')).toBeNull();
    expect(parseAuditLogPointer('')).toBeNull();
    expect(parseAuditLogPointer('runId:')).toBeNull();
  });

  it('a stored entry with no pointer is given the derivable one on read', () => {
    const entry = ensureHistoryEntry(
      {
        runId: 'run-derived',
        featureId: 'feat-derived',
        descriptionPreview: '',
        terminalStatus: 'completed',
        startedAt: '2026-05-10T00:00:00.000Z',
        completedAt: '2026-05-10T00:00:01.000Z',
        durationMs: 0,
        lastErrorSummary: null
      },
      QUEUE
    );
    expect(entry!.auditLogPointer).toBe('runId:run-derived');
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
    const entry = ensureHistoryEntry(raw, QUEUE);
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
    const entry = ensureHistoryEntry(legacyRaw, QUEUE);
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
    const entry = ensureHistoryEntry(raw, QUEUE);
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
    // `raw` and the partition it was read from — no dependency through which
    // I/O could reach it.
    expect(ensureHistoryEntry.length).toBe(2);
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
    }, QUEUE);
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
    }).entry;
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
    const entry = ensureHistoryEntry(JSON.parse(JSON.stringify(built(RECORDED))), QUEUE);
    expect(entry).not.toBeNull();
    expect(entry!.runOutputs).toEqual(RECORDED);
  });

  it('an unresolved record keeps having no reference after the read cycle', () => {
    // The absent key is what makes `prior-output-not-found` reachable (FR-012).
    // A normaliser that filled it with '' or null would make an unlocatable
    // output look locatable to the resolver.
    const entry = ensureHistoryEntry(JSON.parse(JSON.stringify(built(RECORDED))), QUEUE);
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
    const entry = ensureHistoryEntry(legacyRaw, QUEUE);
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
    }, QUEUE);
    expect(entry).not.toBeNull();
    expect(entry!.runOutputs).toBeUndefined();
  });
});
