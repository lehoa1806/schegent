// FR-R6-F08 T008 — the row layer over the five recovery handoff tables.
//
// WHAT THIS PINS:
//   - each insert is idempotent on its unique key: a repeat reports `created: false`;
//   - each read returns a frozen camelCase row;
//   - a revision moves only draft -> issued -> superseded; any other move throws, and the
//     store triggers refuse a direct edit of an issued revision;
//   - a pending delivery settles once; a repeat with the same outcome is a no-op.

import { describe, expect, it } from 'vitest';
import {
  createHandoffStore,
  type NewDeliveryRow,
  type NewHandoffRow,
  type NewRevisionRow
} from '../../../src/services/recovery-handoff/handoff-store';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';

const NOW = 1_800_000_000_000;
const HANDOFF_ID = 'a'.repeat(64);

function handoffRow(overrides: Partial<NewHandoffRow> = {}): NewHandoffRow {
  return {
    handoffId: HANDOFF_ID,
    workspaceId: 'ws-1',
    rootExecutionId: 'root-1',
    invocationId: 'inv-1',
    sourceAttemptId: 'att-1',
    legacyProvenance: null,
    nowMs: NOW,
    ...overrides
  };
}

function revisionRow(overrides: Partial<NewRevisionRow> = {}): NewRevisionRow {
  return {
    handoffId: HANDOFF_ID,
    revisionNo: 1,
    cutoffKey: 'c'.repeat(64),
    executionRevision: 'exec-1',
    usageRevision: 0,
    factCutoffMs: NOW,
    manifestVersion: 1,
    manifestJson: '{"version":1}',
    manifestDigest: 'd'.repeat(64),
    certainty: 'uncertain',
    coverage: 'partial',
    ...overrides
  };
}

function deliveryRow(overrides: Partial<NewDeliveryRow> = {}): NewDeliveryRow {
  return {
    intentId: 'i'.repeat(64),
    handoffId: HANDOFF_ID,
    revisionNo: 1,
    targetAttemptId: 'att-2',
    envelopeDigest: 'e'.repeat(64),
    transport: 'acp',
    backendId: 'claude',
    profileId: 'default',
    profileVersion: 'v1',
    ownerDigest: 'o'.repeat(64),
    sessionPlan: 'fresh-session',
    sessionReason: 'uncertain-prior',
    sessionId: null,
    connectionId: null,
    promptId: null,
    capabilitiesDigest: 'f'.repeat(64),
    accessPlanDigest: 'b'.repeat(64),
    decisionId: null,
    nowMs: NOW,
    ...overrides
  };
}

function withStore(body: (store: ReturnType<typeof createHandoffStore>, conn: NodeSqliteConnection) => void): void {
  const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
  try {
    body(createHandoffStore(conn), conn);
  } finally {
    conn.close();
  }
}

describe('FR-R6-F08 T008 — handoff store', () => {
  it('inserts a handoff once per id and per lineage, and reads it back frozen and camelCase', () => {
    withStore((store) => {
      expect(store.insertHandoff(handoffRow())).toBe(true);
      expect(store.insertHandoff(handoffRow({ nowMs: NOW + 5 }))).toBe(false);
      expect(store.insertHandoff(handoffRow({ handoffId: 'b'.repeat(64) }))).toBe(false);
      const row = store.getHandoff(HANDOFF_ID);
      expect(row).toEqual({
        handoffId: HANDOFF_ID,
        workspaceId: 'ws-1',
        rootExecutionId: 'root-1',
        invocationId: 'inv-1',
        sourceAttemptId: 'att-1',
        state: 'preparing',
        paused: false,
        closedReason: null,
        currentRevision: null,
        pinPurpose: null,
        pinPurposeTarget: null,
        legacyProvenance: null,
        createdAtMs: NOW,
        updatedAtMs: NOW
      });
      expect(Object.isFrozen(row)).toBe(true);
      expect(store.getHandoff('z'.repeat(64))).toBeUndefined();
    });
  });

  it('updates the handoff fields it is given and stamps updatedAtMs', () => {
    withStore((store) => {
      store.insertHandoff(handoffRow());
      store.updateHandoff(HANDOFF_ID, { state: 'ready', paused: true, pinPurpose: 'paused-recovery', currentRevision: 1 }, NOW + 9);
      const row = store.getHandoff(HANDOFF_ID);
      expect(row?.state).toBe('ready');
      expect(row?.paused).toBe(true);
      expect(row?.pinPurpose).toBe('paused-recovery');
      expect(row?.currentRevision).toBe(1);
      expect(row?.updatedAtMs).toBe(NOW + 9);
      expect(row?.createdAtMs).toBe(NOW);
      store.updateHandoff(HANDOFF_ID, { state: 'superseded', closedReason: 'superseded' }, NOW + 10);
      expect(store.getHandoff(HANDOFF_ID)?.closedReason).toBe('superseded');
      expect(store.listOpenHandoffs().map((handoff) => handoff.handoffId)).toEqual([]);
    });
  });

  it('inserts a revision once per cutoff and moves it only draft, issued, superseded', () => {
    withStore((store, conn) => {
      store.insertHandoff(handoffRow());
      expect(store.insertRevision(revisionRow())).toBe(true);
      expect(store.insertRevision(revisionRow())).toBe(false);
      expect(store.insertRevision(revisionRow({ revisionNo: 2 }))).toBe(false);
      expect(store.getRevisionByCutoff(HANDOFF_ID, 'c'.repeat(64))?.revisionNo).toBe(1);
      expect(store.maxRevisionNo(HANDOFF_ID)).toBe(1);
      expect(store.maxRevisionNo('z'.repeat(64))).toBe(0);

      expect(() => store.supersedeRevision(HANDOFF_ID, 1, NOW)).toThrow(/draft/);
      expect(store.issueRevision(HANDOFF_ID, 1, NOW + 1)).toBe(true);
      expect(store.issueRevision(HANDOFF_ID, 1, NOW + 2)).toBe(false);
      expect(store.getRevision(HANDOFF_ID, 1)?.issuedAtMs).toBe(NOW + 1);
      expect(() =>
        conn.run(`UPDATE recovery_handoff_revisions SET manifest_json = '{}' WHERE handoff_id = ?`, HANDOFF_ID)
      ).toThrow(/immutable/);
      expect(() => conn.run(`DELETE FROM recovery_handoff_revisions WHERE handoff_id = ?`, HANDOFF_ID)).toThrow(
        /immutable/
      );

      expect(store.supersedeRevision(HANDOFF_ID, 1, NOW + 3)).toBe(true);
      expect(store.supersedeRevision(HANDOFF_ID, 1, NOW + 4)).toBe(false);
      expect(() => store.issueRevision(HANDOFF_ID, 1, NOW + 5)).toThrow(/superseded/);
      const revision = store.getRevision(HANDOFF_ID, 1);
      expect(revision?.status).toBe('superseded');
      expect(revision?.supersededAtMs).toBe(NOW + 3);
      expect(Object.isFrozen(revision)).toBe(true);
      expect(() => store.issueRevision(HANDOFF_ID, 9, NOW)).toThrow(/not found/);
    });
  });

  it('inserts a reference once and records its pin state and resolution', () => {
    withStore((store) => {
      store.insertHandoff(handoffRow());
      store.insertRevision(revisionRow());
      const reference = {
        handoffId: HANDOFF_ID,
        revisionNo: 1,
        artifactId: 'art-1',
        role: 'validated' as const,
        required: true,
        expectedDigest: null
      };
      expect(store.insertReference(reference)).toBe(true);
      expect(store.insertReference(reference)).toBe(false);
      expect(store.insertReference({ ...reference, role: 'partial' })).toBe(false);
      store.setPinState(HANDOFF_ID, 1, 'art-1', 'refused', 'pin-quota-reached');
      store.setResolution(HANDOFF_ID, 1, 'art-1', 'missing', NOW + 1);
      const rows = store.listReferences(HANDOFF_ID, 1);
      expect(rows).toEqual([
        {
          handoffId: HANDOFF_ID,
          revisionNo: 1,
          artifactId: 'art-1',
          role: 'validated',
          required: true,
          expectedDigest: null,
          pinState: 'refused',
          pinRefusal: 'pin-quota-reached',
          lastResolution: 'missing',
          resolvedAtMs: NOW + 1
        }
      ]);
      expect(Object.isFrozen(rows.at(0))).toBe(true);
      expect(store.listReferencesForHandoff(HANDOFF_ID)).toHaveLength(1);
    });
  });

  it('inserts a delivery once per intent and per target attempt, and settles it once', () => {
    withStore((store) => {
      store.insertHandoff(handoffRow());
      store.insertRevision(revisionRow());
      expect(store.insertDelivery(deliveryRow())).toBe(true);
      expect(store.insertDelivery(deliveryRow())).toBe(false);
      expect(store.insertDelivery(deliveryRow({ intentId: 'j'.repeat(64) }))).toBe(false);
      const pending = store.getDelivery('i'.repeat(64));
      expect(pending?.outcome).toBe('pending');
      expect(pending?.sessionReason).toBe('uncertain-prior');
      expect(store.listPendingDeliveries().map((delivery) => delivery.intentId)).toEqual(['i'.repeat(64)]);

      expect(store.settleDelivery('i'.repeat(64), 'uncertain', 'restart-before-ack', NOW + 1)).toBe(true);
      expect(store.settleDelivery('i'.repeat(64), 'uncertain', 'restart-before-ack', NOW + 2)).toBe(false);
      const settled = store.getDelivery('i'.repeat(64));
      expect(settled?.outcome).toBe('uncertain');
      expect(settled?.outcomeReason).toBe('restart-before-ack');
      expect(settled?.settledAtMs).toBe(NOW + 1);
      expect(store.listPendingDeliveries()).toEqual([]);
      expect(store.listDeliveries(HANDOFF_ID)).toHaveLength(1);
    });
  });

  it('refuses a load-session delivery without a session id at the store', () => {
    withStore((store) => {
      store.insertHandoff(handoffRow());
      store.insertRevision(revisionRow());
      expect(() => store.insertDelivery(deliveryRow({ sessionPlan: 'load-session', sessionReason: null }))).toThrow(
        /CHECK/
      );
    });
  });

  it('inserts a decision once per id and marks it consumed by one intent', () => {
    withStore((store) => {
      store.insertHandoff(handoffRow());
      const decision = {
        decisionId: 'k'.repeat(64),
        handoffId: HANDOFF_ID,
        revisionNo: 1,
        decision: 'continue-new-attempt' as const,
        outcome: 'accepted' as const,
        nowMs: NOW
      };
      expect(store.insertDecision(decision)).toBe(true);
      expect(store.insertDecision({ ...decision, outcome: 'refused-stale' })).toBe(false);
      expect(store.markDecisionConsumed('k'.repeat(64), 'i'.repeat(64))).toBe(true);
      expect(store.markDecisionConsumed('k'.repeat(64), 'j'.repeat(64))).toBe(false);
      const row = store.getDecision('k'.repeat(64));
      expect(row).toEqual({
        decisionId: 'k'.repeat(64),
        handoffId: HANDOFF_ID,
        revisionNo: 1,
        decision: 'continue-new-attempt',
        outcome: 'accepted',
        consumedByIntentId: 'i'.repeat(64),
        recordedAtMs: NOW
      });
      expect(store.listDecisions(HANDOFF_ID)).toHaveLength(1);
    });
  });

  it('runs work in one immediate transaction and rolls it back on a throw', () => {
    withStore((store) => {
      expect(() =>
        store.transaction(() => {
          store.insertHandoff(handoffRow());
          throw new Error('boom');
        })
      ).toThrow('boom');
      expect(store.getHandoff(HANDOFF_ID)).toBeUndefined();
      expect(store.transaction(() => store.insertHandoff(handoffRow()))).toBe(true);
    });
  });
});
