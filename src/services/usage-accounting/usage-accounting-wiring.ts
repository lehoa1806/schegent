/**
 * FR-R6-F06 (T026, FR-015, NFR-006, contracts/surfaces-and-wiring.md section 1, research R9) —
 * the one place the accounting service meets the audit stream and the terminal coordinator.
 *
 * ADMISSION. The audit subscriber runs inside the audit writer's append. It only copies: the
 * correlator turns a `phase-end` row into a frozen snapshot, which goes onto a bounded queue,
 * and the subscriber returns. Past the bound the newest snapshot is dropped and counted as an
 * `admission-overflow` gap. Every other row is ignored, after the correlator has noted the
 * runner and model a `cli-invocation` row carries.
 *
 * TERMINAL RUNS. `onTerminalRun` maps the run status to a root outcome (`completed` to
 * `succeeded`, `failed`, `canceled` to `cancelled`; any other status is not terminal and is
 * ignored) and enqueues it on the same bounded queue (T047). A run with no end time is
 * stamped with the wiring clock when it is enqueued.
 *
 * DRAIN. One drain is scheduled per burst, on `setImmediate`. It ingests each snapshot, and
 * records each root outcome, through the facade. A thrown error, or a refusal whose gap the
 * store did not already count, counts an `ingest-failed` gap.
 *
 * GAPS. Counts are held in memory and flushed to the store at the end of each drain. A flush
 * the store refuses keeps its count for the next drain, so a count is never lost to the very
 * failure it describes.
 *
 * FAILURE. Nothing here throws into the audit writer or the terminal coordinator. A log line
 * carries `operation` and `errorCode` only.
 *
 * A `null` service, which is production until the F01-B cutover, subscribes nothing.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { AuditEntry } from '../../audit/audit-entry';
import type {
  AccountingRefusalCode,
  AccountingResult,
  GapKind,
  RootOutcome
} from '../../contracts/usage-accounting/accounting-types';
import { historyErrorCode } from '../history/error-code';
import { PhaseEndCorrelator, type PhaseEndSnapshot } from './phase-end-ingestion';
import type { AccountingLogger, UsageAccountingService } from './usage-accounting-service';

/** The admission queue bound (contracts/surfaces-and-wiring.md section 1). */
export const DEFAULT_ADMISSION_QUEUE_BOUND = 256;

const LOG_MESSAGE = 'usage-accounting: wiring failure';

/**
 * Refusals whose gap the store already committed. Any other refusal of a row the wiring admitted
 * is counted here as `ingest-failed`, so no admitted row is lost without a gap (FR-015).
 */
const STORE_COUNTED_REFUSALS: ReadonlySet<AccountingRefusalCode> = new Set<AccountingRefusalCode>([
  'invalid-counter',
  'observation-too-large',
  'telemetry-echo',
  'expired-source',
  'unattributed-limit',
  'projection-backlog-full',
  'store-full'
]);

export interface WiringDisposable {
  dispose(): void;
}

/** What the terminal coordinator hands over: identifiers and times, nothing else. */
export interface TerminalRunSummary {
  readonly runId: string;
  readonly status: string;
  readonly endedAtMs: number | null;
}

export interface UsageAccountingWiringInput {
  readonly service: UsageAccountingService | null;
  readonly auditWriter: { subscribe(listener: (entry: AuditEntry) => void): WiringDisposable };
  readonly subscriptions: { push(disposable: WiringDisposable): void };
  readonly logger: AccountingLogger;
  /** Tests only. */
  readonly queueBound?: number | undefined;
  /** Tests only; defaults to `setImmediate`. */
  readonly schedule?: ((drain: () => void) => void) | undefined;
  /** Tests only; stamps a terminal run with no end time. Defaults to the wall clock. */
  readonly nowUtc?: (() => string) | undefined;
}

export interface UsageAccountingWiring {
  onTerminalRun(run: TerminalRunSummary): void;
  dispose(): void;
}

const NOOP_WIRING: UsageAccountingWiring = Object.freeze({
  onTerminalRun: () => undefined,
  dispose: () => undefined
});

const ROOT_OUTCOME_BY_RUN_STATUS: ReadonlyMap<string, RootOutcome> = new Map([
  ['completed', 'succeeded'],
  ['failed', 'failed'],
  ['canceled', 'cancelled']
]);

interface RootOutcomeItem {
  readonly kind: 'root-outcome';
  readonly rootId: string;
  readonly outcome: RootOutcome;
  readonly terminalUtc: string;
}

type AdmittedItem = { readonly kind: 'phase-end'; readonly snapshot: PhaseEndSnapshot } | RootOutcomeItem;

function scheduleImmediate(drain: () => void): void {
  setImmediate(drain);
}

function wallClockUtc(): string {
  return new Date().toISOString();
}

function terminalUtcOf(endedAtMs: number | null, nowUtc: () => string): string {
  return endedAtMs !== null && Number.isFinite(endedAtMs) ? new Date(endedAtMs).toISOString() : nowUtc();
}

export function createUsageAccountingWiring(input: UsageAccountingWiringInput): UsageAccountingWiring {
  if (input.service === null) return NOOP_WIRING;
  const service: UsageAccountingService = input.service;

  const bound = input.queueBound ?? DEFAULT_ADMISSION_QUEUE_BOUND;
  const schedule = input.schedule ?? scheduleImmediate;
  const nowUtc = input.nowUtc ?? wallClockUtc;
  const correlator = new PhaseEndCorrelator();
  const queue: AdmittedItem[] = [];
  const pendingGaps = new Map<GapKind, number>();
  let drainScheduled = false;
  let disposed = false;

  function log(operation: string, error: unknown): void {
    try {
      input.logger.warn(LOG_MESSAGE, { operation, errorCode: historyErrorCode(error) });
    } catch {
      // A failing sink must not turn a counted gap into a throw.
    }
  }

  function countGap(kind: GapKind): void {
    pendingGaps.set(kind, (pendingGaps.get(kind) ?? 0) + 1);
  }

  function requestDrain(): void {
    if (drainScheduled || disposed) return;
    drainScheduled = true;
    schedule(drain);
  }

  function apply(item: AdmittedItem, accounting: UsageAccountingService): void {
    const operation = item.kind === 'phase-end' ? 'ingestPhaseEnd' : 'recordRootOutcome';
    try {
      const result: AccountingResult<unknown> =
        item.kind === 'phase-end'
          ? accounting.ingestPhaseEnd(item.snapshot)
          : accounting.recordRootOutcome({ rootId: item.rootId, outcome: item.outcome, terminalUtc: item.terminalUtc });
      if (!result.ok && !STORE_COUNTED_REFUSALS.has(result.refusal.code)) countGap('ingest-failed');
    } catch (error) {
      countGap('ingest-failed');
      log(operation, error);
    }
  }

  function admit(item: AdmittedItem): void {
    if (queue.length >= bound) {
      countGap('admission-overflow');
    } else {
      queue.push(item);
    }
    requestDrain();
  }

  function flushGaps(accounting: UsageAccountingService): void {
    for (const [kind, count] of [...pendingGaps]) {
      try {
        if (accounting.recordGaps(kind, count).ok) pendingGaps.delete(kind);
      } catch (error) {
        log('recordGaps', error);
      }
    }
  }

  function drain(): void {
    drainScheduled = false;
    if (disposed) return;
    for (const item of queue.splice(0, queue.length)) apply(item, service);
    flushGaps(service);
  }

  function onAuditEntry(entry: AuditEntry): void {
    try {
      const snapshot = correlator.observe(entry);
      if (snapshot === undefined) return;
      admit({ kind: 'phase-end', snapshot });
    } catch (error) {
      countGap('ingest-failed');
      log('admitPhaseEnd', error);
    }
  }

  const subscription = input.auditWriter.subscribe(onAuditEntry);

  const wiring: UsageAccountingWiring = {
    onTerminalRun(run) {
      if (disposed) return;
      try {
        const outcome = ROOT_OUTCOME_BY_RUN_STATUS.get(run.status);
        if (outcome === undefined) return;
        admit({ kind: 'root-outcome', rootId: run.runId, outcome, terminalUtc: terminalUtcOf(run.endedAtMs, nowUtc) });
      } catch (error) {
        countGap('ingest-failed');
        log('admitRootOutcome', error);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      queue.length = 0;
      pendingGaps.clear();
      subscription.dispose();
    }
  };
  input.subscriptions.push({ dispose: () => wiring.dispose() });
  return wiring;
}
