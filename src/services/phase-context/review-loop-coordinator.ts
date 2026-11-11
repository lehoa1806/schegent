/**
 * FR-R6-F15 (F15-B; F15-FR-27..FR-31, F15-FR-34..FR-36) — durable review-loop coordinator
 * helpers and artifact-lifecycle owner-pin release helpers extracted so
 * `phase-handoff-coordinator.ts` stays well below its 1,000-line ceiling.
 *
 * Zero `vscode` or `node:fs` imports (docs/hard-rules.md rules 13, 69).
 */
import { PHASE_CONTEXT_LIMITS, type Refusal } from '../../contracts/phase-context/context-policy';
import type {
  LoopHistory,
  ReviewLoopExplanation,
  Severity
} from '../../contracts/phase-context/review-loop';
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
import { refuse } from './primitives';
import type { DurableHandoffStore } from './sqlite-handoff-store';

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
  readonly candidateSnapshotDigest?: string;
  readonly scopeRevision?: string;
  readonly criteriaRevision?: string;
  readonly blockingSeverities?: readonly Severity[];
  readonly maxReviewPasses?: number;
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

export function buildReviewLoopId(runId: string, repeatNodeId: string): string {
  return normalizeLoopIdentifier(`loop-${runId}-${repeatNodeId}`, 'review-loop');
}

export function resolveEnclosingRepeatNodeId(
  run: ConnectedWorkflowRun,
  frame: WorkflowInvocationFrame
): string | null {
  let cursor: WorkflowInvocationFrame | undefined = frame;
  while (cursor !== undefined) {
    if (cursor.parentInvocationId !== null && cursor.parentCallNodeId !== null) {
      const parentFrame: WorkflowInvocationFrame | undefined =
        run.invocations?.[cursor.parentInvocationId];
      const parentWf = parentFrame
        ? run.frozenClosure?.workflowsById[parentFrame.workflowId]
        : undefined;
      const callNode = parentWf?.nodes.find((n) => n.nodeId === cursor!.parentCallNodeId);
      if (callNode?.control?.kind === 'repeat') {
        return callNode.nodeId;
      }
      cursor = parentFrame;
    } else {
      break;
    }
  }
  return null;
}

export function applyStagedReviewPublications(
  store: DurableHandoffStore,
  input: ReviewLoopAttemptContext,
  captured: Awaited<ReturnType<typeof captureAttemptPublications>>
): { readonly ok: true } | Refusal {
  const runId = input.run.connectedRunId;
  const repeatNodeId =
    input.reviewLoopNodeId ??
    resolveEnclosingRepeatNodeId(input.run, input.frame) ??
    input.attempt.nodeId;
  const loopId = buildReviewLoopId(runId, repeatNodeId);
  const ledgerOptions = {
    loopId,
    blockingSeverities: input.blockingSeverities ?? DEFAULT_BLOCKING_SEVERITIES,
    maxPasses: input.maxReviewPasses ?? PHASE_CONTEXT_LIMITS.loopPassesMax
  };

  if (captured.reviewReport.kind === 'accepted') {
    const { report, capture } = captured.reviewReport;
    const { ledger } = store.loadOrCreateReviewLoop({
      loopId,
      runId,
      nodeId: repeatNodeId,
      options: ledgerOptions
    });
    const candidateRef = input.candidateSnapshotDigest ?? report.candidateRef;
    const scopeRevision = input.scopeRevision ?? report.scopeRevision;
    const criteriaRevision = input.criteriaRevision ?? report.criteriaRevision;
    const reportRef = `artifact:${capture.artifactRef.artifactId}@${capture.artifactRef.immutableVersion}`;
    const acceptedReport = ledger.acceptReport(report, {
      reportRef,
      candidateRef,
      scopeRevision,
      criteriaRevision
    });
    if (!acceptedReport.ok) return acceptedReport;
    store.saveReviewLoop({
      loopId,
      runId,
      nodeId: repeatNodeId,
      ledger,
      options: ledgerOptions,
      candidateRef,
      scopeRevision,
      criteriaRevision
    });
  }

  if (captured.fixClaims.kind === 'accepted') {
    const { claims } = captured.fixClaims;
    const { ledger, entry } = store.loadOrCreateReviewLoop({
      loopId,
      runId,
      nodeId: repeatNodeId,
      options: ledgerOptions
    });
    const candidateRef =
      input.candidateSnapshotDigest ?? entry?.candidateRef ?? 'unknown-candidate';
    const recordedClaims = ledger.recordClaims(claims, { candidateRef });
    if (!recordedClaims.ok) return recordedClaims;
    store.saveReviewLoop({
      loopId,
      runId,
      nodeId: repeatNodeId,
      ledger,
      options: ledgerOptions,
      candidateRef
    });
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
  const entry = store.loadReviewLoop(loopId);
  if (entry === null) return { ok: true };
  if (entry.verdict !== 'passed') {
    return refuse('required-context-unavailable', 'review-blocking-findings');
  }
  const latestPass = entry.snapshot.passes.at(-1);
  if (latestPass === undefined) {
    return refuse('required-context-unavailable', 'review-pass-missing');
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
  const entry = store.loadReviewLoop(loopId);
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
  const record = store.load(handoffId);
  if (record === null) return;
  const artifactIds = new Set<string>();
  for (const rev of record.revisions) {
    const manifest = storedManifest(rev);
    if (manifest === null) continue;
    for (const src of manifest.sources) {
      for (const art of src.artifacts) {
        artifactIds.add(art.artifactId);
        // Also check materialized copy artifact ids deterministic per handoff+attempt.
        if (ownerType === 'attempt') {
          const cleanArt = art.artifactId.trim().replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '').slice(0, 80) || 'art';
          const cleanAtt = ownerId.trim().replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '').slice(0, 80) || 'attempt';
          artifactIds.add(`mat-${cleanArt}-${cleanAtt}`.slice(0, 120));
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
