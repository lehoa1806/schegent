export type EvidenceSinkName = 'audit' | 'rawTranscript' | 'runtimeLog';
export type EvidenceSinkStatus = 'healthy' | 'degraded' | 'unavailable';
export type EvidenceOverallStatus = 'healthy' | 'degraded' | 'unavailable';
export type EvidenceContinuationPolicy = 'fail-closed' | 'continue-degraded';

export interface EvidenceSinkHealth {
  readonly status: EvidenceSinkStatus;
  readonly continuationPolicy: EvidenceContinuationPolicy;
  readonly failureCount: number;
  readonly lastFailureAt: string | null;
  readonly cause: string | null;
}

export interface EvidenceHealthSnapshot {
  readonly overall: EvidenceOverallStatus;
  readonly audit: EvidenceSinkHealth;
  readonly rawTranscript: EvidenceSinkHealth;
  readonly runtimeLog: EvidenceSinkHealth;
}

export interface EvidenceHealthReporter {
  /** Returns true when this sink/cause transition should emit a warning. */
  reportFailure(sink: EvidenceSinkName, cause: string): boolean;
  reportSuccess(sink: EvidenceSinkName): void;
}

export interface EvidenceHealthDisposable {
  dispose(): void;
}

export type EvidenceHealthListener = (snapshot: EvidenceHealthSnapshot) => void;

const POLICIES: Readonly<Record<EvidenceSinkName, EvidenceContinuationPolicy>> = Object.freeze({
  audit: 'fail-closed',
  rawTranscript: 'continue-degraded',
  runtimeLog: 'continue-degraded'
});

function healthySink(sink: EvidenceSinkName): EvidenceSinkHealth {
  return Object.freeze({
    status: 'healthy',
    continuationPolicy: POLICIES[sink],
    failureCount: 0,
    lastFailureAt: null,
    cause: null
  });
}

/**
 * Workspace-scoped, in-memory health owner for the three execution-evidence
 * sinks. It stores no paths, payloads, or exception messages. Audit failure is
 * classified unavailable/fail-closed; raw/runtime failures are degraded and
 * availability-preserving.
 */
export class EvidenceHealthMonitor implements EvidenceHealthReporter {
  private readonly listeners = new Set<EvidenceHealthListener>();
  private readonly now: () => Date;
  private sinks: Record<EvidenceSinkName, EvidenceSinkHealth> = {
    audit: healthySink('audit'),
    rawTranscript: healthySink('rawTranscript'),
    runtimeLog: healthySink('runtimeLog')
  };

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  public reportFailure(sink: EvidenceSinkName, cause: string): boolean {
    const previous = this.sinks[sink];
    const normalizedCause = normalizeEvidenceFailureCause(cause);
    const shouldWarn = previous.status === 'healthy' || previous.cause !== normalizedCause;
    this.sinks = {
      ...this.sinks,
      [sink]: Object.freeze({
        status: sink === 'audit' ? 'unavailable' : 'degraded',
        continuationPolicy: POLICIES[sink],
        failureCount: previous.failureCount + 1,
        lastFailureAt: this.now().toISOString(),
        cause: normalizedCause
      })
    };
    this.notify();
    return shouldWarn;
  }

  public reportSuccess(sink: EvidenceSinkName): void {
    if (this.sinks[sink].status === 'healthy') return;
    this.sinks = { ...this.sinks, [sink]: healthySink(sink) };
    this.notify();
  }

  public reset(): void {
    this.sinks = {
      audit: healthySink('audit'),
      rawTranscript: healthySink('rawTranscript'),
      runtimeLog: healthySink('runtimeLog')
    };
    this.notify();
  }

  public getSnapshot(): EvidenceHealthSnapshot {
    const overall: EvidenceOverallStatus = this.sinks.audit.status === 'unavailable'
      ? 'unavailable'
      : this.sinks.rawTranscript.status === 'degraded' || this.sinks.runtimeLog.status === 'degraded'
        ? 'degraded'
        : 'healthy';
    return Object.freeze({ overall, ...this.sinks });
  }

  public subscribe(listener: EvidenceHealthListener): EvidenceHealthDisposable {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return { dispose: () => this.listeners.delete(listener) };
  }

  private notify(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Health observers are diagnostics only and cannot break sink writes.
      }
    }
  }
}

export function normalizeEvidenceFailureCause(cause: unknown): string {
  const raw = typeof cause === 'string' ? cause : 'unknown';
  switch (raw) {
    case 'EACCES':
    case 'EPERM':
    case 'permission-denied':
      return 'permission-denied';
    case 'ENOSPC':
    case 'disk-full':
      return 'disk-full';
    case 'EROFS':
    case 'read-only-filesystem':
      return 'read-only-filesystem';
    case 'ETIMEDOUT':
    case 'timeout':
      return 'timeout';
    case 'partial-write':
    case 'stream-error':
    case 'cleanup-failed':
    case 'configuration':
    case 'io-error':
      return raw;
    default:
      return 'io-error';
  }
}

export const IDLE_EVIDENCE_HEALTH: EvidenceHealthSnapshot = new EvidenceHealthMonitor().getSnapshot();
