// FR-R7-16 (`16-11`, FR-011) — restart-durable recovery envelope protection assessment,
// `handoff` F05 owner resolution wiring, and `DurableArtifactHandoverSeam` verification.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HandoffCutoff, HandoffLineage } from '../../../src/contracts/recovery-handoff/handoff-types';
import {
  buildDurableHandoffSeam,
  buildOwnerResolver,
  isRecoveryEnvelopeProtectedForServices,
  isRecoveryRunProtectedForServices
} from '../../../src/activation/sqlite-cutover-helpers';
import {
  createArtifactLifecycleService,
  DENY_ALL_ACCESS_POLICY
} from '../../../src/services/artifact-lifecycle';
import {
  assessRecoveryEnvelopeProtection,
  createRecoveryHandoffService,
  type RecoveryEnvelopePort
} from '../../../src/services/recovery-handoff';
import { assessRunSegmentProtection } from '../../../src/services/recovery-handoff/handoff-envelope-protection';
import { createHandoffStore } from '../../../src/services/recovery-handoff/handoff-store';
import { NodeSqliteConnection, SchemaBootstrapService, SqliteApplicationStore } from '../../../src/services/sqlite-store';
import type { WorkspaceStateStore } from '../../../src/state/workspace-state';
import { checkpointArtifact, lifecycleFixture, NOW } from '../artifact-lifecycle/lifecycle-fixture';

const RECORDED = 'a'.repeat(64);
const FROZEN = 'b'.repeat(64);
const CUTOFF: HandoffCutoff = { executionRevision: 'exec-1', usageRevision: 1, factCutoffMs: NOW };

const EMPTY_ENVELOPES: RecoveryEnvelopePort = {
  readRecoveryEnvelope: () => Promise.resolve(null),
  captureAndPersistCandidateHandover: () =>
    Promise.resolve({ ok: false, code: 'invalid-recovery-envelope', message: 'unused', diagnostics: [] })
};

const EMPTY_WORKSPACE_STORE = {
  getRunMap: () => ({}),
  getConnectedRuns: () => ({})
} as unknown as WorkspaceStateStore;

function manifestWithEnvelope(envelopeArtifactId: string | null, refIds: readonly string[] = []): Record<string, unknown> {
  return {
    version: 1,
    sourceOutcome: { status: 'incomplete', reason: 'work-remaining' },
    frozenDefinitionDigest: FROZEN,
    certainty: 'uncertain',
    coverage: 'partial',
    workspace: { entries: [], omittedCount: 0 },
    references: refIds.map((artifactId) => ({ artifactId, role: 'checkpoint', required: false })),
    excluded: [],
    contextId: null,
    envelope: envelopeArtifactId === null ? null : { artifactId: envelopeArtifactId, digest: RECORDED }
  };
}

function lineage(rootExecutionId: string, sourceAttemptId = 'att-1'): HandoffLineage {
  return {
    workspaceId: 'ws-1',
    rootExecutionId,
    invocationId: `inv-${sourceAttemptId}`,
    sourceAttemptId
  };
}

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('FR-R7-16 (16-11) — assessRecoveryEnvelopeProtection', () => {
  it('fails safe with lookup-error on null, closed, newer-build, or throwing connections', () => {
    expect(assessRecoveryEnvelopeProtection(null, 'run-1', 'hand-1')).toEqual({
      protected: true,
      decision: 'lookup-error'
    });

    const fixture = lifecycleFixture();
    fixture.conn.close();
    expect(assessRecoveryEnvelopeProtection(fixture.conn, 'run-1', 'hand-1')).toEqual({
      protected: true,
      decision: 'lookup-error'
    });

    const newer = lifecycleFixture();
    newer.conn.run(
      `INSERT INTO schema_migrations (version, name, checksum_sha256, applied_at_ms) VALUES (99, 'future', ?, ?)`,
      '0'.repeat(64),
      NOW
    );
    expect(assessRecoveryEnvelopeProtection(newer.conn, 'run-1', 'hand-1')).toEqual({
      protected: true,
      decision: 'lookup-error'
    });
    newer.conn.close();

    const throwingConn = {
      isClosed: () => false,
      scalar: () => {
        throw new Error('disk io failure');
      },
      all: () => {
        throw new Error('disk io failure');
      }
    } as unknown as NodeSqliteConnection;
    expect(assessRecoveryEnvelopeProtection(throwingConn, 'run-1', 'hand-1')).toEqual({
      protected: true,
      decision: 'lookup-error'
    });
  });

  it('protects exact open handoffs across restart and marks closed/unowned envelopes unowned', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-env-prot-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'state.db');

    let conn = new NodeSqliteConnection({ databasePath: dbPath });
    SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
    const buildService = (c: NodeSqliteConnection) => {
      const lifecycle = createArtifactLifecycleService({
        conn: c,
        nowMs: () => NOW,
        fs: {
          lstat: () => Promise.resolve(null),
          readdir: () => Promise.resolve([]),
          realpath: (p) => Promise.resolve(p),
          unlink: () => Promise.resolve()
        },
        probe: {
          observe: () => Promise.resolve({ exists: true, sizeBytes: 10, producerIdentity: null, generation: null }),
          digestSha256: () => Promise.resolve(RECORDED)
        },
        audit: { recordLifecycleMutation: () => undefined },
        scanRoots: [],
        accessPolicy: DENY_ALL_ACCESS_POLICY,
        resolveOwner: buildOwnerResolver(EMPTY_WORKSPACE_STORE, c),
        workspaceRoot: dir
      });
      return {
        lifecycle,
        handoffs: createRecoveryHandoffService({
          conn: c,
          lifecycle,
          probe: { digestSha256: () => Promise.resolve(RECORDED) },
          envelopes: EMPTY_ENVELOPES,
          clock: () => NOW
        })
      };
    };

    const first = buildService(conn);
    const prepared = first.handoffs.prepare(lineage('run-1'), CUTOFF, manifestWithEnvelope('hand-open'));
    if (!prepared.ok) throw new Error(prepared.code);
    conn.close();

    // Reopen on disk (simulated host restart) and assess directly from SQLite.
    conn = new NodeSqliteConnection({ databasePath: dbPath });
    expect(assessRecoveryEnvelopeProtection(conn, 'run-1', 'hand-open')).toEqual({
      protected: true,
      decision: 'protected'
    });
    expect(assessRecoveryEnvelopeProtection(conn, 'run-1', 'hand-unowned')).toEqual({
      protected: false,
      decision: 'unowned'
    });

    // Superseding closes the handoff so the envelope becomes affirmatively unowned.
    const second = buildService(conn);
    expect(second.handoffs.supersede(prepared.handoffId)).toEqual({ ok: true, state: 'superseded' });
    conn.close();

    conn = new NodeSqliteConnection({ databasePath: dbPath });
    expect(assessRecoveryEnvelopeProtection(conn, 'run-1', 'hand-open')).toEqual({
      protected: false,
      decision: 'unowned'
    });
    conn.close();
  });

  it('keeps envelopes ambiguous on lossy safeRunSegment collisions with open handoffs', () => {
    const fixture = lifecycleFixture();
    const lifecycle = fixture.build();
    const handoffs = createRecoveryHandoffService({
      conn: fixture.conn,
      lifecycle,
      probe: { digestSha256: () => Promise.resolve(RECORDED) },
      envelopes: EMPTY_ENVELOPES,
      clock: () => NOW
    });

    // Closed exact run_1 handoff, plus open lossy run.1 handoff both normalizing to `run_1`.
    const closedPrep = handoffs.prepare(lineage('run_1', 'att-closed'), CUTOFF, manifestWithEnvelope('hand-1'));
    if (!closedPrep.ok) throw new Error(closedPrep.code);
    expect(handoffs.supersede(closedPrep.handoffId)).toEqual({ ok: true, state: 'superseded' });

    const openLossyRun = handoffs.prepare(lineage('run.1', 'att-open'), CUTOFF, manifestWithEnvelope('hand-1'));
    if (!openLossyRun.ok) throw new Error(openLossyRun.code);

    expect(assessRecoveryEnvelopeProtection(fixture.conn, 'run_1', 'hand-1')).toEqual({
      protected: true,
      decision: 'ambiguous'
    });

    // Lossy handover segment: open handoff names `hand.2` which normalizes to `hand_2`.
    const openLossyHand = handoffs.prepare(lineage('run-exact', 'att-lossy-h'), CUTOFF, manifestWithEnvelope('hand.2'));
    if (!openLossyHand.ok) throw new Error(openLossyHand.code);
    expect(assessRecoveryEnvelopeProtection(fixture.conn, 'run-exact', 'hand_2')).toEqual({
      protected: true,
      decision: 'ambiguous'
    });
    expect(assessRecoveryEnvelopeProtection(fixture.conn, 'run-exact', 'hand-unrelated')).toEqual({
      protected: false,
      decision: 'unowned'
    });
    fixture.conn.close();
  });

  it('marks envelopes ambiguous when an open unsupported, future, or corrupt manifest sits under runSegment', () => {
    const fixture = lifecycleFixture();
    const store = createHandoffStore(fixture.conn);

    // 1. Unsupported open handoff under `run-unsupported`.
    store.insertHandoff({
      handoffId: '1'.repeat(64),
      workspaceId: 'ws-1',
      rootExecutionId: 'run-unsupported',
      invocationId: 'inv-1',
      sourceAttemptId: 'att-1',
      legacyProvenance: '{"kind":"unsupported-envelope","version":7}',
      nowMs: NOW
    });
    store.updateHandoff('1'.repeat(64), { state: 'unsupported' }, NOW);
    expect(assessRecoveryEnvelopeProtection(fixture.conn, 'run-unsupported', 'hand-any')).toEqual({
      protected: true,
      decision: 'ambiguous'
    });

    // 2. Future manifest_version > 1 under `run-future`.
    store.insertHandoff({
      handoffId: '2'.repeat(64),
      workspaceId: 'ws-1',
      rootExecutionId: 'run-future',
      invocationId: 'inv-2',
      sourceAttemptId: 'att-2',
      legacyProvenance: null,
      nowMs: NOW
    });
    store.insertRevision({
      handoffId: '2'.repeat(64),
      revisionNo: 1,
      cutoffKey: 'c'.repeat(64),
      executionRevision: 'exec-future',
      usageRevision: 0,
      factCutoffMs: NOW,
      manifestVersion: 2,
      manifestJson: '{"version":2}',
      manifestDigest: 'd'.repeat(64),
      certainty: 'uncertain',
      coverage: 'partial'
    });
    expect(assessRecoveryEnvelopeProtection(fixture.conn, 'run-future', 'hand-any')).toEqual({
      protected: true,
      decision: 'ambiguous'
    });

    // 3. Unreadable/corrupt manifest_json under `run-corrupt`.
    store.insertHandoff({
      handoffId: '3'.repeat(64),
      workspaceId: 'ws-1',
      rootExecutionId: 'run-corrupt',
      invocationId: 'inv-3',
      sourceAttemptId: 'att-3',
      legacyProvenance: null,
      nowMs: NOW
    });
    store.insertRevision({
      handoffId: '3'.repeat(64),
      revisionNo: 1,
      cutoffKey: 'e'.repeat(64),
      executionRevision: 'exec-corrupt',
      usageRevision: 0,
      factCutoffMs: NOW,
      manifestVersion: 1,
      manifestJson: '{not-valid-json',
      manifestDigest: 'f'.repeat(64),
      certainty: 'uncertain',
      coverage: 'partial'
    });
    expect(assessRecoveryEnvelopeProtection(fixture.conn, 'run-corrupt', 'hand-any')).toEqual({
      protected: true,
      decision: 'ambiguous'
    });
    fixture.conn.close();
  });

  it('honors active F05 protective pins via artifact_locations and artifact_id, releasing once unpinned', () => {
    const fixture = lifecycleFixture();
    const lifecycle = fixture.build();
    const reg = lifecycle.registerArtifact(
      checkpointArtifact('env-art-1', {
        ownerRunId: 'run-pin',
        locator: { storageTier: 'workspace_file', uriOrRelpath: 'checkpoints/run-pin/hand-pinned.recovery.json' }
      })
    );
    if (!reg.ok) throw new Error(reg.refusal.code);

    expect(assessRecoveryEnvelopeProtection(fixture.conn, 'run-pin', 'hand-pinned')).toEqual({
      protected: false,
      decision: 'unowned'
    });

    const pinned = lifecycle.addReference({
      artifactId: 'env-art-1',
      ownerType: 'run',
      ownerId: 'run-pin',
      purpose: 'active-recovery',
      protective: true
    });
    if (!pinned.ok) throw new Error(pinned.refusal.code);

    expect(assessRecoveryEnvelopeProtection(fixture.conn, 'run-pin', 'hand-pinned')).toEqual({
      protected: true,
      decision: 'protected'
    });

    const released = lifecycle.releaseReference({
      artifactId: 'env-art-1',
      ownerType: 'run',
      ownerId: 'run-pin',
      purpose: 'active-recovery',
      reason: 'owner-durable'
    });
    if (!released.ok) throw new Error(released.refusal.code);

    expect(assessRecoveryEnvelopeProtection(fixture.conn, 'run-pin', 'hand-pinned')).toEqual({
      protected: false,
      decision: 'unowned'
    });
    fixture.conn.close();
  });

  it('wires handoff owner resolution and read-pool envelope protection in sqlite-cutover-helpers', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-cutover-helper-'));
    tempDirs.push(dir);
    const store = new SqliteApplicationStore({ databasePath: path.join(dir, 'schegent-state.db') });
    try {
      const handoffStore = createHandoffStore(store.writerConnection);
      const id = '9'.repeat(64);
      handoffStore.insertHandoff({
        handoffId: id,
        workspaceId: 'ws-1',
        rootExecutionId: 'run-live',
        invocationId: 'inv-1',
        sourceAttemptId: 'att-1',
        legacyProvenance: null,
        nowMs: NOW
      });
      handoffStore.insertRevision({
        handoffId: id,
        revisionNo: 1,
        cutoffKey: 'c'.repeat(64),
        executionRevision: 'exec-1',
        usageRevision: 0,
        factCutoffMs: NOW,
        manifestVersion: 1,
        manifestJson: JSON.stringify(manifestWithEnvelope('hand-live')),
        manifestDigest: 'd'.repeat(64),
        certainty: 'uncertain',
        coverage: 'partial'
      });

      const resolver = buildOwnerResolver(EMPTY_WORKSPACE_STORE, store.writerConnection);
      expect(resolver('handoff', id)).toBe('live');
      expect(resolver('handoff', '0'.repeat(64))).toBe('unresolved');

      expect(isRecoveryEnvelopeProtectedForServices(null, 'run-live', 'hand-live')).toBe(true);
      expect(isRecoveryEnvelopeProtectedForServices({ sqliteStore: store }, 'run-live', 'hand-live')).toBe(true);
      expect(isRecoveryEnvelopeProtectedForServices({ sqliteStore: store }, 'run-live', 'hand-unowned')).toBe(false);

      handoffStore.updateHandoff(id, { state: 'consumed', closedReason: 'delivered' }, NOW + 1);
      expect(resolver('handoff', id)).toBe('settled');
      expect(isRecoveryEnvelopeProtectedForServices({ sqliteStore: store }, 'run-live', 'hand-live')).toBe(false);
    } finally {
      store.close();
    }
  });

  it('refuses non-present or unsupported store-kind artifacts in buildDurableHandoffSeam', () => {
    const fixture = lifecycleFixture();
    const lifecycle = fixture.build();
    expect(lifecycle.registerArtifact(checkpointArtifact('art-ok', { storeKind: 'report' })).ok).toBe(true);
    expect(lifecycle.registerArtifact(checkpointArtifact('art-transcript', { storeKind: 'transcript' })).ok).toBe(true);
    expect(lifecycle.registerArtifact(checkpointArtifact('art-missing', { storeKind: 'report' })).ok).toBe(true);
    fixture.conn.run(`UPDATE artifact_lifecycle SET availability = 'missing' WHERE artifact_id = 'art-missing'`);

    const seam = buildDurableHandoffSeam(lifecycle, fixture.conn);
    expect(seam.requestHandover({ rootExecutionId: 'r1', invocationId: 'i1', artifactIds: ['art-ok'] })).toEqual({
      accepted: true
    });
    expect(
      seam.requestHandover({ rootExecutionId: 'r1', invocationId: 'i1', artifactIds: ['art-transcript'] })
    ).toMatchObject({
      accepted: false,
      refusal: { reasonCode: 'durable-handoff-artifact-unsupported:transcript' }
    });
    expect(
      seam.requestHandover({ rootExecutionId: 'r1', invocationId: 'i1', artifactIds: ['art-missing'] })
    ).toMatchObject({
      accepted: false,
      refusal: { reasonCode: 'durable-handoff-artifact-unavailable:missing' }
    });
    fixture.conn.close();
  });

  it('assesses cross-run directory protection via assessRunSegmentProtection and isRecoveryRunProtectedForServices (SR-B2)', async () => {
    // 1. Fail-closed on null, closed, newer-build, or throwing connections.
    expect(assessRunSegmentProtection(null, 'run-1')).toEqual({ protected: true, decision: 'lookup-error' });
    expect(isRecoveryRunProtectedForServices(null, 'run-1')).toBe(true);

    const closedFixture = lifecycleFixture();
    closedFixture.conn.close();
    expect(assessRunSegmentProtection(closedFixture.conn, 'run-1')).toEqual({
      protected: true,
      decision: 'lookup-error'
    });

    const newer = lifecycleFixture();
    newer.conn.run(
      `INSERT INTO schema_migrations (version, name, checksum_sha256, applied_at_ms) VALUES (99, 'future', ?, ?)`,
      '0'.repeat(64),
      NOW
    );
    expect(assessRunSegmentProtection(newer.conn, 'run-1')).toEqual({ protected: true, decision: 'lookup-error' });
    newer.conn.close();

    const throwingConn = {
      isClosed: () => false,
      scalar: () => {
        throw new Error('io failure');
      },
      all: () => {
        throw new Error('io failure');
      }
    } as unknown as NodeSqliteConnection;
    expect(assessRunSegmentProtection(throwingConn, 'run-1')).toEqual({
      protected: true,
      decision: 'lookup-error'
    });

    // 2. Open handoffs (exact + lossy safeRunSegment) and active F05 protective pins (owner_run_id + checkpoints/ path).
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-run-seg-prot-'));
    tempDirs.push(dir);
    const store = new SqliteApplicationStore({ databasePath: path.join(dir, 'schegent-state.db') });
    try {
      const lifecycle = createArtifactLifecycleService({
        conn: store.writerConnection,
        nowMs: () => NOW,
        fs: {
          lstat: () => Promise.resolve(null),
          readdir: () => Promise.resolve([]),
          realpath: (p) => Promise.resolve(p),
          unlink: () => Promise.resolve()
        },
        probe: {
          observe: () => Promise.resolve({ exists: true, sizeBytes: 10, producerIdentity: null, generation: null }),
          digestSha256: () => Promise.resolve(RECORDED)
        },
        audit: { recordLifecycleMutation: () => undefined },
        scanRoots: [],
        accessPolicy: DENY_ALL_ACCESS_POLICY,
        resolveOwner: buildOwnerResolver(EMPTY_WORKSPACE_STORE, store.writerConnection),
        workspaceRoot: dir
      });
      const handoffs = createRecoveryHandoffService({
        conn: store.writerConnection,
        lifecycle,
        probe: { digestSha256: () => Promise.resolve(RECORDED) },
        envelopes: EMPTY_ENVELOPES,
        clock: () => NOW
      });

      const exactH = handoffs.prepare(lineage('run-open-exact', 'att-1'), CUTOFF, manifestWithEnvelope('hand-1'));
      const lossyH = handoffs.prepare(lineage('run.lossy:1', 'att-2'), CUTOFF, manifestWithEnvelope('hand-2'));
      if (!exactH.ok || !lossyH.ok) throw new Error('prepare failed');

      expect(assessRunSegmentProtection(store.writerConnection, 'run-open-exact')).toEqual({
        protected: true,
        decision: 'protected'
      });
      expect(assessRunSegmentProtection(store.writerConnection, 'run_lossy_1')).toEqual({
        protected: true,
        decision: 'ambiguous'
      });
      expect(assessRunSegmentProtection(store.writerConnection, 'run-unowned')).toEqual({
        protected: false,
        decision: 'unowned'
      });
      expect(isRecoveryRunProtectedForServices({ sqliteStore: store }, 'run-open-exact')).toBe(true);
      expect(isRecoveryRunProtectedForServices({ sqliteStore: store }, 'run_lossy_1')).toBe(true);
      expect(isRecoveryRunProtectedForServices({ sqliteStore: store }, 'run-unowned')).toBe(false);

      // Active F05 protective pin via checkpoints/<runSegment>/ location without owner_run_id matching.
      expect(
        lifecycle.registerArtifact(
          checkpointArtifact('pin-by-path', {
            ownerRunId: 'run-other-owner',
            locator: { storageTier: 'workspace_file', uriOrRelpath: 'checkpoints/run-path-pin/hand-p.recovery.json' }
          })
        ).ok
      ).toBe(true);
      expect(
        lifecycle.addReference({
          artifactId: 'pin-by-path',
          ownerType: 'export',
          ownerId: 'exp-1',
          purpose: 'active-recovery',
          protective: true
        }).ok
      ).toBe(true);
      expect(assessRunSegmentProtection(store.writerConnection, 'run-path-pin')).toEqual({
        protected: true,
        decision: 'protected'
      });
      expect(assessRunSegmentProtection(store.writerConnection, 'run-other-owner')).toEqual({
        protected: true,
        decision: 'protected'
      });

      // Releasing pin and closing handoffs releases protection cleanly.
      expect(
        lifecycle.releaseReference({
          artifactId: 'pin-by-path',
          ownerType: 'export',
          ownerId: 'exp-1',
          purpose: 'active-recovery',
          reason: 'owner-durable'
        }).ok
      ).toBe(true);
      expect(handoffs.supersede(exactH.handoffId)).toEqual({ ok: true, state: 'superseded' });
      expect(handoffs.supersede(lossyH.handoffId)).toEqual({ ok: true, state: 'superseded' });

      expect(assessRunSegmentProtection(store.writerConnection, 'run-open-exact')).toEqual({
        protected: false,
        decision: 'unowned'
      });
      expect(assessRunSegmentProtection(store.writerConnection, 'run_lossy_1')).toEqual({
        protected: false,
        decision: 'unowned'
      });
      expect(assessRunSegmentProtection(store.writerConnection, 'run-path-pin')).toEqual({
        protected: false,
        decision: 'unowned'
      });
    } finally {
      store.close();
    }
  });
});
