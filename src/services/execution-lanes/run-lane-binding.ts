/**
 * FR-R6-F10 (F10-FR-01..08, F10-FR-15, F10-FR-17, F10-FR-19):
 * Per-Run isolated lane admission, execution-root resolution, lifecycle synchronization,
 * and retention-pin discovery.
 *
 * Authority boundary (`16-22`): `RunLaneCoordinator` ONLY manages lane provisioning, execution-root
 * resolution, pause/resume/terminal lifecycle sync, and best-effort candidate freeze on Run
 * completion. It NEVER calls `requestIntegration`, `verifyRequest`, `approveRequest`, or
 * `landRequest` on behalf of a Run or agent: integration verification profiles, review approval,
 * and branch landing remain strictly separated host/human-operator actions so an agent cannot
 * propose its own verification `argv`, self-approve, or auto-land into a branch.
 *
 * NOTE: Lives under `src/services/execution-lanes/`, so `execution-lanes-git-verbs.test.ts`
 * scans every string literal here for forbidden Git tokens (`--force`, `-f`, `reset`, `rebase`,
 * `stash`, `push`, `checkout`, `clean`, `--hard`). None of those tokens appear here.
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import {
  LANE_PAGE_LIMIT_MAX,
  LIVE_LANE_STATES,
  type IntegrationRequestView,
  type IntegrationState,
  type LaneRefusalReason,
  type LaneState,
  type LaneView
} from '../../contracts/execution-lanes';
import { LaneGitError } from './git-runner';
import type { LaneService } from './lane-service';

/**
 * Raised before Run admission when `schegent.lanes.enabled` is `true` and provisioning fails or
 * refuses. Prevents any silent fallback to the primary working tree (`F10-FR-17`).
 */
export class IsolatedLaneProvisionRefusedError extends Error {
  public readonly refusalReason: LaneRefusalReason;

  public constructor(reason: LaneRefusalReason) {
    super(`isolated lane provisioning refused: ${reason}`);
    this.name = 'IsolatedLaneProvisionRefusedError';
    this.refusalReason = reason;
  }
}

/**
 * Raised when a Run bound to an isolated lane cannot resolve its contained lane root at dispatch
 * or checkpoint time (`F10-FR-04`, `F10-FR-17`).
 */
export class IsolatedLaneRootUnavailableError extends Error {
  public constructor(public readonly laneId: string) {
    super(`isolated lane execution root unavailable: ${laneId}`);
    this.name = 'IsolatedLaneRootUnavailableError';
  }
}

export interface ProvisionedRunLaneBinding {
  readonly laneId: string;
  readonly laneRootRef: string;
  readonly sourceCommit: string;
}

export interface RunLaneCoordinatorDeps {
  readonly getLaneService: () => LaneService | null;
  readonly isLanesEnabled: () => boolean;
  readonly primaryWorkspaceRoot: string;
  readonly dependencyRecipe?: string;
}

const OPEN_REQUEST_STATES_LIST: readonly IntegrationState[] = Object.freeze([
  'queued',
  'verifying',
  'awaiting-review',
  'landing',
  'blocked',
  'uncertain'
]);

const CANCELABLE_ON_ABORT_STATES = new Set<IntegrationState>(['queued', 'awaiting-review', 'blocked']);

const CACHEABLE_LANE_STATES: readonly LaneState[] = Object.freeze([
  ...LIVE_LANE_STATES,
  'completed',
  'retained'
]);

function listAllLanes(service: LaneService, states?: readonly LaneState[]): readonly LaneView[] {
  const items: LaneView[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = service.listLanes({
      limit: LANE_PAGE_LIMIT_MAX,
      ...(cursor === undefined ? {} : { cursor }),
      ...(states === undefined ? {} : { states })
    });
    if (!page.ok) break;
    items.push(...page.value.items);
    if (page.value.nextCursor === null || page.value.nextCursor === cursor) break;
    cursor = page.value.nextCursor;
  }
  return items;
}

function listAllRequests(
  service: LaneService,
  filter: { readonly laneId?: string; readonly states?: readonly IntegrationState[] } = {}
): readonly IntegrationRequestView[] {
  const items: IntegrationRequestView[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = service.listRequests({
      limit: LANE_PAGE_LIMIT_MAX,
      ...(cursor === undefined ? {} : { cursor }),
      ...(filter.laneId === undefined ? {} : { laneId: filter.laneId }),
      ...(filter.states === undefined ? {} : { states: filter.states })
    });
    if (!page.ok) break;
    items.push(...page.value.items);
    if (page.value.nextCursor === null || page.value.nextCursor === cursor) break;
    cursor = page.value.nextCursor;
  }
  return items;
}

export interface RunLaneCoordinator {
  provisionForRun(
    rootExecutionId: string,
    aliasRunId?: string
  ): Promise<ProvisionedRunLaneBinding | null>;
  resolveExecutionRoot(params: {
    readonly runId: string;
    readonly laneId?: string | undefined;
    readonly laneRootRef?: string | undefined;
  }): Promise<string>;
  resolveExecutionRootSyncOrCached(runId: string): string;
  resolveLaneIdForRun(runId: string): string | null;
  onRunPaused(laneId: string | undefined): void;
  onRunResumed(runId: string): void;
  onRunTerminal(params: {
    readonly runId: string;
    readonly laneId?: string | undefined;
    readonly status: 'completed' | 'failed' | 'canceled';
  }): Promise<void>;
  getProtectedRunIds(): ReadonlySet<string>;
  refreshCacheFromStore(): Promise<void>;
}

const MAX_CACHED_LANE_ROOTS = 256;

function rootRefOf(lane: Pick<LaneView, 'workspaceId' | 'laneId'>): string {
  return `lanes/${lane.workspaceId}/${lane.laneId}`;
}

/**
 * Maps a thrown Git or storage error from `freezeCandidate` to a bounded code without reading
 * error messages (which may contain paths or stderr; docs/hard-rules.md rule 22).
 */
function classifyFreezeThrownError(error: unknown): string {
  if (error instanceof LaneGitError) {
    return `git-${error.operation}-${error.code}`;
  }
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      return `storage-${code}`;
    }
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) {
      const lower = name.toLowerCase();
      if (lower.includes('sqlite') || lower.includes('store') || lower.includes('storage')) {
        return `storage-${name}`;
      }
      return `error-${name}`;
    }
  }
  return 'unexpected-error';
}

export function createRunLaneCoordinator(deps: RunLaneCoordinatorDeps): RunLaneCoordinator {
  const rootByLaneId = new Map<string, string>();
  const laneIdByRunId = new Map<string, string>();

  const rememberRunLaneId = (rootExecutionId: string, laneId: string): void => {
    if (!laneIdByRunId.has(rootExecutionId) && laneIdByRunId.size >= MAX_CACHED_LANE_ROOTS) {
      const oldestRun = laneIdByRunId.keys().next().value;
      if (oldestRun !== undefined) laneIdByRunId.delete(oldestRun);
    }
    laneIdByRunId.set(rootExecutionId, laneId);
  };

  const rememberLaneRoot = (laneId: string, rootExecutionId: string, resolvedRoot: string): void => {
    if (!rootByLaneId.has(laneId) && rootByLaneId.size >= MAX_CACHED_LANE_ROOTS) {
      const oldest = rootByLaneId.keys().next().value;
      if (oldest !== undefined) rootByLaneId.delete(oldest);
    }
    rootByLaneId.set(laneId, resolvedRoot);
    rememberRunLaneId(rootExecutionId, laneId);
  };

  const findLaneForRun = (service: LaneService, runId: string, explicitLaneId?: string): LaneView | null => {
    const targetLaneId = explicitLaneId ?? laneIdByRunId.get(runId);
    if (targetLaneId !== undefined) {
      const direct = service.getLane({ laneId: targetLaneId });
      if (direct.ok) return direct.value;
    }
    // Check live lanes first (bounded by liveLaneCap) so historical terminal lanes cannot shadow
    // or crowd out an active/paused/preparing lane, then paginate all states via nextCursor.
    let matched: LaneView | null = null;
    for (const item of listAllLanes(service, LIVE_LANE_STATES)) {
      if (item.rootExecutionId === runId) matched = item;
    }
    if (matched === null) {
      for (const item of listAllLanes(service)) {
        if (item.rootExecutionId === runId) matched = item;
      }
    }
    if (matched !== null) {
      rememberRunLaneId(runId, matched.laneId);
    }
    return matched;
  };

  const cancelPendingRequestsForLane = (service: LaneService, laneId: string): void => {
    for (const item of listAllRequests(service, { laneId, states: OPEN_REQUEST_STATES_LIST })) {
      if (CANCELABLE_ON_ABORT_STATES.has(item.state)) {
        service.cancelRequest({ requestId: item.requestId });
      }
    }
  };

  return {
    async provisionForRun(
      rootExecutionId: string,
      aliasRunId?: string
    ): Promise<ProvisionedRunLaneBinding | null> {
      if (!deps.isLanesEnabled()) {
        return null;
      }
      const service = deps.getLaneService();
      if (service === null) {
        throw new IsolatedLaneProvisionRefusedError('provisioning-git-failed');
      }
      const existing = findLaneForRun(service, rootExecutionId);
      if (existing !== null && (existing.state === 'active' || existing.state === 'paused')) {
        const existingRef = rootRefOf(existing);
        const existingRoot = await service.resolveLaneRoot(existingRef);
        if (existingRoot === null) {
          throw new IsolatedLaneProvisionRefusedError('lane-state-invalid');
        }
        rememberLaneRoot(existing.laneId, rootExecutionId, existingRoot);
        if (aliasRunId !== undefined && aliasRunId !== rootExecutionId) {
          rememberLaneRoot(existing.laneId, aliasRunId, existingRoot);
        }
        return {
          laneId: existing.laneId,
          laneRootRef: existingRef,
          sourceCommit: existing.sourceCommit
        };
      }
      const provisioned = await service.provisionLane({
        rootExecutionId,
        sourceRevision: 'HEAD',
        dependencyRecipe: deps.dependencyRecipe ?? 'none'
      });
      if (!provisioned.ok) {
        throw new IsolatedLaneProvisionRefusedError(provisioned.refusal.reason);
      }
      const newRef = rootRefOf(provisioned.value);
      const resolvedRoot = await service.resolveLaneRoot(newRef);
      if (resolvedRoot === null) {
        throw new IsolatedLaneProvisionRefusedError('lane-state-invalid');
      }
      rememberLaneRoot(provisioned.value.laneId, rootExecutionId, resolvedRoot);
      if (aliasRunId !== undefined && aliasRunId !== rootExecutionId) {
        rememberLaneRoot(provisioned.value.laneId, aliasRunId, resolvedRoot);
      }
      return {
        laneId: provisioned.value.laneId,
        laneRootRef: newRef,
        sourceCommit: provisioned.value.sourceCommit
      };
    },

    async resolveExecutionRoot(params): Promise<string> {
      const service = deps.getLaneService();
      const knownLaneId =
        params.laneId ??
        laneIdByRunId.get(params.runId) ??
        (service !== null ? findLaneForRun(service, params.runId)?.laneId : undefined);
      if (knownLaneId === undefined && params.laneRootRef === undefined) {
        return deps.primaryWorkspaceRoot;
      }
      if (service === null) {
        throw new IsolatedLaneRootUnavailableError(knownLaneId ?? 'uninitialized-service');
      }
      let rootRef = params.laneRootRef;
      if (rootRef === undefined && knownLaneId !== undefined) {
        const view = service.getLane({ laneId: knownLaneId });
        if (!view.ok) {
          throw new IsolatedLaneRootUnavailableError(knownLaneId);
        }
        rootRef = rootRefOf(view.value);
      }
      if (rootRef === undefined) {
        throw new IsolatedLaneRootUnavailableError(knownLaneId ?? params.runId);
      }
      const resolved = await service.resolveLaneRoot(rootRef);
      if (resolved === null) {
        throw new IsolatedLaneRootUnavailableError(knownLaneId ?? params.runId);
      }
      if (knownLaneId !== undefined) {
        rememberLaneRoot(knownLaneId, params.runId, resolved);
      }
      return resolved;
    },

    resolveExecutionRootSyncOrCached(runId: string): string {
      const laneId = laneIdByRunId.get(runId);
      if (laneId !== undefined) {
        const cached = rootByLaneId.get(laneId);
        if (cached !== undefined) return cached;
      }
      return deps.primaryWorkspaceRoot;
    },

    resolveLaneIdForRun(runId: string): string | null {
      const cached = laneIdByRunId.get(runId);
      if (cached !== undefined) return cached;
      const service = deps.getLaneService();
      if (service === null) return null;
      return findLaneForRun(service, runId)?.laneId ?? null;
    },

    onRunPaused(laneId: string | undefined): void {
      if (laneId === undefined) return;
      const service = deps.getLaneService();
      if (service === null) return;
      cancelPendingRequestsForLane(service, laneId);
      service.pauseLane({ laneId });
    },

    onRunResumed(runId: string): void {
      const service = deps.getLaneService();
      if (service === null) return;
      const lane = findLaneForRun(service, runId);
      if (lane === null) return;
      service.resumeLane({ laneId: lane.laneId });
    },

    async onRunTerminal(params): Promise<void> {
      const service = deps.getLaneService();
      if (service === null) return;
      const lane = findLaneForRun(service, params.runId, params.laneId);
      if (lane === null) return;
      if (params.status === 'completed') {
        if (lane.state === 'active') {
          let freezeFailureCode: string | null = null;
          try {
            const frozen = await service.freezeCandidate({ laneId: lane.laneId });
            if (!frozen.ok && frozen.refusal.reason !== 'candidate-empty') {
              freezeFailureCode = frozen.refusal.reason;
            }
          } catch (error) {
            freezeFailureCode = classifyFreezeThrownError(error);
          }
          if (freezeFailureCode !== null) {
            try {
              service.recordFreezeFailure({ laneId: lane.laneId, reason: freezeFailureCode });
            } catch {
              // Storage also failed while persisting state_reason; keep the lane active so its
              // worktree remains live and retryable rather than closing to completed.
            }
            return;
          }
        }
        if (lane.state === 'active' || lane.state === 'paused') {
          service.completeLane({ laneId: lane.laneId });
        }
      } else {
        cancelPendingRequestsForLane(service, lane.laneId);
        if (lane.state === 'active' || lane.state === 'paused') {
          service.completeLane({ laneId: lane.laneId });
        }
      }
    },

    getProtectedRunIds(): ReadonlySet<string> {
      const out = new Set<string>();
      const service = deps.getLaneService();
      if (service === null) return out;
      const openReqLaneIds = new Set<string>();
      for (const req of listAllRequests(service, { states: OPEN_REQUEST_STATES_LIST })) {
        openReqLaneIds.add(req.laneId);
      }
      for (const lane of listAllLanes(service)) {
        const isLive =
          lane.state === 'preparing' || lane.state === 'active' || lane.state === 'paused';
        if (
          isLive ||
          lane.pinned ||
          lane.state === 'retained' ||
          lane.currentCandidate !== null ||
          openReqLaneIds.has(lane.laneId)
        ) {
          out.add(lane.rootExecutionId);
        }
      }
      return out;
    },

    async refreshCacheFromStore(): Promise<void> {
      const service = deps.getLaneService();
      if (service === null) return;
      for (const lane of listAllLanes(service, CACHEABLE_LANE_STATES)) {
        rememberRunLaneId(lane.rootExecutionId, lane.laneId);
        if (lane.state === 'active' || lane.state === 'paused' || lane.state === 'completed' || lane.state === 'retained') {
          const resolved = await service.resolveLaneRoot(rootRefOf(lane));
          if (resolved !== null) {
            rememberLaneRoot(lane.laneId, lane.rootExecutionId, resolved);
          }
        }
      }
    }
  };
}
