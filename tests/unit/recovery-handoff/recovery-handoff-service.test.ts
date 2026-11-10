// FR-R6-F08 T014 — the recovery handoff service, US1 (prepare, issue, resolve).
//
// WHAT THIS PINS:
//   - `assessAttempt` reports a missing envelope as `context-missing`, a newer envelope as
//     `unsupported-version`, any other invalid one as `context-invalid`;
//   - `captureCandidate` reports a failed capture as `capture-failed` with its diagnostic code;
//   - 100 identical `prepare` calls leave one handoff and one revision (SC-002);
//   - validated and partial references keep their roles and required flags;
//   - the stored manifest keeps the attribution counts and the certainty it was given;
//   - a new cutoff after issue makes revision 2; issuing it supersedes revision 1, whose stored
//     manifest stays byte-identical;
//   - a required reference F05 cannot pin refuses `prepare` and `issue` with its artifact id.
//
// T018 adds US2 (recordIntent, acknowledge, reportNotSent, consume, reopen):
//   - 100 identical intents leave one row; a repeat with a different field is `conflict`;
//   - 100 acknowledgements leave one outcome, `duplicate: true` after the first;
//   - reopen moves a pending intent and its handoff to `uncertain`;
//   - a reused target attempt is refused; a failed delivery releases no pin.
//
// T025 adds US4 (decide, setHandoffPaused, supersede, explain):
//   - a decision against revision 2 when 3 is current is stored `refused-stale` and never
//     consumed: it permits no attempt;
//   - a decision on a closed handoff is stored `refused-closed`;
//   - `abandon` consumes with `closed_reason` `abandoned` and releases every pin;
//   - a repeated request returns the stored decision; a different decision under it is `conflict`;
//   - pause moves the pins to `paused-recovery` and back, with none lost;
//   - `supersede` closes the handoff and its current revision and releases every pin;
//   - `explain` returns the explanation and writes no row.
//
// T029 adds US5 (importLegacy):
//   - a legacy record prepares a handoff under its own ids, idempotently, with its provenance;
//   - a paused record pins with `paused-recovery`; unregistered legacy references do not block;
//   - an unknown envelope version stores an `unsupported` handoff with no revision, which
//     resolves `unsupported-version` and stays `live` for its owner;
//   - an invalid record writes nothing; an existing handoff under the lineage is `conflict`.

import { describe, expect, it } from 'vitest';
import type { RecoveryEnvelope, RecoveryEnvelopeSerializeResult } from '../../../src/contracts/recovery-envelope';
import type { HandoffCutoff, HandoffLineage, SessionOwner } from '../../../src/contracts/recovery-handoff/handoff-types';
import { createHandoffStore } from '../../../src/services/recovery-handoff/handoff-store';
import { decisionIdFor } from '../../../src/services/recovery-handoff/handoff-identity';
import {
  createRecoveryHandoffService,
  type LegacyHandoffRecord,
  type RecordIntentInput,
  type RecoveryEnvelopePort,
  type RecoveryHandoffService
} from '../../../src/services/recovery-handoff';
import type { NodeSqliteConnection } from '../../../src/services/sqlite-store';
import type { ArtifactLifecycleService } from '../../../src/services/artifact-lifecycle';
import { checkpointArtifact, lifecycleFixture, NOW } from '../artifact-lifecycle/lifecycle-fixture';

const RECORDED = 'a'.repeat(64);
const FROZEN = 'b'.repeat(64);

const LINEAGE: HandoffLineage = {
  workspaceId: 'ws-1',
  rootExecutionId: 'root-1',
  invocationId: 'inv-1',
  sourceAttemptId: 'att-1'
};

const CUTOFF_1: HandoffCutoff = { executionRevision: 'exec-1', usageRevision: 4, factCutoffMs: NOW };
const CUTOFF_2: HandoffCutoff = { executionRevision: 'exec-2', usageRevision: 5, factCutoffMs: NOW + 1_000 };

function manifest(): Record<string, unknown> {
  return {
    version: 1,
    sourceOutcome: { status: 'incomplete', reason: 'work-remaining' },
    frozenDefinitionDigest: FROZEN,
    certainty: 'uncertain',
    coverage: 'partial',
    workspace: {
      entries: [
        { path: 'src/app.ts', attribution: 'attempt' },
        { path: 'src/util.ts', attribution: 'attempt' },
        { path: 'README.md', attribution: 'preexisting' }
      ],
      omittedCount: 3
    },
    references: [
      { artifactId: 'art-validated-1', role: 'validated', required: true, digest: RECORDED },
      { artifactId: 'art-partial-1', role: 'partial', required: false }
    ],
    excluded: [{ itemId: 'transcript-1', reason: 'raw-transcript' }],
    contextId: null,
    envelope: { artifactId: 'env-1', digest: RECORDED }
  };
}

function envelope(): RecoveryEnvelope {
  return {
    version: 1,
    invocationId: 'inv-1',
    upstreamArtifactRefs: [],
    partialArtifactRefs: [],
    workspace: { coverage: 'partial', omittedCount: 0, entries: [] },
    effects: { certainty: 'uncertain', evidenceRefs: [] },
    truncated: false
  };
}

interface FakePort extends RecoveryEnvelopePort {
  stored: unknown;
  capture: RecoveryEnvelopeSerializeResult;
}

function fakePort(): FakePort {
  const port: FakePort = {
    stored: null,
    capture: { ok: true, handover: envelope(), serialized: '{}', byteLength: 2 },
    readRecoveryEnvelope: () => {
      if (port.stored === null) return Promise.resolve(null);
      const version: unknown = (port.stored as { version?: unknown }).version;
      return Promise.resolve(
        version === 1
          ? { ok: true as const, value: port.stored as RecoveryEnvelope, diagnostics: [] as const }
          : {
              ok: false as const,
              diagnostics: [{ code: 'unsupported-recovery-envelope-version' as const, field: 'version', message: 'newer' }]
            }
      );
    },
    captureAndPersistCandidateHandover: () => Promise.resolve(port.capture)
  };
  return port;
}

interface Harness {
  readonly conn: NodeSqliteConnection;
  readonly lifecycle: ArtifactLifecycleService;
  readonly port: FakePort;
  readonly service: RecoveryHandoffService;
}

function harness(registered: readonly string[] = ['art-validated-1', 'art-partial-1']): Harness {
  const fixture = lifecycleFixture();
  const lifecycle = fixture.build();
  for (const artifactId of registered) {
    const result = lifecycle.registerArtifact(checkpointArtifact(artifactId));
    if (!result.ok) throw new Error(`register failed: ${result.refusal.code}`);
  }
  const port = fakePort();
  const service = createRecoveryHandoffService({
    conn: fixture.conn,
    lifecycle,
    probe: { digestSha256: () => Promise.resolve(RECORDED) },
    envelopes: port,
    clock: () => NOW + 5
  });
  return { conn: fixture.conn, lifecycle, port, service };
}

function count(conn: NodeSqliteConnection, table: string): number {
  return conn.scalar<number>(`SELECT COUNT(*) FROM ${table}`) ?? -1;
}

function preparedAndIssued(h: Harness, overrides: Record<string, unknown> = {}): string {
  const prepared = h.service.prepare(LINEAGE, CUTOFF_1, { ...manifest(), ...overrides });
  if (!prepared.ok) throw new Error(prepared.code);
  const issued = h.service.issue(prepared.handoffId, prepared.revisionNo);
  if (!issued.ok) throw new Error(issued.code);
  return prepared.handoffId;
}

describe('FR-R6-F08 T014 — assessAttempt and captureCandidate', () => {
  it('reports a missing envelope as context-missing', async () => {
    const h = harness();
    expect(await h.service.assessAttempt('run-1', 'hand-1')).toEqual({ ok: false, code: 'context-missing' });
  });

  it('reports a newer envelope as unsupported-version', async () => {
    const h = harness();
    h.port.stored = { ...envelope(), version: 2 };
    const result = await h.service.assessAttempt('run-1', 'hand-1');
    expect(result.ok ? 'ok' : result.code).toBe('unsupported-version');
  });

  it('reports any other invalid envelope as context-invalid', async () => {
    const h = harness();
    const port: RecoveryEnvelopePort = {
      ...h.port,
      readRecoveryEnvelope: () =>
        Promise.resolve({ ok: false, diagnostics: [{ code: 'invalid-recovery-envelope-field', field: 'workspace', message: 'bad' }] })
    };
    const fixture = lifecycleFixture();
    const service = createRecoveryHandoffService({
      conn: fixture.conn,
      lifecycle: fixture.build(),
      probe: { digestSha256: () => Promise.resolve(null) },
      envelopes: port,
      clock: () => NOW
    });
    const result = await service.assessAttempt('run-1', 'hand-1');
    expect(result.ok ? 'ok' : result.code).toBe('context-invalid');
  });

  it('returns a valid envelope with a stable 64-hex digest', async () => {
    const h = harness();
    h.port.stored = envelope();
    const first = await h.service.assessAttempt('run-1', 'hand-1');
    const second = await h.service.assessAttempt('run-1', 'hand-1');
    if (!first.ok || !second.ok) throw new Error('expected ok');
    expect(first.envelope).toEqual(envelope());
    expect(first.envelopeDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(second.envelopeDigest).toBe(first.envelopeDigest);
  });

  it('reports a failed capture as capture-failed with the envelope diagnostic code', async () => {
    const h = harness();
    h.port.capture = { ok: false, code: 'recovery-context-too-large', message: 'too large', diagnostics: [] };
    expect(await h.service.captureCandidate('run-1', 'hand-1', { invocationId: 'inv-1' })).toEqual({
      ok: false,
      code: 'capture-failed',
      diagnostic: 'recovery-context-too-large'
    });
  });

  it('returns the digest, coverage and certainty of a captured envelope', async () => {
    const h = harness();
    const result = await h.service.captureCandidate('run-1', 'hand-1', { invocationId: 'inv-1' });
    h.port.stored = envelope();
    const assessed = await h.service.assessAttempt('run-1', 'hand-1');
    if (!result.ok || !assessed.ok) throw new Error('expected ok');
    expect(result.coverage).toBe('partial');
    expect(result.certainty).toBe('uncertain');
    expect(result.envelopeDigest).toBe(assessed.envelopeDigest);
  });
});

describe('FR-R6-F08 T014 — prepare', () => {
  it('leaves one handoff and one revision after 100 identical prepares (SC-002)', async () => {
    const h = harness();
    const results = [];
    for (let i = 0; i < 100; i += 1) results.push(h.service.prepare(LINEAGE, CUTOFF_1, manifest()));
    const ids = new Set(results.map((result) => (result.ok ? `${result.handoffId}#${result.revisionNo}` : result.code)));
    expect(ids.size).toBe(1);
    expect(results.filter((result) => result.ok && result.created).length).toBe(1);
    expect(count(h.conn, 'recovery_handoffs')).toBe(1);
    expect(count(h.conn, 'recovery_handoff_revisions')).toBe(1);
    expect(count(h.conn, 'recovery_handoff_references')).toBe(2);
  });

  it('keeps validated and partial references under their roles, pinned', async () => {
    const h = harness();
    const prepared = h.service.prepare(LINEAGE, CUTOFF_1, manifest());
    if (!prepared.ok) throw new Error(prepared.code);
    expect(prepared.state).toBe('preparing');
    expect(prepared.pinRefusals).toEqual([]);
    const rows = createHandoffStore(h.conn).listReferences(prepared.handoffId, prepared.revisionNo);
    expect(rows.map((row) => `${row.artifactId}:${row.role}:${row.required}:${row.pinState}`)).toEqual([
      'art-partial-1:partial:false:pinned',
      'art-validated-1:validated:true:pinned'
    ]);
    expect(rows.find((row) => row.artifactId === 'art-validated-1')?.expectedDigest).toBe(RECORDED);
  });

  it('stores the manifest with its attribution counts and certainty unchanged', async () => {
    const h = harness();
    const prepared = h.service.prepare(LINEAGE, CUTOFF_1, manifest());
    if (!prepared.ok) throw new Error(prepared.code);
    const revision = createHandoffStore(h.conn).getRevision(prepared.handoffId, 1);
    expect(revision?.certainty).toBe('uncertain');
    expect(revision?.coverage).toBe('partial');
    const stored = JSON.parse(revision?.manifestJson ?? '{}') as {
      workspace: { entries: { attribution: string }[]; omittedCount: number };
    };
    const attributions = stored.workspace.entries.map((entry) => entry.attribution);
    expect(attributions.filter((value) => value === 'attempt').length).toBe(2);
    expect(attributions.filter((value) => value === 'preexisting').length).toBe(1);
    expect(stored.workspace.omittedCount).toBe(3);
  });

  it('refuses an invalid manifest and writes nothing', async () => {
    const h = harness();
    const result = h.service.prepare(LINEAGE, CUTOFF_1, { ...manifest(), certainty: 'sure' });
    expect(result.ok ? 'ok' : result.code).toBe('invalid');
    expect(count(h.conn, 'recovery_handoffs')).toBe(0);
  });

  it('refuses a lineage id that is not an opaque id and writes nothing', async () => {
    const h = harness();
    const result = h.service.prepare({ ...LINEAGE, workspaceId: '/abs/path' }, CUTOFF_1, manifest());
    expect(result.ok ? 'ok' : result.code).toBe('invalid');
    expect(count(h.conn, 'recovery_handoffs')).toBe(0);
  });

  it('refuses a closed handoff with handoff-closed', async () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    createHandoffStore(h.conn).updateHandoff(handoffId, { state: 'superseded', closedReason: 'superseded' }, NOW);
    const result = h.service.prepare(LINEAGE, CUTOFF_2, manifest());
    expect(result.ok ? 'ok' : result.code).toBe('handoff-closed');
  });

  it('refuses a required reference F05 cannot pin, naming it, and issue refuses too', async () => {
    const h = harness(['art-partial-1']);
    const prepared = h.service.prepare(LINEAGE, CUTOFF_1, manifest());
    expect(prepared).toEqual({ ok: false, code: 'required-pin-refused', artifactIds: ['art-validated-1'] });
    const store = createHandoffStore(h.conn);
    const handoff = store.listOpenHandoffs().at(0);
    expect(handoff?.state).toBe('preparing');
    const issued = h.service.issue(handoff?.handoffId ?? '', 1);
    expect(issued).toEqual({ ok: false, code: 'required-pin-refused', artifactIds: ['art-validated-1'] });
  });

  it('lists a refused optional pin and still prepares', async () => {
    const h = harness(['art-validated-1']);
    const prepared = h.service.prepare(LINEAGE, CUTOFF_1, manifest());
    if (!prepared.ok) throw new Error(prepared.code);
    expect(prepared.pinRefusals.map((refusal) => refusal.artifactId)).toEqual(['art-partial-1']);
  });
});

describe('FR-R6-F08 T014 — issue and revisions', () => {
  it('moves a prepared handoff to ready and repeats unchanged', async () => {
    const h = harness();
    const prepared = h.service.prepare(LINEAGE, CUTOFF_1, manifest());
    if (!prepared.ok) throw new Error(prepared.code);
    expect(h.service.issue(prepared.handoffId, 1)).toEqual({ ok: true, state: 'ready', revisionNo: 1 });
    expect(h.service.issue(prepared.handoffId, 1)).toEqual({ ok: true, state: 'ready', revisionNo: 1 });
    const handoff = createHandoffStore(h.conn).getHandoff(prepared.handoffId);
    expect(handoff?.state).toBe('ready');
    expect(handoff?.currentRevision).toBe(1);
  });

  it('refuses an unknown handoff or revision with not-found', async () => {
    const h = harness();
    expect(h.service.issue('f'.repeat(64), 1)).toEqual({ ok: false, code: 'not-found' });
    const handoffId = preparedAndIssued(h);
    expect(h.service.issue(handoffId, 9)).toEqual({ ok: false, code: 'not-found' });
  });

  it('makes revision 2 for a new cutoff and supersedes revision 1 byte-identically on issue', async () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    const store = createHandoffStore(h.conn);
    const before = store.getRevision(handoffId, 1)?.manifestJson;
    const second = h.service.prepare(LINEAGE, CUTOFF_2, manifest());
    if (!second.ok) throw new Error(second.code);
    expect(second.revisionNo).toBe(2);
    expect(second.created).toBe(true);
    expect(h.service.issue(handoffId, 2)).toEqual({ ok: true, state: 'ready', revisionNo: 2, supersededRevision: 1 });
    const first = store.getRevision(handoffId, 1);
    expect(first?.status).toBe('superseded');
    expect(first?.manifestJson).toBe(before);
    expect(store.getHandoff(handoffId)?.currentRevision).toBe(2);
  });

  it('refuses to issue a superseded revision with stale-revision', async () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    h.service.prepare(LINEAGE, CUTOFF_2, manifest());
    h.service.issue(handoffId, 2);
    expect(h.service.issue(handoffId, 1)).toEqual({ ok: false, code: 'stale-revision' });
  });

  it('refuses to issue while a delivery is in flight with conflict', async () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    h.service.prepare(LINEAGE, CUTOFF_2, manifest());
    createHandoffStore(h.conn).updateHandoff(handoffId, { state: 'delivering' }, NOW);
    expect(h.service.issue(handoffId, 2)).toEqual({ ok: false, code: 'conflict' });
  });
});

describe('FR-R6-F08 T014 — resolve and ownerResolution', () => {
  it('resolves the current revision as usable and reports the owner live', async () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    const resolved = await h.service.resolve(handoffId);
    if (!resolved.ok) throw new Error(resolved.code);
    expect(resolved.status).toBe('usable');
    expect(resolved.references.map((ref) => ref.resolution)).toEqual(['available', 'available']);
    expect(h.service.ownerResolution(handoffId)).toBe('live');
  });

  it('refuses to resolve an unknown handoff with not-found', async () => {
    const h = harness();
    expect(await h.service.resolve('f'.repeat(64))).toEqual({ ok: false, code: 'not-found' });
  });
});

const OWNER: SessionOwner = { agentId: 'agent-1', accountScope: 'acct-1' };

function intent(handoffId: string, overrides: Partial<RecordIntentInput> = {}): RecordIntentInput {
  return {
    handoffId,
    revisionNo: 1,
    targetAttemptId: 'att-2',
    envelopeDigest: RECORDED,
    transport: 'acp',
    backendId: 'backend-1',
    profileId: 'profile-1',
    profileVersion: '1',
    connectionId: 'conn-1',
    capabilitiesDigest: RECORDED,
    accessPlanDigest: RECORDED,
    owner: OWNER,
    sessionCapability: 'declared',
    ...overrides
  };
}

function recorded(h: Harness, input: RecordIntentInput): string {
  const result = h.service.recordIntent(input);
  if (!result.ok) throw new Error(result.code);
  return result.intentId;
}

function activePins(conn: NodeSqliteConnection, handoffId: string): number {
  return (
    conn.scalar<number>(
      `SELECT COUNT(*) FROM artifact_references
       WHERE owner_type = 'handoff' AND owner_id = ? AND released_revision IS NULL`,
      handoffId
    ) ?? -1
  );
}

const DECISION_ID = 'd'.repeat(64);

function acceptedDecision(h: Harness, handoffId: string, decisionId = DECISION_ID): void {
  createHandoffStore(h.conn).insertDecision({
    decisionId,
    handoffId,
    revisionNo: 1,
    decision: 'continue-new-attempt',
    outcome: 'accepted',
    nowMs: NOW
  });
}

describe('FR-R6-F08 T018 — recordIntent', () => {
  it('leaves one intent row for 100 identical calls, duplicate after the first', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    const results = Array.from({ length: 100 }, () => h.service.recordIntent(intent(handoffId)));
    expect(results.at(0)).toMatchObject({ ok: true, duplicate: false });
    expect(results.slice(1).every((result) => result.ok && result.duplicate)).toBe(true);
    expect(new Set(results.map((result) => (result.ok ? result.intentId : result.code))).size).toBe(1);
    expect(count(h.conn, 'recovery_handoff_deliveries')).toBe(1);
    expect(createHandoffStore(h.conn).getHandoff(handoffId)?.state).toBe('delivering');
  });

  it('plans a fresh session with no prior session, and loads a matching ACP session', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    expect(h.service.recordIntent(intent(handoffId))).toMatchObject({
      sessionPlan: { plan: 'fresh-session', reason: 'no-prior-session' }
    });
    const other = harness();
    const otherId = preparedAndIssued(other);
    const priorSession = {
      sessionId: 'sess-1',
      source: 'acp' as const,
      owner: OWNER,
      backendId: 'backend-1',
      profileId: 'profile-1',
      profileVersion: '1',
      capabilitiesDigest: RECORDED
    };
    expect(other.service.recordIntent(intent(otherId, { priorSession }))).toMatchObject({
      sessionPlan: { plan: 'load-session', sessionId: 'sess-1' }
    });
    const stored = createHandoffStore(other.conn).listDeliveries(otherId).at(0);
    expect(stored?.sessionId).toBe('sess-1');
  });

  it('refuses a repeat with a different field as conflict', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    recorded(h, intent(handoffId));
    expect(h.service.recordIntent(intent(handoffId, { envelopeDigest: FROZEN }))).toEqual({ ok: false, code: 'conflict' });
    expect(h.service.recordIntent(intent(handoffId, { connectionId: 'conn-2' }))).toEqual({ ok: false, code: 'conflict' });
  });

  it('refuses a reused target attempt, the source attempt included', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h, { certainty: 'safe' });
    const first = recorded(h, intent(handoffId));
    expect(h.service.reportNotSent(first)).toEqual({ ok: true });
    expect(h.service.recordIntent(intent(handoffId, { targetAttemptId: 'att-1' }))).toEqual({
      ok: false,
      code: 'attempt-reused'
    });
  });

  it('refuses an unknown handoff, an invalid field and a stale revision', () => {
    const h = harness();
    expect(h.service.recordIntent(intent('f'.repeat(64)))).toEqual({ ok: false, code: 'not-found' });
    const handoffId = preparedAndIssued(h);
    expect(h.service.recordIntent(intent(handoffId, { envelopeDigest: 'nope' }))).toEqual({
      ok: false,
      code: 'invalid',
      field: 'envelopeDigest'
    });
    expect(h.service.recordIntent(intent(handoffId, { revisionNo: 2 }))).toEqual({ ok: false, code: 'stale-revision' });
    expect(count(h.conn, 'recovery_handoff_deliveries')).toBe(0);
  });

  it('permits a new attempt automatically after a refused-before-send intent under safe certainty', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h, { certainty: 'safe' });
    h.service.reportNotSent(recorded(h, intent(handoffId)));
    const next = h.service.recordIntent(intent(handoffId, { targetAttemptId: 'att-3', connectionId: 'conn-2' }));
    expect(next).toMatchObject({ ok: true, duplicate: false });
  });

  it('needs a decision under uncertain certainty, and the decision permits exactly one attempt', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    h.service.reportNotSent(recorded(h, intent(handoffId)));
    const second = intent(handoffId, { targetAttemptId: 'att-3', connectionId: 'conn-2' });
    expect(h.service.recordIntent(second)).toEqual({ ok: false, code: 'new-connection-refused' });
    acceptedDecision(h, handoffId);
    const permitted = h.service.recordIntent(second);
    expect(permitted).toMatchObject({ ok: true, sessionPlan: { plan: 'fresh-session', reason: 'uncertain-prior' } });
    const store = createHandoffStore(h.conn);
    const intentId = permitted.ok ? permitted.intentId : '';
    expect(store.getDecision(DECISION_ID)?.consumedByIntentId).toBe(intentId);
    expect(store.getDelivery(intentId)?.decisionId).toBe(DECISION_ID);
    h.service.reportNotSent(intentId);
    const third = intent(handoffId, { targetAttemptId: 'att-4', connectionId: 'conn-3' });
    expect(h.service.recordIntent(third)).toEqual({ ok: false, code: 'new-connection-refused' });
  });
});

describe('FR-R6-F08 T018 — acknowledge, reportNotSent, consume', () => {
  it('leaves one outcome for 100 acknowledgements, duplicate after the first', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    const intentId = recorded(h, intent(handoffId));
    const results = Array.from({ length: 100 }, () => h.service.acknowledge(intentId));
    expect(results.at(0)).toEqual({ ok: true, duplicate: false });
    expect(results.slice(1).every((result) => result.ok && result.duplicate)).toBe(true);
    const store = createHandoffStore(h.conn);
    expect(store.getDelivery(intentId)?.outcome).toBe('acknowledged');
    expect(store.getHandoff(handoffId)?.state).toBe('acknowledged');
  });

  it('refuses to acknowledge a refused intent, and an unknown one', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    const intentId = recorded(h, intent(handoffId));
    expect(h.service.reportNotSent(intentId)).toEqual({ ok: true });
    expect(h.service.reportNotSent(intentId)).toEqual({ ok: true });
    expect(h.service.acknowledge(intentId)).toEqual({ ok: false, code: 'conflict' });
    expect(h.service.acknowledge('f'.repeat(64))).toEqual({ ok: false, code: 'not-found' });
    expect(h.service.reportNotSent('f'.repeat(64))).toEqual({ ok: false, code: 'not-found' });
  });

  it('returns the handoff to ready on reportNotSent and refuses it for an acknowledged intent', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    const intentId = recorded(h, intent(handoffId));
    h.service.reportNotSent(intentId);
    const store = createHandoffStore(h.conn);
    expect(store.getDelivery(intentId)).toMatchObject({ outcome: 'refused', outcomeReason: 'not-sent' });
    expect(store.getHandoff(handoffId)?.state).toBe('ready');
    acceptedDecision(h, handoffId);
    const other = recorded(h, intent(handoffId, { targetAttemptId: 'att-3' }));
    h.service.acknowledge(other);
    expect(h.service.reportNotSent(other)).toEqual({ ok: false, code: 'conflict' });
  });

  it('consumes only an acknowledged handoff, then releases its pins', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    expect(h.service.consume(handoffId)).toEqual({ ok: false, code: 'conflict' });
    h.service.acknowledge(recorded(h, intent(handoffId)));
    expect(activePins(h.conn, handoffId)).toBe(2);
    expect(h.service.consume(handoffId)).toEqual({ ok: true, state: 'consumed' });
    expect(h.service.consume(handoffId)).toEqual({ ok: true, state: 'consumed' });
    expect(createHandoffStore(h.conn).getHandoff(handoffId)?.closedReason).toBe('delivered');
    expect(activePins(h.conn, handoffId)).toBe(0);
    expect(h.service.consume('f'.repeat(64))).toEqual({ ok: false, code: 'not-found' });
  });
});

describe('FR-R6-F08 T018 — reopen and pins', () => {
  it('moves a pending intent and its handoff to uncertain, switching the pin purpose', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    const intentId = recorded(h, intent(handoffId));
    expect(h.service.reopen()).toEqual({ pendingToUncertain: 1, purposeSwitchesFinished: 1, pinsRetried: 0 });
    const store = createHandoffStore(h.conn);
    expect(store.getDelivery(intentId)).toMatchObject({ outcome: 'uncertain', outcomeReason: 'restart-before-ack' });
    expect(store.getHandoff(handoffId)).toMatchObject({ state: 'uncertain', pinPurpose: 'uncertain-recovery' });
    expect(h.service.reopen()).toEqual({ pendingToUncertain: 0, purposeSwitchesFinished: 0, pinsRetried: 0 });
  });

  it('keeps the handoff delivering when a late acknowledgement lands while a newer intent is pending', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    const first = recorded(h, intent(handoffId));
    h.service.reopen();
    acceptedDecision(h, handoffId);
    const second = recorded(h, intent(handoffId, { targetAttemptId: 'att-3' }));
    expect(h.service.acknowledge(first)).toEqual({ ok: true, duplicate: false });
    const store = createHandoffStore(h.conn);
    expect(store.getHandoff(handoffId)?.state).toBe('delivering');
    expect(h.service.acknowledge(second)).toEqual({ ok: true, duplicate: false });
    expect(store.getHandoff(handoffId)?.state).toBe('acknowledged');
  });

  it('keeps the handoff uncertain when a newer intent is not sent while an earlier one is uncertain', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    const first = recorded(h, intent(handoffId));
    h.service.reopen();
    acceptedDecision(h, handoffId);
    const second = recorded(h, intent(handoffId, { targetAttemptId: 'att-3' }));
    expect(h.service.reportNotSent(second)).toEqual({ ok: true });
    const store = createHandoffStore(h.conn);
    expect(store.getHandoff(handoffId)).toMatchObject({ state: 'uncertain', pinPurpose: 'uncertain-recovery' });
    expect(h.service.acknowledge(first)).toEqual({ ok: true, duplicate: false });
    expect(store.getHandoff(handoffId)?.state).toBe('acknowledged');
    expect(h.service.consume(handoffId)).toEqual({ ok: true, state: 'consumed' });
  });

  it('releases no pin when a delivery fails', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    expect(activePins(h.conn, handoffId)).toBe(2);
    h.service.reportNotSent(recorded(h, intent(handoffId)));
    expect(activePins(h.conn, handoffId)).toBe(2);
    acceptedDecision(h, handoffId);
    recorded(h, intent(handoffId, { targetAttemptId: 'att-3' }));
    h.service.reopen();
    expect(activePins(h.conn, handoffId)).toBe(2);
    const store = createHandoffStore(h.conn);
    expect(store.listReferences(handoffId, 1).map((row) => row.pinState)).toEqual(['pinned', 'pinned']);
  });
});

const CUTOFF_3: HandoffCutoff = { executionRevision: 'exec-3', usageRevision: 6, factCutoffMs: NOW + 2_000 };

/** Issues revisions 2 and 3 on top of revision 1, so revision 3 is current. */
function atRevisionThree(h: Harness): string {
  const handoffId = preparedAndIssued(h);
  for (const cutoff of [CUTOFF_2, CUTOFF_3]) {
    const prepared = h.service.prepare(LINEAGE, cutoff, manifest());
    if (!prepared.ok) throw new Error(prepared.code);
    const issued = h.service.issue(handoffId, prepared.revisionNo);
    if (!issued.ok) throw new Error(issued.code);
  }
  return handoffId;
}

function activePinPurposes(conn: NodeSqliteConnection, handoffId: string): string[] {
  return conn
    .all<{ purpose: string }>(
      `SELECT DISTINCT purpose FROM artifact_references
       WHERE owner_type = 'handoff' AND owner_id = ? AND released_revision IS NULL ORDER BY purpose`,
      handoffId
    )
    .map((row) => row.purpose);
}

const UNKNOWN_HANDOFF = 'f'.repeat(64);

describe('FR-R6-F08 T025 — decide', () => {
  it('stores a decision on a non-current revision as refused-stale, and it permits no attempt', () => {
    const h = harness();
    const handoffId = atRevisionThree(h);
    const result = h.service.decide(handoffId, 2, 'continue-new-attempt', 'req-1');
    const decisionId = decisionIdFor(handoffId, 'req-1');
    expect(result).toEqual({ ok: true, decisionId, outcome: 'refused-stale' });

    recorded(h, intent(handoffId, { revisionNo: 3 }));
    h.service.reopen();
    const retried = h.service.recordIntent(intent(handoffId, { revisionNo: 3, targetAttemptId: 'att-3' }));
    expect(retried).toEqual({ ok: false, code: 'decision-required' });
    const store = createHandoffStore(h.conn);
    expect(store.getDecision(decisionId)).toMatchObject({ revisionNo: 2, outcome: 'refused-stale', consumedByIntentId: null });
  });

  it('accepts a decision on the current revision, and the next attempt consumes it', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    recorded(h, intent(handoffId));
    h.service.reopen();
    const decided = h.service.decide(handoffId, 1, 'continue-new-attempt', 'req-1');
    expect(decided).toMatchObject({ ok: true, outcome: 'accepted' });
    const intentId = recorded(h, intent(handoffId, { targetAttemptId: 'att-3' }));
    const decisionId = decisionIdFor(handoffId, 'req-1');
    expect(createHandoffStore(h.conn).getDecision(decisionId)?.consumedByIntentId).toBe(intentId);
  });

  it('lets a decision recorded before a delivery authorize nothing once that delivery is uncertain', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    const early = h.service.decide(handoffId, 1, 'continue-new-attempt', 'req-early');
    expect(early).toMatchObject({ ok: true, outcome: 'accepted' });
    const firstIntentId = recorded(h, intent(handoffId));
    h.service.reopen();
    const decisionId = decisionIdFor(handoffId, 'req-early');
    expect(createHandoffStore(h.conn).getDecision(decisionId)?.consumedByIntentId).toBe(firstIntentId);
    const next = intent(handoffId, { targetAttemptId: 'att-3' });
    expect(h.service.recordIntent(next)).toEqual({ ok: false, code: 'decision-required' });
    expect(h.service.decide(handoffId, 1, 'continue-new-attempt', 'req-after')).toMatchObject({ outcome: 'accepted' });
    expect(h.service.recordIntent(next)).toMatchObject({ ok: true, duplicate: false });
  });

  it('lapses a decision recorded while a delivery is pending once that delivery becomes uncertain', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    const firstIntentId = recorded(h, intent(handoffId));
    const during = h.service.decide(handoffId, 1, 'continue-new-attempt', 'req-during');
    expect(during).toMatchObject({ ok: true, outcome: 'accepted' });
    expect(h.service.reopen()).toMatchObject({ pendingToUncertain: 1 });
    const decisionId = decisionIdFor(handoffId, 'req-during');
    expect(createHandoffStore(h.conn).getDecision(decisionId)?.consumedByIntentId).toBe(firstIntentId);
    const next = intent(handoffId, { targetAttemptId: 'att-3' });
    expect(h.service.recordIntent(next)).toEqual({ ok: false, code: 'decision-required' });
  });

  it('lapses a decision recorded while a delivery is pending once that delivery is reported not sent', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    const firstIntentId = recorded(h, intent(handoffId));
    h.service.decide(handoffId, 1, 'continue-new-attempt', 'req-during');
    expect(h.service.reportNotSent(firstIntentId)).toEqual({ ok: true });
    const decisionId = decisionIdFor(handoffId, 'req-during');
    expect(createHandoffStore(h.conn).getDecision(decisionId)?.consumedByIntentId).toBe(firstIntentId);
  });

  it('lapses a decision recorded while a delivery is pending once that delivery is acknowledged', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    const firstIntentId = recorded(h, intent(handoffId));
    h.service.decide(handoffId, 1, 'continue-new-attempt', 'req-during');
    expect(h.service.acknowledge(firstIntentId)).toEqual({ ok: true, duplicate: false });
    const decisionId = decisionIdFor(handoffId, 'req-during');
    expect(createHandoffStore(h.conn).getDecision(decisionId)?.consumedByIntentId).toBe(firstIntentId);
    const next = intent(handoffId, { targetAttemptId: 'att-3' });
    expect(h.service.recordIntent(next)).toEqual({ ok: false, code: 'decision-required' });
  });

  it('stores a decision on a closed handoff as refused-closed and leaves the handoff closed', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    expect(h.service.supersede(handoffId)).toEqual({ ok: true, state: 'superseded' });
    const result = h.service.decide(handoffId, 1, 'abandon', 'req-2');
    expect(result).toMatchObject({ ok: true, outcome: 'refused-closed' });
    const store = createHandoffStore(h.conn);
    expect(store.listDecisions(handoffId).map((row) => row.outcome)).toEqual(['refused-closed']);
    expect(store.getHandoff(handoffId)).toMatchObject({ state: 'superseded', closedReason: 'superseded' });
  });

  it('consumes the handoff on abandon with closed_reason abandoned and releases every pin', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    expect(activePins(h.conn, handoffId)).toBe(2);
    expect(h.service.decide(handoffId, 1, 'abandon', 'req-3')).toMatchObject({ ok: true, outcome: 'accepted' });
    expect(createHandoffStore(h.conn).getHandoff(handoffId)).toMatchObject({
      state: 'consumed',
      closedReason: 'abandoned'
    });
    expect(activePins(h.conn, handoffId)).toBe(0);
    expect(h.service.consume(handoffId)).toEqual({ ok: false, code: 'conflict' });
  });

  it('returns the stored decision for a repeated request, and refuses a different decision under it', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    const first = h.service.decide(handoffId, 1, 'abandon', 'req-4');
    expect(h.service.decide(handoffId, 1, 'abandon', 'req-4')).toEqual(first);
    expect(h.service.decide(handoffId, 1, 'continue-new-attempt', 'req-4')).toEqual({ ok: false, code: 'conflict' });
    expect(count(h.conn, 'recovery_handoff_decisions')).toBe(1);
  });

  it('refuses an unknown handoff and invalid input, writing nothing', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    expect(h.service.decide(UNKNOWN_HANDOFF, 1, 'abandon', 'req-5')).toEqual({ ok: false, code: 'not-found' });
    expect(h.service.decide(handoffId, 1, 'retry' as 'abandon', 'req-5')).toEqual({
      ok: false,
      code: 'invalid',
      field: 'decision'
    });
    expect(h.service.decide(handoffId, 1, 'abandon', 'not an id')).toEqual({ ok: false, code: 'invalid', field: 'requestId' });
    expect(h.service.decide(handoffId, -1, 'abandon', 'req-5')).toEqual({ ok: false, code: 'invalid', field: 'revisionNo' });
    expect(h.service.decide(handoffId, 0, 'abandon', 'req-5')).toEqual({ ok: false, code: 'invalid', field: 'revisionNo' });
    expect(count(h.conn, 'recovery_handoff_decisions')).toBe(0);
  });
});

describe('FR-R6-F08 T025 — setHandoffPaused', () => {
  it('moves every pin to paused-recovery and back, losing none', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    expect(activePinPurposes(h.conn, handoffId)).toEqual(['pending-handoff']);
    expect(h.service.setHandoffPaused(handoffId, true)).toEqual({ ok: true, pinPurpose: 'paused-recovery' });
    expect(activePinPurposes(h.conn, handoffId)).toEqual(['paused-recovery']);
    expect(activePins(h.conn, handoffId)).toBe(2);
    expect(createHandoffStore(h.conn).getHandoff(handoffId)).toMatchObject({ paused: true, state: 'ready' });
    expect(h.service.setHandoffPaused(handoffId, false)).toEqual({ ok: true, pinPurpose: 'pending-handoff' });
    expect(activePinPurposes(h.conn, handoffId)).toEqual(['pending-handoff']);
    expect(activePins(h.conn, handoffId)).toBe(2);
  });

  it('keeps the paused purpose across an uncertain restart', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    h.service.setHandoffPaused(handoffId, true);
    recorded(h, intent(handoffId));
    h.service.reopen();
    expect(activePinPurposes(h.conn, handoffId)).toEqual(['paused-recovery']);
    expect(h.service.setHandoffPaused(handoffId, false)).toEqual({ ok: true, pinPurpose: 'uncertain-recovery' });
  });

  it('refuses an unknown handoff and a closed one', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    expect(h.service.setHandoffPaused(UNKNOWN_HANDOFF, true)).toEqual({ ok: false, code: 'not-found' });
    h.service.supersede(handoffId);
    expect(h.service.setHandoffPaused(handoffId, true)).toEqual({ ok: false, code: 'handoff-closed' });
    expect(activePins(h.conn, handoffId)).toBe(0);
  });
});

describe('FR-R6-F08 T025 — supersede', () => {
  it('closes the handoff and its current revision and releases every pin', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    const before = createHandoffStore(h.conn).getRevision(handoffId, 1)?.manifestJson;
    expect(h.service.supersede(handoffId)).toEqual({ ok: true, state: 'superseded' });
    const store = createHandoffStore(h.conn);
    expect(store.getHandoff(handoffId)).toMatchObject({ state: 'superseded', closedReason: 'superseded' });
    expect(store.getRevision(handoffId, 1)).toMatchObject({ status: 'superseded', manifestJson: before });
    expect(activePins(h.conn, handoffId)).toBe(0);
  });

  it('supersedes a handoff with only a draft revision, leaving the draft as it is', () => {
    const h = harness();
    const prepared = h.service.prepare(LINEAGE, CUTOFF_1, manifest());
    if (!prepared.ok) throw new Error(prepared.code);
    expect(h.service.supersede(prepared.handoffId)).toEqual({ ok: true, state: 'superseded' });
    expect(createHandoffStore(h.conn).getRevision(prepared.handoffId, 1)?.status).toBe('draft');
    expect(activePins(h.conn, prepared.handoffId)).toBe(0);
  });

  it('refuses an unknown handoff and a closed one', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    expect(h.service.supersede(UNKNOWN_HANDOFF)).toEqual({ ok: false, code: 'not-found' });
    h.service.supersede(handoffId);
    expect(h.service.supersede(handoffId)).toEqual({ ok: false, code: 'handoff-closed' });
  });
});

const HANDOFF_TABLES = [
  'recovery_handoffs',
  'recovery_handoff_revisions',
  'recovery_handoff_references',
  'recovery_handoff_deliveries',
  'recovery_handoff_decisions',
  'artifact_references'
] as const;

function tableDump(conn: NodeSqliteConnection): string {
  return JSON.stringify(HANDOFF_TABLES.map((table) => conn.all<Record<string, unknown>>(`SELECT * FROM ${table}`)));
}

describe('FR-R6-F08 T025 — explain', () => {
  it('explains the current revision and writes no row', () => {
    const h = harness();
    const handoffId = preparedAndIssued(h);
    recorded(h, intent(handoffId));
    h.service.reopen();
    const before = tableDump(h.conn);
    const result = h.service.explain(handoffId);
    expect(tableDump(h.conn)).toBe(before);
    if (!result.ok) throw new Error(result.code);
    expect(result.explanation).toMatchObject({
      handoffId,
      state: 'uncertain',
      revisionNo: 1,
      currentRevision: 1,
      certainty: 'uncertain',
      attribution: { counts: { attempt: 2, preexisting: 1, concurrent: 0, unknown: 0 }, omittedCount: 3 },
      nextActions: ['decide', 'inspect-evidence']
    });
    expect(result.explanation.references.map((row) => row.artifactId)).toEqual(['art-partial-1', 'art-validated-1']);
    expect(result.explanation.deliveries.map((row) => row.outcome)).toEqual(['uncertain']);
  });

  it('explains a prepared handoff from its newest draft revision', () => {
    const h = harness();
    const prepared = h.service.prepare(LINEAGE, CUTOFF_1, manifest());
    if (!prepared.ok) throw new Error(prepared.code);
    const result = h.service.explain(prepared.handoffId);
    expect(result).toMatchObject({ ok: true, explanation: { state: 'preparing', revisionNo: 1, currentRevision: null } });
  });

  it('refuses an unknown handoff with not-found', () => {
    expect(harness().service.explain(UNKNOWN_HANDOFF)).toEqual({ ok: false, code: 'not-found' });
  });
});

const LEGACY_CUTOFF: HandoffCutoff = { executionRevision: 'legacy-exec-1', usageRevision: 0, factCutoffMs: NOW };

function legacyRecord(overrides: Partial<LegacyHandoffRecord> = {}): LegacyHandoffRecord {
  return {
    workspaceId: 'ws-1',
    runId: 'run-legacy-1',
    invocationId: 'inv-legacy-1',
    attemptId: 'att-legacy-1',
    status: 'settled',
    outcome: { status: 'incomplete', reason: 'work-remaining' },
    certainty: 'uncertain',
    frozenDefinitionDigest: FROZEN,
    cutoff: LEGACY_CUTOFF,
    attribution: { backendId: 'claude-cli', runtimeId: 'legacy-runner' },
    envelope: {
      version: 1,
      invocationId: 'inv-legacy-1',
      upstreamArtifactRefs: ['art-validated-1'],
      partialArtifactRefs: ['art-partial-1'],
      workspace: { coverage: 'complete', omittedCount: 0, entries: [] },
      effects: { certainty: 'uncertain', evidenceRefs: [] },
      truncated: false
    },
    ...overrides
  };
}

describe('FR-R6-F08 T029 — importLegacy', () => {
  it('prepares a handoff under the record ids, once, with its provenance', () => {
    const h = harness();
    const first = h.service.importLegacy(legacyRecord({ providerSessionId: 'sess-provider-9' }));
    if (!first.ok || !('created' in first)) throw new Error(JSON.stringify(first));
    expect(first).toMatchObject({ state: 'preparing', revisionNo: 1, created: true, pinRefusals: [] });
    expect(h.service.importLegacy(legacyRecord({ providerSessionId: 'sess-provider-9' }))).toMatchObject({
      ok: true,
      handoffId: first.handoffId,
      created: false
    });
    expect(count(h.conn, 'recovery_handoffs')).toBe(1);
    expect(count(h.conn, 'recovery_handoff_revisions')).toBe(1);
    const row = createHandoffStore(h.conn).getHandoff(first.handoffId);
    expect(row).toMatchObject({ rootExecutionId: 'run-legacy-1', sourceAttemptId: 'att-legacy-1', paused: false });
    expect(JSON.parse(row?.legacyProvenance ?? 'null')).toMatchObject({
      kind: 'legacy-record',
      providerSession: { kind: 'legacy-provider-session', value: 'sess-provider-9' }
    });
  });

  it('pins a paused record with paused-recovery', () => {
    const h = harness();
    const result = h.service.importLegacy(legacyRecord({ status: 'paused' }));
    if (!result.ok) throw new Error(result.code);
    expect(createHandoffStore(h.conn).getHandoff(result.handoffId)).toMatchObject({ paused: true });
    expect(activePinPurposes(h.conn, result.handoffId)).toEqual(['paused-recovery']);
    expect(activePins(h.conn, result.handoffId)).toBe(2);
  });

  it('does not block on legacy references F05 cannot pin', () => {
    const h = harness([]);
    const result = h.service.importLegacy(legacyRecord());
    if (!result.ok || !('pinRefusals' in result)) throw new Error(JSON.stringify(result));
    expect(result.pinRefusals.map((refusal) => refusal.artifactId)).toEqual(['art-partial-1', 'art-validated-1']);
  });

  it('stores an unknown envelope version as an unsupported handoff, idempotently', async () => {
    const h = harness();
    const record = legacyRecord({ envelope: { version: 7, futureField: true } });
    const result = h.service.importLegacy(record);
    if (!result.ok) throw new Error(result.code);
    expect(result).toEqual({ ok: true, handoffId: result.handoffId, state: 'unsupported' });
    expect(h.service.importLegacy(record)).toEqual(result);
    expect(count(h.conn, 'recovery_handoffs')).toBe(1);
    expect(count(h.conn, 'recovery_handoff_revisions')).toBe(0);
    expect(createHandoffStore(h.conn).getHandoff(result.handoffId)?.legacyProvenance).toBe(
      JSON.stringify({ kind: 'unsupported-envelope', version: 7 })
    );
    expect(h.service.ownerResolution(result.handoffId)).toBe('live');
    expect(await h.service.resolve(result.handoffId)).toEqual({ ok: false, code: 'unsupported-version' });
    expect(h.service.importLegacy(legacyRecord())).toEqual({ ok: false, code: 'unsupported-version' });
  });

  it('refuses an invalid record, writing nothing', () => {
    const h = harness();
    expect(h.service.importLegacy(legacyRecord({ runId: 'not an id' }))).toEqual({
      ok: false,
      code: 'invalid',
      field: 'runId'
    });
    expect(count(h.conn, 'recovery_handoffs')).toBe(0);
  });

  it('refuses an unsupported import over a live handoff with conflict', () => {
    const h = harness();
    const imported = h.service.importLegacy(legacyRecord());
    if (!imported.ok) throw new Error(imported.code);
    expect(h.service.importLegacy(legacyRecord({ envelope: { version: 7 } }))).toEqual({ ok: false, code: 'conflict' });
    expect(createHandoffStore(h.conn).getHandoff(imported.handoffId)).toMatchObject({ state: 'preparing' });
  });
});
