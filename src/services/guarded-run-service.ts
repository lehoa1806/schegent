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
  FeatureRequestRerun
} from '../queue/feature-request';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { PipelineCatalog } from '../config/pipeline-config';

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
}

export interface GuardedScheduleResult {
  outcome:
    | 'enqueued'
    | 'rejected-foreign-lock'
    | 'rejected-paused'
    | 'rejected-validation';
  reason?: string;
  queueItemId?: string;
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
  readonly store: Pick<WorkspaceStateStore, 'getLock' | 'getQueue'>;
  readonly cliPathProvider: () => Promise<string> | string;
  readonly workspaceRoot: string;
  readonly clock?: () => number;
  /** Optional override for tests; production reads the catalog via the controller. */
  readonly catalogProvider?: () => PipelineCatalog;
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

    const pipelineCheck = this.validatePipelineId(req.pipelineId ?? null);
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

    try {
      const feature = await this.deps.queue.enqueue(validated.value, {
        ...(req.pipelineId ? { pipelineId: req.pipelineId } : {}),
        ...(req.queueId ? { queueId: req.queueId } : {}),
        ...(req.position !== null && req.position !== undefined ? { position: req.position } : {}),
        ...(req.rerun ? { rerun: req.rerun } : {})
      });
      return { outcome: 'enqueued', queueItemId: feature.id };
    } catch (err) {
      const reason = this.deps.logger.sanitize((err as Error).message ?? 'enqueue-failed');
      await this.emitRejection('schedule', 'rejected-validation', reason, req.via);
      return { outcome: 'rejected-validation', reason };
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

    const cliCheck = await this.assertCliAvailable();
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

  private validatePipelineId(
    pipelineId: string | null
  ): { kind: 'ok' } | { kind: 'invalid'; reason: string } {
    if (pipelineId === null) return { kind: 'ok' };
    if (typeof pipelineId !== 'string' || pipelineId.length === 0) {
      return { kind: 'invalid', reason: 'pipeline-id-empty' };
    }
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

  private async assertCliAvailable(): Promise<
    { kind: 'ok' } | { kind: 'invalid'; reason: string }
  > {
    let cliPath: string;
    try {
      cliPath = await this.deps.cliPathProvider();
    } catch (err) {
      return {
        kind: 'invalid',
        reason: `cli-path-unavailable:${this.deps.logger.sanitize((err as Error).message ?? 'unknown')}`
      };
    }
    if (!cliPath || cliPath.trim().length === 0) {
      return { kind: 'invalid', reason: 'cli-path-empty' };
    }
    if (path.isAbsolute(cliPath)) {
      try {
        await fs.access(cliPath, fs.constants.X_OK);
        return { kind: 'ok' };
      } catch {
        return { kind: 'invalid', reason: 'cli-not-found' };
      }
    }
    const which = process.platform === 'win32' ? 'where' : 'which';
    const ok = await new Promise<boolean>((resolve) => {
      try {
        const proc = spawn(which, [cliPath], { stdio: 'ignore' });
        proc.on('exit', (code) => resolve(code === 0));
        proc.on('error', () => resolve(false));
      } catch {
        resolve(false);
      }
    });
    return ok ? { kind: 'ok' } : { kind: 'invalid', reason: 'cli-not-found' };
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
