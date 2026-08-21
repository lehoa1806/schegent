// Feature 103 (T005, FR-002) — the projected history row equals its declared
// type, and names the queue it was filed under.
//
// Two facts, one cause. `projectHistory` returned `history.list().slice()`,
// which is a copy of the array and not a projection of its members: every
// `HistoryRecord` field reached the webview, including three the snapshot type
// never declared — `originalDescription` (a legacy 32,000-character operator
// string kept only for byte-identical replay), `descriptionRef`, and
// `runOutputs`. `tsc` cannot see it, because a value with extra properties
// satisfies a narrower interface everywhere except a fresh object literal.
//
// So the wire carried more than the contract said, and simultaneously less than
// the surface needs: `queueId` is on `HistoryRecord` and was never declared on
// the snapshot row, so a cross-queue list had no way to name a row's queue
// (FR-002). Constructing each row explicitly fixes both at once — the shape
// becomes exactly the declared one, which is the only form in which "no
// undeclared field ships" is a property a test can hold.

import { describe, it, expect } from 'vitest';
import { projectHistory } from '../../../../src/ui/sidebar/history-projector';
import type { HistoryRecord } from '../../../../src/state/history-entry';

/** Fields the snapshot row declares. Anything else on a projected row is a leak. */
const DECLARED_KEYS = [
  'runId',
  'featureId',
  'descriptionPreview',
  'terminalStatus',
  'startedAt',
  'completedAt',
  'durationMs',
  'lastErrorSummary',
  'auditLogPointer',
  'queueId',
  // T031 — the two provenance readings. Listed here, and populated on the
  // fixture below, so this guard keeps its teeth: a fixture that stopped being
  // full would let a `slice()` regression through on exactly the fields the
  // feature added.
  'catalogVersion',
  'origin',
  // T052 (FR-053) — the length of the original description, so the detail can
  // state how much of it the preview is. The number ships; `descriptionRef` and
  // `originalDescription`, asserted absent below, do not.
  'descriptionLength'
] as const;

/**
 * A record as the store actually holds one: every optional field populated, so
 * a projection that copies rather than constructs is caught. A fixture carrying
 * only the required fields would pass against `slice()`.
 */
function fullRecord(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    runId: 'run-1',
    featureId: 'feat-1',
    descriptionPreview: 'Investigate auth flow',
    terminalStatus: 'completed',
    startedAt: '2026-08-20T10:00:00.000Z',
    completedAt: '2026-08-20T10:05:00.000Z',
    durationMs: 300_000,
    lastErrorSummary: null,
    auditLogPointer: 'runId:run-1',
    queueId: 'queue-alpha',
    descriptionRef: '.schegent/descriptions/run-1.txt',
    descriptionLength: 4_182,
    originalDescription: 'Investigate auth flow, the whole thing, at length',
    pipelineId: 'pipe-1',
    runOutputs: [],
    catalogVersion: { kind: 'pipeline', id: 'pipe-1', versionId: 'ver-1' },
    origin: { kind: 'workflow-member', workflowId: 'wf-1' },
    ...overrides
  };
}

function storeOf(records: readonly HistoryRecord[]) {
  return { list: () => records };
}

describe('projectHistory — the wire row equals its declared type (T005)', () => {
  it('carries queueId on every row', () => {
    const rows = projectHistory(
      storeOf([
        fullRecord({ runId: 'run-1', queueId: 'queue-alpha' }),
        fullRecord({ runId: 'run-2', queueId: 'queue-beta' }),
        fullRecord({ runId: 'run-3', queueId: '__unattributed__' })
      ])
    );

    expect(rows.map((r) => r.queueId)).toEqual([
      'queue-alpha',
      'queue-beta',
      '__unattributed__'
    ]);
  });

  it('ships no key the snapshot row does not declare', () => {
    const [row] = projectHistory(storeOf([fullRecord()]));

    expect(Object.keys(row).sort()).toEqual([...DECLARED_KEYS].sort());
  });

  it('ships the description length, and omits the key when the record has none', () => {
    const [withLength] = projectHistory(storeOf([fullRecord()]));
    expect(withLength.descriptionLength).toBe(4_182);

    // Absent stays absent rather than becoming a zero: a row recorded before the
    // store kept the length has an unknown original, and "0 characters" would
    // read as an empty description the operator never wrote.
    const record = fullRecord();
    delete (record as { descriptionLength?: number }).descriptionLength;
    const [withoutLength] = projectHistory(storeOf([record]));
    expect(Object.hasOwn(withoutLength, 'descriptionLength')).toBe(false);
  });

  it('does not ship originalDescription, descriptionRef or runOutputs', () => {
    // Named individually rather than left to the key-set assertion above,
    // because these three are the reason this test exists and a future field
    // added to both sides would quietly relax the general check.
    const [row] = projectHistory(storeOf([fullRecord()])) as unknown as readonly Record<
      string,
      unknown
    >[];

    expect(row).not.toHaveProperty('originalDescription');
    expect(row).not.toHaveProperty('descriptionRef');
    expect(row).not.toHaveProperty('runOutputs');
  });

  it('returns an empty frozen array for a null store', () => {
    const rows = projectHistory(null);

    expect(rows).toEqual([]);
    expect(Object.isFrozen(rows)).toBe(true);
  });
});
