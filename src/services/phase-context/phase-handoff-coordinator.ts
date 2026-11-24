/**
 * FR-R6-F15 (F15-B; F15-FR-01..FR-36, F15-NFR-01..NFR-08) — authoritative coordinator for
 * phase-to-phase context handoffs, review-loop ledgers, cross-root artifact materialization,
 * manual handoff edit/approval, and ACP prompt-block delivery planning.
 *
 * Zero `vscode` or `node:fs` imports (docs/hard-rules.md rules 13, 69).
 */
import { ACP_PROTOCOL_VERSION } from '../../contracts/acp-runtime';
import { getBackendDescriptor } from '../../contracts/backend-descriptors';
import { DEFAULT_BACKEND, isBackendRunnerKind } from '../../contracts/backend-kinds';
import type { DeliveryRepresentation } from '../../contracts/phase-context/context-delivery';
import type {
  AcceptedRevision,
  HandoffExplanation,
  HandoffManifest,
  HandoffObservation,
  HandoffRecord,
  HandoffRevisionDiff
} from '../../contracts/phase-context/context-manifest';
import {
  PHASE_CONTEXT_CONTRIBUTION_VERSION,
  PHASE_CONTEXT_LIMITS,
  type ArtifactRef,
  type BoundInput,
  type ContributionCandidate,
  type HandoffIdentity,
  type PhaseContextFailure,
  type ProducerRef,
  type Refusal,
  type SourceContribution
} from '../../contracts/phase-context/context-policy';
import type { Severity } from '../../contracts/phase-context/review-loop';
import type { WorkflowConnection, WorkflowDefinition } from '../../contracts/workflow-definitions';
import type {
  ConnectedWorkflowRun,
  NodeAttemptRecord,
  WorkflowInvocationFrame
} from '../../state/connected-workflow-run';
import type { ArtifactLifecycleService } from '../artifact-lifecycle';
import { createAcceptanceService, storedManifest, type AcceptanceService } from './acceptance';
import {
  allocateAttemptStagingPaths,
  captureAttemptPublications,
  type AttemptStagingPaths,
  type LegacySidecarScope
} from './attempt-result-publisher';
import {
  compareHandoffRevisions,
  explainHandoff,
  observationOf,
  observePrepared
} from './explanation';
import {
  artifactLocationKey,
  buildBoundedAdmissionOwner,
  canonicalNodePathInFrame,
  clipUtf8Safe,
  ensureHandoffArtifactsPinned,
  executePlanAttemptDelivery,
  inspectDeclaredOutputFiles,
  inspectForEachResultIndexArtifact,
  normalizeHandoffIdentifier,
  normalizeNodePathForHandoff,
  splitSafeRelativePath,
  type PlanAttemptDeliveryInput,
  type PlanAttemptDeliveryResult,
  type StoredArtifactLocation,
  type TargetProfileResolution
} from './handoff-delivery-coordinator';
import { handoffIdOf, parseHandoffIdentity } from './identity';
import { AdmissionWaiterQueue } from './phase-context-helpers';
import { prepareHandoff } from './preparation';
import { createPreparationAdmission, type PreparationAdmission } from './preparation-admission';
import { refuse } from './primitives';
import {
  applyStagedReviewPublications,
  buildForEachSourceContribution,
  inspectStoredReviewLoop,
  invalidateStoredReviewLoopCandidate,
  releaseCleanHandoffAttemptReferences,
  releasePhaseContextOwnerReferences,
  resolveNodeReviewRole,
  resolveReviewLoopTarget,
  scopeRunCandidatesToFrame,
  verifyStoredRepeatExitAllowed,
  type ReviewLoopInspection
} from './review-loop-coordinator';
import { parseSourceContribution } from './source-contribution';
import type {
  DurableHandoffStore,
  TransitionedUncertainDispatch
} from './sqlite-handoff-store';

export { normalizeNodePathForHandoff } from './handoff-delivery-coordinator';
export type {
  PlanAttemptDeliveryInput,
  PlanAttemptDeliveryResult,
  TargetProfileResolution
} from './handoff-delivery-coordinator';
export type { ReviewLoopInspection } from './review-loop-coordinator';

export interface PhaseHandoffCoordinatorDeps {
  readonly store: DurableHandoffStore;
  readonly primaryWorkspaceRoot: string;
  readonly workspaceId: string;
  readonly lifecycle?: ArtifactLifecycleService | null;
  readonly resolveExecutionRoot?: (runId: string) => string;
  readonly resolveLaneId?: (runId: string) => string | null;
  readonly resolveTargetProfile?: (backendId: string) => TargetProfileResolution;
  readonly legacySidecarOptIn?: boolean;
  readonly onObservation?: (observation: HandoffObservation) => void;
  readonly nowMs?: () => number;
  readonly admission?: PreparationAdmission;
}

interface RecordedAttemptCandidate {
  readonly candidate: ContributionCandidate;
  readonly artifactsByKey: ReadonlyMap<string, StoredArtifactLocation>;
}

export interface RecordSettledAttemptInput {
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
  readonly legacySidecarScope?: LegacySidecarScope;
  readonly legacySidecarSegments?: readonly string[];
}

export interface PrepareTransitionHandoffInput {
  readonly run: ConnectedWorkflowRun;
  readonly frame: WorkflowInvocationFrame;
  readonly workflow: WorkflowDefinition;
  readonly connection: WorkflowConnection;
  readonly connectionIndex: number;
  readonly fromNodeId: string;
  readonly fromAttempt: NodeAttemptRecord;
  readonly targetNodeId: string;
  readonly targetInstructions: string;
  readonly targetBackendId: string;
  /** Optional explicit working-set byte estimate (never clamped below `workingSetBytesMax`). */
  readonly estimatedWorkingSetBytes?: number;
}

export type PrepareTransitionHandoffResult =
  | { readonly kind: 'no-handoff' }
  | {
      readonly kind: 'accepted';
      readonly handoffId: string;
      readonly revision: AcceptedRevision;
      readonly manifest: HandoffManifest;
      readonly waitingApproval: boolean;
    }
  | {
      readonly kind: 'refused';
      readonly failure: PhaseContextFailure;
      readonly detail: string;
    };

function defaultTargetProfile(backendId: string): TargetProfileResolution {
  const normalized = normalizeHandoffIdentifier(backendId || DEFAULT_BACKEND, DEFAULT_BACKEND);
  const descriptor = isBackendRunnerKind(normalized) ? getBackendDescriptor(normalized) : null;
  return {
    profile: {
      profileId: descriptor !== null ? descriptor.acpProfile.profileId : `${normalized}-acp`,
      profileRevision: descriptor !== null ? descriptor.acpProfile.revision : 1,
      qualifiedContextBytes: PHASE_CONTEXT_LIMITS.renderedContextBytesMax
    },
    capabilities: {
      protocolVersion: ACP_PROTOCOL_VERSION,
      loadSession: true,
      image: false,
      audio: false,
      embeddedContext: true,
      authMethodCount: 0
    }
  };
}

export interface PhaseHandoffCoordinator {
  readonly store: DurableHandoffStore;
  readonly acceptance: AcceptanceService;
  stagingPathsForAttempt(runId: string, attemptId: string): AttemptStagingPaths;
  registerExternalContribution(params: {
    readonly runId: string;
    readonly contribution: SourceContribution;
    readonly artifacts?: readonly {
      readonly ref: ArtifactRef;
      readonly sourceRoot: string;
      readonly relativePath: string;
      readonly inlineText?: string | null;
    }[];
  }): { readonly ok: true; readonly sequence: number } | Refusal;
  recordSettledAttempt(input: RecordSettledAttemptInput): Promise<{ readonly ok: true } | Refusal>;
  invalidateReviewLoopCandidate(params: {
    readonly runId: string;
    readonly repeatNodeId: string;
    readonly newCandidateRef: string;
  }): void;
  verifyRepeatExitAllowed(params: {
    readonly runId: string;
    readonly repeatNodeId: string;
    readonly currentCandidateRef?: string;
  }): { readonly ok: true } | Refusal;
  prepareTransitionHandoff(
    input: PrepareTransitionHandoffInput
  ): Promise<PrepareTransitionHandoffResult>;
  resolvePendingHandoffForTarget(
    runId: string,
    invocationId: string,
    targetNodeId: string
  ): string | null;
  planAndAuthorizeAttemptDelivery(
    input: PlanAttemptDeliveryInput
  ): Promise<PlanAttemptDeliveryResult>;
  resolveHandoffRepresentation(attemptId: string): DeliveryRepresentation | null;
  resolveHandoffContentDigest(handoffId: string): string | null;
  settleAttemptDispatch(params: {
    readonly handoffId: string;
    readonly revision: number;
    readonly targetAttemptId: string;
    readonly delivered: boolean;
  }): { readonly ok: true } | Refusal;
  reconcileInterruptedDispatches(runId?: string): readonly TransitionedUncertainDispatch[];
  releaseTerminalRunPins(runId: string): void;
  reloadFromStore(): void;
  inspectHandoff(
    handoffId: string,
    revision?: number
  ): { readonly ok: true; readonly explanation: HandoffExplanation } | Refusal;
  compareHandoffRevisions(
    handoffId: string,
    fromRevision: number,
    toRevision: number
  ): { readonly ok: true; readonly diff: HandoffRevisionDiff } | Refusal;
  inspectReviewLoop(loopId: string): ReviewLoopInspection | null;
  listRunHandoffs(runId: string): readonly HandoffExplanation[];
  listRunReviewLoops(runId: string): readonly ReviewLoopInspection[];
  editHandoff(
    handoffId: string,
    baseRevision: number,
    replacementSources: unknown
  ): { readonly ok: true; readonly revision: AcceptedRevision } | Refusal;
  approveHandoff(
    handoffId: string,
    revision: number,
    decisionId: string
  ): { readonly ok: true; readonly revision: number } | Refusal;
}

class PhaseHandoffCoordinatorImpl implements PhaseHandoffCoordinator {
  public readonly store: DurableHandoffStore;
  public readonly acceptance: AcceptanceService;
  private readonly admission: PreparationAdmission;
  private readonly admissionQueue: AdmissionWaiterQueue;
  private readonly clock: () => number;
  private readonly resolveExecutionRoot: (runId: string) => string;
  private readonly resolveLaneId: (runId: string) => string | null;
  private readonly resolveProfile: (backendId: string) => TargetProfileResolution;
  private readonly sequenceByRunId = new Map<string, number>();
  private readonly candidatesByRunId = new Map<string, RecordedAttemptCandidate[]>();
  private admissionNonce = 0;

  public constructor(private readonly deps: PhaseHandoffCoordinatorDeps) {
    this.store = deps.store;
    this.acceptance = createAcceptanceService(deps.store);
    this.clock = deps.nowMs ?? (() => Date.now());
    this.admission = deps.admission ?? createPreparationAdmission({ now: this.clock });
    this.admissionQueue = new AdmissionWaiterQueue(this.admission, this.clock);
    this.resolveExecutionRoot =
      deps.resolveExecutionRoot ?? (() => deps.primaryWorkspaceRoot);
    this.resolveLaneId = deps.resolveLaneId ?? (() => null);
    this.resolveProfile = deps.resolveTargetProfile ?? defaultTargetProfile;
  }

  private nextSequence(runId: string): number {
    const next = (this.sequenceByRunId.get(runId) ?? 0) + 1;
    this.sequenceByRunId.set(runId, next);
    return next;
  }

  private emitObservation(obs: HandoffObservation | null): void {
    if (obs === null) return;
    if (this.store.recordObservation(obs)) {
      try {
        this.deps.onObservation?.(obs);
      } catch {
        // Non-authoritative telemetry sink errors must never abort or roll back authoritative SQLite writes.
      }
    }
  }

  private emitRecordObservations(
    record: HandoffRecord,
    revision: number,
    events: readonly (
      | 'accepted'
      | 'approved'
      | 'superseded'
      | 'dispatch-intent'
      | 'delivered'
      | 'uncertain'
    )[],
    targetAttemptId?: string
  ): void {
    for (const evt of events) {
      this.emitObservation(observationOf(evt, record, revision, targetAttemptId));
    }
  }

  private appendCandidate(runId: string, entry: RecordedAttemptCandidate): void {
    const existing = this.candidatesByRunId.get(runId) ?? [];
    const filtered = existing.filter(
      (c) => c.candidate.acceptedFrom.attemptId !== entry.candidate.acceptedFrom.attemptId
    );
    filtered.push(entry);
    this.candidatesByRunId.set(runId, filtered);
  }

  private lookupRunArtifactLocations(runId: string): ReadonlyMap<string, StoredArtifactLocation> {
    const merged = new Map<string, StoredArtifactLocation>();
    for (const item of this.candidatesByRunId.get(runId) ?? []) {
      for (const [k, loc] of item.artifactsByKey.entries()) {
        merged.set(k, loc);
      }
    }
    return merged;
  }

  public stagingPathsForAttempt(runId: string, attemptId: string): AttemptStagingPaths {
    return allocateAttemptStagingPaths(this.resolveExecutionRoot(runId), runId, attemptId);
  }

  public registerExternalContribution(params: {
    readonly runId: string;
    readonly contribution: SourceContribution;
    readonly artifacts?: readonly {
      readonly ref: ArtifactRef;
      readonly sourceRoot: string;
      readonly relativePath: string;
      readonly inlineText?: string | null;
    }[];
  }): { readonly ok: true; readonly sequence: number } | Refusal {
    const parsed = parseSourceContribution(params.contribution, params.contribution.producer);
    if (!parsed.ok) return parsed;
    const locations = new Map<string, StoredArtifactLocation>();
    for (const item of params.artifacts ?? []) {
      const segments = splitSafeRelativePath(item.relativePath);
      if (segments === null) return refuse('invalid-source', 'artifact-relative-path');
      locations.set(artifactLocationKey(item.ref.artifactId, item.ref.immutableVersion), {
        ref: item.ref,
        sourceRoot: item.sourceRoot,
        sourceSegments: segments,
        inlineText: item.inlineText ?? null
      });
    }
    const seq = this.nextSequence(params.runId);
    this.appendCandidate(params.runId, {
      candidate: {
        acceptedFrom: parsed.contribution.producer,
        acceptedSequence: seq,
        contribution: parsed.contribution
      },
      artifactsByKey: locations
    });
    return { ok: true, sequence: seq };
  }

  private async recordForEachWorkflowAttempt(
    input: RecordSettledAttemptInput,
    producer: ProducerRef,
    executionRoot: string
  ): Promise<{ readonly ok: true } | Refusal> {
    const wf = input.run.frozenClosure?.workflowsById[input.frame.workflowId];
    const node = wf?.nodes.find((n) => n.nodeId === input.attempt.nodeId);
    if (node?.control?.kind !== 'for-each') return { ok: true };

    const runId = input.run.connectedRunId;
    const forEachIdx = await inspectForEachResultIndexArtifact({
      executionRoot,
      primaryWorkspaceRoot: this.deps.primaryWorkspaceRoot,
      runId,
      attemptId: producer.attemptId,
      declaredOutputs: input.attempt.declaredOutputs,
      lifecycle: this.deps.lifecycle ?? null
    });
    if (!forEachIdx.ok) return forEachIdx;

    const nonIndexOutputs: Record<string, typeof input.attempt.declaredOutputs[string]> = {};
    for (const [portId, portVal] of Object.entries(input.attempt.declaredOutputs)) {
      if (portId === 'resultIndexArtifact') continue;
      nonIndexOutputs[portId] = portVal;
    }
    const extraFiles = await inspectDeclaredOutputFiles({
      executionRoot,
      primaryWorkspaceRoot: this.deps.primaryWorkspaceRoot,
      runId,
      attemptId: producer.attemptId,
      declaredOutputs: nonIndexOutputs,
      lifecycle: this.deps.lifecycle ?? null
    });
    if (!extraFiles.ok) return extraFiles;

    const locations = new Map<string, StoredArtifactLocation>(extraFiles.locations);
    if (forEachIdx.ref !== null && forEachIdx.location !== null) {
      locations.set(
        artifactLocationKey(forEachIdx.ref.artifactId, forEachIdx.ref.immutableVersion),
        forEachIdx.location
      );
    }
    const checked = buildForEachSourceContribution({
      producer,
      completed: input.attempt.status === 'completed',
      summaryLine: forEachIdx.summaryLine,
      indexRef: forEachIdx.ref,
      extraRefs: extraFiles.refs
    });
    if (!checked.ok) return checked;

    this.appendCandidate(runId, {
      candidate: { acceptedFrom: producer, acceptedSequence: this.nextSequence(runId), contribution: checked.contribution },
      artifactsByKey: locations
    });
    return { ok: true };
  }

  public async recordSettledAttempt(
    input: RecordSettledAttemptInput
  ): Promise<{ readonly ok: true } | Refusal> {
    const runId = input.run.connectedRunId;
    const executionRoot = this.resolveExecutionRoot(runId);
    const producer: ProducerRef = Object.freeze({
      nodePath: normalizeNodePathForHandoff(input.attempt.nodePath),
      occurrenceId: normalizeHandoffIdentifier(input.frame.invocationId, 'occ-1'),
      attemptId: normalizeHandoffIdentifier(input.attempt.attemptId, 'attempt-1')
    });

    if (input.attempt.nodeKind === 'workflow') {
      return this.recordForEachWorkflowAttempt(input, producer, executionRoot);
    }

    const allowReviewReport =
      input.allowReviewReport ??
      (input.reviewLoopNodeId !== undefined &&
      resolveReviewLoopTarget(input.run, input.frame, input.attempt.nodeId) === null
        ? true
        : resolveNodeReviewRole(input.run, input.frame, input.attempt.nodeId) === 'reviewer');

    const captured = await captureAttemptPublications({
      runId,
      executionRoot,
      primaryWorkspaceRoot: this.deps.primaryWorkspaceRoot,
      producer,
      allowReviewReport,
      ...(this.deps.legacySidecarOptIn !== undefined
        ? { legacySidecarOptIn: this.deps.legacySidecarOptIn }
        : {}),
      ...(input.legacySidecarScope !== undefined
        ? { legacySidecarScope: input.legacySidecarScope }
        : {}),
      ...(input.legacySidecarSegments !== undefined
        ? { legacySidecarSegments: input.legacySidecarSegments }
        : {}),
      lifecycle: this.deps.lifecycle ?? null
    });

    if (captured.contribution.kind === 'refused') {
      return { ok: false, failure: captured.contribution.failure, detail: captured.contribution.detail };
    }
    if (captured.reviewReport.kind === 'refused') {
      return { ok: false, failure: captured.reviewReport.failure, detail: captured.reviewReport.detail };
    }
    if (captured.fixClaims.kind === 'refused') {
      return { ok: false, failure: captured.fixClaims.failure, detail: captured.fixClaims.detail };
    }

    const declaredFiles = await inspectDeclaredOutputFiles({
      executionRoot,
      primaryWorkspaceRoot: this.deps.primaryWorkspaceRoot,
      runId,
      attemptId: producer.attemptId,
      declaredOutputs: input.attempt.declaredOutputs,
      lifecycle: this.deps.lifecycle ?? null
    });
    if (!declaredFiles.ok) return declaredFiles;
    const locations = new Map<string, StoredArtifactLocation>(declaredFiles.locations);

    if (captured.contribution.kind === 'accepted') {
      const cap = captured.contribution.capture;
      const capSegments = splitSafeRelativePath(cap.immutableRelPath);
      if (capSegments !== null) {
        locations.set(
          artifactLocationKey(cap.artifactRef.artifactId, cap.artifactRef.immutableVersion),
          {
            ref: cap.artifactRef,
            sourceRoot: this.deps.primaryWorkspaceRoot,
            sourceSegments: capSegments,
            inlineText:
              cap.artifactRef.byteSize <= PHASE_CONTEXT_LIMITS.embedBytesMax ? cap.rawText : null
          }
        );
      }
      const existingIds = new Set(
        captured.contribution.contribution.artifacts.map((a) => a.artifactId)
      );
      const mergedArtifacts = [
        ...captured.contribution.contribution.artifacts,
        ...declaredFiles.refs.filter((r) => !existingIds.has(r.artifactId))
      ].slice(0, PHASE_CONTEXT_LIMITS.artifactReferencesMax);
      const mergedCheck = parseSourceContribution(
        { ...captured.contribution.contribution, artifacts: mergedArtifacts },
        producer
      );
      const effectiveContribution = mergedCheck.ok
        ? mergedCheck.contribution
        : captured.contribution.contribution;
      this.appendCandidate(runId, {
        candidate: {
          acceptedFrom: producer,
          acceptedSequence: this.nextSequence(runId),
          contribution: effectiveContribution
        },
        artifactsByKey: locations
      });
    } else {
      const outcomeLines = Object.entries(input.attempt.declaredOutputs)
        .slice(0, PHASE_CONTEXT_LIMITS.collectionEntriesMax)
        .map(([k, v]) => clipUtf8Safe(`${k}:${v.value}`, PHASE_CONTEXT_LIMITS.textEntryBytesMax));
      const fallbackContribution: SourceContribution = {
        schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
        producer,
        coverage: input.attempt.status === 'completed' ? 'complete' : 'unavailable',
        outcomes: outcomeLines.length > 0 ? outcomeLines : [`phase-status:${input.attempt.status}`],
        decisions: [],
        constraints: [],
        unresolvedIssues: [],
        summary: null,
        artifacts: declaredFiles.refs
      };
      const checked = parseSourceContribution(fallbackContribution, producer);
      if (checked.ok) {
        this.appendCandidate(runId, {
          candidate: {
            acceptedFrom: producer,
            acceptedSequence: this.nextSequence(runId),
            contribution: checked.contribution
          },
          artifactsByKey: locations
        });
      }
    }

    return applyStagedReviewPublications(
      this.store,
      { ...input, allowReviewReport },
      captured
    );
  }

  public invalidateReviewLoopCandidate(params: {
    readonly runId: string;
    readonly repeatNodeId: string;
    readonly newCandidateRef: string;
  }): void {
    invalidateStoredReviewLoopCandidate(this.store, params);
  }

  public verifyRepeatExitAllowed(params: {
    readonly runId: string;
    readonly repeatNodeId: string;
    readonly currentCandidateRef?: string;
  }): { readonly ok: true } | Refusal {
    return verifyStoredRepeatExitAllowed(this.store, params);
  }

  public async prepareTransitionHandoff(
    input: PrepareTransitionHandoffInput
  ): Promise<PrepareTransitionHandoffResult> {
    if (input.connection.contextPolicy === undefined) {
      return { kind: 'no-handoff' };
    }

    const runId = input.run.connectedRunId;
    const runCandidates = scopeRunCandidatesToFrame(
      input.run,
      input.frame,
      (this.candidatesByRunId.get(runId) ?? []).map((c) => c.candidate),
      normalizeHandoffIdentifier
    );
    const cutoffSequence = this.sequenceByRunId.get(runId) ?? 0;

    // NFR-003: do NOT clamp `estimatedBytes` to `workingSetBytesMax` so oversized single
    // preparations genuinely fail closed with `working-set-exceeded`.
    const estimatedBytes =
      input.estimatedWorkingSetBytes ??
      Math.max(4096, Buffer.byteLength(JSON.stringify(runCandidates), 'utf8') * 2);
    const admissionOwner = buildBoundedAdmissionOwner('prep', [
      runId,
      input.frame.invocationId,
      input.targetNodeId,
      String(++this.admissionNonce)
    ]);
    this.admission.expire();
    const admitted = this.admission.request(admissionOwner, estimatedBytes);
    if (!admitted.ok) {
      return { kind: 'refused', failure: admitted.failure, detail: admitted.detail };
    }

    try {
      if (admitted.state === 'queued') {
        const waited = await this.admissionQueue.waitForActivation(admissionOwner, estimatedBytes);
        if (!waited.ok) {
          return { kind: 'refused', failure: waited.failure, detail: waited.detail };
        }
      }

      const framePath = normalizeNodePathForHandoff(input.frame.nodePath);
      const targetNodePath = canonicalNodePathInFrame(input.frame, input.targetNodeId);
      const resolveSiblingNodePath = (nodeId: string): string => {
        const attemptsForNode = input.frame.attemptsByNodeId[nodeId] as
          | readonly { readonly nodePath: string }[]
          | undefined;
        const recordedPath = attemptsForNode?.at(-1)?.nodePath;
        return recordedPath !== undefined
          ? normalizeNodePathForHandoff(recordedPath)
          : normalizeNodePathForHandoff(`${framePath}/${nodeId}`);
      };

      const normalizedPolicy = {
        ...input.connection.contextPolicy,
        selectors: input.connection.contextPolicy.selectors.map((sel) => ({
          ...sel,
          sourceNodePath: sel.sourceNodePath.includes('/')
            ? normalizeNodePathForHandoff(sel.sourceNodePath)
            : resolveSiblingNodePath(sel.sourceNodePath)
        }))
      };

      const boundInputs: BoundInput[] = [];
      for (const binding of input.workflow.bindings ?? []) {
        if (
          binding.kind === 'input' &&
          binding.nodeId === input.targetNodeId &&
          binding.source.from === 'node-output'
        ) {
          boundInputs.push({
            bindingId: normalizeHandoffIdentifier(
              `bind-${binding.nodeId}-${binding.inputKey}`,
              'bind-1'
            ),
            sourceNodePath: resolveSiblingNodePath(binding.source.nodeId)
          });
        }
      }

      const requestedSourcePaths = new Set<string>([
        ...boundInputs.map((b) => b.sourceNodePath),
        ...normalizedPolicy.selectors.map((s) => s.sourceNodePath)
      ]);
      const sourceAttempts: ProducerRef[] = runCandidates
        .filter(
          (c) =>
            c.acceptedSequence <= cutoffSequence &&
            requestedSourcePaths.has(c.acceptedFrom.nodePath)
        )
        .map((c) => c.acceptedFrom);

      const rawIdentity: HandoffIdentity = {
        workspaceId: normalizeHandoffIdentifier(this.deps.workspaceId, 'ws-default'),
        rootExecutionId: normalizeHandoffIdentifier(runId, 'run-1'),
        sourceInvocationId: normalizeHandoffIdentifier(input.frame.invocationId, 'inv-1'),
        targetNodePath,
        targetOccurrenceId: normalizeHandoffIdentifier(input.frame.invocationId, 'occ-1'),
        inputEnvelopeRevision: Math.max(0, input.run.revision),
        sourceAttempts
      };

      const parsedIdentity = parseHandoffIdentity(rawIdentity);
      if (!parsedIdentity.ok) {
        return { kind: 'refused', failure: parsedIdentity.failure, detail: parsedIdentity.detail };
      }
      const computedHandoffId = handoffIdOf(parsedIdentity.identity);
      let existingRecord: HandoffRecord | null;
      try {
        existingRecord = this.store.load(computedHandoffId);
      } catch {
        return { kind: 'refused', failure: 'storage-unavailable', detail: 'store-failure' };
      }
      const nextRevNumber =
        existingRecord === null ? 1 : (existingRecord.revisions.at(-1)?.revision ?? 0) + 1;

      const { profile } = this.resolveProfile(input.targetBackendId);
      const prep = prepareHandoff({
        policy: normalizedPolicy,
        identity: parsedIdentity.identity,
        cutoffSequence,
        candidates: runCandidates,
        boundInputs,
        targetInstructions: input.targetInstructions,
        profile,
        revision: nextRevNumber
      });

      if (prep.kind === 'no-handoff' || prep.kind === 'refused') {
        return prep;
      }

      // Check active preparation deadline before committing external pins or SQLite rows.
      if (this.admission.expire().includes(admissionOwner)) {
        return { kind: 'refused', failure: 'capacity-exceeded', detail: 'preparation-deadline' };
      }

      // Acquire checked protective F05 pins and durable workspace-relative artifact locators BEFORE
      // opening the SQLite handoff transaction (so F05 `BEGIN IMMEDIATE` never nests and pin quota
      // refusals leave zero unpinned handoff rows).
      const pinnedRes = await ensureHandoffArtifactsPinned({
        primaryWorkspaceRoot: this.deps.primaryWorkspaceRoot,
        runId,
        handoffId: prep.manifest.handoffId,
        manifest: prep.manifest,
        runLocations: this.lookupRunArtifactLocations(runId),
        lifecycle: this.deps.lifecycle ?? null
      });
      if (!pinnedRes.ok) {
        return { kind: 'refused', failure: pinnedRes.failure, detail: pinnedRes.detail };
      }

      let txOutcome:
        | { readonly ok: true; readonly revision: AcceptedRevision; readonly created: boolean }
        | Refusal;
      try {
        txOutcome = this.store.runInImmediateTransaction(() => {
          this.store.bindRunMetadata(prep.manifest.handoffId, {
            runId,
            sourceAttemptId: input.fromAttempt.attemptId,
            targetPhaseId: input.targetNodeId,
            laneId: this.resolveLaneId(runId)
          });
          if (Object.keys(pinnedRes.persistedLocations).length > 0) {
            this.store.saveArtifactLocations(prep.manifest.handoffId, pinnedRes.persistedLocations);
          }
          const accepted = this.acceptance.accept(prep);
          if (!accepted.ok) return accepted;

          // FR-022: emit `'prepared'` AFTER `acceptance.accept` creates/updates the SQLite row so
          // revision-1 `'prepared'` is durably persisted in `store.listObservations`.
          this.emitObservation(observePrepared(prep));
          const stored = this.store.load(prep.manifest.handoffId);
          if (stored !== null) {
            this.emitRecordObservations(stored, accepted.revision.revision, ['accepted']);
            if (accepted.revision.revision > 1) {
              this.emitRecordObservations(stored, accepted.revision.revision - 1, ['superseded']);
            }
          }
          return accepted;
        });
      } catch {
        // CR-314-8: convert SQLite/transaction exceptions to typed refusal so F05 pin rollback executes.
        txOutcome = refuse('storage-unavailable', 'store-failure');
      }

      if (!txOutcome.ok) {
        if (this.deps.lifecycle) {
          for (const artifactId of pinnedRes.newlyPinnedArtifactIds) {
            try {
              this.deps.lifecycle.releaseReference({
                artifactId,
                ownerType: 'handoff',
                ownerId: prep.manifest.handoffId,
                purpose: 'phase-context',
                reason: 'owner-durable'
              });
            } catch {
              // Best-effort cleanup of newly acquired handoff pins after acceptance refusal.
            }
          }
        }
        return { kind: 'refused', failure: txOutcome.failure, detail: txOutcome.detail };
      }

      return {
        kind: 'accepted',
        handoffId: prep.manifest.handoffId,
        revision: txOutcome.revision,
        manifest: prep.manifest,
        waitingApproval: txOutcome.revision.state === 'waiting-approval'
      };
    } finally {
      this.admissionQueue.release(admissionOwner);
    }
  }

  public resolvePendingHandoffForTarget(
    runId: string,
    invocationId: string,
    targetNodeId: string
  ): string | null {
    const normalizedOcc = normalizeHandoffIdentifier(invocationId, 'occ-1');
    const normalizedInv = normalizeHandoffIdentifier(invocationId, 'inv-1');
    for (const id of this.store.listHandoffIdsForRun(runId)) {
      const meta = this.store.getRunMetadata(id);
      if (meta?.targetPhaseId !== targetNodeId) continue;
      let record: HandoffRecord | null;
      try {
        record = this.store.load(id);
      } catch {
        // Corrupt handoff row for this target phase: return its id so delivery fails closed.
        return id;
      }
      const latestRev = record?.revisions.at(-1);
      const manifest = latestRev !== undefined ? storedManifest(latestRev) : null;
      if (
        manifest !== null &&
        (manifest.identity.targetOccurrenceId === normalizedOcc ||
          manifest.identity.sourceInvocationId === normalizedInv)
      ) {
        return id;
      }
    }
    return null;
  }

  public resolveHandoffRepresentation(attemptId: string): DeliveryRepresentation | null {
    const normalized = normalizeHandoffIdentifier(attemptId, 'attempt-1');
    try {
      return (
        this.store.findRepresentationByAttemptId(normalized) ??
        (attemptId !== normalized ? this.store.findRepresentationByAttemptId(attemptId) : null)
      );
    } catch {
      // Unreadable representation lookup fails closed at caller.
      return null;
    }
  }

  public resolveHandoffContentDigest(handoffId: string): string | null {
    try {
      const record = this.store.load(handoffId);
      return record?.revisions.at(-1)?.manifestDigest ?? null;
    } catch {
      // Corrupt handoff row returns null so checkDispatch refuses content-changed.
      return null;
    }
  }

  public async planAndAuthorizeAttemptDelivery(
    input: PlanAttemptDeliveryInput
  ): Promise<PlanAttemptDeliveryResult> {
    return executePlanAttemptDelivery({
      input,
      store: this.store,
      acceptance: this.acceptance,
      primaryWorkspaceRoot: this.deps.primaryWorkspaceRoot,
      resolveExecutionRoot: this.resolveExecutionRoot,
      resolveProfile: this.resolveProfile,
      lookupRunArtifactLocations: (runId) => this.lookupRunArtifactLocations(runId),
      lifecycle: this.deps.lifecycle ?? null,
      admission: this.admission,
      clock: this.clock,
      onDispatchIntentRecorded: (record, revision, attemptId) => {
        this.emitRecordObservations(record, revision, ['dispatch-intent'], attemptId);
      }
    });
  }

  public settleAttemptDispatch(params: {
    readonly handoffId: string;
    readonly revision: number;
    readonly targetAttemptId: string;
    readonly delivered: boolean;
  }): { readonly ok: true } | Refusal {
    const normalizedAttemptId = normalizeHandoffIdentifier(params.targetAttemptId, 'attempt-1');
    const outcome = params.delivered ? ('delivered' as const) : ('uncertain' as const);
    let txOutcome: { readonly ok: true } | Refusal;
    try {
      txOutcome = this.store.runInImmediateTransaction(() => {
        const settled = this.acceptance.settleDispatch(
          params.handoffId,
          params.revision,
          normalizedAttemptId,
          outcome
        );
        if (!settled.ok) return settled;
        const record = this.store.load(params.handoffId);
        if (record !== null) {
          this.emitRecordObservations(record, params.revision, [outcome], normalizedAttemptId);
        }
        return { ok: true as const };
      });
    } catch {
      // Fail closed on SQLite/corruption failures during dispatch settlement.
      return refuse('storage-unavailable', 'store-failure');
    }
    if (txOutcome.ok && params.delivered && this.deps.lifecycle) {
      releasePhaseContextOwnerReferences(
        this.deps.lifecycle,
        this.store,
        params.handoffId,
        'attempt',
        normalizedAttemptId
      );
      if (params.targetAttemptId !== normalizedAttemptId) {
        releasePhaseContextOwnerReferences(
          this.deps.lifecycle,
          this.store,
          params.handoffId,
          'attempt',
          params.targetAttemptId
        );
      }
    }
    return txOutcome;
  }

  public reconcileInterruptedDispatches(runId?: string): readonly TransitionedUncertainDispatch[] {
    const transitioned = this.store.markUnsettledIntentsUncertain(runId);
    for (const item of transitioned) {
      try {
        const record = this.store.load(item.handoffId);
        if (record !== null) {
          this.emitRecordObservations(record, item.revision, ['uncertain'], item.targetAttemptId);
        }
      } catch {
        // Corrupt handoff row already marked status='uncertain' in SQLite; skip observation emission.
      }
    }
    return transitioned;
  }

  public releaseTerminalRunPins(runId: string): void {
    if (this.deps.lifecycle) {
      for (const handoffId of this.store.listHandoffIdsForRun(runId)) {
        let hasUncertainOrIntent = true;
        try {
          const record = this.store.load(handoffId);
          // R7-17-07 (Clarification Q3): preserve BOTH `handoff` and `attempt` protective pins
          // whenever ANY dispatch on this handoff is `'uncertain'` or unsettled `'intent'`.
          hasUncertainOrIntent =
            record?.dispatches.some((d) => d.state === 'uncertain' || d.state === 'intent') ?? false;
        } catch {
          // Fail closed: keep protective pins intact when stored handoff JSON is corrupt.
          hasUncertainOrIntent = true;
        }
        if (!hasUncertainOrIntent) {
          releasePhaseContextOwnerReferences(
            this.deps.lifecycle,
            this.store,
            handoffId,
            'handoff',
            handoffId
          );
          releaseCleanHandoffAttemptReferences(this.deps.lifecycle, this.store, handoffId);
        }
      }
    }
    this.candidatesByRunId.delete(runId);
    this.sequenceByRunId.delete(runId);
  }

  public reloadFromStore(): void {
    this.candidatesByRunId.clear();
    this.sequenceByRunId.clear();
    this.store.clearPendingMetadata?.();
    this.reconcileInterruptedDispatches();
  }

  public inspectHandoff(
    handoffId: string,
    revision?: number
  ): { readonly ok: true; readonly explanation: HandoffExplanation } | Refusal {
    const inspected = this.acceptance.inspect(handoffId);
    if (!inspected.ok) return inspected;
    if (inspected.record === null) return refuse('stale-revision', 'unknown-handoff');
    return explainHandoff(inspected.record, revision);
  }

  public compareHandoffRevisions(
    handoffId: string,
    fromRevision: number,
    toRevision: number
  ): { readonly ok: true; readonly diff: HandoffRevisionDiff } | Refusal {
    const inspected = this.acceptance.inspect(handoffId);
    if (!inspected.ok) return inspected;
    if (inspected.record === null) return refuse('stale-revision', 'unknown-handoff');
    return compareHandoffRevisions(inspected.record, fromRevision, toRevision);
  }

  public inspectReviewLoop(loopId: string): ReviewLoopInspection | null {
    return inspectStoredReviewLoop(this.store, loopId);
  }

  public listRunHandoffs(runId: string): readonly HandoffExplanation[] {
    const out: HandoffExplanation[] = [];
    for (const id of this.store.listHandoffIdsForRun(runId)) {
      const res = this.inspectHandoff(id);
      if (res.ok) out.push(res.explanation);
    }
    return out;
  }

  public listRunReviewLoops(runId: string): readonly ReviewLoopInspection[] {
    const out: ReviewLoopInspection[] = [];
    for (const entry of this.store.listReviewLoopsForRun(runId)) {
      const inspected = this.inspectReviewLoop(entry.loopId);
      if (inspected !== null) out.push(inspected);
    }
    return out;
  }

  public editHandoff(
    handoffId: string,
    baseRevision: number,
    replacementSources: unknown
  ): { readonly ok: true; readonly revision: AcceptedRevision } | Refusal {
    try {
      return this.store.runInImmediateTransaction(() => {
        const edited = this.acceptance.edit(handoffId, baseRevision, replacementSources);
        if (!edited.ok) return edited;
        this.emitObservation(observePrepared(edited.prepared));
        const record = this.store.load(handoffId);
        if (record !== null) {
          this.emitRecordObservations(record, edited.revision.revision, ['accepted']);
          this.emitRecordObservations(record, baseRevision, ['superseded']);
        }
        return { ok: true as const, revision: edited.revision };
      });
    } catch {
      // Fail closed on SQLite/corruption failures during handoff edit.
      return refuse('storage-unavailable', 'store-failure');
    }
  }

  public approveHandoff(
    handoffId: string,
    revision: number,
    decisionId: string
  ): { readonly ok: true; readonly revision: number } | Refusal {
    const normalizedDecision = normalizeHandoffIdentifier(decisionId, 'decision-approve');
    try {
      return this.store.runInImmediateTransaction(() => {
        const approved = this.acceptance.approve(handoffId, revision, normalizedDecision);
        if (!approved.ok) return approved;
        const record = this.store.load(handoffId);
        if (record !== null) {
          this.emitRecordObservations(record, revision, ['approved']);
        }
        return { ok: true as const, revision: approved.approval.revision };
      });
    } catch {
      // Fail closed on SQLite/corruption failures during handoff approval.
      return refuse('storage-unavailable', 'store-failure');
    }
  }
}

export function createPhaseHandoffCoordinator(
  deps: PhaseHandoffCoordinatorDeps
): PhaseHandoffCoordinator {
  return new PhaseHandoffCoordinatorImpl(deps);
}
