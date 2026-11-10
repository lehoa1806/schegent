/**
 * FR-R6-F10 (contracts/execution-lanes.md §5): the execution-lane service.
 *
 * `open` validates the host's configuration, then claims the next ownership generation for the
 * workspace (research R7). Every operation re-checks that generation in its first transaction, so a
 * service opened by a newer host supersedes this one.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import * as path from 'node:path';
import {
  LANE_CAP_DEFAULT,
  LANE_CAP_MAX,
  laneOk,
  laneRefused,
  PROVISIONING_DEADLINE_DEFAULT_MS,
  PROVISIONING_DEADLINE_MAX_MS,
  PROVISIONING_DEADLINE_MIN_MS,
  type CandidateView,
  type CleanupReport,
  type IntegrationRequestView,
  type IntegrationState,
  type LanePage,
  type LaneResult,
  type LaneState,
  type LaneView,
  type ReceiptView,
  type ReconcileReport,
  type VerificationCheckView
} from '../../contracts/execution-lanes';
import { resolveContainedTarget } from '../../lib/path-containment';
import type { NodeSqliteConnection } from '../sqlite-store';
import type { LaneGitRunner } from './git-runner';
import { freezeCandidate } from './candidate-freezer';
import { createIntegrationRequest, type RequestIntegrationInput } from './integration-requests';
import { IntegrationStore, type RequestRecord } from './integration-store';
import { checkViewOf, receiptViewOf, requestViewOf } from './integration-views';
import { landRequest, type LandingContext } from './landing';
import { cleanupLanes, type LaneRootLocation } from './lane-cleanup';
import {
  completeLane,
  pauseLane,
  releaseLane,
  resumeLane,
  setLanePinned,
  type LifecycleContext,
  type ReleaseDisposition
} from './lane-lifecycle';
import { parseFrozenProfile } from './lane-input-rules';
import { provisionLane, type ProvisionRequest } from './lane-provisioner';
import { reconcileLanes } from './lane-reconciler';
import { LaneStore } from './lane-store';
import { candidateViewOf, LANES_DIRECTORY, LaneStoreCorruptError, laneViewOf, type CandidateRecord, type LaneRecord } from './lane-store-rows';
import { probeProvisioning } from './provisioning-probe';
import { cancelRequest } from './request-cancel';
import { approveRequest, type ApproveRequestInput } from './review-receipts';
import { createSpawnCheck, runVerification, type SpawnCheck, type VerificationOutcome } from './verification-runner';

export { LANES_DIRECTORY };

/** The page size of `listLanes` when the caller names none; the port bounds it at 200. */
export const LANE_LIST_DEFAULT_LIMIT = 50;

const LANE_CAP_MIN = 1;
/** Research R1: the workspace segment of a lane root; never `.`, `..` or a separator. */
export const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ROOT_REF_PATTERN = /^lanes\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[0-9a-f]{32}$/;

export interface LaneServiceDeps {
  /** The shared connection, already migrated. */
  readonly connection: NodeSqliteConnection;
  readonly workspaceRoot: string;
  readonly storageDir: string;
  readonly workspaceId: string;
  /** An integer from 1 to 20; default 1 (NFR-001). */
  readonly liveLaneCap?: number;
  readonly git: LaneGitRunner;
  /** Milliseconds since the epoch. */
  readonly clock: () => number;
  /** `size` random bytes; ids are drawn from it. */
  readonly random: (size: number) => Buffer;
  /** From 1,000 to 600,000 ms; default 120,000 (research R10). */
  readonly provisioningDeadlineMs?: number;
  /** The verification process port; default `createSpawnCheck()` (research R9). */
  readonly spawnCheck?: SpawnCheck;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export class LaneService {
  public readonly liveLaneCap: number;
  public readonly provisioningDeadlineMs: number;
  public readonly generation: number;
  protected readonly lanes: LaneStore;
  protected readonly integrations: IntegrationStore;
  protected readonly spawnCheck: SpawnCheck;
  /** Lanes with a Git-mutating operation in flight in this host; a second one refuses `lane-busy`. */
  private readonly lanesInFlight = new Set<string>();

  private constructor(
    protected readonly deps: LaneServiceDeps,
    settings: { liveLaneCap: number; provisioningDeadlineMs: number }
  ) {
    this.liveLaneCap = settings.liveLaneCap;
    this.provisioningDeadlineMs = settings.provisioningDeadlineMs;
    this.lanes = new LaneStore(deps.connection);
    this.integrations = new IntegrationStore(deps.connection);
    this.spawnCheck = deps.spawnCheck ?? createSpawnCheck();
    this.generation = this.lanes.claimGeneration(deps.workspaceId, this.nowIso());
  }

  /**
   * Throws `RangeError` on a malformed workspace id, a workspace root or storage directory that is
   * not absolute, or a cap or deadline out of range: a host defect, not operator input. A relative
   * path would be checked for containment from the process directory while Git acts from the
   * workspace root (review S7).
   */
  public static open(deps: LaneServiceDeps): LaneService {
    if (!WORKSPACE_ID_PATTERN.test(deps.workspaceId)) {
      throw new RangeError('workspaceId must match the lane workspace pattern (research R1)');
    }
    if (!path.isAbsolute(deps.workspaceRoot) || !path.isAbsolute(deps.storageDir)) {
      throw new RangeError('workspaceRoot and storageDir must be absolute paths');
    }
    const liveLaneCap = boundedInteger(deps.liveLaneCap, LANE_CAP_DEFAULT, LANE_CAP_MIN, LANE_CAP_MAX, 'liveLaneCap');
    const provisioningDeadlineMs = boundedInteger(
      deps.provisioningDeadlineMs,
      PROVISIONING_DEADLINE_DEFAULT_MS,
      PROVISIONING_DEADLINE_MIN_MS,
      PROVISIONING_DEADLINE_MAX_MS,
      'provisioningDeadlineMs'
    );
    return new LaneService(deps, { liveLaneCap, provisioningDeadlineMs });
  }

  /**
   * The real path of an existing lane root, proven inside `<storageDir>/lanes`. `null` when the
   * reference is malformed, the root is absent, or it resolves anywhere else. Internal to the host;
   * never part of the port (contract §4).
   */
  public async resolveLaneRoot(rootRef: string): Promise<string | null> {
    const located = await this.locateLaneRoot(rootRef);
    return located.kind === 'contained' ? located.root : null;
  }

  /**
   * Where a lane root is (research R12, conditions 5 and 6). A malformed reference, or one that
   * cannot be resolved, counts as `not-contained`: cleanup keeps such a lane.
   */
  public async locateLaneRoot(rootRef: string): Promise<LaneRootLocation> {
    if (!ROOT_REF_PATTERN.test(rootRef)) return { kind: 'not-contained' };
    const lanesDir = path.join(this.deps.storageDir, LANES_DIRECTORY);
    const verdict = await resolveContainedTarget(path.join(this.deps.storageDir, rootRef), [lanesDir]);
    if (verdict.outcome === 'contained') return { kind: 'contained', root: verdict.resolved };
    return verdict.outcome === 'absent' ? { kind: 'absent' } : { kind: 'not-contained' };
  }

  /** Contract §5: a lane in `active`, or the first refusal. */
  public async provisionLane(request: ProvisionRequest): Promise<LaneResult<LaneView>> {
    const result = await provisionLane(
      {
        store: this.lanes,
        git: this.deps.git,
        workspaceRoot: this.deps.workspaceRoot,
        storageDir: this.deps.storageDir,
        workspaceId: this.deps.workspaceId,
        generation: this.generation,
        liveLaneCap: this.liveLaneCap,
        deadlineMs: this.provisioningDeadlineMs,
        clock: this.deps.clock,
        random: this.deps.random,
        probe: (probeRequest, remainingMs) => probeProvisioning(this.deps, probeRequest, remainingMs)
      },
      request
    );
    return result.ok ? laneOk(this.viewOf(result.value)) : result;
  }

  public getLane(input: { readonly laneId: string }): LaneResult<LaneView> {
    const lane = this.lanes.getLane(this.deps.workspaceId, input.laneId);
    return lane === null ? laneRefused('lane-not-found') : laneOk(this.viewOf(lane));
  }

  public listLanes(input: {
    readonly limit?: number;
    readonly cursor?: string;
    readonly states?: readonly LaneState[];
  }): LaneResult<LanePage<LaneView>> {
    const page = this.lanes.listLanes(this.deps.workspaceId, {
      limit: input.limit ?? LANE_LIST_DEFAULT_LIMIT,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.states === undefined ? {} : { states: input.states })
    });
    if (!page.ok) return page;
    return laneOk({ items: page.value.items.map((lane) => this.viewOf(lane)), nextCursor: page.value.nextCursor });
  }

  /**
   * Contract §5: freezes an `active` lane's work into its next candidate. Throws `LaneGitError`
   * when a Git step fails for a reason no refusal names; the caller maps it.
   */
  public async freezeCandidate(input: { readonly laneId: string }): Promise<LaneResult<CandidateView>> {
    const lane = this.lanes.getLane(this.deps.workspaceId, input.laneId);
    if (lane === null) return laneRefused('lane-not-found');
    if (lane.state !== 'active') return laneRefused('lane-state-invalid');
    // The slot is taken before the first await, so a second call cannot slip in behind it.
    const result = await this.exclusively<CandidateRecord>(lane.laneId, async () => {
      const root = await this.resolveLaneRoot(lane.rootRef);
      if (root === null) return laneRefused('lane-state-invalid');
      return freezeCandidate(
        {
          lanes: this.lanes,
          integrations: this.integrations,
          git: this.deps.git,
          workspaceId: this.deps.workspaceId,
          generation: this.generation,
          clock: this.deps.clock,
          random: this.deps.random
        },
        lane,
        root
      );
    });
    return result.ok ? laneOk(candidateViewOf(result.value)) : result;
  }

  /** Contract §5: a `queued` request for the lane's current candidate. */
  public async requestIntegration(input: RequestIntegrationInput): Promise<LaneResult<IntegrationRequestView>> {
    const lane = this.lanes.getLane(this.deps.workspaceId, input.laneId);
    if (lane === null) return laneRefused('lane-not-found');
    const result = await this.exclusively(lane.laneId, () =>
      createIntegrationRequest(
        {
          lanes: this.lanes,
          integrations: this.integrations,
          git: this.deps.git,
          workspaceRoot: this.deps.workspaceRoot,
          workspaceId: this.deps.workspaceId,
          generation: this.generation,
          clock: this.deps.clock,
          random: this.deps.random
        },
        lane,
        input
      )
    );
    return result.ok ? laneOk(this.requestView(result.value)) : result;
  }

  /**
   * Contract §5: runs a `queued` request's frozen profile in its lane. The request ends in
   * `awaiting-review` or `blocked`; when Git fails mid-run it goes back to `queued` and the error
   * is rethrown.
   */
  public async verifyRequest(input: { readonly requestId: string }): Promise<LaneResult<IntegrationRequestView>> {
    const request = this.integrations.getRequest(this.deps.workspaceId, input.requestId);
    if (request === null) return laneRefused('request-not-found');
    if (request.state !== 'queued') return laneRefused('request-state-invalid');
    const lane = this.lanes.getLane(this.deps.workspaceId, request.laneId);
    if (lane === null) throw new LaneStoreCorruptError('lane_id');
    const profile = parseFrozenProfile(request.profileJson);
    if (profile === null) throw new LaneStoreCorruptError('profile_json');

    const result = await this.exclusively(lane.laneId, async () => {
      const started = this.moveRequest(request.requestId, ['queued'], 'verifying', null, true);
      if (!started.ok) return started;
      const outcome = await this.verificationOutcome(started.value, lane, profile);
      return this.moveRequest(request.requestId, ['verifying'], outcome.state, outcome.reason);
    });
    return result.ok ? laneOk(this.requestView(result.value)) : result;
  }

  /** Contract §5: the checks of the request's latest verification attempt. */
  public getVerification(input: { readonly requestId: string }): LaneResult<readonly VerificationCheckView[]> {
    const request = this.integrations.getRequest(this.deps.workspaceId, input.requestId);
    if (request === null) return laneRefused('request-not-found');
    return laneOk(this.integrations.listVerificationResults(request.requestId, request.verificationAttempt).map(checkViewOf));
  }

  /** Contract §5: one request, or `request-not-found`. */
  public getRequest(input: { readonly requestId: string }): LaneResult<IntegrationRequestView> {
    const request = this.integrations.getRequest(this.deps.workspaceId, input.requestId);
    return request === null ? laneRefused('request-not-found') : laneOk(this.requestView(request));
  }

  /**
   * Contract §5: requests oldest first, optionally of one lane or in some states. An undecodable
   * cursor refuses `invalid-input`.
   */
  public listRequests(input: {
    readonly limit?: number;
    readonly cursor?: string;
    readonly laneId?: string;
    readonly states?: readonly IntegrationState[];
  }): LaneResult<LanePage<IntegrationRequestView>> {
    const page = this.integrations.listRequests(this.deps.workspaceId, {
      limit: input.limit ?? LANE_LIST_DEFAULT_LIMIT,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.laneId === undefined ? {} : { laneId: input.laneId }),
      ...(input.states === undefined ? {} : { states: input.states })
    });
    if (!page.ok) return page;
    return laneOk({ items: page.value.items.map((request) => this.requestView(request)), nextCursor: page.value.nextCursor });
  }

  /**
   * Contract §5 (data-model, integration lifecycle): cancels a `queued`, `awaiting-review`,
   * `blocked` or `uncertain` request; the last journals `acknowledged-uncertain`.
   */
  public cancelRequest(input: { readonly requestId: string }): LaneResult<IntegrationRequestView> {
    const result = cancelRequest(
      {
        lanes: this.lanes,
        integrations: this.integrations,
        workspaceId: this.deps.workspaceId,
        generation: this.generation,
        clock: this.deps.clock,
        random: this.deps.random
      },
      input.requestId
    );
    return result.ok ? laneOk(this.requestView(result.value)) : result;
  }

  /** Contract §5: the receipt for an `awaiting-review` request whose verified facts the operator names. */
  public approveRequest(input: ApproveRequestInput): LaneResult<ReceiptView> {
    const result = approveRequest(
      {
        lanes: this.lanes,
        integrations: this.integrations,
        workspaceId: this.deps.workspaceId,
        generation: this.generation,
        clock: this.deps.clock,
        random: this.deps.random
      },
      input
    );
    return result.ok ? laneOk(receiptViewOf(result.value)) : result;
  }

  /**
   * Contract §5 and §6: lands an approved request. `landed` and `uncertain` come back as the view;
   * every blocked outcome is a refusal carrying the commits.
   */
  public async landRequest(input: { readonly requestId: string }): Promise<LaneResult<IntegrationRequestView>> {
    const request = this.integrations.getRequest(this.deps.workspaceId, input.requestId);
    if (request === null) return laneRefused('request-not-found');
    const result = await this.exclusively(request.laneId, () => landRequest(this.landingContext(), request));
    return result.ok ? laneOk(this.requestView(result.value)) : result;
  }

  /** Contract §5 lifecycle (data-model, lane lifecycle): `active` to `paused`. */
  public pauseLane(input: { readonly laneId: string }): LaneResult<LaneView> {
    return this.viewResult(pauseLane(this.lifecycleContext(), input.laneId));
  }

  /** `paused` to `active`. */
  public resumeLane(input: { readonly laneId: string }): LaneResult<LaneView> {
    return this.viewResult(resumeLane(this.lifecycleContext(), input.laneId));
  }

  /** `active` or `paused` to `completed`; `lane-busy` while a request of the lane verifies or lands. */
  public completeLane(input: { readonly laneId: string }): LaneResult<LaneView> {
    return this.viewResult(completeLane(this.lifecycleContext(), input.laneId));
  }

  /** `retain`: `completed` to `retained`; `eligible`: `completed`, `retained` or `preparation-failed` to `cleanup-eligible`. */
  public releaseLane(input: { readonly laneId: string; readonly disposition: ReleaseDisposition }): LaneResult<LaneView> {
    return this.viewResult(releaseLane(this.lifecycleContext(), input.laneId, input.disposition));
  }

  /** Pins or unpins a lane; its state does not change. A pinned lane is never cleaned up. */
  public setLanePinned(input: { readonly laneId: string; readonly pinned: boolean }): LaneResult<LaneView> {
    return this.viewResult(setLanePinned(this.lifecycleContext(), input.laneId, input.pinned));
  }

  /**
   * Contract §5 (research R12): removes the worktrees of the named lanes, or of every
   * `cleanup-eligible` lane, that meet every condition, and reports the rest kept with the first
   * failing one. Refuses only `ownership-superseded`; throws `LaneGitError` on a Git failure.
   */
  public async cleanupLanes(input: { readonly laneIds?: readonly string[] }): Promise<LaneResult<CleanupReport>> {
    return cleanupLanes(
      {
        ...this.landingContext(),
        locateLaneRoot: (rootRef) => this.locateLaneRoot(rootRef),
        exclusively: (laneId, work) => this.exclusively(laneId, work)
      },
      input.laneIds
    );
  }

  /**
   * Contract §5: settles what an earlier host left mid-operation (spec US5). Refuses only
   * `ownership-superseded`; throws `LaneGitError` when the worktree registry cannot be read.
   */
  public async reconcile(): Promise<LaneResult<ReconcileReport>> {
    return reconcileLanes({
      ...this.landingContext(),
      resolveLaneRoot: (rootRef) => this.resolveLaneRoot(rootRef),
      inFlight: (laneId) => this.lanesInFlight.has(laneId)
    });
  }

  protected landingContext(): LandingContext {
    return {
      lanes: this.lanes,
      integrations: this.integrations,
      git: this.deps.git,
      workspaceRoot: this.deps.workspaceRoot,
      storageDir: this.deps.storageDir,
      workspaceId: this.deps.workspaceId,
      generation: this.generation,
      clock: this.deps.clock,
      random: this.deps.random
    };
  }

  private async verificationOutcome(
    request: RequestRecord,
    lane: LaneRecord,
    profile: NonNullable<ReturnType<typeof parseFrozenProfile>>
  ): Promise<VerificationOutcome> {
    const root = await this.resolveLaneRoot(lane.rootRef);
    if (root === null) return { state: 'blocked', reason: 'verification-workspace-changed' };
    try {
      return await runVerification(
        {
          integrations: this.integrations,
          git: this.deps.git,
          spawnCheck: this.spawnCheck,
          clock: this.deps.clock,
          random: this.deps.random
        },
        request,
        profile,
        root
      );
    } catch (error) {
      this.moveRequest(request.requestId, ['verifying'], 'queued', null);
      throw error;
    }
  }

  /** A fenced request transition. */
  protected moveRequest(
    requestId: string,
    from: readonly RequestRecord['state'][],
    to: RequestRecord['state'],
    reason: string | null,
    startAttempt = false
  ): LaneResult<RequestRecord> {
    return this.lanes.fenced(this.deps.workspaceId, this.generation, () =>
      this.integrations.transitionRequest(this.deps.workspaceId, requestId, from, to, {
        reason,
        now: this.nowIso(),
        generation: this.generation,
        startAttempt
      })
    );
  }

  protected requestView(request: RequestRecord): IntegrationRequestView {
    return requestViewOf(request, this.integrations.getReceipt(request.requestId));
  }

  /** Runs `work` holding the lane's in-host operation slot, or refuses `lane-busy`. */
  protected async exclusively<T>(laneId: string, work: () => Promise<LaneResult<T>>): Promise<LaneResult<T>> {
    if (this.lanesInFlight.has(laneId)) return laneRefused('lane-busy');
    this.lanesInFlight.add(laneId);
    try {
      return await work();
    } finally {
      this.lanesInFlight.delete(laneId);
    }
  }

  protected lifecycleContext(): LifecycleContext {
    return {
      lanes: this.lanes,
      integrations: this.integrations,
      workspaceId: this.deps.workspaceId,
      generation: this.generation,
      now: () => this.nowIso(),
      inFlight: (laneId) => this.lanesInFlight.has(laneId)
    };
  }

  protected viewResult(result: LaneResult<LaneRecord>): LaneResult<LaneView> {
    return result.ok ? laneOk(this.viewOf(result.value)) : result;
  }

  protected viewOf(lane: LaneRecord): LaneView {
    return laneViewOf(lane, this.lanes.currentCandidate(lane.laneId));
  }

  protected nowIso(): string {
    return new Date(this.deps.clock()).toISOString();
  }
}
