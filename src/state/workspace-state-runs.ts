/**
 * FR-R7-07 — Run, Run Quarantine, Atomic Run Admission, and Terminal Transition
 * Intent key-family module (`KEYS.run`, `KEYS.runQuarantine`,
 * `KEYS.terminalTransitionIntent`), delegated from `WorkspaceStateStore`.
 *
 * Every Run write executes on the single facade-owned `ctx.serialize` /
 * `ctx.serializeAcrossKeys` chain, single commit fence, and single
 * `ctx.writeGate` (Hard Rules 28, 57, 58).
 */

import type { RunRecordQuarantinedPayload } from '../contracts/audit-events';
import { DEFAULT_QUEUE_ID } from '../contracts/queue-identity';
import { findQueue } from '../contracts/queue-registry';
import { DELAYED_RETRY_CAP } from '../contracts/retry-bounds';
import type { QueueState } from '../queue/feature-request';
import { assertCreditPauseShape } from './credit-pause-state';
import {
  checkCommitFence,
  isFencedClaim,
  type RunCommitClaim
} from './ownership-claim';
import { queueResource } from './ownership-registry';
import { assertPendingRetryShape } from './pending-retry-shape';
import { RunFieldInvariantError, RunTransitionError } from './run-invariant-error';
import {
  isRunStateMap,
  isWorkflowRun,
  type RunStateMap
} from './run-state-migrator';
import {
  ADMISSIBLE_INITIAL_RUN_STATUS,
  DEFAULT_ACTOR_BY_RUN_UPDATE_LABEL,
  decideRunTransition,
  type RunTransitionActor
} from './run-transition-decision';
import type { RunUpdate } from './run-update';
import {
  isSupersededRun,
  isTerminalRunStatus,
  type TerminalTransitionIntent,
  type WorkflowRun
} from './workflow-run';
import {
  KEYS,
  QueueMutationRejected,
  type RunReadVerdict,
  type WorkspaceStateFamilyContext
} from './workspace-state-types';

const DELAYED_RETRY_COUNT_PERSISTED_CEILING = 20;

function asTerminalTransitionIntent(raw: unknown): TerminalTransitionIntent | null {
  if (!raw || typeof raw !== 'object') return null;
  const intent = raw as Partial<TerminalTransitionIntent> & { description?: unknown };
  if (
    intent.schemaVersion !== 1 ||
    intent.run === undefined ||
    typeof intent.run !== 'object' ||
    typeof (intent.run as WorkflowRun).id !== 'string' ||
    typeof intent.createdAt !== 'number'
  ) {
    return null;
  }
  if (intent.description !== undefined && typeof intent.description !== 'string') {
    const { description: _dropped, ...rest } = intent;
    return rest as TerminalTransitionIntent;
  }
  return intent as TerminalTransitionIntent;
}

function assertRunStatusTransition(
  previous: WorkflowRun,
  targetStatus: WorkflowRun['status'],
  actor: RunTransitionActor
): void {
  const decision = decideRunTransition({
    current: previous,
    targetStatus,
    actor
  });
  if (!decision.allowed) {
    throw new RunTransitionError(decision.from, decision.to, decision.actor, decision.reasonCode);
  }
}

export function validateRunInvariants(run: WorkflowRun, previous: WorkflowRun | null = null): void {
  const transcriptMode: unknown = run.rawTranscriptMode;
  if (
    transcriptMode !== undefined &&
    transcriptMode !== 'always' &&
    transcriptMode !== 'errors-only' &&
    transcriptMode !== 'off'
  ) {
    throw new RunFieldInvariantError(
      'invalid-raw-transcript-mode',
      'WorkflowRun invariant violation: invalid rawTranscriptMode'
    );
  }
  const pendingAtSet = run.pendingRetryAt !== null;
  const pendingCauseSet = run.pendingRetryCause !== null;
  if (pendingAtSet !== pendingCauseSet) {
    throw new RunFieldInvariantError(
      'one-sided-pending-retry',
      `WorkflowRun invariant violation: pendingRetryAt (${run.pendingRetryAt}) and pendingRetryCause (${run.pendingRetryCause}) must be both null or both non-null`
    );
  }
  assertPendingRetryShape(run, previous);
  if (
    run.delayedRetryCount >= DELAYED_RETRY_CAP &&
    run.status !== 'paused' &&
    run.status !== 'failed'
  ) {
    throw new RunFieldInvariantError(
      'delayed-retry-cap-status',
      `WorkflowRun invariant violation: delayedRetryCount >= ${DELAYED_RETRY_CAP} requires status 'paused' or 'failed' (got '${run.status}')`
    );
  }
  if (
    !Number.isFinite(run.delayedRetryCount) ||
    run.delayedRetryCount < 0 ||
    run.delayedRetryCount > DELAYED_RETRY_COUNT_PERSISTED_CEILING
  ) {
    throw new RunFieldInvariantError(
      'delayed-retry-count-range',
      `WorkflowRun invariant violation: delayedRetryCount must be in [0, ${DELAYED_RETRY_COUNT_PERSISTED_CEILING}] (got ${run.delayedRetryCount})`
    );
  }
  const manualAtSet = run.manualPauseAt !== null;
  const manualCauseSet = run.manualPauseCause !== null;
  if (manualAtSet !== manualCauseSet) {
    throw new RunFieldInvariantError(
      'one-sided-manual-pause',
      `WorkflowRun invariant violation: manualPauseAt (${run.manualPauseAt}) and manualPauseCause (${run.manualPauseCause}) must be both null or both non-null`
    );
  }
  assertCreditPauseShape(run);
  if (run.failureCause !== undefined && run.status !== 'failed') {
    throw new RunFieldInvariantError(
      'failure-cause-requires-failed',
      `WorkflowRun invariant violation: failureCause requires status 'failed' (got '${run.status}')`
    );
  }
  if (!Array.isArray(run.phaseBreakpoints)) {
    throw new RunFieldInvariantError(
      'invalid-phase-breakpoints',
      `WorkflowRun invariant violation: phaseBreakpoints must be an array (got ${typeof run.phaseBreakpoints})`
    );
  }
  const breakpointPhaseIds = new Set<string>();
  const pipelinePhaseIds = run.pipeline
    ? new Set<string>(run.pipeline.phases.map((p) => p.id))
    : null;
  const overrideIds = new Set<string>(run.phaseOverrides.map((o) => o.phaseId));
  for (const bp of run.phaseBreakpoints) {
    if (breakpointPhaseIds.has(bp.phaseId)) {
      throw new RunFieldInvariantError(
        'duplicate-phase-breakpoint',
        `WorkflowRun invariant violation: phaseBreakpoints contains duplicate phaseId '${bp.phaseId}'`
      );
    }
    breakpointPhaseIds.add(bp.phaseId);
    if (pipelinePhaseIds !== null && !pipelinePhaseIds.has(bp.phaseId)) {
      throw new RunFieldInvariantError(
        'unknown-breakpoint-phase',
        `WorkflowRun invariant violation: phaseBreakpoints phaseId '${bp.phaseId}' is not in pipeline.phases`
      );
    }
    if (overrideIds.has(bp.phaseId)) {
      throw new RunFieldInvariantError(
        'breakpoint-override-conflict',
        `WorkflowRun invariant violation: phaseId '${bp.phaseId}' appears in BOTH phaseBreakpoints AND phaseOverrides`
      );
    }
  }
  const resumeTargetSet = run.resumeTargetPhaseId !== null;
  const breakpointPaused = run.manualPauseCause === 'breakpoint-paused';
  if (resumeTargetSet !== breakpointPaused) {
    throw new RunFieldInvariantError(
      'resume-target-phase-mismatch',
      `WorkflowRun invariant violation: resumeTargetPhaseId (${run.resumeTargetPhaseId}) is non-null iff manualPauseCause === 'breakpoint-paused' (got '${run.manualPauseCause}')`
    );
  }
}

export function readRunMap(ctx: WorkspaceStateFamilyContext): RunStateMap {
  const raw = ctx.memento.get<unknown>(KEYS.run);
  if (raw === undefined || raw === null) return {};
  if (isWorkflowRun(raw)) return { [DEFAULT_QUEUE_ID]: raw };
  if (isRunStateMap(raw)) return raw;
  return {};
}

export function readRunForQueue(
  ctx: WorkspaceStateFamilyContext,
  queueId: string
): WorkflowRun | null {
  return readRunMap(ctx)[queueId] ?? null;
}

export async function readRunIfLive(
  ctx: WorkspaceStateFamilyContext,
  queueId: string
): Promise<RunReadVerdict> {
  const run = readRunForQueue(ctx, queueId);
  if (run === null) return { outcome: 'absent' };
  const record = await ctx.getOwnershipRegistry().read(queueResource(queueId));
  const liveFence = record?.fence ?? 0;
  if (!isSupersededRun(run, liveFence)) return { outcome: 'live', run };
  return {
    outcome: 'superseded',
    run,
    writtenAtFence: run.writtenAtFence ?? 0,
    liveFence
  };
}

export function getRunMap(ctx: WorkspaceStateFamilyContext): Readonly<RunStateMap> {
  return { ...readRunMap(ctx) };
}

export function findRunByTask(
  ctx: WorkspaceStateFamilyContext,
  taskId: string
): { readonly queueId: string; readonly run: WorkflowRun } | null {
  for (const [queueId, run] of Object.entries(readRunMap(ctx))) {
    if (run.featureId === taskId) return { queueId, run };
  }
  return null;
}

export function findRunById(
  ctx: WorkspaceStateFamilyContext,
  runId: string
): { readonly queueId: string; readonly run: WorkflowRun } | null {
  for (const [queueId, run] of Object.entries(readRunMap(ctx))) {
    if (run.id === runId) return { queueId, run };
  }
  return null;
}

export function writeRunForQueue(
  ctx: WorkspaceStateFamilyContext,
  queueId: string,
  run: WorkflowRun | null,
  claim: RunCommitClaim,
  actor: RunTransitionActor = 'driver'
): Promise<void> {
  if (run !== null) {
    const previous = readRunForQueue(ctx, queueId);
    if (previous !== null && previous.id === run.id) {
      assertRunStatusTransition(previous, run.status, actor);
    }
    validateRunInvariants(run, previous);
    if (!findQueue(ctx.getQueueRegistry(), queueId)) {
      throw new QueueMutationRejected('unknown-queue-id', `Unknown queue id: ${queueId}`);
    }
  }
  return ctx.serialize(KEYS.run, async () => {
    if (run !== null && !findQueue(ctx.getQueueRegistry(), queueId)) {
      throw new QueueMutationRejected('unknown-queue-id', `Unknown queue id: ${queueId}`);
    }
    if (run !== null) {
      const livePrevious = readRunForQueue(ctx, queueId);
      if (livePrevious !== null && livePrevious.id === run.id) {
        assertRunStatusTransition(livePrevious, run.status, actor);
      }
      validateRunInvariants(run, livePrevious);
    }
    if (isFencedClaim(claim)) {
      const f = await checkCommitFence(
        ctx.getOwnershipRegistry(),
        claim,
        queueId,
        'Run',
        ctx.scheduler
      );
      if (f !== null) ctx.refuseCommit(f, claim, queueId);
    }
    const next = { ...readRunMap(ctx) };
    if (run === null) delete next[queueId];
    else next[queueId] = isFencedClaim(claim) ? { ...run, writtenAtFence: claim.fence } : run;
    await ctx.memento.update(KEYS.run, next);
  }).then(() => {
    ctx.notify(KEYS.run);
  });
}

export function updateRunForQueue(
  ctx: WorkspaceStateFamilyContext,
  queueId: string,
  update: RunUpdate,
  claim: RunCommitClaim
): Promise<WorkflowRun> {
  let written!: WorkflowRun;
  return ctx.serialize(KEYS.run, async () => {
    const current = readRunForQueue(ctx, queueId);
    if (current === null || current.id !== update.runId) {
      throw new QueueMutationRejected(
        'stale-run-id',
        `Run update '${update.label}' refused: queue ${queueId} no longer holds run ${update.runId.slice(0, 8)}`
      );
    }
    if (!update.allowedStatuses.includes(current.status)) {
      throw new QueueMutationRejected(
        'run-status-precondition',
        `Run update '${update.label}' refused: the run is ${current.status}`
      );
    }
    ctx.refuseIfClaimLost(queueId);
    if (isFencedClaim(claim)) {
      const f = await checkCommitFence(
        ctx.getOwnershipRegistry(),
        claim,
        queueId,
        'Run',
        ctx.scheduler
      );
      if (f !== null) ctx.refuseCommit(f, claim, queueId);
    }
    const patch = update.patch(current);
    const merged = { ...current, ...patch } as WorkflowRun;
    for (const key of Object.keys(patch) as Array<keyof WorkflowRun>) {
      if (patch[key] === undefined) delete merged[key];
    }
    const actor = update.actor ?? DEFAULT_ACTOR_BY_RUN_UPDATE_LABEL[update.label];
    assertRunStatusTransition(current, merged.status, actor);
    validateRunInvariants(merged, current);
    written = isFencedClaim(claim) ? { ...merged, writtenAtFence: claim.fence } : merged;
    await ctx.memento.update(KEYS.run, { ...readRunMap(ctx), [queueId]: written });
  }).then(() => {
    ctx.notify(KEYS.run);
    return written;
  });
}

export function admitRunAtomically<T>(
  ctx: WorkspaceStateFamilyContext,
  queueId: string,
  run: WorkflowRun,
  mutateQueue: (queue: QueueState) => { readonly queue: QueueState; readonly result: T },
  claim: RunCommitClaim
): Promise<T> {
  const initialExisting = readRunForQueue(ctx, queueId);
  if (
    initialExisting !== null &&
    isTerminalRunStatus(initialExisting.status) &&
    initialExisting.id === run.id
  ) {
    assertRunStatusTransition(initialExisting, run.status, 'driver');
  }
  validateRunInvariants(
    run,
    initialExisting !== null && initialExisting.id === run.id ? initialExisting : null
  );
  if (run.status !== ADMISSIBLE_INITIAL_RUN_STATUS) {
    throw new RunFieldInvariantError(
      'invalid-admission-status',
      `WorkflowRun invariant violation: admitRunAtomically requires status '${ADMISSIBLE_INITIAL_RUN_STATUS}' (got '${run.status}')`
    );
  }
  if (!findQueue(ctx.getQueueRegistry(), queueId)) {
    throw new QueueMutationRejected('unknown-queue-id', `Unknown queue id: ${queueId}`);
  }
  let result!: T;
  return ctx.serializeAcrossKeys([KEYS.run, KEYS.queue], async () => {
    if (!findQueue(ctx.getQueueRegistry(), queueId)) {
      throw new QueueMutationRejected('unknown-queue-id', `Unknown queue id: ${queueId}`);
    }
    const existingRun = readRunForQueue(ctx, queueId);
    if (existingRun !== null && !isTerminalRunStatus(existingRun.status)) {
      throw new QueueMutationRejected(
        'in-flight-ownership-conflict',
        `Cannot admit run ${run.id.slice(0, 8)} on queue ${queueId}: non-terminal run ${existingRun.id.slice(0, 8)} (${existingRun.status}) is already active`
      );
    }
    if (existingRun !== null && existingRun.id === run.id) {
      assertRunStatusTransition(existingRun, run.status, 'driver');
    }
    validateRunInvariants(
      run,
      existingRun !== null && existingRun.id === run.id ? existingRun : null
    );
    ctx.refuseIfClaimLost(queueId);
    if (isFencedClaim(claim)) {
      const f = await checkCommitFence(
        ctx.getOwnershipRegistry(),
        claim,
        queueId,
        'Run',
        ctx.scheduler
      );
      if (f !== null) ctx.refuseCommit(f, claim, queueId);
    }
    const currentQueue = ctx.getQueue(queueId);
    const mutation = mutateQueue(currentQueue);
    const nextQueue = ctx.ensureExtendedQueueShape({
      ...mutation.queue,
      requests: ctx.compactRequestPositions(mutation.queue.requests),
      updatedAt: Date.now()
    });
    const stampedRun = isFencedClaim(claim) ? { ...run, writtenAtFence: claim.fence } : run;
    const prevRawRunMap = ctx.memento.get<unknown>(KEYS.run);
    const prevRunMap = readRunMap(ctx);
    const nextRunMap = { ...prevRunMap, [queueId]: stampedRun };
    const nextQueueMap = { ...ctx.readQueueMap(), [queueId]: nextQueue };
    result = mutation.result;
    if (ctx.supportsBatchWrite) {
      await ctx.writeGate.writeBatch([
        { key: KEYS.run, value: nextRunMap },
        { key: KEYS.queue, value: nextQueueMap }
      ]);
    } else {
      await ctx.memento.update(KEYS.run, nextRunMap);
      try {
        await ctx.memento.update(KEYS.queue, nextQueueMap);
      } catch (queueErr) {
        try {
          await ctx.memento.update(KEYS.run, prevRawRunMap);
        } catch {
          // Best-effort compensating rollback on legacy Memento without batch transactions.
        }
        throw queueErr;
      }
    }
  }).then(() => {
    ctx.notify(KEYS.run);
    ctx.notify(KEYS.queue);
    return result;
  });
}

export function getTerminalTransitionIntents(
  ctx: WorkspaceStateFamilyContext
): Readonly<Record<string, TerminalTransitionIntent>> {
  const value = ctx.memento.get<unknown>(KEYS.terminalTransitionIntent);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const legacy = asTerminalTransitionIntent(value);
  if (legacy) return { [legacy.run.id]: legacy };
  const entries: Record<string, TerminalTransitionIntent> = {};
  for (const [runId, raw] of Object.entries(value as Record<string, unknown>)) {
    const intent = asTerminalTransitionIntent(raw);
    if (intent) entries[runId] = intent;
  }
  return entries;
}

export function setTerminalTransitionIntent(
  ctx: WorkspaceStateFamilyContext,
  runId: string,
  intent: TerminalTransitionIntent | null
): Promise<void> {
  return ctx.serialize(KEYS.terminalTransitionIntent, () => {
    const next = { ...getTerminalTransitionIntents(ctx) };
    if (intent === null) delete next[runId];
    else next[runId] = intent;
    return ctx.memento.update(KEYS.terminalTransitionIntent, next);
  }).then(() => ctx.notify(KEYS.terminalTransitionIntent));
}

export async function removeTerminalIntentIfOwn(
  ctx: WorkspaceStateFamilyContext,
  runId: string,
  createdAt: number
): Promise<boolean> {
  let removed = false as boolean;
  await ctx.serialize(KEYS.terminalTransitionIntent, () => {
    const intents: Readonly<Partial<Record<string, TerminalTransitionIntent>>> =
      getTerminalTransitionIntents(ctx);
    if (intents[runId]?.createdAt !== createdAt) return Promise.resolve();
    const next = { ...intents };
    delete next[runId];
    removed = true;
    return ctx.memento.update(KEYS.terminalTransitionIntent, next);
  });
  if (removed) ctx.notify(KEYS.terminalTransitionIntent);
  return removed;
}

export function drainRunQuarantineEvents(
  ctx: WorkspaceStateFamilyContext
): ReadonlyArray<{
  readonly eventType: 'run-record-quarantined';
  readonly payload: RunRecordQuarantinedPayload;
}> {
  return ctx.runQuarantine.drain();
}
