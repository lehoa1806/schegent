import type { AuditEventType } from '../contracts/audit-events';
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import type {
  BackendCapabilityService,
  BackendProbeFailureCause
} from './backend-capability-service';

export type BackendPingFailureCause =
  | BackendProbeFailureCause
  | 'already-in-progress';

export type BackendPingState =
  | { readonly status: 'idle' }
  | {
      readonly status: 'running';
      readonly runner: BackendRunnerKind;
      readonly startedAt: number;
      readonly timeoutSeconds: number;
    }
  | {
      readonly status: 'success';
      readonly runner: BackendRunnerKind;
      readonly startedAt: number;
      readonly completedAt: number;
      readonly latencyMs: number;
      readonly timeoutSeconds: number;
    }
  | {
      readonly status: 'failure';
      readonly runner: BackendRunnerKind;
      readonly startedAt: number;
      readonly completedAt: number;
      readonly latencyMs: number;
      readonly timeoutSeconds: number;
      readonly cause: BackendPingFailureCause;
      readonly exitCode?: number;
    };

export interface BackendPingResult {
  readonly accepted: boolean;
  readonly state: Exclude<BackendPingState, { readonly status: 'idle' | 'running' }>;
}

interface BackendPingAuditWriter {
  append(entry: {
    runId: string;
    phase: string;
    iteration: number;
    eventType: AuditEventType;
    payload: Record<string, unknown>;
    outcome: 'info' | 'success' | 'failure';
    correlationId?: string;
  }): Promise<unknown>;
}

export interface BackendPingServiceDeps {
  readonly capabilities: Pick<BackendCapabilityService, 'probe'>;
  readonly readTimeoutSeconds: () => number;
  readonly audit: BackendPingAuditWriter;
  readonly logger: { warn(message: string): void };
  readonly onDidChange?: () => void;
  readonly now?: () => number;
}

/** Memory-only, single-flight operator diagnostic for the three v1 CLIs. */
export class BackendPingService {
  private state: BackendPingState = Object.freeze({ status: 'idle' });
  private inFlight = false;

  constructor(private readonly deps: BackendPingServiceDeps) {}

  public getState(): BackendPingState {
    return this.state;
  }

  public async ping(
    runner: BackendRunnerKind,
    correlationId: string
  ): Promise<BackendPingResult> {
    const startedAt = this.now();
    const timeoutSeconds = this.deps.readTimeoutSeconds();
    if (this.inFlight) {
      const rejected = Object.freeze({
        status: 'failure' as const,
        runner,
        startedAt,
        completedAt: startedAt,
        latencyMs: 0,
        timeoutSeconds,
        cause: 'already-in-progress' as const
      });
      await this.appendAudit(rejected, correlationId, false);
      return { accepted: false, state: rejected };
    }

    this.inFlight = true;
    this.publish(Object.freeze({
      status: 'running',
      runner,
      startedAt,
      timeoutSeconds
    }));

    try {
      const probe = await this.deps.capabilities.probe(runner);
      const completedAt = this.now();
      const latencyMs = Math.max(0, completedAt - startedAt);
      const completed: BackendPingResult['state'] = probe.available
        ? Object.freeze({
            status: 'success',
            runner,
            startedAt,
            completedAt,
            latencyMs,
            timeoutSeconds
          })
        : Object.freeze({
            status: 'failure',
            runner,
            startedAt,
            completedAt,
            latencyMs,
            timeoutSeconds,
            cause: probe.cause,
            ...(probe.exitCode === undefined ? {} : { exitCode: probe.exitCode })
          });
      this.publish(completed);
      await this.appendAudit(completed, correlationId, true);
      return { accepted: true, state: completed };
    } catch {
      const completedAt = this.now();
      const failure = Object.freeze({
        status: 'failure' as const,
        runner,
        startedAt,
        completedAt,
        latencyMs: Math.max(0, completedAt - startedAt),
        timeoutSeconds,
        cause: 'unknown' as const
      });
      this.publish(failure);
      await this.appendAudit(failure, correlationId, true);
      return { accepted: true, state: failure };
    } finally {
      this.inFlight = false;
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private publish(state: BackendPingState): void {
    this.state = state;
    try {
      this.deps.onDidChange?.();
    } catch {
      this.deps.logger.warn('backend-ping: update callback failed');
    }
  }

  private async appendAudit(
    state: BackendPingResult['state'],
    correlationId: string,
    accepted: boolean
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      runner: state.runner,
      status: state.status,
      accepted,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      latencyMs: state.latencyMs,
      timeoutSeconds: state.timeoutSeconds
    };
    if (state.status === 'failure') {
      payload.cause = state.cause;
      if (state.exitCode !== undefined) payload.exitCode = state.exitCode;
    }
    try {
      await this.deps.audit.append({
        runId: `backend-ping:${state.runner}`,
        phase: 'backend-health',
        iteration: 0,
        eventType: 'backend-ping',
        payload,
        outcome: state.status === 'success' ? 'success' : 'failure',
        correlationId
      });
    } catch {
      this.deps.logger.warn('backend-ping: audit append failed');
    }
  }
}
