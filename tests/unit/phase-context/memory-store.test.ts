// FR-R6-F15 T022 — the in-memory handoff store: an unknown handoff, the version check on save,
// and stored records that nothing outside the store can change.
import { describe, expect, it } from 'vitest';
import type {
  AcceptedRevision,
  ApprovalRecord,
  DispatchRecord,
  HandoffRecord
} from '../../../src/contracts/phase-context/context-manifest';
import { createMemoryHandoffStore } from '../../../src/services/phase-context/memory-store';
import { digestOf } from '../../fixtures/phase-context/builders';

const HANDOFF_ID = digestOf('1');
const OTHER_ID = digestOf('2');

function revision(overrides: Partial<AcceptedRevision> = {}): AcceptedRevision {
  return {
    revision: 1,
    manifestDigest: digestOf('a'),
    serializedManifest: '{"manifestVersion":1}',
    rendererVersion: 1,
    renderedDigest: digestOf('b'),
    renderedBytes: 120,
    state: 'ready',
    ...overrides
  };
}

interface MutableRecord {
  handoffId: string;
  version: number;
  revisions: AcceptedRevision[];
  approvals: ApprovalRecord[];
  dispatches: DispatchRecord[];
}

function record(overrides: Partial<MutableRecord> = {}): MutableRecord {
  return { handoffId: HANDOFF_ID, version: 0, revisions: [revision()], approvals: [], dispatches: [], ...overrides };
}

function loaded(store: ReturnType<typeof createMemoryHandoffStore>, handoffId = HANDOFF_ID): HandoffRecord {
  const found = store.load(handoffId);
  if (found === null) throw new Error('expected a stored record');
  return found;
}

describe('the in-memory handoff store', () => {
  it('has no record of a handoff nothing saved', () => {
    expect(createMemoryHandoffStore().load(HANDOFF_ID)).toBeNull();
  });

  it('stores a new record saved with expected version 0, as version 1', () => {
    const store = createMemoryHandoffStore();

    expect(store.save(record(), 0)).toBe(true);
    expect(loaded(store)).toEqual({ ...record(), version: 1 });
  });

  it('stores the version it computes, not the one the record names', () => {
    const store = createMemoryHandoffStore();

    expect(store.save(record({ version: 41 }), 0)).toBe(true);
    expect(loaded(store).version).toBe(1);
  });

  it('bumps the version on each save made with the stored version', () => {
    const store = createMemoryHandoffStore();
    store.save(record(), 0);

    expect(store.save(record({ revisions: [revision({ state: 'superseded' }), revision({ revision: 2 })] }), 1)).toBe(true);
    expect(loaded(store).version).toBe(2);
    expect(loaded(store).revisions.map((entry) => entry.revision)).toEqual([1, 2]);
    expect(store.save(record(), 2)).toBe(true);
    expect(loaded(store).version).toBe(3);
  });

  it.each([
    ['a new record saved with a version other than 0', null, 1],
    ['a stored record saved with an earlier version', 1, 0],
    ['a stored record saved with a later version', 1, 2]
  ])('refuses %s and stores nothing', (_label, storedVersion, expectedVersion) => {
    const store = createMemoryHandoffStore();
    if (storedVersion !== null) store.save(record(), 0);
    const before = store.load(HANDOFF_ID);

    expect(store.save(record({ revisions: [revision({ state: 'waiting-approval' })] }), expectedVersion)).toBe(false);
    expect(store.load(HANDOFF_ID)).toEqual(before);
  });

  it('lets one of two saves made with the same expected version win', () => {
    const store = createMemoryHandoffStore();
    store.save(record(), 0);

    expect(store.save(record({ approvals: [{ revision: 1, decisionId: 'decision-1' }] }), 1)).toBe(true);
    expect(store.save(record({ approvals: [{ revision: 1, decisionId: 'decision-2' }] }), 1)).toBe(false);
    expect(loaded(store).approvals).toEqual([{ revision: 1, decisionId: 'decision-1' }]);
  });

  it('keeps each handoff apart', () => {
    const store = createMemoryHandoffStore();
    store.save(record(), 0);

    expect(store.load(OTHER_ID)).toBeNull();
    expect(store.save(record({ handoffId: OTHER_ID, revisions: [revision({ state: 'waiting-approval' })] }), 0)).toBe(true);
    expect(loaded(store).revisions.at(0)?.state).toBe('ready');
    expect(loaded(store, OTHER_ID).revisions.at(0)?.state).toBe('waiting-approval');
  });

  it('returns frozen records, down to each revision, approval and dispatch', () => {
    const store = createMemoryHandoffStore();
    store.save(
      record({
        approvals: [{ revision: 1, decisionId: 'decision-1' }],
        dispatches: [{ revision: 1, targetAttemptId: 'att-2', representationDigest: digestOf('c'), state: 'intent' }]
      }),
      0
    );
    const found = loaded(store);

    expect(Object.isFrozen(found)).toBe(true);
    expect(Object.isFrozen(found.revisions)).toBe(true);
    expect(Object.isFrozen(found.approvals)).toBe(true);
    expect(Object.isFrozen(found.dispatches)).toBe(true);
    expect(Object.isFrozen(found.revisions.at(0))).toBe(true);
    expect(Object.isFrozen(found.approvals.at(0))).toBe(true);
    expect(Object.isFrozen(found.dispatches.at(0))).toBe(true);
  });

  it('is not reached by a later change to the object that was saved', () => {
    const store = createMemoryHandoffStore();
    const saved = record({ approvals: [{ revision: 1, decisionId: 'decision-1' }] });
    const savedRevision = { ...revision() };
    saved.revisions = [savedRevision];
    store.save(saved, 0);

    saved.handoffId = OTHER_ID;
    saved.revisions.push(revision({ revision: 2 }));
    saved.approvals.length = 0;
    saved.dispatches.push({ revision: 1, targetAttemptId: 'att-2', representationDigest: digestOf('c'), state: 'intent' });
    Object.assign(savedRevision, { state: 'superseded', manifestDigest: digestOf('f') });

    const found = loaded(store);
    expect(found.revisions).toEqual([revision()]);
    expect(found.approvals).toEqual([{ revision: 1, decisionId: 'decision-1' }]);
    expect(found.dispatches).toEqual([]);
    expect(store.load(OTHER_ID)).toBeNull();
  });

  it('keeps only the fields of a record, a revision, an approval and a dispatch', () => {
    const store = createMemoryHandoffStore();
    const extra = { ...record(), note: 'not a field' } as unknown as HandoffRecord;
    store.save(extra, 0);

    expect(Object.keys(loaded(store)).sort()).toEqual(['approvals', 'dispatches', 'handoffId', 'revisions', 'version']);
  });

  it('gives every load of an unchanged handoff an equal record', () => {
    const store = createMemoryHandoffStore();
    store.save(record(), 0);

    expect(store.load(HANDOFF_ID)).toEqual(store.load(HANDOFF_ID));
  });
});
