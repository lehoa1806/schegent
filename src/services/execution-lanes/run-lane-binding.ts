/**
 * FR-R6-F10 (F10-FR-01..08, F10-FR-15, F10-FR-17, F10-FR-19):
 * Per-Run isolated lane admission, execution-root resolution, lifecycle synchronization,
 * and retention-pin discovery.
 *
 * NOTE: Lives under `src/services/execution-lanes/`, so `execution-lanes-git-verbs.test.ts`
 * scans every string literal here for forbidden Git tokens (`--force`, `-f`, `reset`, `rebase`,
 * `stash`, `push`, `checkout`, `clean`, `--hard`). None of those tokens appear here.
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import type { LaneRefusalReason, LaneView } from '../../contracts/execution-lanes';
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

const OPEN_REQUEST_STATES = new Set([
  'queued',
  'verifying',
  'awaiting-review',
  'landing',
  'blocked',
  'uncertain'
]);

const CANCELABLE_ON_ABORT_STATES = new Set(['queued', 'awaiting-review', 'blocked']);

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

export function createRunLaneCoordinator(deps: RunLaneCoordinatorDeps): RunLaneCoordinator {
  const rootByLaneId = new Map<string, string>();
  const laneIdByRunId = new Map<string, string>();

  const rememberLaneRoot = (laneId: string, rootExecutionId: string, resolvedRoot: string): void => {
    if (!rootByLaneId.has(laneId) && rootByLaneId.size >= MAX_CACHED_LANE_ROOTS) {
      const oldest = rootByLaneId.keys().next().value;
      if (oldest !== undefined) rootByLaneId.delete(oldest);
    }
    rootByLaneId.set(laneId, resolvedRoot);
    if (!laneIdByRunId.has(rootExecutionId) && laneIdByRunId.size >= MAX_CACHED_LANE_ROOTS) {
      const oldestRun = laneIdByRunId.keys().next().value;
      if (oldestRun !== undefined) laneIdByRunId.delete(oldestRun);
    }
    laneIdByRunId.set(rootExecutionId, laneId);
  };

  const findLaneForRun = (service: LaneService, runId: string, explicitLaneId?: string): LaneView | null => {
    const targetLaneId = explicitLaneId ?? laneIdByRunId.get(runId);
    if (targetLaneId !== undefined) {
      const direct = service.getLane({ laneId: targetLaneId });
      if (direct.ok) return direct.value;
    }
    const page = service.listLanes({ limit: 200 });
    if (!page.ok) return null;
    const matched = page.value.items.find((item) => item.rootExecutionId === runId) ?? null;
    if (matched !== null) {
      laneIdByRunId.set(runId, matched.laneId);
    }
    return matched;
  };

  const cancelPendingRequestsForLane = (service: LaneService, laneId: string): void => {
    const reqs = service.listRequests({ laneId, limit: 200 });
    if (!reqs.ok) return;
    for (const item of reqs.value.items) {
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
          try {
            await service.freezeCandidate({ laneId: lane.laneId });
          } catch {
            // Candidate freeze is best-effort on auto-completion; operator can freeze explicitly.
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
      const lanes = service.listLanes({ limit: 200 });
      if (!lanes.ok) return out;
      const openReqLaneIds = new Set<string>();
      const reqs = service.listRequests({ limit: 200 });
      if (reqs.ok) {
        for (const req of reqs.value.items) {
          if (OPEN_REQUEST_STATES.has(req.state)) {
            openReqLaneIds.add(req.laneId);
          }
        }
      }
      for (const lane of lanes.value.items) {
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
      const lanes = service.listLanes({ limit: 200 });
      if (!lanes.ok) return;
      for (const lane of lanes.value.items) {
        laneIdByRunId.set(lane.rootExecutionId, lane.laneId);
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
