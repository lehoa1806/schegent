export type EvidenceSinkName =
  | 'audit'
  | 'rawTranscript'
  | 'runtimeLog'
  | 'metricsRollup'
  | 'historyPointer';

// FR-R3-132 (T1502) — moved to `src/contracts/snapshot-vocabulary.ts` so the webview
// imports them instead of restating them. Re-exported unchanged.
import type {
  EvidenceContinuationPolicy,
  EvidenceOverallStatus,
  EvidenceSinkHealth,
  EvidenceSinkStatus
} from '../../contracts/snapshot-vocabulary';

export type {
  EvidenceContinuationPolicy,
  EvidenceOverallStatus,
  EvidenceSinkHealth,
  EvidenceSinkStatus
};

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
  /**
   * FR-R3-106 (FR-075) — transport lines refused because the sink's pending queue was
   * already at its bound.
   *
   * WHY IT BELONGS HERE. `CliTransportSink` has counted these since `FR-R3-052` and exposed
   * them on a getter whose only readers were two unit tests. So the operator question "did
   * the transport log lose lines?" was answerable by the code and answered nowhere — the
   * bound was real, the loss was real, and the evidence said nothing. Same class as a
   * declared threshold no command enforces.
   *
   * A COUNT, not a status, and it deliberately does not feed `overall`. A drop is not a sink
   * failure: the cap did its job and the run continued. What it means is that the transcript
   * is **incomplete**, which matters when someone later reads that transcript to explain a
   * run. Folding it into `overall` would put the whole surface amber for a working system,
   * which is how a status people learn to ignore gets made.
   *
   * Zero is the common value and is reported as zero rather than omitted — "no drops" and
   * "nobody looked" must not read the same.
   */
  readonly transportDrops: TransportDropCounts;
}

/**
 * Lines and bytes the transport sink refused under backpressure.
 *
 * Both, because they answer different questions: a thousand dropped short lines and one
 * dropped megabyte-long line are the same number to a line counter, and only one of them
 * loses a meaningful amount of a transcript.
 */
export interface TransportDropCounts {
  readonly lines: number;
  readonly bytes: number;
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

/**
 * FR-R3-080 (T1075) — the phase-end warning code for a sink whose write was
 * REFUSED rather than failed.
 *
 * One code per sink, composed here rather than at the call sites, so the
 * phase-end allowlist can hold the literals and no caller can invent a code the
 * allowlist has never seen. `SEC-06` / `SEC-07`'s refusals reached the log and
 * stopped there, and a refusal nobody surfaces is a refusal nobody acts on.
 */
export function pathRefusedWarning(sink: EvidenceSinkName): string {
  return `evidence-path-refused:${sink}`;
}

/**
 * Every sink name, so the allowlist and its test enumerate the same set the
 * type does rather than a hand-copied echo of it.
 */
export const EVIDENCE_SINK_NAMES: readonly EvidenceSinkName[] = [
  'audit',
  'rawTranscript',
  'runtimeLog',
  'metricsRollup',
  'historyPointer'
];

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
  private transportDrops: TransportDropCounts = { lines: 0, bytes: 0 };

  /** FR-R3-080 — refusal codes awaiting a phase end to report them. */
  private readonly pathRefusals = new Set<string>();

  private readonly listeners = new Set<EvidenceHealthListener>();
  private readonly now: () => Date;
  private sinks: Record<EvidenceSinkName, EvidenceSinkHealth> = healthySinks();

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  /**
   * FR-R3-080 (T1075) — refusal codes recorded since the last drain.
   *
   * Drained rather than read, and drained by the phase runner at phase end, so
   * each refusal is reported against the phase it happened in and is not
   * repeated on every phase after it. A `Set`, so a sink refusing on every line
   * of output contributes one warning rather than ten thousand.
   */
  public drainPathRefusals(): readonly string[] {
    const drained = [...this.pathRefusals];
    this.pathRefusals.clear();
    return drained;
  }

  public reportFailure(sink: EvidenceSinkName, cause: string): boolean {
    const previous = this.sinks[sink];
    const normalizedCause = normalizeEvidenceFailureCause(cause);
    if (normalizedCause === 'path-refused') this.pathRefusals.add(pathRefusedWarning(sink));
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
    // FR-R3-106 (FR-075) — the drop counts ride along, and deliberately do NOT feed
    // `overall`. A drop means the transcript is incomplete, not that a sink is failing: the
    // cap did its job and the run continued. Folding it into `overall` would put the whole
    // surface amber for a working system, which is how a status people learn to ignore gets
    // made.
    return Object.freeze({ overall, ...this.sinks, transportDrops: this.transportDrops });
  }

  /**
   * Record the transport sink's current refusal counts.
   *
   * Absolute values rather than a delta, because the sink already keeps a cumulative total
   * and two counters that must be kept in step is how they come to disagree. Called from
   * wherever the sink is observed; until then the reported value is zero, which is the
   * truthful reading of "the sink has refused nothing that anyone has told us about".
   */
  public noteTransportDrops(counts: TransportDropCounts): void {
    if (
      counts.lines === this.transportDrops.lines &&
      counts.bytes === this.transportDrops.bytes
    ) {
      return;
    }
    this.transportDrops = { lines: counts.lines, bytes: counts.bytes };
    this.notify();
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
    case 'path-refused':
      // FR-R3-080 (T1075) — a REFUSAL, not a failure, and the distinction is the
      // whole point of the round that added it: `io-error` says the write was
      // attempted and went wrong, and this says the write never ran because the
      // path could not be proven. Folding the two would tell an operator to look
      // at their disk when they should be looking at their tree. Carries no path,
      // like every case here.
      return raw;
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
