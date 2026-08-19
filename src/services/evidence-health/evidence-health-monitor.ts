export type EvidenceSinkName =
  | 'audit'
  | 'rawTranscript'
  | 'runtimeLog'
  | 'metricsRollup'
  | 'historyPointer';
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
  /**
   * Feature FR-R3-009 — the append-only cumulative-totals rollup. Degraded, not
   * unavailable: a failed rollup append loses nothing that the audit log still
   * holds, but it does mean the affected run's contribution to cumulative
   * totals will drop back out when its log evidence is pruned. Surfacing it is
   * what makes that regression visible instead of silent.
   */
  readonly metricsRollup: EvidenceSinkHealth;
  /**
   * FR-R3-010 — the read side of `HistoryEntry.auditLogPointer`: can a completed
   * Run's recorded evidence still be located?
   *
   * Degraded only when the corpus cannot be *read*. An expired pointer, a run
   * that wrote no entries, and a legacy pointer an older build minted are all
   * definitive answers about one record, not conditions of the sink — treating
   * them as failures would leave every workspace with pre-feature history
   * permanently degraded, which tells an operator nothing they can act on.
   *
   * `continue-degraded` rather than `fail-closed`: this is a read path over
   * evidence that has already been written, so an unreadable corpus cannot make
   * a *new* run's evidence any less durable. It is the audit sink's own
   * `fail-closed` status that governs writes.
   */
  readonly historyPointer: EvidenceSinkHealth;
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
  runtimeLog: 'continue-degraded',
  metricsRollup: 'continue-degraded',
  historyPointer: 'continue-degraded'
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

function healthySinks(): Record<EvidenceSinkName, EvidenceSinkHealth> {
  return {
    audit: healthySink('audit'),
    rawTranscript: healthySink('rawTranscript'),
    runtimeLog: healthySink('runtimeLog'),
    metricsRollup: healthySink('metricsRollup'),
    historyPointer: healthySink('historyPointer')
  };
}

/**
 * Workspace-scoped, in-memory health owner for the execution-evidence sinks. It
 * stores no paths, payloads, or exception messages. Audit failure is classified
 * unavailable/fail-closed; every other sink's failure is degraded and
 * availability-preserving.
 */
export class EvidenceHealthMonitor implements EvidenceHealthReporter {
  private readonly listeners = new Set<EvidenceHealthListener>();
  private readonly now: () => Date;
  private sinks: Record<EvidenceSinkName, EvidenceSinkHealth> = healthySinks();

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
    this.sinks = healthySinks();
    this.notify();
  }

  public getSnapshot(): EvidenceHealthSnapshot {
    const overall: EvidenceOverallStatus = this.sinks.audit.status === 'unavailable'
      ? 'unavailable'
      : this.sinks.rawTranscript.status === 'degraded' ||
          this.sinks.runtimeLog.status === 'degraded' ||
          this.sinks.metricsRollup.status === 'degraded' ||
          this.sinks.historyPointer.status === 'degraded'
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
    case 'corpus-unreadable':
      // FR-R3-010 added `corpus-unreadable`: a host-minted closed token from the
      // pointer resolver, passed through rather than folded into `io-error`
      // because it names a distinct condition — the corpus could not be read at
      // all, as opposed to one write that failed. Like every case above it, it
      // carries no path. The comment sits inside the shared body rather than
      // between the two labels because `no-fallthrough` reads a comment-only case
      // body as a fallthrough it has to report.
      return raw;
    default:
      return 'io-error';
  }
}

export const IDLE_EVIDENCE_HEALTH: EvidenceHealthSnapshot = new EvidenceHealthMonitor().getSnapshot();
