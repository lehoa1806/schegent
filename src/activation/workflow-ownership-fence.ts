// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT.
// Pure ownership-fence resolution and verification adapter for desktop workflow composition.
// Reads the live filesystem OwnershipRegistry and local primacy/queue claim sources on demand;
// performs zero side effects at import or construction time.

import type { ExecutionFence } from '../contracts/control-ledger';
import type { ConnectedWorkflowRun } from '../state/connected-workflow-run';
import { STALENESS_THRESHOLD_MS, systemScheduler, type Scheduler } from '../state/lock';
import {
  checkCommitFence,
  OWNERSHIP_VERIFY_DEADLINE_MS,
  readOwnershipStatusWithinDeadline,
  verifyWithin
} from '../state/ownership-claim';
import { PRIMACY_RESOURCE, queueResource } from '../state/ownership-registry';
import type { WorkspaceStateStore } from '../state/workspace-state';

const PRIMACY_CLAIM_RE = /^primacy:(.+):g(\d+)$/;
const QUEUE_OWNER_RE = /^queue:([^:]+):owner:(.+):g(\d+)$/;
const QUEUE_HELD_RE = /^queue:([^:]+):(.+):g(\d+)$/;
const QUEUE_UNLEASED_RE = /^queue:([^:]+):unleased:(.+):g(\d+)$/;

function parseOwnerScopedQueueClaim(
  raw: string,
  expectedQueueId: string
): { readonly ownerId: string; readonly primacyFence: number } | null {
  const match = QUEUE_OWNER_RE.exec(raw) ?? QUEUE_UNLEASED_RE.exec(raw);
  const queueId = match?.at(1);
  const ownerId = match?.at(2);
  const fenceRaw = match?.at(3);
  if (queueId !== expectedQueueId || ownerId === undefined || fenceRaw === undefined) {
    return null;
  }
  const primacyFence = Number(fenceRaw);
  if (!Number.isSafeInteger(primacyFence) || primacyFence < 1) return null;
  return { ownerId, primacyFence };
}

function parseHeldQueueClaim(
  raw: string,
  expectedQueueId: string
): { readonly ownerId: string; readonly fence: number } | null {
  if (
    raw.endsWith(':lost') ||
    raw.startsWith(`queue:${expectedQueueId}:unleased:`) ||
    raw.startsWith(`queue:${expectedQueueId}:owner:`)
  ) {
    return null;
  }
  const match = QUEUE_HELD_RE.exec(raw);
  const queueId = match?.at(1);
  const ownerId = match?.at(2);
  const fenceRaw = match?.at(3);
  if (queueId !== expectedQueueId || ownerId === undefined || fenceRaw === undefined) {
    return null;
  }
  const fence = Number(fenceRaw);
  if (!Number.isSafeInteger(fence) || fence < 1) return null;
  return { ownerId, fence };
}

export interface DesktopOwnershipFenceDeps {
  readonly store: Pick<
    WorkspaceStateStore,
    'ownership' | 'primacyClaim' | 'runClaimFor' | 'runTenureOf' | 'markRunClaimLost'
  >;
  readonly getRootGeneration?: (connectedRunId: string) => number | undefined;
  readonly now?: () => number;
  readonly scheduler?: Scheduler;
}

export interface DesktopOwnershipFencePair {
  readonly resolveExecutionFence: (run: ConnectedWorkflowRun, queueId: string) => ExecutionFence;
  readonly verifyLiveFence: (
    fence: ExecutionFence,
    context: { readonly rootRunId: string; readonly queueId: string }
  ) => Promise<boolean>;
  readonly isLocalFenceCurrent: (
    fence: ExecutionFence,
    context: { readonly rootRunId: string; readonly queueId: string }
  ) => boolean;
}

export function createDesktopOwnershipFenceForStore(
  store: Pick<
    WorkspaceStateStore,
    'ownership' | 'primacyClaim' | 'runClaimFor' | 'runTenureOf' | 'markRunClaimLost' | 'getRawControlLedger'
  >
): DesktopOwnershipFencePair {
  return createDesktopOwnershipFence({
    store,
    getRootGeneration: (connectedRunId) => {
      const raw = store.getRawControlLedger();
      if (typeof raw !== 'object' || raw === null) return undefined;
      const roots = (raw as { roots?: Record<string, { fence?: { rootGeneration?: number } } | undefined> }).roots;
      const gen = roots && Object.hasOwn(roots, connectedRunId) ? roots[connectedRunId]?.fence?.rootGeneration : undefined;
      return typeof gen === 'number' ? gen : undefined;
    }
  });
}

function parsePrimacyClaim(raw: string): { readonly ownerId: string; readonly fence: number } | null {
  const match = PRIMACY_CLAIM_RE.exec(raw);
  const ownerId = match?.at(1);
  const fenceRaw = match?.at(2);
  if (ownerId === undefined || fenceRaw === undefined) return null;
  const fence = Number(fenceRaw);
  if (!Number.isSafeInteger(fence) || fence < 1) return null;
  return { ownerId, fence };
}

/**
 * FR-R8-01 (01-03) — Build real desktop ownership-fence resolvers and async
 * verifiers backed by `.schegent/ownership/` (`WorkspaceLockManager` +
 * `ExecutionLeaseManager`).
 */
export function createDesktopOwnershipFence(
  deps: DesktopOwnershipFenceDeps
): DesktopOwnershipFencePair {
  const nowFn = deps.now ?? (() => Date.now());
  const scheduler = deps.scheduler ?? systemScheduler;

  const resolveExecutionFence = (run: ConnectedWorkflowRun, queueId: string): ExecutionFence => {
    const primacy = deps.store.primacyClaim();
    const primacyClaim =
      primacy !== null ? `primacy:${primacy.ownerId}:g${primacy.fence}` : 'primacy:unheld';
    const tenure = deps.store.runTenureOf(queueId);
    let queueClaim: string;
    if (tenure.state === 'lost') {
      queueClaim = `queue:${queueId}:${tenure.claim.ownerId}:g${tenure.claim.fence}:lost`;
    } else if (primacy !== null) {
      // Stable across legitimate single-owner lease transitions (`unleased -> held:g1 -> released -> held:g2`)
      // while remaining pinned to this window's primacy identity and generation. Live primacy and
      // queue lease state are still verified against `.schegent/ownership/` on every effect boundary.
      queueClaim = `queue:${queueId}:owner:${primacy.ownerId}:g${primacy.fence}`;
    } else {
      queueClaim = `queue:${queueId}:unheld`;
    }
    const existingGen = deps.getRootGeneration?.(run.connectedRunId);
    const rootGeneration =
      existingGen !== undefined && Number.isSafeInteger(existingGen) && existingGen >= 1
        ? existingGen
        : 1;
    return Object.freeze({ primacyClaim, queueClaim, rootGeneration });
  };

  const isLocalFenceCurrent = (
    fence: ExecutionFence,
    context: { readonly rootRunId: string; readonly queueId: string }
  ): boolean => {
    const parsedPrimacy = parsePrimacyClaim(fence.primacyClaim);
    if (parsedPrimacy === null) return false;
    const localPrimacy = deps.store.primacyClaim();
    if (
      localPrimacy === null ||
      localPrimacy.ownerId !== parsedPrimacy.ownerId ||
      localPrimacy.fence !== parsedPrimacy.fence
    ) {
      return false;
    }
    if (fence.queueClaim.endsWith(':lost')) return false;
    const tenure = deps.store.runTenureOf(context.queueId);
    if (tenure.state === 'lost') return false;
    const held = parseHeldQueueClaim(fence.queueClaim, context.queueId);
    if (held !== null) {
      return (
        held.ownerId === localPrimacy.ownerId &&
        tenure.state === 'held' &&
        tenure.claim.ownerId === held.ownerId &&
        tenure.claim.fence === held.fence
      );
    }
    const ownerScoped = parseOwnerScopedQueueClaim(fence.queueClaim, context.queueId);
    if (ownerScoped !== null) {
      if (
        ownerScoped.ownerId !== localPrimacy.ownerId ||
        ownerScoped.primacyFence !== localPrimacy.fence
      ) {
        return false;
      }
      if (tenure.state === 'held' && tenure.claim.ownerId !== localPrimacy.ownerId) {
        return false;
      }
      return true;
    }
    return false;
  };

  const verifyLiveFence = async (
    fence: ExecutionFence,
    context: { readonly rootRunId: string; readonly queueId: string }
  ): Promise<boolean> => {
    const parsedPrimacy = parsePrimacyClaim(fence.primacyClaim);
    if (parsedPrimacy === null) return false;
    const localPrimacy = deps.store.primacyClaim();
    if (
      localPrimacy === null ||
      localPrimacy.ownerId !== parsedPrimacy.ownerId ||
      localPrimacy.fence !== parsedPrimacy.fence
    ) {
      return false;
    }
    const primacyVerdict = await verifyWithin(
      deps.store.ownership,
      PRIMACY_RESOURCE,
      parsedPrimacy.ownerId,
      parsedPrimacy.fence,
      OWNERSHIP_VERIFY_DEADLINE_MS,
      scheduler
    );
    if (primacyVerdict.outcome !== 'valid') return false;

    if (fence.queueClaim.endsWith(':lost')) return false;
    const tenure = deps.store.runTenureOf(context.queueId);
    if (tenure.state === 'lost') return false;

    const held = parseHeldQueueClaim(fence.queueClaim, context.queueId);
    if (held !== null) {
      if (
        held.ownerId !== localPrimacy.ownerId ||
        tenure.state !== 'held' ||
        tenure.claim.ownerId !== held.ownerId ||
        tenure.claim.fence !== held.fence
      ) {
        return false;
      }
      const failure = await checkCommitFence(
        deps.store.ownership,
        tenure.claim,
        context.queueId,
        'Run',
        scheduler
      );
      if (failure !== null) {
        if (failure.reason === 'fence-superseded') {
          const current = deps.store.runClaimFor(context.queueId);
          if (current?.ownerId === held.ownerId && current.fence === held.fence) {
            deps.store.markRunClaimLost(context.queueId, 'superseded');
          }
        }
        return false;
      }
      return true;
    }

    const ownerScoped = parseOwnerScopedQueueClaim(fence.queueClaim, context.queueId);
    if (ownerScoped === null) return false;
    if (
      ownerScoped.ownerId !== parsedPrimacy.ownerId ||
      ownerScoped.primacyFence !== parsedPrimacy.fence
    ) {
      return false;
    }
    if (tenure.state === 'held') {
      if (tenure.claim.ownerId !== localPrimacy.ownerId) return false;
      const failure = await checkCommitFence(
        deps.store.ownership,
        tenure.claim,
        context.queueId,
        'Run',
        scheduler
      );
      if (failure !== null) {
        if (failure.reason === 'fence-superseded') {
          deps.store.markRunClaimLost(context.queueId, 'superseded');
        }
        return false;
      }
      return true;
    }

    const status = await readOwnershipStatusWithinDeadline(
      deps.store.ownership,
      queueResource(context.queueId),
      OWNERSHIP_VERIFY_DEADLINE_MS,
      scheduler
    );
    if (status.outcome === 'unavailable') return false;
    const holder = status.outcome === 'present' ? status.record.holder : null;
    if (
      holder !== null &&
      holder.ownerId !== parsedPrimacy.ownerId &&
      nowFn() - holder.heartbeatAt <= STALENESS_THRESHOLD_MS
    ) {
      return false;
    }
    return true;
  };

  return Object.freeze({
    resolveExecutionFence,
    verifyLiveFence,
    isLocalFenceCurrent
  });
}
