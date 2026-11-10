/**
 * FR-R6-F08 T022 — recovery handoff acceptance, US1 to US3, over a file-backed store.
 *
 * Every case runs the real F05 lifecycle service, the real recovery handoff service and, for
 * capture, a real `RunCheckpointService` over a temp Git workspace. Between seams the store is
 * closed and reopened on the same database file, as a host restart would, and every service is
 * built again on the new connection.
 *
 * A zero-age retention policy is adopted first, so every seeded artifact is collectable unless
 * something protects it. `currentRetentionDecisions` is read between seams: the handoff's
 * references must stay `preserve-protected` while it is live, and an unrelated artifact must
 * stay `collect`, which proves the policy would have removed them.
 *
 * WHAT THIS PINS:
 *   - US1: a captured envelope reads back after restart with the same digest; validated and
 *     partial references keep their roles; workspace attributions and the recorded certainty
 *     are kept across restarts;
 *   - US2: a pending intent becomes `uncertain` at restart under the same handoff and revision,
 *     and a redelivery through another connection is refused with its typed reason;
 *   - US3: protection holds at the prepare, issue, intent and uncertain seams and after a failed
 *     delivery; `consume` releases only the handoff's own pins.
 *
 * T031 adds US4 and US5:
 *   - a paused handoff keeps protecting across an uncertain restart; `supersede` releases it;
 *   - a decision recorded before a restart is returned unchanged after it, and the explanation
 *     after reopen shows it; an accepted `abandon` releases every pin;
 *   - a legacy record imported after reopen protects its references across a restart; one with
 *     an unknown envelope version stays `live` to the owner resolver and resolves
 *     `unsupported-version`;
 *   - a stored revision written by a newer build (inserted directly) is refused by `resolve` and
 *     `recordIntent` as `unsupported-version`, explained as `unsupported`, and left
 *     byte-identical.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MutationAuthority } from '../../src/contracts/artifact-lifecycle/lifecycle-types';
import { DEFAULT_RETENTION_POLICY } from '../../src/contracts/artifact-lifecycle/retention-policy-types';
import type { HandoffCutoff, HandoffLineage, SessionOwner } from '../../src/contracts/recovery-handoff/handoff-types';
import { SanitizedLogger } from '../../src/lib/logger';
import {
  ArtifactRecordStore,
  createArtifactLifecycleService,
  currentRetentionDecisions,
  DENY_ALL_ACCESS_POLICY,
  PreviewStore,
  ReferenceStore,
  type ArtifactByteProbe,
  type ArtifactLifecycleService,
  type ArtifactLifecycleServiceDependencies,
  type LifecycleFs,
  type LifecycleFsEntry,
  type StorageScanRoot
} from '../../src/services/artifact-lifecycle';
import {
  createRecoveryHandoffService,
  type LegacyHandoffRecord,
  type RecordIntentInput,
  type RecoveryHandoffService
} from '../../src/services/recovery-handoff';
import { createHandoffStore } from '../../src/services/recovery-handoff/handoff-store';
import { RunCheckpointService } from '../../src/services/run-checkpoint-service';
import { RunMutationLedger } from '../../src/services/run-mutation-ledger';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../src/services/sqlite-store';

const run = promisify(execFile);

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Older than any policy age, so only protection keeps a seeded artifact. */
const SETTLED_AGO_MS = 100 * DAY_MS;
const FULL: MutationAuthority = { trusted: true, primary: true, auditHealthy: true };
const DETAIL_CLASS = 'new-terminal-execution-usage-detail' as const;
const ZERO_AGE_POLICY = { ...DEFAULT_RETENTION_POLICY, terminalDetailMaxAgeMs: 0 };

const VALIDATED = 'art-validated-1';
const PARTIAL = 'art-partial-1';
const UNRELATED = 'art-other';
const SEEDED = [VALIDATED, PARTIAL, UNRELATED] as const;

const RUN_ID = 'run-1';
const HANDOVER_ID = 'hand-1';
const SOURCE_ATTEMPT = 'att-1';
const TARGET_ATTEMPT = 'att-2';
const OTHER_TARGET_ATTEMPT = 'att-3';
const FROZEN = 'b'.repeat(64);
const CAPABILITIES = 'c'.repeat(64);
const ACCESS_PLAN = 'd'.repeat(64);
const OWNER: SessionOwner = { agentId: 'agent-1', accountScope: 'scope-1' };

const LINEAGE: HandoffLineage = {
  workspaceId: 'ws-1',
  rootExecutionId: 'root-1',
  invocationId: 'inv-1',
  sourceAttemptId: SOURCE_ATTEMPT
};
const CUTOFF: HandoffCutoff = { executionRevision: 'exec-1', usageRevision: 4, factCutoffMs: NOW };

let base = '';
let now = NOW;
let ids = 0;
let openConnections: NodeSqliteConnection[] = [];

const newId = (): string => `id-${(ids += 1)}`;
const sha256Hex = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const workspacePath = (...segments: readonly string[]): string => path.join(base, 'ws', ...segments);
const gitPath = (...segments: readonly string[]): string => path.join(base, 'git', ...segments);
const reportRel = (artifactId: string): string => path.join('.schegent', 'reports', `${artifactId}.json`);

/** `LifecycleFs` over the real filesystem; links are never followed. */
const nodeFs: LifecycleFs = {
  async lstat(absolutePath): Promise<LifecycleFsEntry | null> {
    try {
      const st = await fs.lstat(absolutePath);
      const kind = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other';
      return { kind, sizeBytes: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
  },
  async readdir(absolutePath) {
    return (await fs.readdir(absolutePath)).sort();
  },
  realpath: (absolutePath) => fs.realpath(absolutePath),
  unlink: (absolutePath) => fs.unlink(absolutePath)
};

/** Observes and hashes the real bytes behind a workspace locator. */
const realProbe: ArtifactByteProbe = {
  async observe(locator) {
    try {
      const st = await fs.lstat(workspacePath(locator.uriOrRelpath));
      if (!st.isFile()) return { exists: false, sizeBytes: 0, producerIdentity: null, generation: null };
      return { exists: true, sizeBytes: st.size, producerIdentity: null, generation: null };
    } catch {
      return { exists: false, sizeBytes: 0, producerIdentity: null, generation: null };
    }
  },
  async digestSha256(locator) {
    try {
      return sha256Hex(await fs.readFile(workspacePath(locator.uriOrRelpath)));
    } catch {
      return null;
    }
  }
};

function scanRoots(): readonly StorageScanRoot[] {
  return [
    {
      rootId: 'reports',
      root: workspacePath('.schegent', 'reports'),
      retentionClass: DETAIL_CLASS,
      storeKind: 'report'
    }
  ];
}

/** One host lifetime: a connection and every service built on it. */
interface Host {
  readonly conn: NodeSqliteConnection;
  readonly lifecycle: ArtifactLifecycleService;
  readonly handoffs: RecoveryHandoffService;
  readonly checkpoints: RunCheckpointService;
  readonly lifecycleDeps: ArtifactLifecycleServiceDependencies;
}

function ledger(): RunMutationLedger {
  return new RunMutationLedger({
    readDiff: async () => (await run('git', ['diff', '--binary', '--no-ext-diff', 'HEAD'], { cwd: gitPath() })).stdout,
    listInFlightRunIds: () => [RUN_ID],
    workspaceRoot: gitPath()
  });
}

/** Opens the database file, bootstraps it and builds every service, as a host start would. */
function startHost(): Host {
  const conn = new NodeSqliteConnection({ databasePath: workspacePath('.schegent', 'state.db') });
  openConnections.push(conn);
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => now);
  const checkpoints = new RunCheckpointService(path.join(base, 'store'), gitPath(), new SanitizedLogger(), () => 1, ledger());
  /** The handoff service is built on the lifecycle service, which asks it who owns a pin. */
  const late: { handoffs?: RecoveryHandoffService } = {};
  const lifecycleDeps: ArtifactLifecycleServiceDependencies = {
    conn,
    nowMs: () => now,
    fs: nodeFs,
    probe: realProbe,
    audit: { recordLifecycleMutation: () => undefined },
    scanRoots: scanRoots(),
    accessPolicy: DENY_ALL_ACCESS_POLICY,
    resolveOwner: (ownerType, ownerId) =>
      ownerType === 'handoff' && late.handoffs !== undefined ? late.handoffs.ownerResolution(ownerId) : 'live',
    newId,
    workspaceRoot: workspacePath()
  };
  const lifecycle = createArtifactLifecycleService(lifecycleDeps);
  const handoffs = createRecoveryHandoffService({
    conn,
    lifecycle,
    probe: realProbe,
    envelopes: checkpoints,
    clock: () => now
  });
  late.handoffs = handoffs;
  return { conn, lifecycle, handoffs, checkpoints, lifecycleDeps };
}

/** A host restart: the old connection closes before the new one opens on the same file. */
function restart(host: Host): Host {
  host.conn.close();
  openConnections = openConnections.filter((open) => open !== host.conn);
  now += 1_000;
  return startHost();
}

/** The retention action F05 would take now for each seeded artifact. */
function decisions(host: Host): Map<string, string> {
  const nowMs = (): number => now;
  const ctx = {
    deps: host.lifecycleDeps,
    records: new ArtifactRecordStore(host.conn, nowMs),
    previews: new PreviewStore(host.conn, nowMs, newId),
    references: new ReferenceStore(host.conn, nowMs),
    newId
  };
  return new Map(currentRetentionDecisions(ctx).map((decision) => [decision.artifactId, decision.action]));
}

function expectProtected(host: Host, label: string): void {
  const actions = decisions(host);
  expect(actions.get(VALIDATED), `${label}: validated`).toBe('preserve-protected');
  expect(actions.get(PARTIAL), `${label}: partial`).toBe('preserve-protected');
  expect(actions.get(UNRELATED), `${label}: unrelated`).toBe('collect');
}

/** `revisionNo` is needed before issue: a handoff has no current revision until one is issued. */
async function expectUsable(host: Host, handoffId: string, label: string, revisionNo?: number): Promise<void> {
  const resolved = await host.handoffs.resolve(handoffId, revisionNo);
  if (!resolved.ok) throw new Error(`${label}: resolve refused: ${resolved.code}`);
  expect(resolved.status, label).toBe('usable');
  expect(resolved.references.map((ref) => [ref.artifactId, ref.role, ref.required, ref.resolution])).toEqual([
    [PARTIAL, 'partial', false, 'available'],
    [VALIDATED, 'validated', true, 'available']
  ]);
}

/** Active handoff-owned F05 references on one artifact, as `purpose` strings. */
function handoffPins(host: Host, artifactId: string, handoffId: string): string[] {
  const listed = host.lifecycle.listReferences(artifactId);
  if (!listed.ok) throw new Error(`list references refused: ${listed.refusal.code}`);
  return listed.value
    .filter((ref) => ref.active && ref.ownerType === 'handoff' && ref.ownerId === handoffId)
    .map((ref) => ref.purpose);
}

async function seedArtifacts(host: Host): Promise<void> {
  for (const artifactId of SEEDED) {
    const body = `bytes of ${artifactId}\n`;
    const rel = reportRel(artifactId);
    await fs.mkdir(path.dirname(workspacePath(rel)), { recursive: true });
    await fs.writeFile(workspacePath(rel), body);
    const registered = host.lifecycle.registerArtifact({
      artifactId,
      ownerRunId: RUN_ID,
      sensitivity: 'content',
      retentionClass: DETAIL_CLASS,
      storeKind: 'report',
      immutability: 'immutable',
      digest: { algorithm: 'sha256', value: sha256Hex(body) },
      byteSize: Buffer.byteLength(body),
      mediaType: 'application/json',
      displayName: artifactId,
      producerIdentity: 'writer',
      locator: { storageTier: 'workspace_file', uriOrRelpath: rel }
    });
    if (!registered.ok) throw new Error(`seed ${artifactId} refused: ${registered.refusal.code}`);
    host.conn.run(
      'UPDATE artifact_lifecycle SET terminal_settled_at_ms = ? WHERE artifact_id = ?',
      now - SETTLED_AGO_MS,
      artifactId
    );
  }
}

function adoptZeroAgePolicy(host: Host): void {
  const preview = host.lifecycle.previewRetentionPolicy(ZERO_AGE_POLICY);
  if (!preview.ok) throw new Error(`policy preview refused: ${preview.refusal.code}`);
  const adopted = host.lifecycle.adoptRetentionPolicy({
    previewId: preview.value.previewId,
    confirmation: 'confirmed',
    authority: FULL,
    policy: ZERO_AGE_POLICY
  });
  if (!adopted.ok) throw new Error(`policy adoption refused: ${adopted.refusal.code}`);
}

async function initGit(): Promise<void> {
  await fs.mkdir(gitPath('src'), { recursive: true });
  await run('git', ['init', '-q'], { cwd: gitPath() });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: gitPath() });
  await run('git', ['config', 'user.name', 'Test'], { cwd: gitPath() });
  await fs.writeFile(gitPath('src', 'app.ts'), 'export const app = 1;\n');
  await run('git', ['add', '.'], { cwd: gitPath() });
  await run('git', ['commit', '-q', '-m', 'init'], { cwd: gitPath() });
}

/** The source attempt edits one file and fails; its envelope is captured and persisted. */
async function captureSourceAttempt(host: Host): Promise<string> {
  await host.checkpoints.captureBeforeCandidateAttempt(RUN_ID, SOURCE_ATTEMPT);
  await fs.writeFile(gitPath('src', 'app.ts'), 'export const app = 2;\n');
  const captured = await host.handoffs.captureCandidate(RUN_ID, HANDOVER_ID, {
    invocationId: LINEAGE.invocationId,
    previousAttemptId: SOURCE_ATTEMPT,
    previousOutcome: { status: 'incomplete', reason: 'credits' },
    upstreamArtifactRefs: [VALIDATED],
    partialArtifactRefs: [PARTIAL],
    sideEffects: 'workspace',
    hasAttributableTeardown: false,
    effectEvidenceRefs: []
  });
  if (!captured.ok) throw new Error(`capture refused: ${captured.diagnostic}`);
  return captured.envelopeDigest;
}

/** The manifest built from the envelope the restarted host reads back. */
async function manifestFromEnvelope(host: Host): Promise<{ manifest: Record<string, unknown>; digest: string }> {
  const assessed = await host.handoffs.assessAttempt(RUN_ID, HANDOVER_ID);
  if (!assessed.ok) throw new Error(`assess refused: ${assessed.code}`);
  const { envelope } = assessed;
  const manifest = {
    version: 1,
    sourceOutcome: { status: 'incomplete', reason: 'credits' },
    frozenDefinitionDigest: FROZEN,
    certainty: envelope.effects.certainty,
    coverage: envelope.workspace.coverage,
    workspace: {
      entries: envelope.workspace.entries.map((entry) => ({ path: entry.path, attribution: entry.attribution })),
      omittedCount: envelope.workspace.omittedCount
    },
    references: [
      { artifactId: VALIDATED, role: 'validated', required: true, digest: sha256Hex(`bytes of ${VALIDATED}\n`) },
      { artifactId: PARTIAL, role: 'partial', required: false }
    ],
    excluded: [{ itemId: 'transcript-1', reason: 'raw-transcript' }],
    contextId: null,
    envelope: { artifactId: 'env-1', digest: assessed.envelopeDigest }
  };
  return { manifest, digest: assessed.envelopeDigest };
}

function intent(handoffId: string, envelopeDigest: string, overrides: Partial<RecordIntentInput> = {}): RecordIntentInput {
  return {
    handoffId,
    revisionNo: 1,
    targetAttemptId: TARGET_ATTEMPT,
    envelopeDigest,
    transport: 'acp',
    backendId: 'backend-1',
    profileId: 'profile-1',
    profileVersion: '1',
    connectionId: 'conn-1',
    capabilitiesDigest: CAPABILITIES,
    accessPlanDigest: ACCESS_PLAN,
    owner: OWNER,
    sessionCapability: 'declared',
    ...overrides
  };
}

interface Delivering {
  readonly host: Host;
  readonly handoffId: string;
  readonly envelopeDigest: string;
  readonly intentId: string;
}

/** Capture, prepare, issue and record an intent, restarting the host between every seam. */
async function deliverAcrossRestarts(): Promise<Delivering> {
  let host = startHost();
  await seedArtifacts(host);
  adoptZeroAgePolicy(host);
  const before = decisions(host);
  for (const artifactId of SEEDED) expect(before.get(artifactId), `before: ${artifactId}`).toBe('collect');

  const capturedDigest = await captureSourceAttempt(host);
  host = restart(host);
  const { manifest, digest } = await manifestFromEnvelope(host);
  expect(digest).toBe(capturedDigest);

  const prepared = host.handoffs.prepare(LINEAGE, CUTOFF, manifest);
  if (!prepared.ok) throw new Error(`prepare refused: ${prepared.code}`);
  const { handoffId } = prepared;
  host = restart(host);
  expectProtected(host, 'after prepare');
  await expectUsable(host, handoffId, 'after prepare', prepared.revisionNo);

  const issued = host.handoffs.issue(handoffId, prepared.revisionNo);
  if (!issued.ok) throw new Error(`issue refused: ${issued.code}`);
  host = restart(host);
  expectProtected(host, 'after issue');
  await expectUsable(host, handoffId, 'after issue');

  const recorded = host.handoffs.recordIntent(intent(handoffId, digest));
  if (!recorded.ok) throw new Error(`intent refused: ${recorded.code}`);
  host = restart(host);
  expectProtected(host, 'after intent');
  await expectUsable(host, handoffId, 'after intent');
  return { host, handoffId, envelopeDigest: digest, intentId: recorded.intentId };
}

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-f08-ac-')));
  await fs.mkdir(workspacePath('.schegent'), { recursive: true });
  await initGit();
  now = NOW;
  ids = 0;
  openConnections = [];
});

afterEach(async () => {
  for (const conn of openConnections) {
    try {
      conn.close();
    } catch {
      // A connection a case already closed.
    }
  }
  openConnections = [];
  await fs.rm(base, { recursive: true, force: true });
});

describe('FR-R6-F08 acceptance — US1 durable handoff', () => {
  it('keeps roles, attributions and the recorded certainty across restarts at every seam', async () => {
    const { host, handoffId } = await deliverAcrossRestarts();
    const revision = createHandoffStore(host.conn).getRevision(handoffId, 1);
    if (revision === undefined) throw new Error('revision 1 missing');
    const stored = JSON.parse(revision.manifestJson) as {
      readonly certainty: string;
      readonly workspace: { readonly entries: readonly { readonly path: string; readonly attribution: string }[] };
      readonly references: readonly { readonly artifactId: string; readonly role: string }[];
    };
    expect(revision.certainty).toBe(stored.certainty);
    expect(stored.certainty).not.toBe('safe');
    expect(stored.workspace.entries.find((entry) => entry.path === 'src/app.ts')?.attribution).toBe('attempt');
    expect(stored.references.filter((ref) => ref.role === 'validated').map((ref) => ref.artifactId)).toEqual([VALIDATED]);
  });
});

describe('FR-R6-F08 acceptance — US2 restart before acknowledgement', () => {
  it('turns a pending intent uncertain under the same handoff and revision, keeps protection, and refuses a new connection', async () => {
    const delivering = await deliverAcrossRestarts();
    const { handoffId, envelopeDigest, intentId } = delivering;
    const host = restart(delivering.host);
    expect(host.handoffs.reopen().pendingToUncertain).toBe(1);

    const store = createHandoffStore(host.conn);
    expect(store.getHandoff(handoffId)?.state).toBe('uncertain');
    expect(store.getHandoff(handoffId)?.currentRevision).toBe(1);
    expect(store.getDelivery(intentId)?.outcome).toBe('uncertain');
    expect(store.getDelivery(intentId)?.revisionNo).toBe(1);
    expect(handoffPins(host, VALIDATED, handoffId)).toEqual(['uncertain-recovery']);
    expectProtected(host, 'uncertain');
    await expectUsable(host, handoffId, 'uncertain');

    const redelivery = host.handoffs.recordIntent(
      intent(handoffId, envelopeDigest, { targetAttemptId: OTHER_TARGET_ATTEMPT, connectionId: 'conn-2' })
    );
    expect(redelivery.ok ? 'ok' : redelivery.code).toBe('new-connection-refused');
  });
});

describe('FR-R6-F08 acceptance — US3 retention before resume', () => {
  it('keeps every pin after a failed delivery', async () => {
    const delivering = await deliverAcrossRestarts();
    const { handoffId, intentId } = delivering;
    expect(delivering.host.handoffs.reportNotSent(intentId)).toEqual({ ok: true });
    const host = restart(delivering.host);
    expect(createHandoffStore(host.conn).getHandoff(handoffId)?.state).toBe('ready');
    expectProtected(host, 'after a failed delivery');
    expect(handoffPins(host, PARTIAL, handoffId)).toEqual(['pending-handoff']);
  });

  it('releases only its own pins on consume; another owner keeps protecting a shared artifact', async () => {
    const delivering = await deliverAcrossRestarts();
    const { handoffId, intentId } = delivering;
    const other = delivering.host.lifecycle.addReference({
      artifactId: VALIDATED,
      ownerType: 'run',
      ownerId: 'run-other',
      purpose: 'active-recovery',
      protective: true
    });
    if (!other.ok) throw new Error(`other owner refused: ${other.refusal.code}`);
    expect(delivering.host.handoffs.acknowledge(intentId)).toEqual({ ok: true, duplicate: false });
    expect(delivering.host.handoffs.consume(handoffId)).toEqual({ ok: true, state: 'consumed' });

    const host = restart(delivering.host);
    expect(handoffPins(host, VALIDATED, handoffId)).toEqual([]);
    expect(handoffPins(host, PARTIAL, handoffId)).toEqual([]);
    const actions = decisions(host);
    expect(actions.get(VALIDATED)).toBe('preserve-protected');
    expect(actions.get(PARTIAL)).toBe('collect');
    expect(actions.get(UNRELATED)).toBe('collect');
    const kept = host.lifecycle.listReferences(VALIDATED);
    expect(kept.ok && kept.value.filter((ref) => ref.active).map((ref) => ref.ownerId)).toEqual(['run-other']);
  });
});

describe('FR-R6-F08 acceptance — US3 paused and superseded', () => {
  it('keeps protecting while paused across an uncertain restart, and releases every pin on supersede', async () => {
    const delivering = await deliverAcrossRestarts();
    const { handoffId } = delivering;
    expect(delivering.host.handoffs.setHandoffPaused(handoffId, true)).toEqual({ ok: true, pinPurpose: 'paused-recovery' });
    let host = restart(delivering.host);
    expect(host.handoffs.reopen().pendingToUncertain).toBe(1);
    expect(handoffPins(host, VALIDATED, handoffId)).toEqual(['paused-recovery']);
    expectProtected(host, 'paused and uncertain');

    expect(host.handoffs.supersede(handoffId)).toEqual({ ok: true, state: 'superseded' });
    host = restart(host);
    expect(handoffPins(host, VALIDATED, handoffId)).toEqual([]);
    expect(decisions(host).get(VALIDATED)).toBe('collect');
    expect(createHandoffStore(host.conn).getRevision(handoffId, 1)?.status).toBe('superseded');
  });
});

describe('FR-R6-F08 acceptance — US4 decisions and explanation', () => {
  it('returns a decision recorded before a restart unchanged, and explains it after reopen', async () => {
    const delivering = await deliverAcrossRestarts();
    const { handoffId } = delivering;
    let host = restart(delivering.host);
    host.handoffs.reopen();
    const before = host.handoffs.explain(handoffId);
    if (!before.ok) throw new Error(`explain refused: ${before.code}`);
    expect(before.explanation.state).toBe('uncertain');
    expect(before.explanation.nextActions).toContain('decide');

    const decided = host.handoffs.decide(handoffId, 1, 'continue-new-attempt', 'req-1');
    if (!decided.ok) throw new Error(`decide refused: ${decided.code}`);
    expect(decided.outcome).toBe('accepted');
    host = restart(host);
    host.handoffs.reopen();
    expect(host.handoffs.decide(handoffId, 1, 'continue-new-attempt', 'req-1')).toEqual(decided);
    expect(host.handoffs.decide(handoffId, 1, 'abandon', 'req-1')).toEqual({ ok: false, code: 'conflict' });
    const after = host.handoffs.explain(handoffId);
    if (!after.ok) throw new Error(`explain refused: ${after.code}`);
    expect(after.explanation.decisions).toEqual([
      { revisionNo: 1, decision: 'continue-new-attempt', outcome: 'accepted', consumed: false }
    ]);
    expectProtected(host, 'after a decision');
  });

  it('releases every pin after an accepted abandon, across a restart', async () => {
    const delivering = await deliverAcrossRestarts();
    const { handoffId } = delivering;
    let host = restart(delivering.host);
    host.handoffs.reopen();
    expect(host.handoffs.decide(handoffId, 1, 'abandon', 'req-abandon')).toMatchObject({ ok: true, outcome: 'accepted' });
    host = restart(host);
    expect(createHandoffStore(host.conn).getHandoff(handoffId)).toMatchObject({
      state: 'consumed',
      closedReason: 'abandoned'
    });
    expect(handoffPins(host, VALIDATED, handoffId)).toEqual([]);
    expect(handoffPins(host, PARTIAL, handoffId)).toEqual([]);
    expect(decisions(host).get(VALIDATED)).toBe('collect');
  });
});

function legacyRecord(overrides: Partial<LegacyHandoffRecord> = {}): LegacyHandoffRecord {
  return {
    workspaceId: 'ws-1',
    runId: 'run-legacy-1',
    invocationId: 'inv-legacy-1',
    attemptId: 'att-legacy-1',
    status: 'uncertain',
    outcome: { status: 'incomplete', reason: 'credits' },
    certainty: 'uncertain',
    frozenDefinitionDigest: FROZEN,
    cutoff: { executionRevision: 'legacy-exec-1', usageRevision: 0, factCutoffMs: NOW },
    attribution: { backendId: 'claude-cli', runtimeId: 'legacy-runner' },
    providerSessionId: 'sess-provider-1',
    envelope: {
      version: 1,
      invocationId: 'inv-legacy-1',
      upstreamArtifactRefs: [VALIDATED],
      partialArtifactRefs: [PARTIAL],
      workspace: { coverage: 'unavailable', omittedCount: 0, entries: [] },
      effects: { certainty: 'uncertain', evidenceRefs: [] },
      truncated: false
    },
    ...overrides
  };
}

const HANDOFF_TABLES = [
  'recovery_handoffs',
  'recovery_handoff_revisions',
  'recovery_handoff_references',
  'recovery_handoff_deliveries',
  'recovery_handoff_decisions'
] as const;

function handoffTables(conn: NodeSqliteConnection): string {
  return JSON.stringify(HANDOFF_TABLES.map((table) => conn.all<Record<string, unknown>>(`SELECT * FROM ${table}`)));
}

describe('FR-R6-F08 acceptance — US5 legacy records and future versions', () => {
  it('protects the references of a legacy record imported after reopen, and keeps an unknown version live', async () => {
    let host = startHost();
    await seedArtifacts(host);
    adoptZeroAgePolicy(host);
    host = restart(host);
    host.handoffs.reopen();
    const imported = host.handoffs.importLegacy(legacyRecord());
    if (!imported.ok || !('created' in imported)) throw new Error(`import refused: ${JSON.stringify(imported)}`);
    expect(imported).toMatchObject({ created: true, pinRefusals: [] });
    const unsupported = host.handoffs.importLegacy(
      legacyRecord({ attemptId: 'att-legacy-2', envelope: { version: 9, futureField: true } })
    );
    if (!unsupported.ok) throw new Error(`unsupported import refused: ${unsupported.code}`);

    host = restart(host);
    host.handoffs.reopen();
    expectProtected(host, 'after a legacy import');
    expect(host.handoffs.importLegacy(legacyRecord())).toMatchObject({ ok: true, created: false });
    expect(JSON.parse(createHandoffStore(host.conn).getHandoff(imported.handoffId)?.legacyProvenance ?? 'null')).toMatchObject({
      kind: 'legacy-record',
      providerSession: { kind: 'legacy-provider-session', value: 'sess-provider-1' }
    });
    expect(host.handoffs.ownerResolution(unsupported.handoffId)).toBe('live');
    expect(await host.handoffs.resolve(unsupported.handoffId)).toEqual({ ok: false, code: 'unsupported-version' });
    const before = handoffTables(host.conn);
    expect(host.handoffs.decide(unsupported.handoffId, 1, 'abandon', 'req-legacy')).toEqual({
      ok: false,
      code: 'unsupported-version'
    });
    expect(host.handoffs.supersede(unsupported.handoffId)).toEqual({ ok: false, code: 'unsupported-version' });
    expect(handoffTables(host.conn)).toBe(before);
  });

  it('refuses a stored revision written by a newer build and leaves it byte-identical', async () => {
    const delivering = await deliverAcrossRestarts();
    const { handoffId, envelopeDigest, intentId } = delivering;
    expect(delivering.host.handoffs.reportNotSent(intentId)).toEqual({ ok: true });
    const conn = delivering.host.conn;
    conn.run(
      `INSERT INTO recovery_handoff_revisions (handoff_id, revision_no, status, cutoff_key, execution_revision,
         usage_revision, fact_cutoff_ms, manifest_version, manifest_json, manifest_digest, certainty, coverage,
         issued_at_ms, superseded_at_ms)
       VALUES (?, 2, 'issued', ?, 'exec-future', 9, ?, 2, ?, ?, 'uncertain', 'partial', ?, NULL)`,
      handoffId,
      'f'.repeat(64),
      now,
      JSON.stringify({ version: 2, futureField: { nested: true } }),
      'e'.repeat(64),
      now
    );
    conn.run(
      "UPDATE recovery_handoff_revisions SET status = 'superseded', superseded_at_ms = ? WHERE handoff_id = ? AND revision_no = 1",
      now,
      handoffId
    );
    conn.run('UPDATE recovery_handoffs SET current_revision = 2 WHERE handoff_id = ?', handoffId);

    const host = restart(delivering.host);
    host.handoffs.reopen();
    const before = handoffTables(host.conn);
    expect(await host.handoffs.resolve(handoffId)).toEqual({ ok: false, code: 'unsupported-version' });
    expect(await host.handoffs.resolve(handoffId, 2)).toEqual({ ok: false, code: 'unsupported-version' });
    const redelivery = host.handoffs.recordIntent(
      intent(handoffId, envelopeDigest, { revisionNo: 2, targetAttemptId: OTHER_TARGET_ATTEMPT })
    );
    expect(redelivery.ok ? 'ok' : redelivery.code).toBe('unsupported-version');
    const explained = host.handoffs.explain(handoffId);
    expect(explained.ok && explained.explanation.state).toBe('unsupported');
    expect(host.handoffs.decide(handoffId, 2, 'abandon', 'req-future')).toEqual({ ok: false, code: 'unsupported-version' });
    expect(host.handoffs.supersede(handoffId)).toEqual({ ok: false, code: 'unsupported-version' });
    expect(handoffTables(host.conn)).toBe(before);
    expectProtected(host, 'future version');

    // The newer build then closes it: closed is reported before unsupported-version (R7 order).
    host.conn.run(
      "UPDATE recovery_handoffs SET state = 'superseded', closed_reason = 'superseded' WHERE handoff_id = ?",
      handoffId
    );
    const afterClose = host.handoffs.recordIntent(
      intent(handoffId, envelopeDigest, { revisionNo: 2, targetAttemptId: 'att-after-close' })
    );
    expect(afterClose.ok ? 'ok' : afterClose.code).toBe('handoff-closed');
  });
});
