/**
 * FR-R6-F15 (F15-B; F15-FR-01..FR-36, F15-NFR-01..NFR-08) — authoritative coordinator for
 * phase-to-phase context handoffs, review-loop ledgers, cross-root artifact materialization,
 * manual handoff edit/approval, and ACP prompt-block delivery planning.
 *
 * Zero `vscode` or `node:fs` imports (docs/hard-rules.md rules 13, 69).
 */
import { ACP_PROTOCOL_VERSION } from '../../contracts/acp-runtime';
import type {
  AcceptedRevision,
  HandoffExplanation,
  HandoffManifest,
  HandoffObservation,
  HandoffRecord
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
import { createAcceptanceService, type AcceptanceService } from './acceptance';
import {
  allocateAttemptStagingPaths,
  captureAttemptPublications,
  type AttemptStagingPaths
} from './attempt-result-publisher';
import { explainHandoff, observationOf, observePrepared } from './explanation';
import {
  artifactLocationKey,
  executePlanAttemptDelivery,
  inspectDeclaredOutputFiles,
  normalizeHandoffIdentifier,
  splitSafeRelativePath,
  type PlanAttemptDeliveryInput,
  type PlanAttemptDeliveryResult,
  type StoredArtifactLocation,
  type TargetProfileResolution
} from './handoff-delivery-coordinator';
import { handoffIdOf, parseHandoffIdentity } from './identity';
import { prepareHandoff } from './preparation';
import { createPreparationAdmission, type PreparationAdmission } from './preparation-admission';
import { refuse } from './primitives';
import {
  applyStagedReviewPublications,
  inspectStoredReviewLoop,
  invalidateStoredReviewLoopCandidate,
  releasePhaseContextOwnerReferences,
  verifyStoredRepeatExitAllowed,
  type ReviewLoopInspection
} from './review-loop-coordinator';
import { parseSourceContribution } from './source-contribution';
import type { DurableHandoffStore } from './sqlite-handoff-store';

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
  readonly candidateSnapshotDigest?: string;
  readonly scopeRevision?: string;
  readonly criteriaRevision?: string;
  readonly blockingSeverities?: readonly Severity[];
  readonly maxReviewPasses?: number;
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

export function normalizeNodePathForHandoff(raw: string): string {
  const stripped = raw.trim().replace(/^\/+/, '').replace(/[^A-Za-z0-9._:/#-]/g, '-');
  const ensured = stripped.replace(/^[^A-Za-z0-9]+/, '').slice(0, 256);
  return ensured.length > 0 ? ensured : 'root';
}

function defaultTargetProfile(backendId: string): TargetProfileResolution {
  const normalized = normalizeHandoffIdentifier(backendId || 'claude', 'claude');
  return {
    profile: {
      profileId: `${normalized}-acp`,
      profileRevision: 1,
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
  settleAttemptDispatch(params: {
    readonly handoffId: string;
    readonly revision: number;
    readonly targetAttemptId: string;
    readonly delivered: boolean;
  }): { readonly ok: true } | Refusal;
  releaseTerminalRunPins(runId: string): void;
  inspectHandoff(
    handoffId: string,
    revision?: number
  ): { readonly ok: true; readonly explanation: HandoffExplanation } | Refusal;
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
  private readonly clock: () => number;
  private readonly resolveExecutionRoot: (runId: string) => string;
  private readonly resolveLaneId: (runId: string) => string | null;
  private readonly resolveProfile: (backendId: string) => TargetProfileResolution;
  private readonly sequenceByRunId = new Map<string, number>();
  private readonly candidatesByRunId = new Map<string, RecordedAttemptCandidate[]>();
  private readonly latestHandoffByTargetKey = new Map<string, string>();

  public constructor(private readonly deps: PhaseHandoffCoordinatorDeps) {
    this.store = deps.store;
    this.acceptance = createAcceptanceService(deps.store);
    this.clock = deps.nowMs ?? (() => Date.now());
    this.admission = deps.admission ?? createPreparationAdmission({ now: this.clock });
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

  private targetKey(runId: string, invocationId: string, targetNodeId: string): string {
    return `${runId}::${invocationId}::${targetNodeId}`;
  }

  private emitObservation(obs: HandoffObservation | null): void {
    if (obs === null) return;
    if (this.store.recordObservation(obs)) {
      this.deps.onObservation?.(obs);
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
  ): Promise<void> {
    const wf = input.run.frozenClosure?.workflowsById[input.frame.workflowId];
    const node = wf?.nodes.find((n) => n.nodeId === input.attempt.nodeId);
    if (node?.control?.kind !== 'for-each') return;

    const outputs = Object.entries(input.attempt.declaredOutputs);
    const outcomes = outputs
      .slice(0, PHASE_CONTEXT_LIMITS.collectionEntriesMax)
      .map(([portId, val]) =>
        Buffer.from(`foreach-result-index:${portId}=${val.value}`, 'utf8')
          .subarray(0, PHASE_CONTEXT_LIMITS.textEntryBytesMax)
          .toString('utf8')
      );
    const { refs, locations } = await inspectDeclaredOutputFiles(
      executionRoot,
      input.attempt.declaredOutputs
    );
    const synthetic: SourceContribution = {
      schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
      producer,
      coverage: input.attempt.status === 'completed' ? 'complete' : 'unavailable',
      outcomes: outcomes.length > 0 ? outcomes : ['foreach-ordered-result-index:empty'],
      decisions: [],
      constraints: [],
      unresolvedIssues: [],
      summary: null,
      artifacts: refs
    };
    const checked = parseSourceContribution(synthetic, producer);
    if (checked.ok) {
      const runId = input.run.connectedRunId;
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
      await this.recordForEachWorkflowAttempt(input, producer, executionRoot);
      return { ok: true };
    }

    const captured = await captureAttemptPublications({
      runId,
      executionRoot,
      primaryWorkspaceRoot: this.deps.primaryWorkspaceRoot,
      producer,
      ...(this.deps.legacySidecarOptIn !== undefined
        ? { legacySidecarOptIn: this.deps.legacySidecarOptIn }
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

    const declaredFiles = await inspectDeclaredOutputFiles(
      executionRoot,
      input.attempt.declaredOutputs
    );
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
        .map(([k, v]) =>
          Buffer.from(`${k}:${v.value}`, 'utf8')
            .subarray(0, PHASE_CONTEXT_LIMITS.textEntryBytesMax)
            .toString('utf8')
        );
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

    return applyStagedReviewPublications(this.store, input, captured);
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
    const runCandidates = (this.candidatesByRunId.get(runId) ?? []).map((c) => c.candidate);
    const cutoffSequence = this.sequenceByRunId.get(runId) ?? 0;

    const estimatedBytes = Math.min(
      PHASE_CONTEXT_LIMITS.workingSetBytesMax,
      Math.max(4096, JSON.stringify(runCandidates).length * 2)
    );
    const admissionOwner = this.targetKey(runId, input.frame.invocationId, input.targetNodeId);
    this.admission.expire();
    const admitted = this.admission.request(admissionOwner, estimatedBytes);
    if (!admitted.ok) {
      return { kind: 'refused', failure: admitted.failure, detail: admitted.detail };
    }

    try {
      const framePath = normalizeNodePathForHandoff(input.frame.nodePath);
      const targetNodePath = normalizeNodePathForHandoff(`${framePath}/${input.targetNodeId}`);
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
      const existingRecord = this.store.load(computedHandoffId);
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

      const txOutcome = this.store.runInImmediateTransaction(() => {
        this.store.bindRunMetadata(prep.manifest.handoffId, {
          runId,
          sourceAttemptId: input.fromAttempt.attemptId,
          targetPhaseId: input.targetNodeId,
          laneId: this.resolveLaneId(runId)
        });
        this.emitObservation(observePrepared(prep));
        const accepted = this.acceptance.accept(prep);
        if (!accepted.ok) return accepted;

        if (this.deps.lifecycle) {
          for (const src of prep.manifest.sources) {
            for (const art of src.artifacts) {
              this.deps.lifecycle.addReference({
                artifactId: art.artifactId,
                ownerType: 'handoff',
                ownerId: prep.manifest.handoffId,
                purpose: 'phase-context',
                protective: true
              });
            }
          }
        }

        const stored = this.store.load(prep.manifest.handoffId);
        if (stored !== null) {
          this.emitRecordObservations(stored, accepted.revision.revision, ['accepted']);
          if (accepted.revision.revision > 1) {
            this.emitRecordObservations(stored, accepted.revision.revision - 1, ['superseded']);
          }
        }
        return accepted;
      });

      if (!txOutcome.ok) {
        return { kind: 'refused', failure: txOutcome.failure, detail: txOutcome.detail };
      }

      this.latestHandoffByTargetKey.set(admissionOwner, prep.manifest.handoffId);

      return {
        kind: 'accepted',
        handoffId: prep.manifest.handoffId,
        revision: txOutcome.revision,
        manifest: prep.manifest,
        waitingApproval: txOutcome.revision.state === 'waiting-approval'
      };
    } finally {
      this.admission.release(admissionOwner);
    }
  }

  public resolvePendingHandoffForTarget(
    runId: string,
    invocationId: string,
    targetNodeId: string
  ): string | null {
    const cached = this.latestHandoffByTargetKey.get(
      this.targetKey(runId, invocationId, targetNodeId)
    );
    if (cached !== undefined) return cached;
    for (const id of this.store.listHandoffIdsForRun(runId)) {
      const meta = this.store.getRunMetadata(id);
      if (meta?.targetPhaseId === targetNodeId) return id;
    }
    return null;
  }

  public async planAndAuthorizeAttemptDelivery(
    input: PlanAttemptDeliveryInput
  ): Promise<PlanAttemptDeliveryResult> {
    return executePlanAttemptDelivery({
      input,
      store: this.store,
      acceptance: this.acceptance,
      resolveExecutionRoot: this.resolveExecutionRoot,
      resolveProfile: this.resolveProfile,
      lookupRunArtifactLocations: (runId) => this.lookupRunArtifactLocations(runId),
      lifecycle: this.deps.lifecycle ?? null,
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
    return this.store.runInImmediateTransaction(() => {
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
      if (params.delivered && this.deps.lifecycle) {
        releasePhaseContextOwnerReferences(
          this.deps.lifecycle,
          this.store,
          params.handoffId,
          'attempt',
          params.targetAttemptId
        );
      }
      return { ok: true as const };
    });
  }

  public releaseTerminalRunPins(runId: string): void {
    if (this.deps.lifecycle) {
      for (const handoffId of this.store.listHandoffIdsForRun(runId)) {
        const record = this.store.load(handoffId);
        const hasUncertain = record?.dispatches.some((d) => d.state === 'uncertain') ?? false;
        if (!hasUncertain) {
          releasePhaseContextOwnerReferences(
            this.deps.lifecycle,
            this.store,
            handoffId,
            'handoff',
            handoffId
          );
        }
      }
    }
    this.candidatesByRunId.delete(runId);
    this.sequenceByRunId.delete(runId);
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
  }

  public approveHandoff(
    handoffId: string,
    revision: number,
    decisionId: string
  ): { readonly ok: true; readonly revision: number } | Refusal {
    const normalizedDecision = normalizeHandoffIdentifier(decisionId, 'decision-approve');
    return this.store.runInImmediateTransaction(() => {
      const approved = this.acceptance.approve(handoffId, revision, normalizedDecision);
      if (!approved.ok) return approved;
      const record = this.store.load(handoffId);
      if (record !== null) {
        this.emitRecordObservations(record, revision, ['approved']);
      }
      return { ok: true as const, revision: approved.approval.revision };
    });
  }
}

export function createPhaseHandoffCoordinator(
  deps: PhaseHandoffCoordinatorDeps
): PhaseHandoffCoordinator {
  return new PhaseHandoffCoordinatorImpl(deps);
}
