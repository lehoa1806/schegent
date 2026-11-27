/**
 * FR-R6-F15 (F15-B; F15-FR-27..FR-31, F15-FR-34..FR-36) — durable review-loop coordinator
 * helpers and artifact-lifecycle owner-pin release helpers extracted so
 * `phase-handoff-coordinator.ts` stays well below its 1,000-line ceiling.
 *
 * Zero `vscode` or `node:fs` imports (docs/hard-rules.md rules 13, 69).
 */
import type { TypedCondition, TypedLeaf } from '../../contracts/decision-results';
import {
  PHASE_CONTEXT_CONTRIBUTION_VERSION,
  PHASE_CONTEXT_LIMITS,
  type ArtifactRef,
  type ContributionCandidate,
  type ProducerRef,
  type Refusal,
  type SourceContribution
} from '../../contracts/phase-context/context-policy';
import { parseSourceContribution } from './source-contribution';
import type { HandoffManifest, HandoffRecord } from '../../contracts/phase-context/context-manifest';
import type {
  LoopHistory,
  ReviewLoopExplanation,
  Severity
} from '../../contracts/phase-context/review-loop';
import type { WorkflowDefinition, WorkflowNode } from '../../contracts/workflow-definitions';
import type {
  ConnectedWorkflowRun,
  NodeAttemptRecord,
  WorkflowInvocationFrame
} from '../../state/connected-workflow-run';
import type { ArtifactLifecycleService } from '../artifact-lifecycle';
import { storedManifest } from './acceptance';
import type { captureAttemptPublications } from './attempt-result-publisher';
import { explainReviewLoop } from './explanation';
import { buildLoopHistory } from './loop-history';
import { materializedCopyArtifactId, sanitizePhaseContextToken } from './phase-context-helpers';
import { refuse } from './primitives';
import type { DurableHandoffStore, StoredReviewLoopEntry } from './sqlite-handoff-store';

export type NodeReviewRole = 'reviewer' | 'fixer' | 'none';

export interface ReviewLoopInspection {
  readonly explanation: ReviewLoopExplanation;
  readonly history: LoopHistory;
  readonly candidateRef: string | null;
}

export interface ReviewLoopAttemptContext {
  readonly run: ConnectedWorkflowRun;
  readonly frame: WorkflowInvocationFrame;
  readonly attempt: NodeAttemptRecord;
  readonly reviewLoopNodeId?: string;
  readonly allowReviewReport?: boolean;
  readonly candidateSnapshotDigest?: string;
  readonly fallbackCandidateRef?: string;
  readonly scopeRevision?: string;
  readonly fallbackScopeRevision?: string;
  readonly criteriaRevision?: string;
  readonly fallbackCriteriaRevision?: string;
  readonly blockingSeverities?: readonly Severity[];
  readonly maxReviewPasses?: number;
}

export interface ResolvedReviewLoopTarget {
  readonly repeatNodeId: string;
  readonly repeatNode: WorkflowNode;
  readonly parentWorkflow: WorkflowDefinition;
  readonly insideRepeat: boolean;
}

const DEFAULT_BLOCKING_SEVERITIES: readonly Severity[] = Object.freeze(['critical', 'high']);

function normalizeLoopIdentifier(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9._:-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 128);
  return cleaned.length > 0 ? cleaned : fallback;
}

function collectTypedConditionLeaves(condition: TypedCondition): readonly TypedLeaf[] {
  const { test } = condition;
  if ('all' in test) return test.all;
  if ('any' in test) return test.any;
  return [test];
}

export function buildReviewLoopId(runId: string, repeatNodeId: string): string {
  return normalizeLoopIdentifier(`loop-${runId}-${repeatNodeId}`, 'review-loop');
}

function resolveEnclosingRepeatTarget(
  run: ConnectedWorkflowRun,
  frame: WorkflowInvocationFrame
): ResolvedReviewLoopTarget | null {
  let cursor: WorkflowInvocationFrame | undefined = frame;
  while (cursor !== undefined) {
    if (cursor.parentInvocationId !== null && cursor.parentCallNodeId !== null) {
      const parentFrame: WorkflowInvocationFrame | undefined =
        run.invocations?.[cursor.parentInvocationId];
      const parentWf = parentFrame
        ? run.frozenClosure?.workflowsById[parentFrame.workflowId]
        : undefined;
      const callNode = parentWf?.nodes.find((n) => n.nodeId === cursor!.parentCallNodeId);
      if (parentWf !== undefined && callNode?.control?.kind === 'repeat') {
        return {
          repeatNodeId: callNode.nodeId,
          repeatNode: callNode,
          parentWorkflow: parentWf,
          insideRepeat: true
        };
      }
      cursor = parentFrame;
    } else {
      break;
    }
  }
  return null;
}

export function resolveEnclosingRepeatNodeId(
  run: ConnectedWorkflowRun,
  frame: WorkflowInvocationFrame
): string | null {
  return resolveEnclosingRepeatTarget(run, frame)?.repeatNodeId ?? null;
}

/**
 * FR-027 — unifies loop identity across an authored `Initial Review -> conditional Repeat(Fix -> Review)`
 * workflow: nodes inside `Repeat` resolve to the enclosing `Repeat` node, and an upstream review node
 * with an outgoing connection into a `Repeat` node maps to that same downstream `Repeat` node.
 */
export function resolveReviewLoopTarget(
  run: ConnectedWorkflowRun,
  frame: WorkflowInvocationFrame,
  nodeId: string
): ResolvedReviewLoopTarget | null {
  const enclosing = resolveEnclosingRepeatTarget(run, frame);
  if (enclosing !== null) return enclosing;

  const wf = run.frozenClosure?.workflowsById[frame.workflowId];
  if (wf === undefined) return null;
  for (const conn of wf.connections) {
    if (conn.from.nodeId !== nodeId) continue;
    const targetNodeId = 'nodeId' in conn.to ? conn.to.nodeId : undefined;
    if (targetNodeId === undefined) continue;
    const targetNode = wf.nodes.find((n) => n.nodeId === targetNodeId);
    if (targetNode?.control?.kind === 'repeat') {
      return {
        repeatNodeId: targetNode.nodeId,
        repeatNode: targetNode,
        parentWorkflow: wf,
        insideRepeat: false
      };
    }
  }
  return null;
}

/**
 * FR-027 / FR-029 — derives the host-authoritative review-loop role of a node strictly from the
 * frozen workflow closure (`PhaseDefinition.nativeReview`, `Repeat.until` decision-result bindings,
 * or conditional upstream review edge into a `Repeat` node). Fixer and non-reviewer nodes never
 * receive the `'reviewer'` role and are never authorized to publish `review-report.json`.
 */
export function resolveNodeReviewRole(
  run: ConnectedWorkflowRun,
  frame: WorkflowInvocationFrame,
  nodeId: string
): NodeReviewRole {
  const wf = run.frozenClosure?.workflowsById[frame.workflowId];
  const node = wf?.nodes.find((n) => n.nodeId === nodeId);
  const phase =
    node?.phaseId !== undefined ? run.frozenClosure?.phasesById[node.phaseId] : undefined;
  if (phase?.nativeReview !== undefined) {
    return 'reviewer';
  }
  const loopTarget = resolveReviewLoopTarget(run, frame, nodeId);
  if (loopTarget === null) {
    return 'none';
  }
  if (loopTarget.insideRepeat) {
    const control = loopTarget.repeatNode.control;
    if (control?.kind === 'repeat') {
      const leaves = collectTypedConditionLeaves(control.until);
      if (leaves.some((l) => l.left.source === 'node-result' && l.left.nodeId === nodeId)) {
        return 'reviewer';
      }
      const untilFields = new Set(
        leaves
          .filter(
            (l): l is TypedLeaf & { readonly left: { readonly source: 'result-field'; readonly fieldId: string } } =>
              l.left.source === 'result-field'
          )
          .map((l) => l.left.fieldId)
      );
      const bindsUntil =
        wf?.decisionResults?.bindings.some(
          (b) =>
            untilFields.has(b.fieldId) &&
            b.source.kind === 'node-result' &&
            b.source.nodeId === nodeId
        ) === true;
      if (bindsUntil) {
        return 'reviewer';
      }
    }
    return 'fixer';
  }
  // Upstream node outside Repeat with an outgoing connection to the Repeat node:
  // reviewer role only when a conditional edge from this node gates Repeat entry on its result/output.
  const gatesRepeatConditionally = loopTarget.parentWorkflow.connections.some((conn) => {
    if (conn.from.nodeId !== nodeId || conn.condition === undefined) return false;
    if ('kind' in conn.condition) {
      return collectTypedConditionLeaves(conn.condition).some(
        (l) => l.left.source === 'node-result' && l.left.nodeId === nodeId
      );
    }
    return conn.condition.left.nodeId === nodeId;
  });
  return gatesRepeatConditionally ? 'reviewer' : 'none';
}

export function deriveMaxReviewPassesForRepeat(target: ResolvedReviewLoopTarget): number {
  const control = target.repeatNode.control;
  if (control?.kind !== 'repeat') {
    return PHASE_CONTEXT_LIMITS.loopPassesMax;
  }
  const hasUpstreamFeeder = target.parentWorkflow.connections.some((conn) => {
    const targetId = 'nodeId' in conn.to ? conn.to.nodeId : undefined;
    return targetId === target.repeatNodeId && conn.from.nodeId !== target.repeatNodeId;
  });
  const computed = hasUpstreamFeeder ? control.maxIterations + 1 : control.maxIterations;
  return Math.max(1, Math.min(PHASE_CONTEXT_LIMITS.loopPassesMax, computed));
}

export function applyStagedReviewPublications(
  store: DurableHandoffStore,
  input: ReviewLoopAttemptContext,
  captured: Awaited<ReturnType<typeof captureAttemptPublications>>
): { readonly ok: true } | Refusal {
  const runId = input.run.connectedRunId;
  const loopTarget = resolveReviewLoopTarget(input.run, input.frame, input.attempt.nodeId);
  const repeatNodeId =
    input.reviewLoopNodeId ?? loopTarget?.repeatNodeId ?? input.attempt.nodeId;
  const loopId = buildReviewLoopId(runId, repeatNodeId);
  const derivedMaxPasses =
    input.maxReviewPasses ??
    (loopTarget !== null ? deriveMaxReviewPassesForRepeat(loopTarget) : PHASE_CONTEXT_LIMITS.loopPassesMax);
  const ledgerOptions = {
    loopId,
    blockingSeverities: input.blockingSeverities ?? DEFAULT_BLOCKING_SEVERITIES,
    maxPasses: Math.max(1, Math.min(PHASE_CONTEXT_LIMITS.loopPassesMax, derivedMaxPasses))
  };

  if (captured.reviewReport.kind === 'accepted') {
    if (input.allowReviewReport === false) {
      return refuse('invalid-source', 'reviewer-role-unauthorized');
    }
    const { report, capture } = captured.reviewReport;
    let loaded: ReturnType<DurableHandoffStore['loadOrCreateReviewLoop']>;
    try {
      loaded = store.loadOrCreateReviewLoop({
        loopId,
        runId,
        nodeId: repeatNodeId,
        options: ledgerOptions
      });
    } catch {
      // Fail closed when stored review-loop ledger JSON is corrupt or unreadable.
      return refuse('storage-unavailable', 'corrupt-review-loop-ledger');
    }
    const { ledger, entry } = loaded;
    // FR-027 / FR-028: on pass 2+ (`entry !== null`), NEVER echo untrusted agent `report.candidateRef`,
    // `report.scopeRevision`, or `report.criteriaRevision`, and NEVER let stale `boundInputs` override
    // the host-tracked candidate in `entry.candidateRef`.
    const candidateRef =
      entry !== null
        ? (input.candidateSnapshotDigest ?? entry.candidateRef ?? '')
        : (input.candidateSnapshotDigest ?? input.fallbackCandidateRef ?? report.candidateRef);
    const scopeRevision =
      entry !== null
        ? (input.scopeRevision ?? entry.scopeRevision ?? '')
        : (input.scopeRevision ?? input.fallbackScopeRevision ?? report.scopeRevision);
    const criteriaRevision =
      entry !== null
        ? (input.criteriaRevision ?? entry.criteriaRevision ?? '')
        : (input.criteriaRevision ?? input.fallbackCriteriaRevision ?? report.criteriaRevision);
    const reportRef = `artifact:${capture.artifactRef.artifactId}@${capture.artifactRef.immutableVersion}`;
    const acceptedReport = ledger.acceptReport(report, {
      reportRef,
      candidateRef,
      scopeRevision,
      criteriaRevision
    });
    if (!acceptedReport.ok) return acceptedReport;
    try {
      store.saveReviewLoop({
        loopId,
        runId,
        nodeId: repeatNodeId,
        ledger,
        options: entry?.snapshot.options ?? ledgerOptions,
        candidateRef,
        scopeRevision,
        criteriaRevision
      });
    } catch {
      // Fail closed on review-loop ledger persistence failure.
      return refuse('storage-unavailable', 'corrupt-review-loop-ledger');
    }
  }

  if (captured.fixClaims.kind === 'accepted') {
    const { claims } = captured.fixClaims;
    let loaded: ReturnType<DurableHandoffStore['loadOrCreateReviewLoop']>;
    try {
      loaded = store.loadOrCreateReviewLoop({
        loopId,
        runId,
        nodeId: repeatNodeId,
        options: ledgerOptions
      });
    } catch {
      // Fail closed when stored review-loop ledger JSON is corrupt or unreadable.
      return refuse('storage-unavailable', 'corrupt-review-loop-ledger');
    }
    const { ledger, entry } = loaded;
    // Claims respond to the previously reviewed candidate (`entry.candidateRef`), while any new
    // `input.candidateSnapshotDigest` declared by the Fix attempt becomes the post-fix candidate
    // requiring re-review before Repeat may exit.
    const claimsCandidateRef =
      entry?.candidateRef ??
      input.candidateSnapshotDigest ??
      input.fallbackCandidateRef ??
      'unknown-candidate';
    const recordedClaims = ledger.recordClaims(claims, { candidateRef: claimsCandidateRef });
    if (!recordedClaims.ok) return recordedClaims;
    const postFixCandidateRef =
      input.candidateSnapshotDigest ?? entry?.candidateRef ?? null;
    try {
      store.saveReviewLoop({
        loopId,
        runId,
        nodeId: repeatNodeId,
        ledger,
        options: entry?.snapshot.options ?? ledgerOptions,
        candidateRef: postFixCandidateRef
      });
    } catch {
      // Fail closed on review-loop ledger persistence failure.
      return refuse('storage-unavailable', 'corrupt-review-loop-ledger');
    }
  }

  return { ok: true };
}

export function invalidateStoredReviewLoopCandidate(
  store: DurableHandoffStore,
  params: {
    readonly runId: string;
    readonly repeatNodeId: string;
    readonly newCandidateRef: string;
  }
): void {
  const loopId = buildReviewLoopId(params.runId, params.repeatNodeId);
  const existing = store.loadReviewLoop(loopId);
  if (existing === null) return;
  const { ledger } = store.loadOrCreateReviewLoop({
    loopId,
    runId: params.runId,
    nodeId: params.repeatNodeId,
    options: existing.snapshot.options
  });
  store.saveReviewLoop({
    loopId,
    runId: params.runId,
    nodeId: params.repeatNodeId,
    ledger,
    options: existing.snapshot.options,
    candidateRef: params.newCandidateRef
  });
}

export function verifyStoredRepeatExitAllowed(
  store: DurableHandoffStore,
  params: {
    readonly runId: string;
    readonly repeatNodeId: string;
    readonly currentCandidateRef?: string;
  }
): { readonly ok: true } | Refusal {
  const loopId = buildReviewLoopId(params.runId, params.repeatNodeId);
  let entry: StoredReviewLoopEntry | null;
  try {
    entry = store.loadReviewLoop(loopId);
  } catch {
    // Fail closed: corrupt review-loop ledger row must NEVER allow Repeat exit.
    return refuse('storage-unavailable', 'corrupt-review-loop-ledger');
  }
  if (entry === null) return { ok: true };
  if (entry.verdict !== 'passed') {
    return refuse('required-context-unavailable', 'review-blocking-findings');
  }
  const latestPass = entry.snapshot.passes.at(-1);
  if (latestPass === undefined) {
    return refuse('required-context-unavailable', 'review-pass-missing');
  }
  if (latestPass.outcome.verdict !== 'passed') {
    return refuse('required-context-unavailable', 'review-blocking-findings');
  }
  if (entry.candidateRef !== null && latestPass.candidateRef !== entry.candidateRef) {
    return refuse('stale-revision', 'review-revalidation-required');
  }
  if (
    params.currentCandidateRef !== undefined &&
    latestPass.candidateRef !== params.currentCandidateRef
  ) {
    return refuse('stale-revision', 'review-revalidation-required');
  }
  return { ok: true };
}

export function inspectStoredReviewLoop(
  store: DurableHandoffStore,
  loopId: string
): ReviewLoopInspection | null {
  let entry: StoredReviewLoopEntry | null;
  try {
    entry = store.loadReviewLoop(loopId);
  } catch {
    // Read-only inspection returns null on corrupt ledger rows while gating paths fail closed.
    return null;
  }
  if (entry === null) return null;
  const { ledger } = store.loadOrCreateReviewLoop({
    loopId,
    runId: entry.runId,
    nodeId: entry.nodeId,
    options: entry.snapshot.options
  });
  const explanation = explainReviewLoop(ledger, loopId);
  if (explanation === null) return null;
  return {
    explanation,
    history: buildLoopHistory(ledger.passes()),
    candidateRef: entry.candidateRef
  };
}

export function releasePhaseContextOwnerReferences(
  lifecycle: ArtifactLifecycleService,
  store: DurableHandoffStore,
  handoffId: string,
  ownerType: 'handoff' | 'attempt',
  ownerId: string
): void {
  let record: HandoffRecord | null;
  try {
    record = store.load(handoffId);
  } catch {
    // Preserve protective pins when a stored handoff record cannot be parsed cleanly.
    return;
  }
  if (record === null) return;
  const artifactIds = new Set<string>();
  const cleanOwner = sanitizePhaseContextToken(ownerId, 'attempt');
  if (ownerType === 'attempt') {
    for (const kindLabel of ['contribution', 'legacy-sidecar', 'review-report', 'fix-claims'] as const) {
      artifactIds.add(`res-${kindLabel}-${cleanOwner}`.slice(0, 120));
    }
  }
  for (const rev of record.revisions) {
    const manifest = storedManifest(rev);
    if (manifest === null) continue;
    for (const src of manifest.sources) {
      for (const art of src.artifacts) {
        artifactIds.add(art.artifactId);
        // Also check materialized copy artifact ids deterministic per handoff+attempt.
        if (ownerType === 'attempt') {
          artifactIds.add(materializedCopyArtifactId(art.artifactId, ownerId, art.digestHex));
        }
      }
    }
  }
  for (const artifactId of artifactIds) {
    lifecycle.releaseReference({
      artifactId,
      ownerType,
      ownerId,
      purpose: 'phase-context',
      reason: 'owner-durable'
    });
  }
}

/**
 * Releases clean non-uncertain source and target attempt protective pins for a handoff when a
 * run reaches terminal status with zero `'intent'` or `'uncertain'` dispatches on that handoff.
 */
export function releaseCleanHandoffAttemptReferences(
  lifecycle: ArtifactLifecycleService,
  store: DurableHandoffStore,
  handoffId: string
): void {
  let record: HandoffRecord | null;
  try {
    record = store.load(handoffId);
  } catch {
    // Preserve protective attempt pins when a stored handoff record is corrupt.
    return;
  }
  if (record === null) return;
  const attemptIds = new Set<string>();
  const meta = store.getRunMetadata(handoffId);
  if (meta?.sourceAttemptId !== undefined && meta.sourceAttemptId !== 'none') {
    attemptIds.add(meta.sourceAttemptId);
    attemptIds.add(normalizeLoopIdentifier(meta.sourceAttemptId, 'attempt-1'));
  }
  for (const rev of record.revisions) {
    const manifest = storedManifest(rev);
    if (manifest === null) continue;
    for (const src of manifest.sources) {
      attemptIds.add(src.producer.attemptId);
    }
  }
  for (const d of record.dispatches) {
    if (d.state === 'delivered') {
      attemptIds.add(d.targetAttemptId);
    }
  }
  for (const attemptId of attemptIds) {
    releasePhaseContextOwnerReferences(lifecycle, store, handoffId, 'attempt', attemptId);
  }
}

/**
 * Ensures an immutable artifact is registered in F05 `ArtifactLifecycleService` and optionally
 * adds a checked protective reference (`attempt` or `handoff`), surfacing typed refusals on
 * conflict, quota exhaustion, or storage error rather than swallowing `LifecycleResult`.
 */
export function ensureArtifactRegisteredInLifecycle(params: {
  readonly lifecycle: ArtifactLifecycleService;
  readonly artifactId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly digestHex: string;
  readonly byteSize: number;
  readonly mediaType: string;
  readonly displayName: string;
  readonly relPath: string;
  readonly pinOwner?: { readonly ownerType: 'attempt' | 'handoff'; readonly ownerId: string };
}): { readonly ok: true; readonly alreadyRegistered: boolean } | Refusal {
  try {
    const normalizedRunId = normalizeLoopIdentifier(params.runId, 'run-1');
    const matchesOwnedArtifact = (
      art: {
        readonly ownerRunId: string | null;
        readonly immutability: string;
        readonly digest: { readonly value: string } | null;
        readonly byteSize: number;
      }
    ): boolean =>
      art.ownerRunId !== null &&
      (art.ownerRunId === params.runId || art.ownerRunId === normalizedRunId) &&
      art.immutability === 'immutable' &&
      art.digest?.value === params.digestHex &&
      art.byteSize === params.byteSize;
    const existing = params.lifecycle.getArtifact(params.artifactId);
    let alreadyRegistered = false;
    if (existing.ok) {
      if (!matchesOwnedArtifact(existing.value)) {
        return refuse('storage-unavailable', 'artifact-registration-conflict');
      }
      alreadyRegistered = true;
    } else if (existing.refusal.code === 'not-found') {
      const reg = params.lifecycle.registerArtifact({
        artifactId: params.artifactId,
        ownerRunId: normalizedRunId,
        ownerAttemptId: normalizeLoopIdentifier(params.attemptId, 'attempt-1'),
        sensitivity: 'content',
        retentionClass: 'generated-reports-handoff-exports',
        storeKind: 'handoff-context',
        immutability: 'immutable',
        digest: { algorithm: 'sha256', value: params.digestHex },
        byteSize: params.byteSize,
        mediaType: params.mediaType,
        displayName: params.displayName,
        producerIdentity: normalizeLoopIdentifier(params.attemptId, 'attempt-1'),
        locator: { storageTier: 'workspace_file', uriOrRelpath: params.relPath }
      });
      if (!reg.ok) {
        if (reg.refusal.code === 'identity-conflict') {
          const retryGet = params.lifecycle.getArtifact(params.artifactId);
          if (!retryGet.ok || !matchesOwnedArtifact(retryGet.value)) {
            return refuse('storage-unavailable', 'artifact-registration-conflict');
          }
          alreadyRegistered = true;
        } else {
          return refuse('storage-unavailable', 'artifact-registration-failed');
        }
      }
    } else {
      return refuse('storage-unavailable', 'artifact-lookup-failed');
    }

    if (params.pinOwner !== undefined) {
      const pinned = params.lifecycle.addReference({
        artifactId: params.artifactId,
        ownerType: params.pinOwner.ownerType,
        ownerId: params.pinOwner.ownerId,
        purpose: 'phase-context',
        protective: true
      });
      if (!pinned.ok) {
        return pinned.refusal.code === 'pin-quota-reached'
          ? refuse('capacity-exceeded', 'pin-quota-reached')
          : refuse('storage-unavailable', 'artifact-pin-failed');
      }
    }
    return { ok: true, alreadyRegistered };
  } catch {
    return refuse('storage-unavailable', 'artifact-lifecycle-error');
  }
}

/**
 * FR-008 / FR-016 — acquires checked F05 `ownerType: 'handoff'` protective pins for all artifacts
 * referenced by a prepared handoff manifest, registering unregistered artifacts first and rolling
 * back newly added pins on any quota/storage refusal.
 */
export function pinHandoffArtifactsInLifecycle(params: {
  readonly lifecycle: ArtifactLifecycleService;
  readonly runId: string;
  readonly handoffId: string;
  readonly manifest: HandoffManifest;
  readonly persistedLocations: Readonly<Record<string, string>>;
}): { readonly ok: true; readonly newlyPinnedArtifactIds: readonly string[] } | Refusal {
  const distinctArtifacts = new Map<string, { readonly ref: ArtifactRef; readonly attemptId: string }>();
  for (const src of params.manifest.sources) {
    for (const art of src.artifacts) {
      if (!distinctArtifacts.has(art.artifactId)) {
        distinctArtifacts.set(art.artifactId, { ref: art, attemptId: src.producer.attemptId });
      }
    }
  }

  const newlyPinnedArtifactIds: string[] = [];
  const rollback = (): void => {
    for (const artifactId of newlyPinnedArtifactIds) {
      try {
        params.lifecycle.releaseReference({
          artifactId,
          ownerType: 'handoff',
          ownerId: params.handoffId,
          purpose: 'phase-context',
          reason: 'owner-durable'
        });
      } catch {
        // Best-effort rollback of partial handoff pins on refusal.
      }
    }
  };

  const normalizedRunId = normalizeLoopIdentifier(params.runId, 'run-1');
  for (const { ref, attemptId } of distinctArtifacts.values()) {
    const existingRefs = params.lifecycle.listReferences(ref.artifactId);
    const alreadyPinnedByHandoff =
      existingRefs.ok &&
      existingRefs.value.some(
        (r) =>
          r.ownerType === 'handoff' &&
          r.ownerId === params.handoffId &&
          r.purpose === 'phase-context' &&
          r.active
      );

    const existingArt = params.lifecycle.getArtifact(ref.artifactId);
    if (existingArt.ok) {
      const ownerMatches =
        existingArt.value.ownerRunId !== null &&
        (existingArt.value.ownerRunId === params.runId ||
          existingArt.value.ownerRunId === normalizedRunId);
      const validExisting =
        ownerMatches &&
        existingArt.value.immutability === 'immutable' &&
        existingArt.value.digest?.value === ref.digestHex &&
        existingArt.value.byteSize === ref.byteSize;
      if (!validExisting) {
        rollback();
        return refuse('invalid-source', 'artifact-owner-or-digest-mismatch');
      }
    } else {
      if (existingArt.refusal.code === 'not-found') {
        const relPath: string | undefined = Object.hasOwn(params.persistedLocations, ref.artifactId)
          ? params.persistedLocations[ref.artifactId]
          : undefined;
        if (relPath === undefined) {
          rollback();
          return refuse('storage-unavailable', 'artifact-not-registered');
        }
        const leaf = relPath.split('/').at(-1) ?? ref.artifactId;
        const reg = ensureArtifactRegisteredInLifecycle({
          lifecycle: params.lifecycle,
          artifactId: ref.artifactId,
          runId: params.runId,
          attemptId,
          digestHex: ref.digestHex,
          byteSize: ref.byteSize,
          mediaType: ref.kind === 'text' ? 'text/plain' : 'application/octet-stream',
          displayName: leaf,
          relPath
        });
        if (!reg.ok) {
          rollback();
          return reg;
        }
      } else {
        rollback();
        return refuse('storage-unavailable', 'artifact-lookup-failed');
      }
    }

    const pinRes = params.lifecycle.addReference({
      artifactId: ref.artifactId,
      ownerType: 'handoff',
      ownerId: params.handoffId,
      purpose: 'phase-context',
      protective: true
    });
    if (!pinRes.ok) {
      rollback();
      return pinRes.refusal.code === 'pin-quota-reached'
        ? refuse('capacity-exceeded', 'pin-quota-reached')
        : refuse('storage-unavailable', 'artifact-pin-failed');
    }
    if (!alreadyPinnedByHandoff) {
      newlyPinnedArtifactIds.push(ref.artifactId);
    }
  }

  return { ok: true, newlyPinnedArtifactIds };
}

/**
 * FR-014 — filters run-wide contribution candidates to the current invocation frame and its
 * ancestor chain so closed sibling Repeat iterations or sibling ForEach items never bleed into
 * each other or trigger false `ambiguous-source` refusals.
 */
export function scopeRunCandidatesToFrame(
  run: ConnectedWorkflowRun,
  frame: WorkflowInvocationFrame,
  candidates: readonly ContributionCandidate[],
  normalizeId: (raw: string, fallback: string) => string
): readonly ContributionCandidate[] {
  const knownInvocations = new Set(
    Object.keys(run.invocations ?? {}).map((id) => normalizeId(id, 'occ-1'))
  );
  const inScopeOccurrences = new Set<string>();
  for (
    let cursor: WorkflowInvocationFrame | undefined = frame;
    cursor !== undefined;
    cursor =
      cursor.parentInvocationId !== null ? run.invocations?.[cursor.parentInvocationId] : undefined
  ) {
    inScopeOccurrences.add(normalizeId(cursor.invocationId, 'occ-1'));
  }
  return candidates.filter(
    (c) =>
      inScopeOccurrences.has(c.acceptedFrom.occurrenceId) ||
      !knownInvocations.has(c.acceptedFrom.occurrenceId)
  );
}

/**
 * FR-032 — merges the immutable ForEach result index `ArtifactRef` with any additional declared
 * output file refs and validates the synthetic ForEach `SourceContribution`.
 */
export function buildForEachSourceContribution(params: {
  readonly producer: ProducerRef;
  readonly completed: boolean;
  readonly summaryLine: string;
  readonly indexRef: ArtifactRef | null;
  readonly extraRefs: readonly ArtifactRef[];
}): { readonly ok: true; readonly contribution: SourceContribution } | Refusal {
  const refs: ArtifactRef[] = [];
  if (params.indexRef !== null) refs.push(params.indexRef);
  const seenIds = new Set(refs.map((r) => r.artifactId));
  for (const r of params.extraRefs) {
    if (!seenIds.has(r.artifactId) && refs.length < PHASE_CONTEXT_LIMITS.artifactReferencesMax) {
      refs.push(r);
      seenIds.add(r.artifactId);
    }
  }
  const synthetic: SourceContribution = {
    schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
    producer: params.producer,
    coverage: params.completed ? 'complete' : 'unavailable',
    outcomes: [params.summaryLine],
    decisions: [],
    constraints: [],
    unresolvedIssues: [],
    summary: null,
    artifacts: refs
  };
  return parseSourceContribution(synthetic, params.producer);
}
