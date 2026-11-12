/**
 * FR-R6-F11 (FR-003, FR-010; research R10, R11) — the live report registry.
 *
 * One registry per engine owns the three F03 bounds of its workspace: the historical-query
 * admission gate, the working-data budget and the live-report lease table.
 *
 * - Admission: `executing` proceeds; `waiting` awaits the slot `complete()` hands over; `busy` and
 *   `limited` refuse `query-busy` and `query-limited`. An abort while waiting leaves the queue.
 * - Working data: a query reserves its estimate into a tally before it keeps rows; a refused
 *   reservation releases the whole tally and ends `limited` with `working-data`.
 * - Leases: a report registers after its capture succeeds. The registry sweeps its own expired
 *   reports before every acquire, because the lease table evicts expired leases silently and the
 *   budget each one holds would otherwise never be released. Every use checks the lease; an
 *   expired one evicts the report, releases its budget and answers `expired`.
 *
 * The population digest (R10) is the SHA-256 of the canonical, key-sorted JSON lines of the
 * source rows, in identity order. The working-data estimate is string length × 2 plus 64 bytes
 * per row (R11).
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { createHash } from 'node:crypto';
import {
  reportCancelled,
  reportExpired,
  reportLimited,
  reportOk,
  reportRefused,
  type ReportResult
} from '../../contracts/reporting/report-outcomes';
import type { ReportQuery } from '../../contracts/reporting/report-query';
import type {
  AttemptAcpAttribution,
  AttemptHandoffSummary,
  LegacyUsageSummary,
  ReportCoverage,
  ReportEvidenceReference,
  ReportOmission,
  ReportRow,
  RootReviewLoopSummary,
  TimeBasis
} from '../../contracts/reporting/report-rows';
import {
  HistoricalQueryAdmissionGate,
  HistoricalQueryWorkingDataBudget,
  LiveReportLeaseTable
} from '../runtime-resource-budgets/common-bound-references';
import type { RowSlicer } from './report-aggregates';
import type { CursorTarget } from './report-cursor';
import type { SnapshotAttempt, SnapshotRoot } from './snapshot-capture';

/** Bytes per UTF-16 code unit in the working-data estimate (R11). */
const UTF16_BYTES = 2;
/** Fixed bytes per row in the working-data estimate (R11). */
const ROW_OVERHEAD_BYTES = 64;

/** A captured, aggregated report, frozen for its lease lifetime. */
export interface LiveReport {
  readonly reportId: string;
  readonly query: ReportQuery;
  readonly queryDigest: string;
  readonly populationDigest: string;
  readonly sourceCutoffMs: number;
  readonly accountingRevision: number | null;
  readonly calculationVersion: number;
  /** Run-derived views only; drill-down reads them. */
  readonly roots: readonly SnapshotRoot[];
  readonly attempts: readonly SnapshotAttempt[];
  readonly evidenceRefs?: readonly ReportEvidenceReference[];
  readonly acpAttributions?: readonly AttemptAcpAttribution[];
  readonly handoffSummaries?: readonly AttemptHandoffSummary[];
  readonly reviewSummaries?: readonly RootReviewLoopSummary[];
  readonly rows: readonly ReportRow[];
  readonly coverage: ReportCoverage;
  readonly timeBasis: TimeBasis;
  readonly omissions: readonly ReportOmission[];
  readonly legacy?: LegacyUsageSummary;
  /** The saved report this one re-runs (research R10). */
  readonly rerunOf?: string;
}

/** The bounds a registry is built with; an absent bound takes the F03 default. */
export interface ReportSnapshotBounds {
  readonly maxExecuting?: number;
  readonly maxWaiting?: number;
  readonly maxQueuedParameterBytes?: number;
  readonly workingDataBytes?: number;
  readonly maxLeases?: number;
  readonly leaseLifetimeMs?: number;
}

/** The bytes one query has reserved so far; the registry owns it once the report registers. */
export interface ReservationTally {
  bytes: number;
}

/** An admitted query's slot; `release` is idempotent and hands the slot to the next waiter. */
export interface AdmissionSlot {
  release(): void;
}

export interface ReportResources {
  readonly executing: number;
  readonly waiting: number;
  readonly reservedBytes: number;
  readonly liveReports: number;
}

export interface PopulationMeasure {
  readonly digest: string;
  readonly bytes: number;
}

interface HeldReport {
  readonly report: LiveReport;
  readonly reservedBytes: number;
  readonly expiresAtMs: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The UTF-16 code units of every string value in `value`, nested ones included; keys are not counted. */
function stringUnits(value: unknown): number {
  if (typeof value === 'string') {
    return value.length;
  }
  if (value === null || typeof value !== 'object') {
    return 0;
  }
  let units = 0;
  for (const inner of Object.values(value)) {
    units += stringUnits(inner);
  }
  return units;
}

/** The JSON of `value` with every object's keys in sorted order. */
export function canonicalLine(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (!isPlainRecord(inner)) {
      return inner;
    }
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(inner).sort()) {
      sorted[key] = inner[key];
    }
    return sorted;
  });
}

/**
 * The population digest (R10) and working-data estimate (R11) of `groups`, visited in order
 * through the slicer: one canonical line per item is hashed, and each row is estimated at its
 * string values' code units × 2 plus 64 bytes; keys, numbers and JSON punctuation are not counted.
 */
export async function measurePopulation(
  groups: readonly (readonly unknown[])[],
  slicer: RowSlicer
): Promise<ReportResult<PopulationMeasure>> {
  const hash = createHash('sha256');
  let bytes = 0;
  for (const items of groups) {
    const visited = await slicer.forEach(items, (item) => {
      const line = canonicalLine(item);
      hash.update(line, 'utf8');
      hash.update('\n', 'utf8');
      bytes += stringUnits(item) * UTF16_BYTES + ROW_OVERHEAD_BYTES;
    });
    if (!visited.ok) {
      return visited;
    }
  }
  return reportOk(Object.freeze({ digest: hash.digest('hex'), bytes }));
}

/** The live reports of one workspace, with the admission, budget and lease bounds they share. */
export class ReportSnapshots {
  private readonly gate: HistoricalQueryAdmissionGate;
  private readonly budget: HistoricalQueryWorkingDataBudget;
  private readonly leases: LiveReportLeaseTable;
  private readonly waiters = new Map<string, () => void>();
  private readonly live = new Map<string, HeldReport>();

  constructor(bounds: ReportSnapshotBounds = {}) {
    this.gate = new HistoricalQueryAdmissionGate(bounds);
    this.budget = new HistoricalQueryWorkingDataBudget(
      bounds.workingDataBytes === undefined ? {} : { maxBytes: bounds.workingDataBytes }
    );
    this.leases = new LiveReportLeaseTable(bounds);
  }

  /** Admits a query, waiting for a slot when every slot is taken. */
  admit(queryId: string, parameterBytes: number, signal?: AbortSignal): Promise<ReportResult<AdmissionSlot>> {
    const outcome = this.gate.submit({ queryId, parameterBytes });
    if (outcome.status === 'busy') {
      return Promise.resolve(reportRefused('query-busy'));
    }
    if (outcome.status === 'limited') {
      return Promise.resolve(reportRefused('query-limited'));
    }
    const slot = this.slotOf(queryId);
    if (outcome.status === 'executing') {
      return Promise.resolve(reportOk(slot));
    }
    return new Promise((resolve) => {
      const onAbort = (): void => {
        if (this.gate.cancel(queryId)) {
          this.waiters.delete(queryId);
          resolve(reportCancelled());
        }
      };
      this.waiters.set(queryId, () => {
        signal?.removeEventListener('abort', onAbort);
        resolve(reportOk(slot));
      });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Adds `bytes` to the tally; a refusal releases the whole tally. */
  reserve(tally: ReservationTally, bytes: number): ReportResult<undefined> {
    if (this.budget.reserve(bytes).status !== 'reserved') {
      this.releaseTally(tally);
      return reportLimited('working-data');
    }
    tally.bytes += bytes;
    return reportOk(undefined);
  }

  /** Releases whatever the tally still holds; a no-op once the report registered. */
  releaseTally(tally: ReservationTally): void {
    this.budget.release(tally.bytes);
    tally.bytes = 0;
  }

  /** True when a new report could take a lease now. */
  hasLeaseRoom(nowMs: number): boolean {
    this.sweep(nowMs);
    const state = this.leases.state;
    return state.activeLeases < state.maxLeases;
  }

  /** Takes a lease for the report and moves the tally's bytes to it. */
  register(report: LiveReport, tally: ReservationTally, nowMs: number): ReportResult<undefined> {
    this.sweep(nowMs);
    const acquired = this.leases.acquire(report.reportId, nowMs);
    if (acquired.status !== 'acquired') {
      this.releaseTally(tally);
      return reportRefused('report-lease-limit');
    }
    this.live.set(report.reportId, { report, reservedBytes: tally.bytes, expiresAtMs: acquired.lease.expiresAtMs });
    tally.bytes = 0;
    return reportOk(undefined);
  }

  /** The live report behind a lease that is still valid; an expired one is evicted. */
  use(reportId: string, nowMs: number): ReportResult<LiveReport> {
    const held = this.live.get(reportId);
    const lease = this.leases.useLease(reportId, nowMs);
    if (held === undefined || lease.status !== 'active') {
      this.evict(reportId);
      return reportExpired();
    }
    return reportOk(held.report);
  }

  /** What a cursor naming `reportId` is checked against. */
  lookup(reportId: string): CursorTarget | undefined {
    const held = this.live.get(reportId);
    return held === undefined ? undefined : { queryDigest: held.report.queryDigest, rowCount: held.report.rows.length };
  }

  /** Releases a report's lease and budget; false when it is not live. */
  close(reportId: string): boolean {
    if (!this.live.has(reportId)) {
      return false;
    }
    this.evict(reportId);
    return true;
  }

  /** Evicts every report whose lease has expired, releasing its budget. */
  sweep(nowMs: number): void {
    for (const [reportId, held] of [...this.live.entries()]) {
      if (nowMs > held.expiresAtMs) {
        this.evict(reportId);
      }
    }
  }

  resources(): ReportResources {
    const gate = this.gate.state;
    return Object.freeze({
      executing: gate.executingCount,
      waiting: gate.waitingCount,
      reservedBytes: this.budget.state.allocatedBytes,
      liveReports: this.live.size
    });
  }

  private evict(reportId: string): void {
    const held = this.live.get(reportId);
    this.live.delete(reportId);
    this.leases.release(reportId);
    if (held !== undefined) {
      this.budget.release(held.reservedBytes);
    }
  }

  private slotOf(queryId: string): AdmissionSlot {
    let released = false;
    return {
      release: () => {
        if (!released) {
          released = true;
          this.finish(queryId);
        }
      }
    };
  }

  /** Completes a slot and wakes the waiter it is handed to. */
  private finish(queryId: string): void {
    const promoted = this.gate.complete(queryId);
    if (promoted === null) {
      return;
    }
    const wake = this.waiters.get(promoted);
    this.waiters.delete(promoted);
    if (wake === undefined) {
      this.finish(promoted);
      return;
    }
    wake();
  }
}
