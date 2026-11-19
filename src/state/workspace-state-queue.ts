/**
 * FR-R7-07 — Queue, Queue Registry, Task CRUD, Concurrency Cap, and Concurrency
 * Notice key-family module (`KEYS.queue`, `KEYS.queueRegistry`,
 * `KEYS.queueDefaultId`, `KEYS.queueGlobalConcurrencyCap`,
 * `KEYS.concurrencyNotice`), delegated from `WorkspaceStateStore`.
 *
 * Every mutation executes on the single facade-owned `ctx.serialize` /
 * `ctx.serializeAcrossKeys` chain and single commit fence.
 */

import { DEFAULT_GLOBAL_CONCURRENCY_CAP } from '../contracts/queue-bounds';
import type { QueueFailurePolicy } from '../contracts/queue-failure-policy';
import {
  MAX_PENDING_TASKS_PER_QUEUE,
  validateDescription
} from '../contracts/queue-feature-request-helpers';
import { DEFAULT_QUEUE_ID } from '../contracts/queue-identity';
import { withRefreshedLifecycle } from '../contracts/queue-lifecycle-refresh';
import {
  deleteQueue as removeQueueEntry,
  findQueue,
  makeDefaultRegistry,
  projectQueueRegistry,
  validateQueueRegistry,
  type ProjectedQueueRegistry,
  type QueuePauseView,
  type QueueRegistry,
  type QueueRegistryEntry
} from '../contracts/queue-registry';
import type { FeatureRequest, QueueState } from '../queue/feature-request';
import {
  checkCommitFence,
  isFencedClaim,
  type QueueCommitClaim
} from './ownership-claim';
import type { QueueStateMap } from './queue-state-migrator';
import {
  KEYS,
  QueueMutationRejected,
  type ConcurrencyNotice,
  type QueueDeletionView,
  type WorkspaceStateFamilyContext
} from './workspace-state-types';

export function bornEmptyQueue(): QueueState {
  return {
    requests: [],
    inFlightId: null,
    updatedAt: Date.now(),
    queueLifecycle: 'active-empty',
    pauseSource: null,
    pausedReason: null,
    scheduledStartAt: null,
    scheduledStartSource: null
  };
}

export function readQueueMap(ctx: WorkspaceStateFamilyContext): QueueStateMap {
  const raw = ctx.memento.get<unknown>(KEYS.queue);
  if (raw === undefined || raw === null) return {};
  if (Array.isArray((raw as QueueState).requests)) {
    return { [DEFAULT_QUEUE_ID]: raw as QueueState };
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as QueueStateMap;
  }
  return {};
}

export function getQueue(ctx: WorkspaceStateFamilyContext, queueId: string): QueueState {
  const map = readQueueMap(ctx);
  const persisted: QueueState | undefined = Object.hasOwn(map, queueId)
    ? (map[queueId] as QueueState | undefined)
    : undefined;
  if (!persisted) return bornEmptyQueue();
  return ctx.ensureExtendedQueueShape(persisted);
}

export function getQueueStates(ctx: WorkspaceStateFamilyContext): QueueStateMap {
  const map = readQueueMap(ctx);
  const out: QueueStateMap = {};
  for (const [queueId, state] of Object.entries(map)) {
    out[queueId] = ctx.ensureExtendedQueueShape(state);
  }
  return out;
}

export function getQueueStateIds(ctx: WorkspaceStateFamilyContext): readonly string[] {
  return Object.keys(readQueueMap(ctx));
}

export function hasQueueState(ctx: WorkspaceStateFamilyContext, queueId: string): boolean {
  return Object.prototype.hasOwnProperty.call(readQueueMap(ctx), queueId);
}

export function writeQueueState(
  ctx: WorkspaceStateFamilyContext,
  queue: QueueState,
  queueId: string
): Promise<void> {
  const next = ctx.ensureExtendedQueueShape({
    ...queue,
    requests: ctx.compactRequestPositions(queue.requests),
    updatedAt: Date.now()
  });
  return ctx.serialize(KEYS.queue, () =>
    ctx.memento.update(KEYS.queue, { ...readQueueMap(ctx), [queueId]: next })
  ).then(() => {
    ctx.notify(KEYS.queue);
  });
}

export function deleteQueueState(
  ctx: WorkspaceStateFamilyContext,
  queueId: string
): Promise<void> {
  return ctx.serialize(KEYS.queue, () => {
    const map = { ...readQueueMap(ctx) };
    delete map[queueId];
    return ctx.memento.update(KEYS.queue, map);
  }).then(() => {
    ctx.notify(KEYS.queue);
  });
}

export function updateQueue<T>(
  ctx: WorkspaceStateFamilyContext,
  mutate: (current: QueueState) => { readonly queue: QueueState; readonly result: T },
  queueId: string,
  claim: QueueCommitClaim
): Promise<T> {
  let result!: T;
  return ctx.serialize(KEYS.queue, async () => {
    if (isFencedClaim(claim)) {
      const f = await checkCommitFence(
        ctx.getOwnershipRegistry(),
        claim,
        queueId,
        'Queue',
        ctx.scheduler
      );
      if (f !== null) ctx.refuseCommit(f, claim, queueId);
    }
    const current = getQueue(ctx, queueId);
    const mutation = mutate(current);
    const next = ctx.ensureExtendedQueueShape({
      ...mutation.queue,
      requests: ctx.compactRequestPositions(mutation.queue.requests),
      updatedAt: Date.now()
    });
    result = mutation.result;
    await ctx.memento.update(KEYS.queue, { ...readQueueMap(ctx), [queueId]: next });
  }).then(() => {
    ctx.notify(KEYS.queue);
    return result;
  });
}

function updateQueueMap<T>(
  ctx: WorkspaceStateFamilyContext,
  mutate: (current: QueueStateMap) => { readonly queueStates: QueueStateMap; readonly result: T },
  touchedQueueIds: readonly string[] = []
): Promise<T> {
  let result!: T;
  return ctx.serialize(KEYS.queue, async () => {
    await ctx.verifyPrimacyForCommit('Queue');
    for (const queueId of touchedQueueIds) {
      await ctx.verifyQueueOwnershipForCommit(queueId, 'Queue');
    }
    const current = getQueueStates(ctx);
    const mutation = mutate(current);
    const next: QueueStateMap = {};
    for (const [queueId, state] of Object.entries(mutation.queueStates)) {
      next[queueId] = ctx.ensureExtendedQueueShape({
        ...state,
        requests: ctx.compactRequestPositions(state.requests),
        updatedAt: Date.now()
      });
    }
    result = mutation.result;
    await ctx.memento.update(KEYS.queue, next);
  }).then(() => {
    ctx.notify(KEYS.queue);
    return result;
  });
}

function findTaskOwner(
  ctx: WorkspaceStateFamilyContext,
  taskId: string
): { queueId: string; request: FeatureRequest } | null {
  for (const [queueId, state] of Object.entries(readQueueMap(ctx))) {
    const requests = (state as Partial<QueueState>).requests;
    const request = requests?.find((r) => r.id === taskId);
    if (request) return { queueId, request };
  }
  return null;
}

export function getQueueRegistry(ctx: WorkspaceStateFamilyContext): QueueRegistry {
  const registry = ctx.memento.get<QueueRegistry>(KEYS.queueRegistry) ?? makeDefaultRegistry();
  validateQueueRegistry(registry);
  return registry;
}

export function getProjectedQueueRegistry(
  ctx: WorkspaceStateFamilyContext,
  workspaceFailurePolicyDefault: QueueFailurePolicy = 'halt-on-failure'
): ProjectedQueueRegistry {
  const queueStates = readQueueMap(ctx);
  const pauseByQueueId = new Map<string, QueuePauseView>();
  const failurePolicyByQueueId = new Map<string, QueueFailurePolicy | undefined>();
  for (const [queueId, state] of Object.entries(queueStates)) {
    pauseByQueueId.set(queueId, {
      paused: state.queueLifecycle === 'operator-paused',
      pauseSource: state.pauseSource ?? null
    });
    failurePolicyByQueueId.set(queueId, state.failurePolicy);
  }
  return projectQueueRegistry(
    getQueueRegistry(ctx),
    pauseByQueueId,
    failurePolicyByQueueId,
    workspaceFailurePolicyDefault
  );
}

function normalizedRegistry(registry: QueueRegistry): QueueRegistry {
  validateQueueRegistry(registry);
  return {
    entries: registry.entries.map((entry) => {
      const { state: _state, pauseSource: _pauseSource, ...rest } = entry as QueueRegistryEntry & {
        state?: unknown;
        pauseSource?: unknown;
      };
      return rest;
    }),
    updatedAt: registry.updatedAt
  };
}

export function setQueueRegistry(
  ctx: WorkspaceStateFamilyContext,
  registry: QueueRegistry
): Promise<void> {
  const normalized = normalizedRegistry(registry);
  return ctx.serialize(KEYS.queueRegistry, () =>
    ctx.memento.update(KEYS.queueRegistry, normalized)
  ).then(() => {
    ctx.notify(KEYS.queueRegistry);
  });
}

export async function updateQueueRegistry<T>(
  ctx: WorkspaceStateFamilyContext,
  mutate: (current: QueueRegistry) => { readonly registry: QueueRegistry; readonly result: T },
  queueIds: readonly string[] = []
): Promise<T> {
  let result!: T;
  let updated = false as boolean;
  await ctx.serialize(KEYS.queueRegistry, async () => {
    await ctx.verifyPrimacyForCommit('Queue registry');
    for (const queueId of queueIds) {
      await ctx.verifyQueueOwnershipForCommit(queueId, 'Queue');
    }
    const current = getQueueRegistry(ctx);
    const mutation = mutate(current);
    result = mutation.result;
    if (mutation.registry === current) return;
    const normalized = normalizedRegistry(mutation.registry);
    await ctx.memento.update(KEYS.queueRegistry, normalized);
    updated = true;
  });
  if (updated) {
    ctx.notify(KEYS.queueRegistry);
  }
  return result;
}

export async function deleteQueueIfNoLiveRun<
  I extends { readonly outcome: 'refused' | 'deletable' }
>(
  ctx: WorkspaceStateFamilyContext,
  queueId: string,
  recheck: (view: QueueDeletionView) => I,
  now: number
): Promise<I> {
  let impact!: I;
  let registryUpdated = false as boolean;
  let queueUpdated = false as boolean;
  try {
    await ctx.serializeAcrossKeys([KEYS.queueRegistry, KEYS.run, KEYS.queue], async () => {
      await ctx.verifyPrimacyForCommit('Queue');
      await ctx.verifyQueueOwnershipForCommit(queueId, 'Queue');
      const registry = getQueueRegistry(ctx);
      const requests = findQueue(registry, queueId)
        ? getQueue(ctx, queueId)
            .requests.slice()
            .sort((a, b) => a.position - b.position)
        : [];
      impact = recheck({ registry, run: ctx.getRun(queueId), requests });
      if (impact.outcome !== 'deletable') return;
      await ctx.memento.update(
        KEYS.queueRegistry,
        normalizedRegistry(removeQueueEntry(registry, { id: queueId, now }))
      );
      registryUpdated = true;
      const remaining = { ...readQueueMap(ctx) };
      delete remaining[queueId];
      await ctx.memento.update(KEYS.queue, remaining);
      queueUpdated = true;
    });
  } finally {
    if (registryUpdated) ctx.notify(KEYS.queueRegistry);
    if (queueUpdated) ctx.notify(KEYS.queue);
  }
  return impact;
}

export function getDefaultQueueId(ctx: WorkspaceStateFamilyContext): string {
  const id = ctx.memento.get<string>(KEYS.queueDefaultId) ?? DEFAULT_QUEUE_ID;
  return findQueue(getQueueRegistry(ctx), id) ? id : DEFAULT_QUEUE_ID;
}

export function setDefaultQueueId(ctx: WorkspaceStateFamilyContext, id: string): Promise<void> {
  if (!findQueue(getQueueRegistry(ctx), id)) {
    throw new QueueMutationRejected('unknown-queue-id', `Unknown queue id: ${id}`);
  }
  return ctx.serialize(KEYS.queueDefaultId, () =>
    ctx.memento.update(KEYS.queueDefaultId, id)
  ).then(() => {
    ctx.notify(KEYS.queueDefaultId);
  });
}

export function getGlobalConcurrencyCap(ctx: WorkspaceStateFamilyContext): number {
  const value = ctx.memento.get<number | null>(KEYS.queueGlobalConcurrencyCap);
  if (value === undefined || value === null) return DEFAULT_GLOBAL_CONCURRENCY_CAP;
  ctx.assertGlobalConcurrencyCap(value, 'persisted');
  return value;
}

export function setGlobalConcurrencyCap(
  ctx: WorkspaceStateFamilyContext,
  value: number
): Promise<void> {
  ctx.assertGlobalConcurrencyCap(value, 'requested');
  return ctx.serialize(KEYS.queueGlobalConcurrencyCap, () =>
    ctx.memento.update(KEYS.queueGlobalConcurrencyCap, value)
  ).then(() => {
    ctx.notify(KEYS.queueGlobalConcurrencyCap);
  });
}

export function getConcurrencyNotice(ctx: WorkspaceStateFamilyContext): ConcurrencyNotice | null {
  const value = ctx.memento.get<unknown>(KEYS.concurrencyNotice);
  return value === 'pending' || value === 'dismissed' ? value : null;
}

export function setConcurrencyNotice(
  ctx: WorkspaceStateFamilyContext,
  value: ConcurrencyNotice
): Promise<void> {
  return ctx.serialize(KEYS.concurrencyNotice, () =>
    ctx.memento.update(KEYS.concurrencyNotice, value)
  ).then(() => {
    ctx.notify(KEYS.concurrencyNotice);
  });
}

export function getRequestsForQueue(
  ctx: WorkspaceStateFamilyContext,
  queueId: string
): FeatureRequest[] {
  if (!findQueue(getQueueRegistry(ctx), queueId)) {
    throw new QueueMutationRejected('unknown-queue-id', `Unknown queue id: ${queueId}`);
  }
  return getQueue(ctx, queueId)
    .requests.slice()
    .sort((a, b) => a.position - b.position);
}

export async function insertPendingRequest(
  ctx: WorkspaceStateFamilyContext,
  request: FeatureRequest,
  params: { queueId?: string; position?: number | null } = {}
): Promise<FeatureRequest> {
  const queueId = params.queueId ?? getDefaultQueueId(ctx);
  if (!findQueue(getQueueRegistry(ctx), queueId)) {
    throw new QueueMutationRejected('unknown-queue-id', `Unknown queue id: ${queueId}`);
  }
  return updateQueue(
    ctx,
    (queue) => {
      const pendingInTarget = queue.requests
        .filter((item) => item.status === 'pending')
        .sort((a, b) => a.position - b.position);
      if (pendingInTarget.length >= MAX_PENDING_TASKS_PER_QUEUE) {
        throw new QueueMutationRejected(
          'task-cap-reached',
          `Queue ${queueId} already has ${MAX_PENDING_TASKS_PER_QUEUE} pending tasks`
        );
      }
      const insertAt = params.position ?? queue.requests.length;
      if (!Number.isInteger(insertAt) || insertAt < 0 || insertAt > queue.requests.length) {
        throw new QueueMutationRejected(
          'position-out-of-range',
          `Position must be in [0, ${queue.requests.length}] (got ${String(params.position)})`
        );
      }
      const now = Date.now();
      const nextRequest: FeatureRequest = {
        ...request,
        queueId,
        position: insertAt,
        pauseCause: null,
        updatedAt: now
      };
      const denseIndex = new Map<string, number>();
      const allInTarget = queue.requests.slice().sort((a, b) => a.position - b.position);
      allInTarget.forEach((item, idx) => denseIndex.set(item.id, idx));
      const shifted = queue.requests.map((item) => {
        const dense = denseIndex.get(item.id) ?? item.position;
        const repositioned = dense >= insertAt ? dense + 1 : dense;
        if (repositioned === item.position) return item;
        return { ...item, position: repositioned, updatedAt: now };
      });
      return {
        queue: { ...queue, requests: [...shifted, nextRequest] },
        result: nextRequest
      };
    },
    queueId,
    ctx.runCommitClaim(queueId)
  );
}

export function getRequest(
  ctx: WorkspaceStateFamilyContext,
  taskId: string
): FeatureRequest | null {
  return findTaskOwner(ctx, taskId)?.request ?? null;
}

export async function removeRequest(
  ctx: WorkspaceStateFamilyContext,
  taskId: string
): Promise<FeatureRequest> {
  const owner = findTaskOwner(ctx, taskId);
  if (!owner) {
    throw new QueueMutationRejected('task-not-found', `Unknown task id: ${taskId}`);
  }
  return updateQueue(
    ctx,
    (queue) => {
      const target = queue.requests.find((request) => request.id === taskId);
      if (!target) {
        throw new QueueMutationRejected('task-not-found', `Unknown task id: ${taskId}`);
      }
      return {
        queue: withRefreshedLifecycle({
          ...queue,
          inFlightId: queue.inFlightId === taskId ? null : queue.inFlightId,
          requests: queue.requests.filter((request) => request.id !== taskId)
        }),
        result: target
      };
    },
    owner.queueId,
    ctx.runCommitClaim(owner.queueId)
  );
}

export async function modifyPendingRequest(
  ctx: WorkspaceStateFamilyContext,
  taskId: string,
  updates: { description?: string }
): Promise<FeatureRequest> {
  const owner = findTaskOwner(ctx, taskId);
  if (!owner) {
    throw new QueueMutationRejected('task-not-found', `Unknown task id: ${taskId}`);
  }
  return updateQueue(
    ctx,
    (queue) => {
      const target = queue.requests.find((request) => request.id === taskId);
      if (!target) {
        throw new QueueMutationRejected('task-not-found', `Unknown task id: ${taskId}`);
      }
      if (target.status !== 'pending') {
        throw new QueueMutationRejected(
          'task-not-in-pending-state',
          `Task ${taskId} is not pending`
        );
      }
      const nextTarget: FeatureRequest = {
        ...target,
        ...(updates.description !== undefined
          ? { description: validateDescription(updates.description) }
          : {}),
        updatedAt: Date.now()
      };
      return {
        queue: {
          ...queue,
          requests: queue.requests.map((request) =>
            request.id === taskId ? nextTarget : request
          )
        },
        result: nextTarget
      };
    },
    owner.queueId,
    ctx.runCommitClaim(owner.queueId)
  );
}

export async function reorderPendingRequest(
  ctx: WorkspaceStateFamilyContext,
  taskId: string,
  position: number
): Promise<FeatureRequest> {
  const owner = findTaskOwner(ctx, taskId);
  if (!owner) {
    throw new QueueMutationRejected('task-not-found', `Unknown task id: ${taskId}`);
  }
  return updateQueue(
    ctx,
    (queue) => {
      const target = queue.requests.find((request) => request.id === taskId);
      if (!target) {
        throw new QueueMutationRejected('task-not-found', `Unknown task id: ${taskId}`);
      }
      if (target.status !== 'pending') {
        throw new QueueMutationRejected(
          'task-not-in-pending-state',
          `Task ${taskId} is not pending`
        );
      }
      const pendingPeers = queue.requests
        .filter((request) => request.status === 'pending')
        .sort((a, b) => a.position - b.position);
      if (!Number.isInteger(position) || position < 0 || position >= pendingPeers.length) {
        throw new QueueMutationRejected(
          'position-out-of-range',
          `Position must be in [0, ${Math.max(0, pendingPeers.length - 1)}] (got ${position})`
        );
      }
      const pendingSlots = pendingPeers.map((peer) => peer.position);
      const reorderedPending = pendingPeers.filter((request) => request.id !== taskId);
      reorderedPending.splice(position, 0, target);
      const now = Date.now();
      const byId = new Map(
        reorderedPending.map((request, i) => {
          const nextPosition = pendingSlots[i];
          if (request.position === nextPosition) return [request.id, request];
          return [request.id, { ...request, position: nextPosition, updatedAt: now }];
        })
      );
      return {
        queue: {
          ...queue,
          requests: queue.requests.map((request) => byId.get(request.id) ?? request)
        },
        result: byId.get(taskId) ?? target
      };
    },
    owner.queueId,
    ctx.runCommitClaim(owner.queueId)
  );
}

export async function movePendingRequest(
  ctx: WorkspaceStateFamilyContext,
  taskId: string,
  params: { targetQueueId: string; position?: number | null }
): Promise<FeatureRequest> {
  if (!findQueue(getQueueRegistry(ctx), params.targetQueueId)) {
    throw new QueueMutationRejected(
      'unknown-queue-id',
      `Unknown queue id: ${params.targetQueueId}`
    );
  }
  const owner = findTaskOwner(ctx, taskId);
  if (!owner) {
    throw new QueueMutationRejected('task-not-found', `Unknown task id: ${taskId}`);
  }
  const target = owner.request;
  if (target.status !== 'pending') {
    throw new QueueMutationRejected(
      'task-not-in-pending-state',
      `Task ${taskId} is not pending`
    );
  }
  const sameQueue = owner.queueId === params.targetQueueId;
  if (sameQueue) {
    const targetPending = getQueue(ctx, params.targetQueueId)
      .requests.filter((request) => request.status === 'pending')
      .sort((a, b) => a.position - b.position);
    const maxPosition = targetPending.length - 1;
    const insertAt = params.position ?? maxPosition;
    if (!Number.isInteger(insertAt) || insertAt < 0 || insertAt > maxPosition) {
      throw new QueueMutationRejected(
        'position-out-of-range',
        `Position must be in [0, ${maxPosition}] (got ${String(params.position)})`
      );
    }
    return reorderPendingRequest(ctx, taskId, insertAt);
  }
  return updateQueueMap(
    ctx,
    (current) => {
      if (!findQueue(getQueueRegistry(ctx), params.targetQueueId)) {
        throw new QueueMutationRejected(
          'unknown-queue-id',
          `Unknown queue id: ${params.targetQueueId}`
        );
      }
      const source = current[owner.queueId] ?? bornEmptyQueue();
      const freshTarget = source.requests.find((request) => request.id === taskId);
      if (!freshTarget) {
        throw new QueueMutationRejected('task-not-found', `Unknown task id: ${taskId}`);
      }
      if (freshTarget.status !== 'pending') {
        throw new QueueMutationRejected(
          'task-not-in-pending-state',
          `Task ${taskId} is not pending`
        );
      }
      const destination = current[params.targetQueueId] ?? bornEmptyQueue();
      const targetPending = destination.requests
        .filter((request) => request.status === 'pending')
        .sort((a, b) => a.position - b.position);
      if (targetPending.length >= MAX_PENDING_TASKS_PER_QUEUE) {
        throw new QueueMutationRejected(
          'task-cap-reached',
          `Queue ${params.targetQueueId} already has ${MAX_PENDING_TASKS_PER_QUEUE} pending tasks`
        );
      }
      const maxPosition = targetPending.length;
      const insertAt = params.position ?? maxPosition;
      if (!Number.isInteger(insertAt) || insertAt < 0 || insertAt > maxPosition) {
        throw new QueueMutationRejected(
          'position-out-of-range',
          `Position must be in [0, ${maxPosition}] (got ${String(params.position)})`
        );
      }
      const last = targetPending.at(-1);
      const ahead = targetPending.at(insertAt);
      const insertSlot =
        ahead?.position ??
        (last === undefined ? destination.requests.length : last.position + 1);
      const now = Date.now();
      const moved: FeatureRequest = {
        ...freshTarget,
        queueId: params.targetQueueId,
        position: insertSlot,
        updatedAt: now
      };
      return {
        queueStates: {
          ...current,
          [owner.queueId]: {
            ...source,
            requests: source.requests.filter((request) => request.id !== taskId)
          },
          [params.targetQueueId]: {
            ...destination,
            requests: [
              ...destination.requests.map((request) =>
                request.position >= insertSlot
                  ? { ...request, position: request.position + 1, updatedAt: now }
                  : request
              ),
              moved
            ]
          }
        },
        result: moved
      };
    },
    [owner.queueId, params.targetQueueId]
  );
}
