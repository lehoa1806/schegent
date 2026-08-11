// GuardedRunService — single guarded entry point for run-starting and
// queue-mutating command paths (FR-006/FR-007/FR-008/FR-009/FR-010).
//
// Centralizes lock checks, primary-window detection, and validation so no
// command can bypass them. Direct calls to queue.enqueue() or
// controller.startNew() from command handlers are forbidden once US2 is
// fully landed; all paths must delegate through this service.
//
// See `specs/007-principal-review-remediation/contracts/guarded-run-service.md`.

import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import type { QueueManager } from '../queue/queue-manager';
import type { SchegentWorkflowController } from '../controller/workflow-controller';
import type { WorkspaceLockManager } from '../state/lock';
import { STALENESS_THRESHOLD_MS } from '../state/lock';
import type { SanitizedLogger } from '../lib/logger';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type {
  FeatureRequest,
  FeatureRequestFailure,
  FeatureRequestRerun,
  QueueLifecycle,
  ScheduledStartSource
} from '../queue/feature-request';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { FrozenRunPlan } from '../contracts/run-request';
import type { PipelineCatalog } from '../config/pipeline-config';
import { phaseRunnerPolicyError } from '../config/phase-runner-policy';
import type { ScheduledStartCoordinator } from './scheduled-start-coordinator';
import type { EnqueueStartIntent } from '../contracts/sidebar-ipc';
import {
  DEFAULT_BACKEND,
  type BackendRunnerKind
} from '../runner/backend-runner-factory';

// Feature 065 — `scheduleOrEnqueue` accepts an optional `startIntent` to
// drive the host policy table (see contracts/sidebar-ipc.diff.md).
// The horizon limit per FR-009c.
export const SCHEDULED_START_MAX_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Feature 065 — typed error thrown by `scheduleOrEnqueue` when a programmatic
 * caller requests `scheduledStartAt > now + 7d`. Programmatic callers can
 * pattern-match by class to surface a user-facing rejection.
 */
export class ScheduledStartHorizonError extends Error {
  public readonly requestedScheduledStartAt: number;
  public readonly callerId?: string;
  constructor(requestedScheduledStartAt: number, callerId?: string) {
    super('scheduled-start-horizon-exceeded');
    this.name = 'ScheduledStartHorizonError';
    this.requestedScheduledStartAt = requestedScheduledStartAt;
    if (callerId !== undefined) this.callerId = callerId;
  }
}

export type GuardedVia =
  | 'command-palette'
  | 'webview'
  | 'dashboard-submit'
  | 'auto-drain'
  | 'rerun-from-history'
  | 'retry-active';

export interface GuardedScheduleRequest {
  description: string;
  scheduledAt: number;
  via: GuardedVia;
  pipelineId?: string | null;
  queueId?: string | null;
  position?: number | null;
  rerun?: FeatureRequestRerun | null;
  // Feature 065 — optional start-mode intent (additive). Omission is
  // valid; the host's policy table routes it to the chooser default or
  // the warn-level automation default. See sidebar-ipc.diff.md.
  startIntent?: EnqueueStartIntent;
  // Feature 065 — `'automation'` callers without an explicit `startIntent`
  // are detected here so the warn-level `automation-enqueue-no-start-mode`
  // audit event can carry a `callerId`. Human-facing flows pass `'human'`
  // or leave this undefined.
  callerKind?: 'human' | 'automation';
  callerId?: string;
  // Feature 087 (T042, US3, FR-029/FR-030) — a composed Pipeline run arrives
  // here already validated and frozen by `validateRunRequest()`. The service
  // does not construct, inspect, or re-expand the plan; it carries it into the
  // one durable write the enqueue performs, so the item that lands in the queue
  // is the definition the operator submitted against. Omission is valid and
  // leaves every pre-existing path byte-identical.
  runPlan?: FrozenRunPlan;
}

export interface GuardedScheduleResult {
  outcome:
    | 'enqueued'
    | 'rejected-foreign-lock'
    | 'rejected-paused'
    | 'rejected-validation'
    | 'rejected-horizon-exceeded';
  reason?: string;
  queueItemId?: string;
  // Feature 065 — `'now'` when the host coerced or routed to `running`;
  // `'idle-pending'` when the host landed the task in `idle-pending`.
  lifecycleAfter?: QueueLifecycle;
}

export interface GuardedStartRequest {
  description: string;
  startedAt: number;
  via?: GuardedVia;
  featureDir?: string | null;
  pipelineId?: string | null;
  queueId?: string | null;
  position?: number | null;
  rerun?: FeatureRequestRerun | null;
}

export interface GuardedStartResult {
  outcome:
    | 'started'
    | 'rejected-foreign-lock'
    | 'rejected-already-running'
    | 'rejected-validation';
  reason?: string;
  runId?: string;
  feature?: FeatureRequest;
}

export interface GuardedRunServiceDeps {
  readonly lock: WorkspaceLockManager;
  readonly queue: QueueManager;
  readonly controller: Pick<SchegentWorkflowController, 'running' | 'startNew' | 'getCatalog'>;
  readonly logger: SanitizedLogger;
  readonly audit?: Pick<AuditLogWriter, 'append'> | null;
  readonly store: Pick<WorkspaceStateStore, 'getLock' | 'getQueue' | 'updateQueue'>;
  readonly cliPathProvider: (runnerKind?: BackendRunnerKind) => Promise<string> | string;
  readonly defaultRunnerKind?: BackendRunnerKind;
  readonly workspaceRoot: string;
  readonly clock?: () => number;
  /** Optional override for tests; production reads the catalog via the controller. */
  readonly catalogProvider?: () => PipelineCatalog;
  // Feature 065 — coordinator that owns the in-process scheduled-start timer.
  // Optional for backward-compat; when omitted, the policy table falls back
  // to the simpler enqueue-only behavior.
  readonly scheduledStartCoordinator?: Pick<
    ScheduledStartCoordinator,
    'arm' | 'cancel' | 'change'
  >;
}

export class GuardedRunService {
  private readonly deps: GuardedRunServiceDeps;
  private readonly clock: () => number;

  constructor(deps: GuardedRunServiceDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? (() => Date.now());
  }

  public async scheduleOrEnqueue(
    req: GuardedScheduleRequest
  ): Promise<GuardedScheduleResult> {
    const validated = this.validateDescription(req.description);
    if (validated.kind === 'invalid') {
      await this.emitRejection('schedule', 'rejected-validation', validated.reason, req.via);
      return { outcome: 'rejected-validation', reason: validated.reason };
    }

    const rerunCheck = this.validateRerunPair(req.rerun ?? null, req.pipelineId ?? null);
    if (rerunCheck.kind === 'invalid') {
      await this.emitRejection('schedule', 'rejected-validation', rerunCheck.reason, req.via);
      return { outcome: 'rejected-validation', reason: rerunCheck.reason };
    }

    const pipelineCheck = this.validatePipelineId(req.pipelineId ?? null, req.runPlan ?? null);
    if (pipelineCheck.kind === 'invalid') {
      await this.emitRejection('schedule', 'rejected-validation', pipelineCheck.reason, req.via);
      return { outcome: 'rejected-validation', reason: pipelineCheck.reason };
    }

    const foreign = this.checkForeignFreshLock();
    if (foreign) {
      await this.emitRejection('schedule', 'rejected-foreign-lock', foreign, req.via);
      return { outcome: 'rejected-foreign-lock', reason: foreign };
    }

    if (this.deps.store.getQueue().paused) {
      const reason = 'queue-paused';
      await this.emitRejection('schedule', 'rejected-paused', reason, req.via);
      return { outcome: 'rejected-paused', reason };
    }

    // Feature 065 — host policy table for the optional `startIntent`. The
    // horizon and past-coercion checks MUST run BEFORE the enqueue so a
    // rejection leaves the persisted queue state untouched (per FR-009c /
    // SC-008 — "0% of attempts over the 7-day horizon land in idle-pending").
    const policy = this.resolveStartIntentPolicy(req);
    if (policy.kind === 'rejected-horizon') {
      await this.emitHorizonRejection(req, policy.requestedScheduledStartAt);
      throw new ScheduledStartHorizonError(
        policy.requestedScheduledStartAt,
        req.callerId
      );
    }

    try {
      const feature = await this.deps.queue.enqueue(validated.value, {
        ...(req.pipelineId ? { pipelineId: req.pipelineId } : {}),
        ...(req.queueId ? { queueId: req.queueId } : {}),
        ...(req.position !== null && req.position !== undefined ? { position: req.position } : {}),
        ...(req.rerun ? { rerun: req.rerun } : {}),
        ...(req.runPlan ? { runPlan: req.runPlan } : {})
      });
      const lifecycleAfter = await this.applyStartIntentPolicy(req, policy);
      return { outcome: 'enqueued', queueItemId: feature.id, lifecycleAfter };
    } catch (err) {
      const reason = this.deps.logger.sanitize((err as Error).message ?? 'enqueue-failed');
      await this.emitRejection('schedule', 'rejected-validation', reason, req.via);
      return { outcome: 'rejected-validation', reason };
    }
  }

  /**
   * Feature 065 (T041) — operator-restart paths invoked from
   * `CMD_START_QUEUE` when the webview provides a `startIntent`. Routes
   * one of three FR-015 affordances:
   *   - `cancel-schedule` → clear scheduledStartAt/Source, emit
   *     `scheduled-start-canceled { operator-cancel }`, lifecycle stays
   *     `idle-pending` (task preserved).
   *   - `scheduled` (change) → coordinator.change() emits canceled+armed,
   *     persisted scheduledStartAt/Source updated, lifecycle stays
   *     `idle-pending`.
   *   - `now` (convert-to-now) → cancel timer if armed, clear fields,
   *     emit `idle-pending-exited { operator-start-now }`, lifecycle
   *     becomes `running`.
   *
   * No queue mutation (enqueue) — the task is already in the queue. The
   * caller (`schegent.startQueue`) is responsible for invoking the auto-drain
   * pass after the lifecycle settles.
   */
  /**
   * Feature 065 / BUG-006 — transition the queue into `idle-pending` with
   * a system-armed scheduled-restore timestamp after the retry handler
   * exhausts retries on a rate-limit-family cause. Atomic: persists
   * `{queueLifecycle: 'idle-pending', scheduledStartAt, scheduledStartSource}`,
   * arms the coordinator, and emits both `system-pause-scheduled-restore`
   * (FR-026) and `idle-pending-entered` with `transitionReason:
   * 'retry-cap-exhausted'`. Used only by the retry handler; not exposed via
   * IPC. The caller is expected to have parsed `resetsAtMs` via
   * `extractResetTimestamp` and to have validated it is in the future and
   * within the 7-day horizon. If validation fails the caller MUST fall back
   * to `system-pause-restore-unavailable` + legacy `operator-paused`.
   */
  public async transitionToScheduledRestore(args: {
    scheduledStartAt: number;
    scheduledStartSource: ScheduledStartSource;
    transitionReason: 'retry-cap-exhausted';
    pauseCauseCategory: 'rate-limit';
    queueId?: string;
  }): Promise<void> {
    const queueId = args.queueId ?? 'default';
    const now = this.clock();
    const current = this.deps.store.getQueue();
    const wasIdlePending = current.queueLifecycle === 'idle-pending';
    await this.deps.store.updateQueue((queue) => ({
      queue: {
        ...queue,
        queueLifecycle: 'idle-pending',
        scheduledStartAt: args.scheduledStartAt,
        scheduledStartSource: args.scheduledStartSource,
        updatedAt: now
      },
      result: undefined
    }));
    if (this.deps.scheduledStartCoordinator) {
      await this.deps.scheduledStartCoordinator.arm(
        queueId,
        args.scheduledStartAt,
        args.scheduledStartSource
      );
    }
    // FR-023a consistent core payload: queueId, eventType, occurredAt,
    // transitionReason. `eventType` is supplied by the audit writer;
    // `occurredAt` is filled in by `appendScheduleAudit` when omitted.
    await this.appendScheduleAudit('system-pause-scheduled-restore', {
      queueId,
      transitionReason: args.transitionReason,
      scheduledStartAt: args.scheduledStartAt,
      scheduledStartSource: args.scheduledStartSource,
      pauseCauseCategory: args.pauseCauseCategory
    });
    if (!wasIdlePending) {
      await this.appendScheduleAudit('idle-pending-entered', {
        queueId,
        scheduledStartAt: args.scheduledStartAt,
        scheduledStartSource: args.scheduledStartSource,
        transitionReason: args.transitionReason
      });
    }
  }

  /**
   * Feature 065 / BUG-006 — emit the `system-pause-restore-unavailable`
   * fallback when `extractResetTimestamp` could not parse a reset timestamp
   * or the parsed value is outside the 7-day horizon. The caller is
   * responsible for the legacy `operator-paused` lifecycle transition; this
   * method is audit-only.
   */
  public async emitSystemPauseRestoreUnavailable(args: {
    pauseCauseCategory: 'rate-limit';
    fallbackReason: 'unparseable-reset' | 'past-reset' | 'over-horizon-reset';
    queueId?: string;
  }): Promise<void> {
    const queueId = args.queueId ?? 'default';
    await this.appendScheduleAudit('system-pause-restore-unavailable', {
      queueId,
      transitionReason: 'retry-cap-exhausted',
      pauseCauseCategory: args.pauseCauseCategory,
      fallbackReason: args.fallbackReason
    });
  }

  public async applyStartQueueIntent(
    intent: { startMode: 'now' | 'scheduled' | 'cancel-schedule'; scheduledStartAt?: number; source: 'operator-restart' },
    opts: { queueId?: string } = {}
  ): Promise<{ outcome: 'applied' | 'rejected-horizon' | 'noop'; lifecycleAfter?: QueueLifecycle; requestedScheduledStartAt?: number }> {
    const queueId = opts.queueId ?? 'default';
    const current = this.deps.store.getQueue();
    const now = this.clock();
    const coordinator = this.deps.scheduledStartCoordinator;

    if (intent.startMode === 'cancel-schedule') {
      // Cancel: keep task; clear scheduled-start fields; lifecycle stays
      // idle-pending. The coordinator emits `scheduled-start-canceled`
      // with `operator-cancel`.
      if (current.scheduledStartAt === null) return { outcome: 'noop' };
      if (coordinator) {
        await coordinator.cancel(queueId, 'operator-cancel');
      }
      await this.deps.store.updateQueue((queue) => ({
        queue: {
          ...queue,
          queueLifecycle: 'idle-pending',
          scheduledStartAt: null,
          scheduledStartSource: null,
          updatedAt: now
        },
        result: undefined
      }));
      return { outcome: 'applied', lifecycleAfter: 'idle-pending' };
    }

    if (intent.startMode === 'scheduled') {
      const requested = intent.scheduledStartAt;
      if (typeof requested !== 'number' || !Number.isFinite(requested)) {
        return { outcome: 'noop' };
      }
      if (requested <= now) {
        // Past timestamps on the restart path collapse to convert-to-now.
        return this.applyStartQueueIntent(
          { startMode: 'now', source: 'operator-restart' },
          opts
        );
      }
      if (requested > now + SCHEDULED_START_MAX_HORIZON_MS) {
        await this.emitHorizonRejection(
          { via: 'webview' as GuardedVia, queueId } as GuardedScheduleRequest,
          requested
        );
        return { outcome: 'rejected-horizon', requestedScheduledStartAt: requested };
      }
      const source: ScheduledStartSource = 'operator-restart';
      await this.deps.store.updateQueue((queue) => ({
        queue: {
          ...queue,
          queueLifecycle: 'idle-pending',
          scheduledStartAt: requested,
          scheduledStartSource: source,
          updatedAt: now
        },
        result: undefined
      }));
      if (coordinator) {
        if (current.scheduledStartAt !== null) {
          await coordinator.change(queueId, requested, source);
        } else {
          await coordinator.arm(queueId, requested, source);
        }
      }
      return { outcome: 'applied', lifecycleAfter: 'idle-pending' };
    }

    // startMode === 'now' (convert-to-now)
    if (current.scheduledStartAt !== null && coordinator) {
      await coordinator.cancel(queueId, 'operator-cancel');
    }
    const wasIdlePending = current.queueLifecycle === 'idle-pending';
    await this.deps.store.updateQueue((queue) => ({
      queue: {
        ...queue,
        queueLifecycle: 'running',
        scheduledStartAt: null,
        scheduledStartSource: null,
        updatedAt: now
      },
      result: undefined
    }));
    if (wasIdlePending) {
      await this.appendScheduleAudit('idle-pending-exited', {
        queueId,
        exitReason: 'operator-start-now',
        scheduledStartSource: 'operator-restart',
        transitionReason: 'operator-start-now'
      });
    }
    return { outcome: 'applied', lifecycleAfter: 'running' };
  }

  /**
   * Feature 065 — pre-flight evaluation of the `startIntent` against the host
   * policy table. Pure: no state mutation, no audit emission. Returns the
   * resolved policy that `applyStartIntentPolicy` consumes after the enqueue
   * succeeds, OR a `rejected-horizon` discriminator that the caller surfaces
   * before any persisted write.
   */
  private resolveStartIntentPolicy(
    req: GuardedScheduleRequest
  ):
    | { kind: 'no-intent-human' }
    | { kind: 'no-intent-automation'; callerId?: string }
    | { kind: 'append-tail-no-chooser' }
    | { kind: 'now'; source: ScheduledStartSource; coercedFromPast: boolean; originalScheduledStartAt?: number }
    | { kind: 'scheduled'; scheduledStartAt: number; source: ScheduledStartSource }
    | { kind: 'rejected-horizon'; requestedScheduledStartAt: number } {
    // Feature 065 (T033 / FR-006) — running queue silent enqueue. A
    // queue that is already `running` ignores any `startIntent` payload
    // (chooser surfaces should not be presented in this state, but
    // defense-in-depth here too). No scheduled-start-* events are
    // emitted on this path and lifecycle is preserved.
    const currentLifecycle = this.deps.store.getQueue().queueLifecycle;
    if (currentLifecycle === 'running') {
      return { kind: 'append-tail-no-chooser' };
    }
    const intent = req.startIntent;
    if (intent === undefined) {
      if (req.callerKind === 'automation') {
        const result: { kind: 'no-intent-automation'; callerId?: string } = {
          kind: 'no-intent-automation'
        };
        if (req.callerId !== undefined) result.callerId = req.callerId;
        return result;
      }
      return { kind: 'no-intent-human' };
    }
    const source = intent.source as ScheduledStartSource;
    if (intent.startMode === 'now') {
      return { kind: 'now', source, coercedFromPast: false };
    }
    const requested = intent.scheduledStartAt;
    if (typeof requested !== 'number' || !Number.isFinite(requested)) {
      // Treat malformed timestamps as the no-intent default rather than
      // throwing — the IPC validator should have rejected them before
      // they reach this layer, so this is a defense-in-depth fallback.
      return { kind: 'no-intent-human' };
    }
    const now = this.clock();
    if (requested <= now) {
      return {
        kind: 'now',
        source,
        coercedFromPast: true,
        originalScheduledStartAt: requested
      };
    }
    if (requested > now + SCHEDULED_START_MAX_HORIZON_MS) {
      return { kind: 'rejected-horizon', requestedScheduledStartAt: requested };
    }
    return { kind: 'scheduled', scheduledStartAt: requested, source };
  }

  /**
   * Feature 065 — applies the resolved policy after a successful enqueue.
   * Mutates the persisted `QueueState` (`queueLifecycle`,
   * `scheduledStartAt`, `scheduledStartSource`) and arms the scheduled-start
   * coordinator timer when relevant. Emits the required audit events.
   * Returns the lifecycle the queue lands in.
   */
  private async applyStartIntentPolicy(
    req: GuardedScheduleRequest,
    policy: ReturnType<GuardedRunService['resolveStartIntentPolicy']>
  ): Promise<QueueLifecycle> {
    if (policy.kind === 'rejected-horizon') {
      // Unreachable: caller rejects horizon before this method runs.
      return 'active-empty';
    }
    const now = this.clock();
    const current = this.deps.store.getQueue();
    const queueId = req.queueId ?? 'default';
    if (policy.kind === 'append-tail-no-chooser') {
      // Feature 065 (FR-006) — `running` queue silent enqueue. Lifecycle
      // is preserved; no scheduledStartAt fields are touched; no
      // scheduled-start-* / idle-pending-* audit events are emitted.
      // The task was already appended to the queue via `queue.enqueue`.
      void now;
      void current;
      void queueId;
      return 'running';
    }
    if (policy.kind === 'now') {
      if (policy.coercedFromPast && policy.originalScheduledStartAt !== undefined) {
        await this.appendScheduleAudit('scheduled-start-past-timestamp-coerced-to-now', {
          queueId,
          requestedScheduledStartAt: policy.originalScheduledStartAt,
          coercedAt: now,
          scheduledStartSource: policy.source,
          transitionReason: 'past-timestamp'
        });
      }
      const wasIdlePending = current.queueLifecycle === 'idle-pending';
      if (wasIdlePending && current.scheduledStartAt !== null && this.deps.scheduledStartCoordinator) {
        await this.deps.scheduledStartCoordinator.cancel(queueId, 'operator-cancel');
      }
      await this.deps.store.updateQueue((queue) => ({
        queue: {
          ...queue,
          queueLifecycle: 'running',
          scheduledStartAt: null,
          scheduledStartSource: null,
          updatedAt: now
        },
        result: undefined
      }));
      if (wasIdlePending) {
        await this.appendScheduleAudit('idle-pending-exited', {
          queueId,
          exitReason: 'operator-start-now',
          scheduledStartSource: policy.source,
          transitionReason: 'operator-start-now'
        });
      }
      return 'running';
    }
    if (policy.kind === 'scheduled') {
      const wasIdlePending = current.queueLifecycle === 'idle-pending';
      // If the queue was previously in idle-pending with an armed timer, the
      // arm() call on the coordinator already supersedes the prior timer; we
      // emit no extra `scheduled-start-canceled` here. The
      // change-schedule-from-restart path is owned by T042.
      await this.deps.store.updateQueue((queue) => ({
        queue: {
          ...queue,
          queueLifecycle: 'idle-pending',
          scheduledStartAt: policy.scheduledStartAt,
          scheduledStartSource: policy.source,
          updatedAt: now
        },
        result: undefined
      }));
      if (this.deps.scheduledStartCoordinator) {
        await this.deps.scheduledStartCoordinator.arm(
          queueId,
          policy.scheduledStartAt,
          policy.source
        );
      }
      if (!wasIdlePending) {
        await this.appendScheduleAudit('idle-pending-entered', {
          queueId,
          scheduledStartAt: policy.scheduledStartAt,
          scheduledStartSource: policy.source,
          transitionReason: policy.source
        });
      }
      return 'idle-pending';
    }
    if (policy.kind === 'no-intent-human') {
      const wasIdlePending = current.queueLifecycle === 'idle-pending';
      if (!wasIdlePending) {
        await this.deps.store.updateQueue((queue) => ({
          queue: {
            ...queue,
            queueLifecycle: 'idle-pending',
            scheduledStartAt: null,
            scheduledStartSource: null,
            updatedAt: now
          },
          result: undefined
        }));
        await this.appendScheduleAudit('idle-pending-entered', {
          queueId,
          scheduledStartAt: null,
          scheduledStartSource: null,
          transitionReason: 'operator-no-start-mode'
        });
      }
      return 'idle-pending';
    }
    // no-intent-automation
    const wasIdlePending = current.queueLifecycle === 'idle-pending';
    if (!wasIdlePending) {
      await this.deps.store.updateQueue((queue) => ({
        queue: {
          ...queue,
          queueLifecycle: 'idle-pending',
          scheduledStartAt: null,
          scheduledStartSource: null,
          updatedAt: now
        },
        result: undefined
      }));
      await this.appendScheduleAudit('idle-pending-entered', {
        queueId,
        scheduledStartAt: null,
        scheduledStartSource: null,
        transitionReason: 'automation-no-start-mode'
      });
    }
    const payload: Record<string, unknown> = {
      queueId,
      transitionReason: 'automation-no-start-mode'
    };
    if (policy.callerId !== undefined) payload.callerId = policy.callerId;
    await this.appendScheduleAudit('automation-enqueue-no-start-mode', payload);
    return 'idle-pending';
  }

  /**
   * Feature 065 — emit the `scheduled-start-horizon-rejected` warn-level
   * event for a programmatic over-horizon attempt. Persistence is untouched
   * so SC-008 ("0% lands in idle-pending") holds.
   */
  private async emitHorizonRejection(
    req: GuardedScheduleRequest,
    requestedScheduledStartAt: number
  ): Promise<void> {
    const queueId = req.queueId ?? 'default';
    const payload: Record<string, unknown> = {
      queueId,
      requestedScheduledStartAt,
      transitionReason: 'horizon-exceeded',
      scheduledStartSource: req.startIntent?.source ?? 'programmatic-scheduled'
    };
    if (req.callerId !== undefined) payload.callerId = req.callerId;
    await this.appendScheduleAudit('scheduled-start-horizon-rejected', payload);
  }

  private async appendScheduleAudit(
    eventType:
      | 'scheduled-start-armed'
      | 'scheduled-start-fired'
      | 'scheduled-start-canceled'
      | 'scheduled-start-superseded'
      | 'scheduled-start-horizon-rejected'
      | 'scheduled-start-past-timestamp-coerced-to-now'
      | 'idle-pending-entered'
      | 'idle-pending-exited'
      | 'automation-enqueue-no-start-mode'
      // BUG-006 / FR-026 / FR-027
      | 'system-pause-scheduled-restore'
      | 'system-pause-restore-unavailable',
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!this.deps.audit) return;
    try {
      const now = this.clock();
      await this.deps.audit.append({
        runId: '',
        phase: 'scheduled-start',
        iteration: 0,
        eventType,
        outcome: 'info',
        payload: { ...payload, occurredAt: payload.occurredAt ?? now }
      });
    } catch (err) {
      this.deps.logger.warn(
        `guarded-run-service: schedule audit append failed (${eventType}): ${(err as Error).message}`
      );
    }
  }

  public async startNow(req: GuardedStartRequest): Promise<GuardedStartResult> {
    const validated = this.validateDescription(req.description);
    if (validated.kind === 'invalid') {
      await this.emitRejection('start', 'rejected-validation', validated.reason, req.via);
      return { outcome: 'rejected-validation', reason: validated.reason };
    }

    const rerunCheck = this.validateRerunPair(req.rerun ?? null, req.pipelineId ?? null);
    if (rerunCheck.kind === 'invalid') {
      await this.emitRejection('start', 'rejected-validation', rerunCheck.reason, req.via);
      return { outcome: 'rejected-validation', reason: rerunCheck.reason };
    }

    const pipelineCheck = this.validatePipelineId(req.pipelineId ?? null);
    if (pipelineCheck.kind === 'invalid') {
      await this.emitRejection('start', 'rejected-validation', pipelineCheck.reason, req.via);
      return { outcome: 'rejected-validation', reason: pipelineCheck.reason };
    }

    const cliCheck = await this.assertCliAvailable(req.pipelineId ?? null);
    if (cliCheck.kind === 'invalid') {
      await this.emitRejection('start', 'rejected-validation', cliCheck.reason, req.via);
      return { outcome: 'rejected-validation', reason: cliCheck.reason };
    }

    const scaffold = await this.assertScaffoldingPresent();
    if (scaffold.kind === 'invalid') {
      await this.emitRejection('start', 'rejected-validation', scaffold.reason, req.via);
      return { outcome: 'rejected-validation', reason: scaffold.reason };
    }

    // Feature 017 — BUG-003. Defense-in-depth only. Operator-driven
    // enqueue paths (Dashboard `CMD_START`, Command Palette
    // `schegent.auto`) now route through `scheduleOrEnqueue()` via
    // `runEnqueue()` so an operator submitting while a controller is
    // mid-pipeline gets a pending task (FR-010 / FR-013 / FR-029 /
    // FR-036). `startNow()` is reserved for direct
    // start-immediately call sites that already guarantee no
    // controller run is active.
    if (this.deps.controller.running) {
      const reason = 'controller-already-running';
      await this.emitRejection('start', 'rejected-already-running', reason, req.via);
      return { outcome: 'rejected-already-running', reason };
    }

    const foreign = this.checkForeignFreshLock();
    if (foreign) {
      await this.emitRejection('start', 'rejected-foreign-lock', foreign, req.via);
      return { outcome: 'rejected-foreign-lock', reason: foreign };
    }

    const lockResult = await this.deps.lock.tryAcquire();
    if (!lockResult.acquired) {
      const reason = `lock-held-by:${this.deps.logger.sanitize(lockResult.ownerId)}`;
      await this.emitRejection('start', 'rejected-foreign-lock', reason, req.via);
      return { outcome: 'rejected-foreign-lock', reason };
    }

    let feature: FeatureRequest;
    try {
      feature = await this.deps.queue.enqueue(validated.value, {
        ...(req.pipelineId ? { pipelineId: req.pipelineId } : {}),
        ...(req.queueId ? { queueId: req.queueId } : {}),
        ...(req.position !== null && req.position !== undefined ? { position: req.position } : {}),
        ...(req.rerun ? { rerun: req.rerun } : {})
      });
    } catch (err) {
      // Validation passed but enqueue failed — release the lock we just took.
      await this.deps.lock.release().catch(() => undefined);
      const reason = this.deps.logger.sanitize((err as Error).message ?? 'enqueue-failed');
      await this.emitRejection('start', 'rejected-validation', reason, req.via);
      return { outcome: 'rejected-validation', reason };
    }

    // Pass ownership to the controller. driveRun() releases via lockReleased.
    this.startController(feature, req.featureDir ?? null);
    return { outcome: 'started', runId: feature.id, feature };
  }

  // --- helpers --------------------------------------------------------------

  private startController(feature: FeatureRequest, featureDir: string | null): void {
    try {
      void Promise.resolve(this.deps.controller.startNew(feature, featureDir)).catch((err) =>
        this.handleControllerStartFailure(feature, err)
      );
    } catch (err) {
      void this.handleControllerStartFailure(feature, err);
    }
  }

  private async handleControllerStartFailure(
    feature: FeatureRequest,
    err: unknown
  ): Promise<void> {
    const message = this.deps.logger.sanitize(
      err instanceof Error ? err.message : String(err)
    ).slice(0, 240);
    const lastError: FeatureRequestFailure = {
      code: 'controller-start-failed',
      message,
      correlationId: feature.runId ?? feature.id
    };
    this.deps.logger.error(`controller.startNew failed for ${feature.id}: ${message}`);
    try {
      await this.deps.queue.finish(feature.id, 'failed', lastError);
    } catch (finishErr) {
      this.deps.logger.warn(
        `failed to mark ${feature.id} failed after controller.startNew rejection: ${
          this.deps.logger.sanitize((finishErr as Error).message)
        }`
      );
    } finally {
      await this.deps.lock.release().catch(() => undefined);
    }
  }

  private validateDescription(
    raw: string
  ): { kind: 'ok'; value: string } | { kind: 'invalid'; reason: string } {
    if (typeof raw !== 'string') {
      return { kind: 'invalid', reason: 'description-not-string' };
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return { kind: 'invalid', reason: 'description-empty' };
    }
    if (trimmed.length > 32_000) {
      return { kind: 'invalid', reason: 'description-too-long' };
    }
    return { kind: 'ok', value: trimmed };
  }

  private validateRerunPair(
    rerun: FeatureRequestRerun | null,
    pipelineId: string | null
  ): { kind: 'ok' } | { kind: 'invalid'; reason: string } {
    if (rerun === null) return { kind: 'ok' };
    if (typeof rerun.originalRunId !== 'string' || rerun.originalRunId.length === 0) {
      return { kind: 'invalid', reason: 'rerun-original-run-id-required' };
    }
    if (typeof rerun.originalDescription !== 'string' || rerun.originalDescription.length === 0) {
      return { kind: 'invalid', reason: 'rerun-original-description-required' };
    }
    if (rerun.reason !== 'manual' && rerun.reason !== 'retry-active' && rerun.reason !== 'auto-drain') {
      return { kind: 'invalid', reason: 'rerun-reason-invalid' };
    }
    if (pipelineId === null) {
      return { kind: 'invalid', reason: 'rerun-requires-pipeline-id' };
    }
    return { kind: 'ok' };
  }

  /**
   * The catalog is the authority for an item that has none of its own.
   *
   * A composed item carries the definition it will execute: `runPlan` was frozen
   * from the effective catalog at validation, and `workflow-run-factory.ts` runs
   * it at drain without re-resolving anything. Catalog membership is therefore
   * not a precondition for enqueueing such a row, and requiring it would let
   * catalog drift reach a submission that was already validated against the
   * definition it froze — which is the drift feature 087 exists to close, and
   * which feature 088 needs closed at this gate too: a connected run's node start
   * must execute its snapshot even after the Pipeline is deleted from the catalog
   * (FR-005, SC-003), and nothing else in the enqueue path reads the catalog.
   *
   * The plan must agree with the id the row claims. A plan for some other
   * Pipeline falls through to the catalog check rather than vouching for a row
   * that names something it does not describe.
   */
  private validatePipelineId(
    pipelineId: string | null,
    plan: FrozenRunPlan | null = null
  ): { kind: 'ok' } | { kind: 'invalid'; reason: string } {
    if (pipelineId === null) return { kind: 'ok' };
    if (typeof pipelineId !== 'string' || pipelineId.length === 0) {
      return { kind: 'invalid', reason: 'pipeline-id-empty' };
    }
    if (plan !== null && plan.pipeline.id === pipelineId) return { kind: 'ok' };
    const catalog =
      this.deps.catalogProvider?.() ?? this.deps.controller.getCatalog();
    if (!catalog.pipelinesById.has(pipelineId)) {
      return {
        kind: 'invalid',
        reason: `pipeline-id-unknown:${this.deps.logger.sanitize(pipelineId)}`
      };
    }
    return { kind: 'ok' };
  }

  private checkForeignFreshLock(): string | null {
    const existing = this.deps.store.getLock();
    if (!existing) return null;
    if (existing.ownerId === this.deps.lock.id) return null;
    const age = this.clock() - existing.heartbeatAt;
    if (age > STALENESS_THRESHOLD_MS) return null;
    return `foreign-fresh:${this.deps.logger.sanitize(existing.ownerId)}`;
  }

  private async assertCliAvailable(pipelineId: string | null): Promise<
    { kind: 'ok' } | { kind: 'invalid'; reason: string }
  > {
    const catalog =
      this.deps.catalogProvider?.() ?? this.deps.controller.getCatalog();
    const pipeline = catalog.pipelinesById.get(
      pipelineId ?? catalog.defaultPipelineId
    );
    const runnerKinds = new Set<BackendRunnerKind>();
    if (pipeline) {
      for (const phaseId of pipeline.phases) {
        const runnerKind =
          catalog.phasesById.get(phaseId)?.runner ??
          this.deps.defaultRunnerKind ??
          DEFAULT_BACKEND;
        const runnerPolicyError = phaseRunnerPolicyError(phaseId, runnerKind);
        if (runnerPolicyError !== null) {
          return {
            kind: 'invalid',
            reason: `runner-incompatible:${phaseId}:${runnerKind}`
          };
        }
        runnerKinds.add(runnerKind);
      }
    }
    if (runnerKinds.size === 0) {
      runnerKinds.add(this.deps.defaultRunnerKind ?? DEFAULT_BACKEND);
    }

    for (const runnerKind of runnerKinds) {
      let cliPath: string;
      try {
        cliPath = await this.deps.cliPathProvider(runnerKind);
      } catch (err) {
        return {
          kind: 'invalid',
          reason: `cli-path-unavailable:${this.deps.logger.sanitize((err as Error).message ?? 'unknown')}`
        };
      }
      if (!cliPath || cliPath.trim().length === 0) {
        return { kind: 'invalid', reason: 'cli-path-empty' };
      }
      if (!(await isExecutableAvailable(cliPath))) {
        return { kind: 'invalid', reason: 'cli-not-found' };
      }
    }
    return { kind: 'ok' };
  }

  private async assertScaffoldingPresent(): Promise<
    { kind: 'ok' } | { kind: 'invalid'; reason: string }
  > {
    try {
      const stat = await fs.stat(path.join(this.deps.workspaceRoot, '.specify'));
      if (!stat.isDirectory()) {
        return { kind: 'invalid', reason: 'scaffolding-not-directory' };
      }
      return { kind: 'ok' };
    } catch {
      return { kind: 'invalid', reason: 'scaffolding-missing' };
    }
  }

  private async emitRejection(
    operation: 'start' | 'schedule',
    outcomeLiteral: string,
    reason: string,
    via: GuardedScheduleRequest['via'] | GuardedStartRequest['via'] | undefined
  ): Promise<void> {
    const sanitizedReason = this.deps.logger.sanitize(reason);
    this.deps.logger.warn(
      `guarded-run-service: ${operation} ${outcomeLiteral} (via=${via ?? 'unknown'}): ${sanitizedReason}`
    );
    if (!this.deps.audit) return;
    try {
      await this.deps.audit.append({
        runId: 'guarded-run-service',
        phase: 'speckit-specify',
        iteration: 0,
        eventType: 'warning',
        outcome: 'failure',
        payload: {
          source: 'guarded-run-service',
          operation,
          outcome: outcomeLiteral,
          via: via ?? 'unknown',
          reason: sanitizedReason
        }
      });
    } catch (err) {
      this.deps.logger.warn(
        `guarded-run-service: audit emit failed: ${this.deps.logger.sanitize((err as Error).message ?? 'unknown')}`
      );
    }
  }
}

async function isExecutableAvailable(cliPath: string): Promise<boolean> {
  if (path.isAbsolute(cliPath)) {
    try {
      await fs.access(cliPath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const which = process.platform === 'win32' ? 'where' : 'which';
  return new Promise<boolean>((resolve) => {
    try {
      const proc = spawn(which, [cliPath], { stdio: 'ignore' });
      proc.on('exit', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}
