// FR-R4-F04 (FR-001 to FR-008, contract X1, X2, X5, X6, X9; data-model §3, §4) — where each line of CLI
// output goes, and what a Run's end and a maintenance pass do to what was kept.
//
// The sink formats and redacts a line, then hands it here. The router decides, per record and from
// settings read on that record (X1, hard rule 24), whether it is kept at all:
//
//   - `off`: the line is dropped. It was already formatted and passed through the redactor, so the
//     redactor's state has advanced and a later switch to `on` cannot leak the second half of a key
//     block (X2); the router simply writes nothing.
//   - `errors-only`: the line is appended to the Run's stage file in the OS temp area, which survives a
//     host crash. It reaches `.schegent/` only if the Run fails or is canceled (`finalizeRun`, or a pass
//     that finds the Run failed after a crash).
//   - `on`: the line is appended to the Run's file under `.schegent/sessions/<runId>/`.
//
// Every append first applies the bounds (X4): a record longer than the file bound becomes a placeholder,
// and a file that would pass the size bound, or whose oldest record is past the age bound, is compacted.
//
// WHY ONE QUEUE. `route`, `finalizeRun` and `runPass` all mutate the same files, and a Run's end must
// come after every line the sink accepted for it. Each is queued the moment it is called, so the order
// the sink's `record()` saw lines in is the order they are written in, and a Run's end that arrives
// while lines are still queued waits for them instead of promoting a stage that is still growing.
//
// The router never throws into its callers. `route` is fire-and-forget from the monitor's hot path and
// `finalizeRun` runs inside `onRunTerminal`, ahead of the raw transcript finalize and the retention
// sweep, so a failure here is reported once per cause, path-free, and the Run goes on (X5). It never
// imports the audit writer (X9): transport is not audit.

import type { TransportUsage } from '../../contracts/sidebar-ipc/transport-usage';
import type { SanitizedLogger } from '../../lib/logger';
import type { EvidenceHealthReporter } from '../../services/evidence-health/evidence-health-monitor';
import type { RawTranscriptMode, WorkflowRunStatus } from '../../state/workflow-run';
import type { CliTransportRecord } from '../cli-transport-sink';
import {
  RunTransportStore,
  TransportStoreError,
  type LegacyEntry,
  type TransportTarget
} from './run-transport-store';
import { resolveTransportCaptureMode, type TransportCaptureMode } from '../../contracts/transport-capture-mode';
import {
  TRANSPORT_COMPACT_TARGET_BYTES,
  TRANSPORT_FILE_MAX_BYTES,
  selectTotalRemovals,
  transportPlaceholder,
  type TotalCandidate
} from './transport-policy';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** The session retention age's default, used only if the setting reads as something that is not a positive number. */
const FALLBACK_MAX_AGE_DAYS = 30;

export interface TransportRouterDeps {
  /** The workspace to write under, read per record; `null` means there is no destination right now. */
  readonly workspaceRoot: () => string | null;
  /** `schegent.logging.transportCaptureMode`, raw, read uncached (hard rule 24). */
  readonly readSetting: () => unknown;
  /** `schegent.logging.rawTranscriptMode`, read uncached; `inherit` follows it. */
  readonly readRawTranscriptMode: () => RawTranscriptMode;
  /** The session retention age in days, read per check; record age is bounded by it. */
  readonly readMaxAgeDays: () => number;
  /** The OS temp root the stage lives under. */
  readonly tempRoot: string;
  /** A Run's status as the store knows it, for pass reconciliation; `undefined` for an unknown Run. */
  readonly runStatus: (runId: string) => WorkflowRunStatus | undefined;
  readonly logger: Pick<SanitizedLogger, 'warn'>;
  /** Injected for tests; defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * The file layer. Production supplies none and the router builds its own over `tempRoot`; a test
   * passes a store whose methods fail on demand, the way a full or read-only disk cannot be made to on
   * a real filesystem, to prove a failure is reported once and never reaches the Run.
   */
  readonly store?: RunTransportStore;
  /** FR-R5-F13 (FR-008, NS-05) — optional evidence-health reporter for the `transport` sink. */
  readonly evidenceHealth?: EvidenceHealthReporter;
}

/** What a maintenance pass did, as counts only. */
export interface TransportPassReport {
  /** Files removed whole: expired legacy generations, files over the total, emptied compactions. */
  readonly removed: number;
  readonly compacted: number;
  /** Stage files promoted to their Run file. */
  readonly promoted: number;
  /** Stage files removed without promotion. */
  readonly discarded: number;
  /** Bytes of the files removed whole. */
  readonly bytes: number;
}

interface Counters {
  removed: number;
  compacted: number;
  promoted: number;
  discarded: number;
  bytes: number;
}

const newCounters = (): Counters => ({ removed: 0, compacted: 0, promoted: 0, discarded: 0, bytes: 0 });

function causeOf(error: unknown): string {
  if (error instanceof TransportStoreError) return error.code;
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(code)) return code;
  }
  return 'unknown';
}

/** Routes each CLI stream line to the Run's file or the stage by the capture mode, and runs the Run-end and maintenance passes. */
export class TransportRouter {
  private readonly store: RunTransportStore;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly reported = new Set<string>();
  private cachedUsage: TransportUsage | null = null;
  private cachedLegacyAgesOutBy: string | null = null;

  constructor(private readonly deps: TransportRouterDeps) {
    this.store =
      deps.store ??
      new RunTransportStore({
        tempRoot: deps.tempRoot,
        warn: (message) => this.emit(message)
      });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * The effective mode, resolved for this one call and never held (X1). A reader that throws means the
   * setting could not be read, and an unreadable setting resolves to `off`: capture that was not asked
   * for is the worse failure.
   */
  private mode(): TransportCaptureMode {
    try {
      return resolveTransportCaptureMode(this.deps.readSetting(), this.deps.readRawTranscriptMode());
    } catch {
      return 'off';
    }
  }

  private maxAgeMs(): number {
    const days = this.deps.readMaxAgeDays();
    return (Number.isFinite(days) && days > 0 ? days : FALLBACK_MAX_AGE_DAYS) * MS_PER_DAY;
  }

  /** How many append descriptors the router holds, for the sink's disposal accounting. */
  get openDescriptorCount(): number {
    return this.store.openDescriptorCount;
  }

  // ---------------------------------------------------------------------------------------------
  // Serialization and reporting
  // ---------------------------------------------------------------------------------------------

  /** Queue `operation` behind everything already queued. The operation must not reject. */
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.tail.then(operation);
    this.tail = next;
    return next;
  }

  /** The one place the logger is called, so a logger that throws cannot fail a Run. */
  private emit(message: string): void {
    try {
      this.deps.logger.warn(message);
    } catch {
      // Nothing left to report it to.
    }
  }

  /** One warning per (operation, cause), never naming a path. */
  private report(operation: 'record' | 'retention', error: unknown): void {
    const cause = causeOf(error);
    if (cause !== 'disposed' || !this.closed) {
      this.deps.evidenceHealth?.reportFailure('transport', cause);
    }
    const key = `${operation}:${cause}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.emit(
      operation === 'record'
        ? `[cli-transport] could not record CLI output (${cause}); the phase is unaffected and the lines are still in the phase diagnostics.`
        : `[cli-transport] could not apply transport retention (${cause}); the Run is unaffected and the next pass retries.`
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Records
  // ---------------------------------------------------------------------------------------------

  /**
   * Route one formatted record (X1, X2, X4). `line` is the sink's formatted, redacted record, newline
   * included. Resolves when the record is written or dropped; never rejects.
   */
  route(entry: CliTransportRecord, line: string): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.routeNow(entry, line);
      } catch (error) {
        this.report('record', error);
      }
    });
  }

  private async routeNow(entry: CliTransportRecord, line: string): Promise<void> {
    if (this.closed) return;
    const root = this.deps.workspaceRoot();
    if (root === null) return;
    const mode = this.mode();
    if (mode === 'off') return;
    await this.store.narrowLegacy(root);
    const target: TransportTarget = {
      kind: mode === 'on' ? 'run' : 'stage',
      workspaceRoot: root,
      runId: entry.runId
    };
    const data = Buffer.byteLength(line, 'utf8') > TRANSPORT_FILE_MAX_BYTES ? transportPlaceholder(line) : line;
    await this.applyBounds(target, Buffer.byteLength(data, 'utf8'));
    await this.store.append(target, data);
    this.reported.clear();
    this.deps.evidenceHealth?.reportSuccess('transport');
  }

  /**
   * The bounds before an append (X4). The size bound compacts to half the bound so the next compaction
   * is far off; an age-only compaction keeps everything still inside the age bound, because a file
   * within its size bound has nothing to shed for size.
   */
  private async applyBounds(target: TransportTarget, incomingBytes: number): Promise<void> {
    const state = await this.store.stateOf(target);
    const now = this.now();
    const maxAgeMs = this.maxAgeMs();
    const overSize = state.bytes + incomingBytes > TRANSPORT_FILE_MAX_BYTES;
    const aged = state.oldestMs !== null && now - state.oldestMs > maxAgeMs;
    if (!overSize && !aged) return;
    const room = TRANSPORT_FILE_MAX_BYTES - incomingBytes;
    const keep = overSize ? Math.min(TRANSPORT_COMPACT_TARGET_BYTES, room) : room;
    await this.store.compact(target, now, maxAgeMs, keep);
  }

  // ---------------------------------------------------------------------------------------------
  // A Run's end (X5)
  // ---------------------------------------------------------------------------------------------

  /**
   * Apply data-model §3's end table to a Run, then enforce the workspace total and record usage. Called
   * from `onRunTerminal` before the raw transcript's own finalize. Never throws.
   */
  finalizeRun(
    runId: string,
    status: WorkflowRunStatus,
    activeRunIds: ReadonlySet<string>
  ): Promise<void> {
    return this.enqueue(async () => {
      try {
        const root = this.deps.workspaceRoot();
        if (root === null || this.closed) return;
        const counters = newCounters();
        await this.applyEnd(root, runId, status, this.mode(), counters);
        await this.enforceTotal(root, activeRunIds, counters);
        await this.measureNow(root);
        this.reported.clear();
        this.deps.evidenceHealth?.reportSuccess('transport');
      } catch (error) {
        this.report('retention', error);
      } finally {
        await this.store.releaseRun(runId).catch(() => undefined);
      }
    });
  }

  /**
   * The end table. `paused` is not an end. A clean completion removes the stage, and under `errors-only`
   * the Run file too (a resumed Run that now ends clean keeps nothing). A failed or canceled Run has its
   * stage promoted when the mode keeps anything, and discarded when it is `off`.
   */
  private async applyEnd(
    root: string,
    runId: string,
    status: WorkflowRunStatus,
    mode: TransportCaptureMode,
    counters: Counters
  ): Promise<void> {
    if (status === 'completed') {
      if (await this.store.discardStage(root, runId)) counters.discarded += 1;
      if (mode === 'errors-only' && (await this.store.removeRunFile(root, runId))) counters.removed += 1;
      return;
    }
    if (status !== 'failed' && status !== 'canceled') return;
    if (mode === 'off') {
      if (await this.store.discardStage(root, runId)) counters.discarded += 1;
      return;
    }
    if (await this.store.promote(root, runId)) {
      counters.promoted += 1;
      await this.applyBounds({ kind: 'run', workspaceRoot: root, runId }, 0);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // The total, usage
  // ---------------------------------------------------------------------------------------------

  /**
   * While the Run files and legacy generations together pass the workspace total, remove the inactive
   * one whose newest record is oldest (data-model §4). An active Run's file is never a candidate.
   */
  private async enforceTotal(
    root: string,
    activeRunIds: ReadonlySet<string>,
    counters: Counters
  ): Promise<void> {
    const runFiles = await this.store.listRunFiles(root);
    const legacy = await this.store.listLegacy(root);
    const candidates: TotalCandidate[] = [
      ...runFiles.map((file) => ({
        id: `run:${file.runId}`,
        bytes: file.bytes,
        newestMs: file.newestMs,
        active: activeRunIds.has(file.runId)
      })),
      ...legacy.map((entry) => ({
        id: `legacy:${entry.name}`,
        bytes: entry.bytes,
        newestMs: entry.newestMs,
        active: false
      }))
    ];
    const bytesById = new Map(candidates.map((candidate) => [candidate.id, candidate.bytes]));
    for (const id of selectTotalRemovals(candidates)) {
      const removed = id.startsWith('run:')
        ? await this.store.removeRunFile(root, id.slice('run:'.length))
        : await this.removeLegacyNamed(root, legacy, id.slice('legacy:'.length));
      if (removed) {
        counters.removed += 1;
        counters.bytes += bytesById.get(id) ?? 0;
      }
    }
  }

  private async removeLegacyNamed(
    root: string,
    legacy: readonly LegacyEntry[],
    name: string
  ): Promise<boolean> {
    const entry = legacy.find((candidate) => candidate.name === name);
    return entry === undefined ? false : this.store.removeLegacy(root, entry);
  }

  /** Measure the Run files and legacy generations and cache the result (data-model §4). */
  private async measureNow(root: string): Promise<void> {
    const runFiles = await this.store.listRunFiles(root);
    const legacy = await this.store.listLegacy(root);
    const now = this.now();
    const maxAgeMs = this.maxAgeMs();
    const newestOf = (times: readonly number[]): number | null => (times.length === 0 ? null : Math.max(...times));
    const latest = newestOf([...runFiles.map((file) => file.newestMs), ...legacy.map((entry) => entry.newestMs)]);
    const legacyNewest = newestOf(legacy.map((entry) => entry.newestMs));
    const legacyBytes = legacy.reduce((sum, entry) => sum + entry.bytes, 0);
    this.cachedLegacyAgesOutBy = legacyNewest === null ? null : new Date(legacyNewest + maxAgeMs).toISOString();
    this.cachedUsage = {
      version: 1,
      retainedBytes: runFiles.reduce((sum, file) => sum + file.bytes, 0) + legacyBytes,
      runCount: runFiles.length,
      legacyBytes,
      agesOutBy: latest === null ? null : new Date(latest + maxAgeMs).toISOString(),
      measuredAt: new Date(now).toISOString()
    };
  }

  /** Measure on demand, for a caller that needs a current answer (the deletion's kept-store list). */
  measure(): Promise<void> {
    return this.enqueue(async () => {
      try {
        const root = this.deps.workspaceRoot();
        if (root !== null && !this.closed) await this.measureNow(root);
      } catch (error) {
        this.report('retention', error);
      }
    });
  }

  /** The last measure, or `null` before the first Run end, pass or `measure()` (data-model §4). */
  usage(): TransportUsage | null {
    return this.cachedUsage;
  }

  /**
   * When the legacy generations age out: the newest legacy record plus the age bound, or `null` when
   * none exists (contract D5). From the last measure, so it is as current as `usage()`.
   */
  legacyAgesOutBy(): string | null {
    return this.cachedLegacyAgesOutBy;
  }

  // ---------------------------------------------------------------------------------------------
  // The maintenance pass (X6)
  // ---------------------------------------------------------------------------------------------

  /**
   * One maintenance pass, in X6's order, each step reported and survived on its own: reconcile stages
   * by their Run's known status, age-compact inactive Run files and every stage, expire legacy
   * generations, enforce the total, narrow legacy generations, record usage. Returns counts only.
   */
  runPass(activeRunIds: ReadonlySet<string>): Promise<TransportPassReport> {
    const counters = newCounters();
    const done = this.enqueue(async () => {
      const root = this.deps.workspaceRoot();
      if (root === null || this.closed) return;
      // A count, not a boolean: the closure's assignment is invisible to narrowing.
      let failedSteps = 0;
      const step = async (operation: () => Promise<void>): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          failedSteps += 1;
          this.report('retention', error);
        }
      };
      await step(() => this.reconcileStages(root, counters));
      await step(() => this.ageCompact(root, activeRunIds, counters));
      await step(() => this.expireLegacy(root, counters));
      await step(() => this.enforceTotal(root, activeRunIds, counters));
      await step(() => this.store.narrowLegacy(root));
      await step(() => this.measureNow(root));
      if (failedSteps === 0) {
        this.reported.clear();
        this.deps.evidenceHealth?.reportSuccess('transport');
      }
    });
    return done.then(() => ({ ...counters }));
  }

  /** A stage whose Run is known to have ended gets the end rule; an unknown or active Run's is left. */
  private async reconcileStages(root: string, counters: Counters): Promise<void> {
    const mode = this.mode();
    for (const stage of await this.store.listStages(root)) {
      const status = this.deps.runStatus(stage.runId);
      if (status === 'completed' || status === 'failed' || status === 'canceled') {
        await this.applyEnd(root, stage.runId, status, mode, counters);
      }
    }
  }

  private async ageCompact(
    root: string,
    activeRunIds: ReadonlySet<string>,
    counters: Counters
  ): Promise<void> {
    const now = this.now();
    const maxAgeMs = this.maxAgeMs();
    const compact = async (target: TransportTarget): Promise<void> => {
      const result = await this.store.compact(target, now, maxAgeMs, TRANSPORT_FILE_MAX_BYTES);
      if (result.outcome === 'compacted') counters.compacted += 1;
      if (result.outcome === 'removed') counters.removed += 1;
    };
    for (const file of await this.store.listRunFiles(root)) {
      if (!activeRunIds.has(file.runId)) await compact({ kind: 'run', workspaceRoot: root, runId: file.runId });
    }
    for (const stage of await this.store.listStages(root)) {
      await compact({ kind: 'stage', workspaceRoot: root, runId: stage.runId });
    }
  }

  /** A legacy generation whose newest record is past the age bound is removed whole, never rewritten. */
  private async expireLegacy(root: string, counters: Counters): Promise<void> {
    const now = this.now();
    const maxAgeMs = this.maxAgeMs();
    for (const entry of await this.store.listLegacy(root)) {
      if (now - entry.newestMs <= maxAgeMs) continue;
      if (await this.store.removeLegacy(root, entry)) {
        counters.removed += 1;
        counters.bytes += entry.bytes;
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Disposal
  // ---------------------------------------------------------------------------------------------

  /**
   * Close every descriptor now and route nothing afterwards. It does not wait for queued work: the sink
   * has already drained what it could within its grace, and a stalled disk must not hold a descriptor
   * past the shutdown that asked for it back. Work still queued finds the store disposed and is dropped.
   */
  async dispose(): Promise<void> {
    this.closed = true;
    await this.store.dispose();
  }
}

/** Production and test construction. */
export function createTransportRouter(deps: TransportRouterDeps): TransportRouter {
  return new TransportRouter(deps);
}
