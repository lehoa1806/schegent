/**
 * FR-R7-07 — Connected Workflow Runs, Control Ledger, and Reset Transaction
 * key-family module (`KEYS.connectedRuns`, `KEYS.controlLedger`,
 * `KEYS.resetMarker`), delegated from `WorkspaceStateStore`.
 *
 * Uses the single facade-owned `ctx.serialize` / `ctx.serializeAcrossKeys`,
 * `ctx.writeGate`, and ownership/primacy fences.
 */

import { STATE_SCHEMA_VERSION } from '../contracts/state-schema';
import type { FeatureRequest, QueueState } from '../queue/feature-request';
import {
  connectedRunRefusalWarning,
  connectedRunsWithout,
  migrateConnectedRuns
} from './connected-run-migrator';
import {
  assertConnectedRunInvariants,
  type ConnectedWorkflowRun
} from './connected-workflow-run';
import { STALENESS_THRESHOLD_MS } from './lock';
import {
  checkCommitFence,
  OWNERSHIP_VERIFY_DEADLINE_MS,
  readOwnershipStatusWithinDeadline
} from './ownership-claim';
import { queueResource } from './ownership-registry';
import {
  isResetInterrupted,
  isResetMarker,
  nextResetGeneration,
  type ResetMarker
} from './reset-transaction';
import {
  KEYS,
  QueueMutationRejected,
  RESET_CLEARED_KEYS,
  type ConnectedRunWriteResult,
  type WorkspaceStateFamilyContext
} from './workspace-state-types';

export interface ConnectedRunsWarningState {
  connectedRunDropsWarned: string | null;
}

export function createConnectedRunsWarningState(): ConnectedRunsWarningState {
  return { connectedRunDropsWarned: null };
}

function staleConnectedRunWrite(current: ConnectedWorkflowRun | null): ConnectedRunWriteResult {
  return { outcome: 'stale', current };
}

function readConnectedRunCollection(
  ctx: WorkspaceStateFamilyContext,
  warned: ConnectedRunsWarningState
): ReturnType<typeof migrateConnectedRuns> {
  const result = migrateConnectedRuns(ctx.memento.get<unknown>(KEYS.connectedRuns));
  const dropped = result.dropped.length === 0 ? null : result.dropped.join(', ');
  if (dropped !== warned.connectedRunDropsWarned) {
    warned.connectedRunDropsWarned = dropped;
    if (dropped !== null) ctx.logger?.warn(connectedRunRefusalWarning(result));
  }
  return result;
}

export function getConnectedRuns(
  ctx: WorkspaceStateFamilyContext,
  warned: ConnectedRunsWarningState
): Readonly<Record<string, ConnectedWorkflowRun>> {
  return readConnectedRunCollection(ctx, warned).runs;
}

export function getConnectedRun(
  ctx: WorkspaceStateFamilyContext,
  warned: ConnectedRunsWarningState,
  connectedRunId: string
): ConnectedWorkflowRun | null {
  const runs = getConnectedRuns(ctx, warned);
  return Object.hasOwn(runs, connectedRunId) ? runs[connectedRunId]! : null;
}

function violatesCrossRevisionImmutability(
  current: ConnectedWorkflowRun,
  next: ConnectedWorkflowRun
): boolean {
  if (next.workflowId !== current.workflowId) return true;
  if (next.startedAt !== current.startedAt) return true;
  if (current.queueId !== undefined && next.queueId !== current.queueId) return true;
  if (
    current.controlState !== undefined &&
    next.controlState?.ledgerRunId !== current.controlState.ledgerRunId
  ) {
    return true;
  }
  const curReceipts = current.commandReceipts ?? [];
  const nextReceipts = next.commandReceipts ?? [];
  if (curReceipts.length > 0) {
    if (curReceipts.length < 64 && nextReceipts.length < curReceipts.length) return true;
    // Every retained receipt id must preserve its operation and target.
    const nextById = new Map(nextReceipts.map((r) => [r.commandId, r]));
    const retainedStart = Math.max(0, curReceipts.length - nextReceipts.length);
    for (let i = retainedStart; i < curReceipts.length; i += 1) {
      const prev = curReceipts.at(i);
      if (prev === undefined) continue;
      const match = nextById.get(prev.commandId);
      if (match === undefined || match.operation !== prev.operation) return true;
    }
  }
  if (current.invocations !== undefined) {
    if (next.invocations === undefined) return true;
    for (const [invId, curFrame] of Object.entries(current.invocations)) {
      if (!Object.hasOwn(next.invocations, invId)) return true;
      const nextFrame = next.invocations[invId]!;
      if (
        nextFrame.parentInvocationId !== curFrame.parentInvocationId ||
        nextFrame.rootRunId !== curFrame.rootRunId
      ) {
        return true;
      }
    }
  }
  return false;
}

export async function compareAndSetConnectedRun(
  ctx: WorkspaceStateFamilyContext,
  warned: ConnectedRunsWarningState,
  next: ConnectedWorkflowRun,
  expectedRevision: number
): Promise<ConnectedRunWriteResult> {
  let result = staleConnectedRunWrite(null);
  await ctx.serialize(KEYS.connectedRuns, async () => {
    const { runs, refused } = readConnectedRunCollection(ctx, warned);
    if (Object.hasOwn(refused, next.connectedRunId)) return;
    const current: ConnectedWorkflowRun | null = Object.hasOwn(runs, next.connectedRunId)
      ? runs[next.connectedRunId]!
      : null;
    if ((current !== null ? current.revision : 0) !== expectedRevision || next.revision <= expectedRevision) {
      result = staleConnectedRunWrite(current);
      return;
    }
    if (current !== null && violatesCrossRevisionImmutability(current, next)) {
      result = staleConnectedRunWrite(current);
      return;
    }
    const boundQueueId = current?.queueId ?? next.queueId;
    const claimSource = ctx.getRunClaimSource();
    if (
      boundQueueId !== undefined &&
      claimSource?.tenureOf?.(boundQueueId).state === 'lost'
    ) {
      result = staleConnectedRunWrite(current);
      return;
    }
    if (boundQueueId !== undefined && claimSource !== null) {
      const queueClaim = claimSource.claimFor(boundQueueId);
      if (queueClaim !== null) {
        const f = await checkCommitFence(
          ctx.getOwnershipRegistry(),
          queueClaim,
          boundQueueId,
          'Run',
          ctx.scheduler
        );
        if (f !== null) {
          if (f.reason === 'fence-superseded') {
            const currentClaim = claimSource.claimFor(boundQueueId);
            if (currentClaim?.ownerId === queueClaim.ownerId && currentClaim.fence === queueClaim.fence) {
              claimSource.markLost?.(boundQueueId, 'superseded');
            }
          }
          result = staleConnectedRunWrite(current);
          return;
        }
      } else {
        const foreignHeld = await isFreshForeignQueueOwner(ctx, boundQueueId);
        if (foreignHeld) {
          result = staleConnectedRunWrite(current);
          return;
        }
      }
    }
    const primacySource = ctx.getPrimacyClaimSource();
    if (primacySource !== null && !(await primacySource.canCommitConnectedRun())) {
      result = staleConnectedRunWrite(current);
      return;
    }
    assertConnectedRunInvariants(next, {
      knownQueueIds: new Set(ctx.getQueueRegistry().entries.map((entry) => entry.id))
    });
    await ctx.memento.update(KEYS.connectedRuns, {
      ...refused,
      ...runs,
      [next.connectedRunId]: next
    });
    result = { outcome: 'written', run: next };
  });
  if (result.outcome === 'written') ctx.notify(KEYS.connectedRuns);
  return result;
}

export async function deleteConnectedRuns(
  ctx: WorkspaceStateFamilyContext,
  warned: ConnectedRunsWarningState,
  connectedRunIds: readonly string[]
): Promise<number> {
  if (connectedRunIds.length === 0) return 0;
  let removed = 0;
  await ctx.serialize(KEYS.connectedRuns, async () => {
    const after = connectedRunsWithout(readConnectedRunCollection(ctx, warned), connectedRunIds);
    removed = after.removed;
    if (removed === 0) return;
    await ctx.memento.update(KEYS.connectedRuns, after.stored);
  });
  if (removed > 0) ctx.notify(KEYS.connectedRuns);
  return removed;
}

export function getRawControlLedger(ctx: WorkspaceStateFamilyContext): unknown {
  return ctx.memento.get<unknown>(KEYS.controlLedger);
}

async function isFreshForeignQueueOwner(
  ctx: WorkspaceStateFamilyContext,
  queueId: string
): Promise<boolean> {
  const primacy = ctx.getPrimacyClaimSource()?.primacyClaim?.() ?? null;
  if (primacy === null) return false;
  const status = await readOwnershipStatusWithinDeadline(
    ctx.getOwnershipRegistry(),
    queueResource(queueId),
    OWNERSHIP_VERIFY_DEADLINE_MS,
    ctx.scheduler
  );
  if (status.outcome === 'unavailable') return true;
  const holder = status.outcome === 'present' ? status.record.holder : null;
  return (
    holder !== null &&
    holder.ownerId !== primacy.ownerId &&
    Date.now() - holder.heartbeatAt <= STALENESS_THRESHOLD_MS
  );
}

function hasAnyDispatchedOrStartedAttempt(run: ConnectedWorkflowRun): boolean {
  if (findFirstQueueItemId(run) !== null) return true;
  for (const frame of Object.values(run.invocations ?? {})) {
    for (const attempts of Object.values(frame.attemptsByNodeId)) {
      if (
        attempts.some(
          (a) =>
            a.queueItemId !== undefined ||
            a.status === 'in-flight' ||
            a.status === 'completed'
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

export async function deleteUnstartedConnectedRun(
  ctx: WorkspaceStateFamilyContext,
  warned: ConnectedRunsWarningState,
  connectedRunId: string,
  expectedRevision: number
): Promise<boolean> {
  const delState = { removed: false };
  await ctx.serialize(KEYS.connectedRuns, async () => {
    const collection = readConnectedRunCollection(ctx, warned);
    const current = Object.hasOwn(collection.runs, connectedRunId)
      ? collection.runs[connectedRunId]
      : undefined;
    if (current === undefined || current.revision !== expectedRevision) return;
    if (hasAnyDispatchedOrStartedAttempt(current)) return;

    const primacySource = ctx.getPrimacyClaimSource();
    if (primacySource !== null && !(await primacySource.canCommitConnectedRun())) {
      return;
    }
    const boundQueueId = current.queueId;
    const claimSource = ctx.getRunClaimSource();
    if (
      boundQueueId !== undefined &&
      claimSource?.tenureOf?.(boundQueueId).state === 'lost'
    ) {
      return;
    }
    if (boundQueueId !== undefined && claimSource !== null) {
      const queueClaim = claimSource.claimFor(boundQueueId);
      if (queueClaim !== null) {
        const failure = await checkCommitFence(
          ctx.getOwnershipRegistry(),
          queueClaim,
          boundQueueId,
          'Run',
          ctx.scheduler
        );
        if (failure !== null) return;
      } else if (await isFreshForeignQueueOwner(ctx, boundQueueId)) {
        return;
      }
    }

    const after = connectedRunsWithout(collection, [connectedRunId]);
    if (after.removed === 0) return;
    await ctx.memento.update(KEYS.connectedRuns, after.stored);
    delState.removed = true;
  });
  if (delState.removed) ctx.notify(KEYS.connectedRuns);
  return delState.removed;
}

export interface AtomicComposableLaunchInput {
  readonly queueId: string;
  readonly connectedRun: ConnectedWorkflowRun;
  readonly rebindConnectedRun?: (queueItemId: string) => ConnectedWorkflowRun;
  readonly mutateControlLedger: (
    rawLedger: unknown,
    queueItemId?: string
  ) => Promise<
    | { readonly ok: true; readonly nextLedger: unknown }
    | { readonly ok: false; readonly code: string; readonly message: string }
  >;
  readonly mutateQueue: (
    queue: QueueState
  ) => { readonly queue: QueueState; readonly request: FeatureRequest };
}

export type AtomicComposableLaunchOutcome =
  | {
      readonly outcome: 'committed';
      readonly run: ConnectedWorkflowRun;
      readonly queueItemId: string;
      readonly idempotent: boolean;
    }
  | {
      readonly outcome: 'rejected';
      readonly code: string;
      readonly message: string;
    };

/**
 * FR-R8-01 (01-02, 01-03) — Commit `KEYS.controlLedger`, `KEYS.connectedRuns`,
 * and `KEYS.queue` in one serialized SQLite `BEGIN IMMEDIATE` batch transaction,
 * verifying live primacy & queue ownership and enforcing duplicate-delivery
 * idempotency on `connectedRunId` and `workflowOccurrence`.
 */
export async function admitComposableWorkflowLaunchAtomically(
  ctx: WorkspaceStateFamilyContext,
  warned: ConnectedRunsWarningState,
  input: AtomicComposableLaunchInput
): Promise<AtomicComposableLaunchOutcome> {
  let result: AtomicComposableLaunchOutcome = {
    outcome: 'rejected',
    code: 'durable-store-unavailable',
    message: 'Atomic composable launch did not commit.'
  };
  const txState = { didCommit: false };

  await ctx.serializeAcrossKeys(
    [KEYS.connectedRuns, KEYS.controlLedger, KEYS.queue],
    async () => {
      const registry = ctx.getQueueRegistry();
      if (!registry.entries.some((entry) => entry.id === input.queueId)) {
        result = {
          outcome: 'rejected',
          code: 'unknown-queue-id',
          message: `Unknown queue id: ${input.queueId}`
        };
        return;
      }

      const primacySource = ctx.getPrimacyClaimSource();
      if (primacySource !== null && !(await primacySource.canCommitConnectedRun())) {
        result = {
          outcome: 'rejected',
          code: 'stale-execution-fence',
          message: 'Launch refused: this window does not hold workspace primacy.'
        };
        return;
      }
      const claimSource = ctx.getRunClaimSource();
      if (claimSource?.tenureOf?.(input.queueId).state === 'lost') {
        result = {
          outcome: 'rejected',
          code: 'stale-execution-fence',
          message: `Launch refused: this window lost its ownership claim on queue '${input.queueId}'.`
        };
        return;
      }
      if (claimSource !== null) {
        const queueClaim = claimSource.claimFor(input.queueId);
        if (queueClaim !== null) {
          const failure = await checkCommitFence(
            ctx.getOwnershipRegistry(),
            queueClaim,
            input.queueId,
            'Run',
            ctx.scheduler
          );
          if (failure !== null) {
            if (failure.reason === 'fence-superseded') {
              const currentClaim = claimSource.claimFor(input.queueId);
              if (currentClaim?.ownerId === queueClaim.ownerId && currentClaim.fence === queueClaim.fence) {
                claimSource.markLost?.(input.queueId, 'superseded');
              }
            }
            result = {
              outcome: 'rejected',
              code: 'stale-execution-fence',
              message: `Launch refused: queue ownership fence check failed (${failure.reason}).`
            };
            return;
          }
        } else if (await isFreshForeignQueueOwner(ctx, input.queueId)) {
          result = {
            outcome: 'rejected',
            code: 'stale-execution-fence',
            message: `Launch refused: queue '${input.queueId}' is held by another active window.`
          };
          return;
        }
      }

      const { runs, refused } = readConnectedRunCollection(ctx, warned);
      if (Object.hasOwn(refused, input.connectedRun.connectedRunId)) {
        result = {
          outcome: 'rejected',
          code: 'unsupported-run-schema-version',
          message: `Connected run '${input.connectedRun.connectedRunId}' is refused/unreadable.`
        };
        return;
      }

      // Idempotent duplicate delivery by `connectedRunId`
      const existingRun = Object.hasOwn(runs, input.connectedRun.connectedRunId)
        ? runs[input.connectedRun.connectedRunId]
        : undefined;
      if (existingRun !== undefined) {
        const existingQueueItemId = findFirstQueueItemId(existingRun);
        if (existingQueueItemId !== null) {
          result = {
            outcome: 'committed',
            run: existingRun,
            queueItemId: existingQueueItemId,
            idempotent: true
          };
          return;
        }
        result = {
          outcome: 'rejected',
          code: 'connected-run-already-exists',
          message: `Connected run '${input.connectedRun.connectedRunId}' already exists without a bound queue item.`
        };
        return;
      }

      const currentQueue = ctx.getQueue(input.queueId);
      const queueMutation = input.mutateQueue(currentQueue);
      const nextQueue = ctx.ensureExtendedQueueShape({
        ...queueMutation.queue,
        requests: ctx.compactRequestPositions(queueMutation.queue.requests),
        updatedAt: Date.now()
      });

      const rawLedger = ctx.memento.get<unknown>(KEYS.controlLedger);
      const committedQueueItemId = queueMutation.request.id;
      const ledgerMutation = await input.mutateControlLedger(rawLedger, committedQueueItemId);
      if (!ledgerMutation.ok) {
        result = {
          outcome: 'rejected',
          code: ledgerMutation.code,
          message: ledgerMutation.message
        };
        return;
      }

      const committedConnectedRun =
        input.rebindConnectedRun !== undefined
          ? input.rebindConnectedRun(committedQueueItemId)
          : input.connectedRun;

      assertConnectedRunInvariants(committedConnectedRun, {
        knownQueueIds: new Set(registry.entries.map((entry) => entry.id))
      });

      const nextConnectedRuns = {
        ...refused,
        ...runs,
        [committedConnectedRun.connectedRunId]: committedConnectedRun
      };
      const nextQueueMap = {
        ...ctx.readQueueMap(),
        [input.queueId]: nextQueue
      };

      if (ctx.supportsBatchWrite) {
        await ctx.writeGate.writeBatch([
          { key: KEYS.controlLedger, value: ledgerMutation.nextLedger },
          { key: KEYS.connectedRuns, value: nextConnectedRuns },
          { key: KEYS.queue, value: nextQueueMap }
        ]);
      } else {
        const prevLedger = rawLedger;
        const prevConnected = ctx.memento.get<unknown>(KEYS.connectedRuns);
        await ctx.memento.update(KEYS.controlLedger, ledgerMutation.nextLedger);
        try {
          await ctx.memento.update(KEYS.connectedRuns, nextConnectedRuns);
          try {
            await ctx.memento.update(KEYS.queue, nextQueueMap);
          } catch (queueErr) {
            try {
              await ctx.memento.update(KEYS.connectedRuns, prevConnected);
              await ctx.memento.update(KEYS.controlLedger, prevLedger);
            } catch {
              // Best-effort rollback on non-batch Memento.
            }
            throw queueErr;
          }
        } catch (connErr) {
          try {
            await ctx.memento.update(KEYS.controlLedger, prevLedger);
          } catch {
            // Best-effort rollback on non-batch Memento.
          }
          throw connErr;
        }
      }

      txState.didCommit = true;
      result = {
        outcome: 'committed',
        run: committedConnectedRun,
        queueItemId: committedQueueItemId,
        idempotent: false
      };
    }
  );

  if (txState.didCommit) {
    ctx.notify(KEYS.controlLedger);
    ctx.notify(KEYS.connectedRuns);
    ctx.notify(KEYS.queue);
  }
  return result;
}

function findFirstQueueItemId(run: ConnectedWorkflowRun): string | null {
  for (const frame of Object.values(run.invocations ?? {})) {
    for (const attempts of Object.values(frame.attemptsByNodeId)) {
      for (const attempt of attempts) {
        if (attempt.queueItemId !== undefined) return attempt.queueItemId;
      }
    }
  }
  return null;
}

export async function transactControlLedger<T>(
  ctx: WorkspaceStateFamilyContext,
  op: (raw: unknown, write: (next: unknown) => Promise<void>) => Promise<T>
): Promise<T> {
  let outcome!: T;
  const state = { didWrite: false };
  await ctx.serialize(KEYS.controlLedger, async () => {
    const current = ctx.memento.get<unknown>(KEYS.controlLedger);
    outcome = await op(current, async (next: unknown) => {
      const primacySource = ctx.getPrimacyClaimSource();
      if (primacySource !== null && !(await primacySource.canCommitConnectedRun())) {
        throw new QueueMutationRejected(
          'ownership-lost',
          'Control ledger write refused: this window does not hold workspace primacy'
        );
      }
      await ctx.memento.update(KEYS.controlLedger, next);
      state.didWrite = true;
    });
  });
  if (state.didWrite) {
    ctx.notify(KEYS.controlLedger);
  }
  return outcome;
}

export function getResetMarker(ctx: WorkspaceStateFamilyContext): ResetMarker | null {
  const raw = ctx.memento.get<unknown>(KEYS.resetMarker);
  return isResetMarker(raw) ? raw : null;
}

export async function resetWorkspaceState(ctx: WorkspaceStateFamilyContext): Promise<number> {
  ctx.writeGate.lift();
  const generation = nextResetGeneration(getResetMarker(ctx));
  await ctx.serializeAcrossKeys([...RESET_CLEARED_KEYS, KEYS.resetMarker], async () => {
    await ctx.memento.update(KEYS.resetMarker, {
      generation,
      status: 'in-progress'
    } satisfies ResetMarker);
    for (const key of RESET_CLEARED_KEYS) {
      await ctx.memento.update(key, undefined);
    }
    await ctx.memento.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION);
    await ctx.memento.update(KEYS.resetMarker, {
      generation,
      status: 'complete'
    } satisfies ResetMarker);
  });
  return generation;
}

export async function completeInterruptedReset(
  ctx: WorkspaceStateFamilyContext
): Promise<number | null> {
  const marker = getResetMarker(ctx);
  if (!isResetInterrupted(marker)) return null;
  ctx.writeGate.lift();
  const generation = marker!.generation;
  await ctx.serializeAcrossKeys([...RESET_CLEARED_KEYS, KEYS.resetMarker], async () => {
    for (const key of RESET_CLEARED_KEYS) {
      await ctx.memento.update(key, undefined);
    }
    await ctx.memento.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION);
    await ctx.memento.update(KEYS.resetMarker, {
      generation,
      status: 'complete'
    } satisfies ResetMarker);
  });
  return generation;
}
