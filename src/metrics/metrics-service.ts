// Feature 073 — Metrics Dashboard audit-log reader (T009, T015).
//
// Derives Task Records and Phase Records from `.schegent/audit.log` (and,
// optionally, its rotated archives) on every `CMD_READ_METRICS` call. See
// specs/073-metrics-dashboard/data-model.md for the full field-derivation
// rules this module implements, and research.md §6 for the Phase Record
// outcome-precedence rationale.
//
// Task Records are derived two ways: directly from a
// `task-execution-started`/`task-execution-ended` pair (`source:
// 'task-lifecycle'`), or, for runIds with no such pair, reconstructed
// solely from grouped phase-level activity (`source: 'phase-reconstruction'`
// — data-model.md §1, T013/T015).

import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditEntry } from '../audit/audit-entry';
import { parseAuditLogLineDetailed } from '../parser/audit-log-parser';
import type {
  CostTimelinePoint,
  MetricsRunSummary,
  PhaseRecord,
  PhaseTypeAggregate,
  ReadMetricsResponse,
  TaskRecord
} from '../contracts/sidebar-ipc';
import type { SanitizedLogger } from '../lib/logger';
import type { MetricsRollupRecord } from './metrics-rollup';
import { buildMetricsCoverage, composeCumulativeTotals, toRunSummary } from './metrics-rollup';
import { readMetricsRollup } from './metrics-rollup-reader';

export interface ReadMetricsOptions {
  readonly includeArchives?: boolean;
  /**
   * Feature 103 (T093, FR-023, FR-025) — scope `runSummaries` to these runs.
   *
   * Omitted means the response is shaped exactly as it was before this feature
   * and carries no `runSummaries` at all. Bounded at the IPC boundary; nothing
   * here re-derives the bound, and nothing here writes.
   */
  readonly runIds?: readonly string[];
}

const ARCHIVE_PREFIX = 'audit.log.';
const ARCHIVE_STAMP_RE = /^\d{8}-\d{6}(?:-\d{3}-[0-9a-f]{8})?$/;

interface PhaseGroup {
  readonly runId: string;
  readonly phaseType: string;
  readonly iteration: number;
  readonly starts: AuditEntry[];
  readonly ends: AuditEntry[];
  readonly jumps: AuditEntry[];
  readonly breakpoints: AuditEntry[];
  readonly invocations: AuditEntry[];
}

interface ScanState {
  totalScannedEntries: number;
  parseWarnings: number;
  oldestTimestamp: { readonly ms: number; readonly raw: string } | undefined;
  // FR-R3-009 (T394): the retained corpus's upper bound, so the response can
  // state the detail window's range and not only where it starts.
  newestTimestamp: { readonly ms: number; readonly raw: string } | undefined;
  readonly taskStarted: Map<string, AuditEntry[]>;
  readonly taskEnded: Map<string, AuditEntry[]>;
  readonly phaseGroups: Map<string, PhaseGroup>;
}

interface MetricsCacheEntry {
  readonly files: readonly string[];
  readonly offsets: Map<string, number>;
  readonly state: ScanState;
}

const metricsCache = new Map<string, MetricsCacheEntry>();

export async function readMetrics(
  workspaceRoot: string,
  options: ReadMetricsOptions = {},
  logger?: SanitizedLogger
): Promise<ReadMetricsResponse> {
  const includeArchives = options.includeArchives ?? false;
  const auditDir = join(workspaceRoot, '.schegent');
  const { files, archivedScanSucceeded } = await listAuditFiles(auditDir, includeArchives, logger);

  const cacheKey = `${workspaceRoot}\0${includeArchives ? 'archives' : 'live'}`;
  let cache = metricsCache.get(cacheKey);
  const sameFiles = cache !== undefined &&
    cache.files.length === files.length &&
    cache.files.every((file, index) => file === files[index]);
  if (sameFiles && cache) {
    for (const file of files) {
      const priorOffset = cache?.offsets.get(file) ?? 0;
      try {
        if ((await stat(file)).size < priorOffset) cache = undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cache = undefined;
      }
    }
  } else {
    cache = undefined;
  }
  const state: ScanState = cache?.state ?? {
    totalScannedEntries: 0,
    parseWarnings: 0,
    oldestTimestamp: undefined,
    newestTimestamp: undefined,
    taskStarted: new Map(),
    taskEnded: new Map(),
    phaseGroups: new Map()
  };
  const offsets = cache?.offsets ?? new Map<string, number>();

  for (const file of files) {
    offsets.set(file, await scanFile(file, state, logger, offsets.get(file) ?? 0));
  }
  metricsCache.set(cacheKey, { files: [...files], offsets, state });

  const phasesByRunId = buildPhaseRecordsByRunId(state);
  const allPhases = [...phasesByRunId.values()].flat();
  const tasks = buildTaskRecords(state, phasesByRunId);
  tasks.sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));

  // FR-R3-009 (T392/T393) — cumulative totals are composed from the durable
  // rollup unioned with the terminal runs the retained corpus still shows,
  // deduplicated by run id so an overlapping range is counted once. The
  // per-phase detail above is untouched: it stays a pure fold over the retained
  // corpus, and the rollup is used only for totals. Nothing here writes to the
  // rollup or reconstructs a record for a day the corpus no longer covers —
  // there is no backfill path to take.
  const rollup = await readMetricsRollup(workspaceRoot, logger);
  const composed = composeCumulativeTotals(rollup.records, tasks, rollup.carryForward);

  // Feature 103 (T093, FR-025) — the run detail's cost and phase counts come
  // from the rollup and not from `tasks`. `tasks` is a fold over the retained
  // corpus, which rotates on a schedule of its own while History does not: a
  // run History still lists can have no `TaskRecord` at all, and joining there
  // would report "not reported" for a run whose cost was recorded perfectly
  // well. The records are already in hand for the totals above, so scoping
  // costs no additional read.
  const runSummaries =
    options.runIds === undefined
      ? undefined
      : projectRunSummaries(rollup.records, options.runIds);

  return {
    tasks,
    phaseTypeAggregates: buildPhaseTypeAggregates(allPhases),
    costTimeline: buildCostTimeline(allPhases),
    oldestIncludedTimestamp: state.oldestTimestamp?.raw,
    cumulative: composed.totals,
    coverage: buildMetricsCoverage({
      rollupAvailable: rollup.available,
      rollupRuns: composed.rollupRuns,
      rollupEarliest: composed.rollupEarliest,
      rollupLatest: composed.rollupLatest,
      logEarliest: state.oldestTimestamp?.raw,
      logLatest: state.newestTimestamp?.raw,
      includesArchives: archivedScanSucceeded
    }),
    // Spread rather than assigned, so a request that asked for nothing gets a
    // response with no such key — not a key holding `undefined`, which
    // `Object.hasOwn` and structured-clone both treat as present.
    ...(runSummaries === undefined ? {} : { runSummaries }),
    meta: {
      includesArchives: archivedScanSucceeded,
      totalScannedEntries: state.totalScannedEntries,
      // Kept scoped to the audit corpus. An unreadable rollup line is warned by
      // the reader instead of folded in here: an operator reading a nonzero
      // count needs to know which file to look at.
      parseWarnings: state.parseWarnings
    }
  };
}

/**
 * Feature 103 (T093) — the asked-for runs' rollup records, projected to the
 * wire shape.
 *
 * Deduplicated by run id, last write winning. The file is append-only and
 * nothing rewrites it, so a run id appearing twice means a second record was
 * appended for it; returning both would put two costs on one detail with no
 * way for the reader to choose.
 */
function projectRunSummaries(
  records: readonly MetricsRollupRecord[],
  runIds: readonly string[]
): readonly MetricsRunSummary[] {
  const wanted = new Set(runIds);
  const byRunId = new Map<string, MetricsRunSummary>();
  for (const record of records) {
    if (wanted.has(record.runId)) byRunId.set(record.runId, toRunSummary(record));
  }
  return [...byRunId.values()];
}

interface AuditFileListing {
  readonly files: string[];
  readonly archivedScanSucceeded: boolean;
}

async function listAuditFiles(
  auditDir: string,
  includeArchives: boolean,
  logger?: SanitizedLogger
): Promise<AuditFileListing> {
  const liveLog = join(auditDir, 'audit.log');
  if (!includeArchives) return { files: [liveLog], archivedScanSucceeded: false };

  let entries: string[];
  try {
    entries = await readdir(auditDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger?.warn(
        `metrics-service: failed to list archived audit logs: ${logger.sanitize(
          (err as Error).message ?? 'unknown error'
        )}`
      );
    }
    return { files: [liveLog], archivedScanSucceeded: false };
  }

  const archives = entries
    .filter((name) => name.startsWith(ARCHIVE_PREFIX))
    .filter((name) => ARCHIVE_STAMP_RE.test(name.slice(ARCHIVE_PREFIX.length)))
    .sort()
    .map((name) => join(auditDir, name));

  return { files: [...archives, liveLog], archivedScanSucceeded: true };
}

async function scanFile(
  filePath: string,
  state: ScanState,
  logger?: SanitizedLogger,
  offset = 0
): Promise<number> {
  let bytes: Buffer;
  let fileSize: number;
  try {
    fileSize = (await stat(filePath)).size;
    const length = Math.max(0, fileSize - offset);
    bytes = Buffer.allocUnsafe(length);
    if (length > 0) {
      const handle = await open(filePath, 'r');
      try {
        await handle.read(bytes, 0, length, offset);
      } finally {
        await handle.close();
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    logger?.warn(
      `metrics-service: failed to read audit log: ${logger.sanitize((err as Error).message ?? 'unknown error')}`
    );
    return offset;
  }

  const content = bytes.toString('utf8');
  const lastNewline = content.lastIndexOf('\n');
  if (lastNewline === -1) return offset;

  // Audit records are newline-delimited and append-only. Do not advance past
  // a trailing partial record: the next read will include it once the writer
  // has completed the append.
  const completeContent = content.slice(0, lastNewline + 1);
  for (const line of completeContent.split('\n')) {
    if (line.trim().length === 0) continue;
    state.totalScannedEntries += 1;
    const { entry, warning } = parseAuditLogLineDetailed(line);
    if (warning !== undefined) state.parseWarnings += 1;
    if (entry === null) continue;
    ingestEntry(entry, state);
  }
  return offset + Buffer.byteLength(completeContent, 'utf8');
}

/** Test/activation hook for deterministic cache invalidation. */
export function clearMetricsCache(workspaceRoot?: string): void {
  if (workspaceRoot === undefined) {
    metricsCache.clear();
    return;
  }
  for (const key of metricsCache.keys()) {
    if (key.startsWith(`${workspaceRoot}\0`)) metricsCache.delete(key);
  }
}

function ingestEntry(entry: AuditEntry, state: ScanState): void {
  trackOldestTimestamp(entry.timestamp, state);

  switch (entry.eventType) {
    case 'task-execution-started':
      pushTo(state.taskStarted, entry.runId, entry);
      return;
    case 'task-execution-ended':
      pushTo(state.taskEnded, entry.runId, entry);
      return;
    case 'phase-start':
      getOrCreatePhaseGroup(state, entry.runId, entry.phase, entry.iteration).starts.push(entry);
      return;
    case 'phase-end':
      getOrCreatePhaseGroup(state, entry.runId, entry.phase, entry.iteration).ends.push(entry);
      return;
    case 'cli-invocation':
      getOrCreatePhaseGroup(state, entry.runId, entry.phase, entry.iteration).invocations.push(entry);
      return;
    case 'phase-jumped': {
      const iterationN = readIterationN(entry.payload);
      if (iterationN === undefined) {
        state.parseWarnings += 1;
        return;
      }
      getOrCreatePhaseGroup(state, entry.runId, entry.phase, iterationN).jumps.push(entry);
      return;
    }
    case 'phase-breakpoint-fired': {
      const iterationN = readIterationN(entry.payload);
      if (iterationN === undefined) {
        state.parseWarnings += 1;
        return;
      }
      getOrCreatePhaseGroup(state, entry.runId, entry.phase, iterationN).breakpoints.push(entry);
      return;
    }
    default:
      // Unknown event types are preserved by the parser (never dropped)
      // but are inert for metrics grouping purposes.
      return;
  }
}

function trackOldestTimestamp(raw: string, state: ScanState): void {
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return;
  if (state.oldestTimestamp === undefined || ms < state.oldestTimestamp.ms) {
    state.oldestTimestamp = { ms, raw };
  }
  if (state.newestTimestamp === undefined || ms > state.newestTimestamp.ms) {
    state.newestTimestamp = { ms, raw };
  }
}

function pushTo(map: Map<string, AuditEntry[]>, key: string, entry: AuditEntry): void {
  const list = map.get(key);
  if (list) {
    list.push(entry);
  } else {
    map.set(key, [entry]);
  }
}

function getOrCreatePhaseGroup(
  state: ScanState,
  runId: string,
  phaseType: string,
  iteration: number
): PhaseGroup {
  // JSON-encode the tuple rather than joining with a delimiter: runId is
  // not guaranteed to exclude any particular character, so a naive
  // separator risks key collisions between distinct groups. The key is
  // built from the raw phaseType (full collision-avoidance fidelity); only
  // the group's stored phaseType is bounded for display (FR-017, see
  // truncateForDisplay above) — truncating before keying could collide two
  // distinct long phase types into one group.
  const key = JSON.stringify([runId, phaseType, iteration]);
  let group = state.phaseGroups.get(key);
  if (!group) {
    group = {
      runId,
      phaseType: truncateForDisplay(phaseType),
      iteration,
      starts: [],
      ends: [],
      jumps: [],
      breakpoints: [],
      invocations: []
    };
    state.phaseGroups.set(key, group);
  }
  return group;
}

function readIterationN(payload: Record<string, unknown>): number | undefined {
  const value = payload.iterationN;
  return typeof value === 'number' ? value : undefined;
}

function earliest(entries: readonly AuditEntry[]): AuditEntry | undefined {
  return entries.reduce<AuditEntry | undefined>(
    (acc, e) => (!acc || Date.parse(e.timestamp) < Date.parse(acc.timestamp) ? e : acc),
    undefined
  );
}

function latest(entries: readonly AuditEntry[]): AuditEntry | undefined {
  return entries.reduce<AuditEntry | undefined>(
    (acc, e) => (!acc || Date.parse(e.timestamp) > Date.parse(acc.timestamp) ? e : acc),
    undefined
  );
}

function safeDurationMs(startTime: string, endTime: string): number {
  const start = Date.parse(startTime);
  const end = Date.parse(endTime);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, end - start);
}

function buildPhaseRecordsByRunId(state: ScanState): Map<string, PhaseRecord[]> {
  const phasesByRunId = new Map<string, PhaseRecord[]>();
  for (const group of state.phaseGroups.values()) {
    const record = buildPhaseRecord(group);
    if (record === null) {
      state.parseWarnings += 1;
      continue;
    }
    const list = phasesByRunId.get(group.runId);
    if (list) {
      list.push(record);
    } else {
      phasesByRunId.set(group.runId, [record]);
    }
  }
  for (const list of phasesByRunId.values()) {
    list.sort((a, b) => a.iteration - b.iteration || Date.parse(a.startTime) - Date.parse(b.startTime));
  }
  return phasesByRunId;
}

// A phase that exhausts its retry cap gets a second `phase-end` audit entry
// (phase-runner.ts's appendCapExhaustedPhaseEnd) with no cost data, appended
// after the normal phase-end that may carry real cost — both entries share
// the same (runId, phase, iteration) join key. Reading only `latest(ends)`
// silently drops that earlier real cost, so sum every defined cost across
// the whole group instead.
function costFromEnds(ends: readonly AuditEntry[]): number | undefined {
  const defined = ends
    .map((e) => e.payload.totalCostUsd)
    .filter((c): c is number => typeof c === 'number');
  if (defined.length === 0) return undefined;
  return defined.reduce((sum, c) => sum + c, 0);
}

function buildPhaseRecord(group: PhaseGroup): PhaseRecord | null {
  const start = earliest(group.starts);
  const breakpoint = latest(group.breakpoints);
  const jump = latest(group.jumps);
  const end = latest(group.ends);
  const backendInvocations = group.invocations.length;

  if (breakpoint) {
    // A pre-armed breakpoint halts the phase before any CLI spawn (research.md
    // §6), so there is often no matching phase-start. Fall back to the
    // breakpoint event's own timestamp for both bounds — a zero-width
    // duration rather than a fabricated elapsed time.
    const startTime = start?.timestamp ?? breakpoint.timestamp;
    const endTime = breakpoint.timestamp;
    return {
      runId: group.runId,
      phaseType: group.phaseType,
      iteration: group.iteration,
      startTime: truncateForDisplay(startTime),
      endTime: truncateForDisplay(endTime),
      durationMs: safeDurationMs(startTime, endTime),
      backendInvocations,
      costUsd: undefined,
      outcome: 'paused-at-breakpoint',
      rawOutcome: undefined
    };
  }

  if (jump) {
    if (!start) return null;
    const durationMs = typeof jump.payload.durationMs === 'number' ? jump.payload.durationMs : undefined;
    return {
      runId: group.runId,
      phaseType: group.phaseType,
      iteration: group.iteration,
      startTime: truncateForDisplay(start.timestamp),
      endTime: truncateForDisplay(jump.timestamp),
      durationMs,
      backendInvocations,
      costUsd: undefined,
      outcome: 'jumped',
      rawOutcome: undefined
    };
  }

  if (end) {
    if (!start) return null;
    const { outcome, rawOutcome } = derivePhaseEndOutcome(end.payload);
    return {
      runId: group.runId,
      phaseType: group.phaseType,
      iteration: group.iteration,
      startTime: truncateForDisplay(start.timestamp),
      endTime: truncateForDisplay(end.timestamp),
      durationMs: safeDurationMs(start.timestamp, end.timestamp),
      backendInvocations,
      costUsd: costFromEnds(group.ends),
      outcome,
      rawOutcome
    };
  }

  if (!start) return null;
  return {
    runId: group.runId,
    phaseType: group.phaseType,
    iteration: group.iteration,
    startTime: truncateForDisplay(start.timestamp),
    endTime: undefined,
    durationMs: undefined,
    backendInvocations,
    costUsd: undefined,
    outcome: undefined,
    rawOutcome: undefined
  };
}

function derivePhaseEndOutcome(
  payload: Record<string, unknown>
): { outcome: PhaseRecord['outcome']; rawOutcome: string | undefined } {
  if (payload.reason === 'timeout') {
    return { outcome: 'failed', rawOutcome: 'timeout' };
  }
  const raw = typeof payload.outcome === 'string' ? payload.outcome : undefined;
  switch (raw) {
    case 'clean':
      return { outcome: 'completed', rawOutcome: raw };
    case 'skipped':
      return { outcome: 'skipped', rawOutcome: raw };
    case 'failed':
    case 'issues_remain':
    case 'rate_limited':
    case 'transient_error':
      // Documented collapse (research.md §6): spec.md's five-value
      // vocabulary has no dedicated bucket for these three code-level
      // outcomes; the raw value is retained for traceability.
      return { outcome: 'failed', rawOutcome: raw };
    default:
      // Malformed/unrecognized payload.outcome on a genuine phase-end entry
      // is still a concluded phase, never "still running" — bucket as
      // failed rather than mis-signal an in-progress state.
      return { outcome: 'failed', rawOutcome: raw };
  }
}

// Phase Type Aggregate derivation (data-model.md §3, Feature 073 US3/T026).
// Grouped across ALL scanned Phase Records (every runId), not scoped to a
// single Task Record. `executionCount` and the duration statistics only
// consider phases that reached a terminal outcome; `totalBackendInvocations`
// and `totalCostUsd` sum over every constituent phase of that type,
// including any still running, since invocation/cost data already recorded
// against a phase is real regardless of whether it has terminated yet. A
// phase type is omitted entirely when it has zero terminal executions,
// avoiding a meaningless all-empty aggregate entry.
function buildPhaseTypeAggregates(allPhases: readonly PhaseRecord[]): PhaseTypeAggregate[] {
  const phasesByType = new Map<string, PhaseRecord[]>();
  for (const phase of allPhases) {
    const list = phasesByType.get(phase.phaseType);
    if (list) {
      list.push(phase);
    } else {
      phasesByType.set(phase.phaseType, [phase]);
    }
  }

  const aggregates: PhaseTypeAggregate[] = [];
  for (const [phaseType, phases] of phasesByType.entries()) {
    const terminal = phases.filter((p) => p.outcome !== undefined);
    if (terminal.length === 0) continue;

    const durations = terminal.map((p) => p.durationMs ?? 0).sort((a, b) => a - b);
    const totalDurationMs = durations.reduce((sum, d) => sum + d, 0);

    aggregates.push({
      phaseType,
      executionCount: terminal.length,
      totalDurationMs,
      avgDurationMs: totalDurationMs / terminal.length,
      p50DurationMs: nearestRankPercentile(durations, 50),
      p90DurationMs: nearestRankPercentile(durations, 90),
      p99DurationMs: nearestRankPercentile(durations, 99),
      longestDurationMs: durations[durations.length - 1]!,
      shortestDurationMs: durations[0]!,
      totalBackendInvocations: phases.reduce((sum, p) => sum + p.backendInvocations, 0),
      totalCostUsd: sumCostUsd(phases)
    });
  }

  return aggregates;
}

// Nearest-rank percentile, no interpolation (data-model.md §3):
// rank = ceil(p/100 * N), clamped to [1, N], 1-based rank into the
// ascending-sorted array.
function nearestRankPercentile(sortedAscending: readonly number[], percentile: number): number {
  const rank = Math.min(
    sortedAscending.length,
    Math.max(1, Math.ceil((percentile / 100) * sortedAscending.length))
  );
  return sortedAscending[rank - 1]!;
}

// Cost Timeline Point derivation (data-model.md §4, Feature 073 US4/T031).
// Buckets ONLY genuine phase-end-sourced outcomes (completed/failed/skipped)
// by host-local calendar day of `endTime` — jumped/paused-at-breakpoint
// phases never carry cost and must not spuriously create a zero-cost
// timeline day. Returns an empty array when no relevant phase anywhere has
// any recorded cost, so the UI can render "no cost data available" instead
// of an all-zero chart.
function buildCostTimeline(allPhases: readonly PhaseRecord[]): CostTimelinePoint[] {
  const costed = allPhases.filter(
    (p) => p.outcome === 'completed' || p.outcome === 'failed' || p.outcome === 'skipped'
  );
  if (!costed.some((p) => p.costUsd !== undefined)) return [];

  const dailyCostByDate = new Map<string, number>();
  for (const phase of costed) {
    // completed/failed/skipped is only reachable via buildPhaseRecord's
    // `end` branch, which always sets endTime — see derivePhaseEndOutcome.
    const date = toLocalDateKey(phase.endTime!);
    dailyCostByDate.set(date, (dailyCostByDate.get(date) ?? 0) + (phase.costUsd ?? 0));
  }

  let cumulative = 0;
  return [...dailyCostByDate.keys()].sort().map((date) => {
    const dailyCostUsd = dailyCostByDate.get(date)!;
    cumulative += dailyCostUsd;
    return { date, dailyCostUsd, cumulativeCostUsd: cumulative };
  });
}

function toLocalDateKey(iso: string): string {
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function readTaskId(
  startPayload: Record<string, unknown>,
  endPayload: Record<string, unknown> | undefined
): string | undefined {
  const fromEnd = endPayload && typeof endPayload.taskId === 'string' ? endPayload.taskId : undefined;
  if (fromEnd !== undefined) return fromEnd;
  return typeof startPayload.taskId === 'string' ? startPayload.taskId : undefined;
}

// FR-017: bound the length of audit-payload-derived text (task descriptions,
// phase-type labels) before it reaches the webview. These values are
// normally internally-generated (a randomUUID()-based taskId, or a pipeline
// config's phase id), but the audit log is a plain file on disk, not a
// cryptographically protected source — nothing stops a hand-edited entry
// from carrying an arbitrarily long string, so this is a system-boundary
// check, not dead code. There is no separate secret-redaction pass
// (SanitizedLogger.sanitize()) layered in here: anyone able to hand-edit
// `.schegent/audit.log` already shares the same workspace-trust boundary as
// the rest of the dashboard (spec.md Assumptions), so rendering back a
// value they already fully control doesn't cross a privilege boundary the
// way redaction is meant to guard (e.g. keeping a pasted secret out of a
// genuinely lower-trust sink like a shared log or support ticket) — there
// is no such lower-trust sink here. Mirrors ui/sidebar/queue-projector.ts's
// `truncateLabel` bound; duplicated locally rather than imported so
// `metrics/` doesn't take a dependency on `ui/sidebar/`, which already
// depends on `metrics/`.
const MAX_DISPLAY_TEXT_LENGTH = 300;

function truncateForDisplay(text: string): string {
  if (text.length <= MAX_DISPLAY_TEXT_LENGTH) return text;
  let cutAt = MAX_DISPLAY_TEXT_LENGTH - 3;
  // slice() indexes UTF-16 code units, so a naive cut can land inside an
  // astral-plane character's surrogate pair, leaving a lone surrogate that
  // renders as mojibake. Back off one code unit when the cut would split one.
  const before = text.charCodeAt(cutAt - 1);
  const after = text.charCodeAt(cutAt);
  const splitsSurrogatePair = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
  if (splitsSurrogatePair) cutAt -= 1;
  return `${text.slice(0, cutAt)}...`;
}

// No `description` field exists on task-lifecycle audit payloads
// (TaskExecutionStartedPayload/TaskExecutionEndedPayload carry no such
// field). Wiring in HistoryStore would only cover its 50-entry cap
// (workspace-state.ts HISTORY_CAP) — far short of "months of activity"
// (SC-001) — so this falls back to the best available stable identifier
// instead of fabricating display text.
function readDescription(
  runId: string,
  startPayload: Record<string, unknown>,
  endPayload: Record<string, unknown> | undefined
): string {
  return truncateForDisplay(readTaskId(startPayload, endPayload) ?? runId);
}

function readTerminalStatus(value: unknown): TaskRecord['status'] {
  return value === 'completed' || value === 'failed' || value === 'canceled' ? value : undefined;
}

function sumCostUsd(phases: readonly PhaseRecord[]): number | undefined {
  if (!phases.some((p) => p.costUsd !== undefined)) return undefined;
  return phases.reduce((sum, p) => sum + (p.costUsd ?? 0), 0);
}

function earliestPhaseStart(phases: readonly PhaseRecord[]): string {
  return phases.reduce(
    (min, p) => (Date.parse(p.startTime) < Date.parse(min) ? p.startTime : min),
    phases[0]!.startTime
  );
}

function latestPhaseEnd(phases: readonly PhaseRecord[]): string | undefined {
  return phases.reduce<string | undefined>((max, p) => {
    if (p.endTime === undefined) return max;
    if (max === undefined || Date.parse(p.endTime) > Date.parse(max)) return p.endTime;
    return max;
  }, undefined);
}

// Reconstruction fallback (data-model.md §1, T013/T015): assembled solely
// from grouped phase-level activity when no task-execution-started/-ended
// pair exists for this runId. `status` only resolves once every
// constituent phase has reached a terminal state — a single still-running
// phase keeps the whole reconstructed task "running", mirroring the direct
// pairing's "no terminal event yet" semantics.
function buildReconstructedTaskRecord(runId: string, phases: readonly PhaseRecord[]): TaskRecord {
  const startTime = earliestPhaseStart(phases);
  const allTerminal = phases.every((p) => p.outcome !== undefined);
  const endTime = allTerminal ? latestPhaseEnd(phases) : undefined;
  const status: TaskRecord['status'] = allTerminal
    ? phases.some((p) => p.outcome === 'failed')
      ? 'failed'
      : 'completed'
    : undefined;

  return {
    runId,
    taskId: undefined,
    description: truncateForDisplay(runId),
    startTime: truncateForDisplay(startTime),
    endTime: endTime !== undefined ? truncateForDisplay(endTime) : undefined,
    durationMs:
      endTime !== undefined ? safeDurationMs(startTime, endTime) : Math.max(0, Date.now() - Date.parse(startTime)),
    status,
    isRunning: status === undefined,
    phasesTotal: phases.length,
    phasesCompleted: phases.filter((p) => p.outcome === 'completed').length,
    phasesSkipped: phases.filter((p) => p.outcome === 'skipped').length,
    totalCostUsd: sumCostUsd(phases),
    totalBackendInvocations: phases.reduce((sum, p) => sum + p.backendInvocations, 0),
    phases,
    source: 'phase-reconstruction'
  };
}

function buildTaskRecords(state: ScanState, phasesByRunId: Map<string, PhaseRecord[]>): TaskRecord[] {
  const tasks: TaskRecord[] = [];

  for (const [runId, startedEntries] of state.taskStarted.entries()) {
    const start = earliest(startedEntries);
    if (!start) continue;

    const phases = phasesByRunId.get(runId) ?? [];
    const totalCostUsd = sumCostUsd(phases);
    const totalBackendInvocations = phases.reduce((sum, p) => sum + p.backendInvocations, 0);
    const end = latest(state.taskEnded.get(runId) ?? []);

    if (end) {
      const endPayload = end.payload;
      const status = readTerminalStatus(endPayload.terminalStatus);
      tasks.push({
        runId,
        taskId: readTaskId(start.payload, endPayload),
        description: readDescription(runId, start.payload, endPayload),
        startTime: truncateForDisplay(start.timestamp),
        endTime: truncateForDisplay(end.timestamp),
        durationMs:
          typeof endPayload.durationMs === 'number'
            ? endPayload.durationMs
            : safeDurationMs(start.timestamp, end.timestamp),
        status,
        // A task-execution-ended entry exists, so the task is definitely not
        // running — even if its terminalStatus value is unrecognized (status
        // parses to undefined in that case too, but that must not be
        // conflated with "still running").
        isRunning: false,
        phasesTotal: typeof endPayload.phasesTotal === 'number' ? endPayload.phasesTotal : phases.length,
        phasesCompleted:
          typeof endPayload.phasesCompleted === 'number'
            ? endPayload.phasesCompleted
            : phases.filter((p) => p.outcome === 'completed').length,
        phasesSkipped:
          typeof endPayload.phasesSkipped === 'number'
            ? endPayload.phasesSkipped
            : phases.filter((p) => p.outcome === 'skipped').length,
        totalCostUsd,
        totalBackendInvocations,
        phases,
        source: 'task-lifecycle'
      });
    } else {
      tasks.push({
        runId,
        taskId: readTaskId(start.payload, undefined),
        description: readDescription(runId, start.payload, undefined),
        startTime: truncateForDisplay(start.timestamp),
        endTime: undefined,
        durationMs: Math.max(0, Date.now() - Date.parse(start.timestamp)),
        status: undefined,
        isRunning: true,
        phasesTotal: phases.length,
        phasesCompleted: phases.filter((p) => p.outcome === 'completed').length,
        phasesSkipped: phases.filter((p) => p.outcome === 'skipped').length,
        totalCostUsd,
        totalBackendInvocations,
        phases,
        source: 'task-lifecycle'
      });
    }
  }

  for (const [runId, phases] of phasesByRunId.entries()) {
    if (state.taskStarted.has(runId)) continue;
    // An orphaned task-execution-ended entry (handled below) is
    // authoritative and takes precedence over phase-outcome inference —
    // otherwise a runId whose last phase never reached a terminal outcome
    // (e.g. its own phase-end was lost to log rotation) would be reported
    // as running forever even though we know for a fact it ended.
    if (state.taskEnded.has(runId)) continue;
    tasks.push(buildReconstructedTaskRecord(runId, phases));
  }

  // A runId can have a task-execution-ended entry with no surviving
  // task-execution-started entry (e.g. log rotation split the pair).
  // Without this fallback such a task silently disappears from the
  // dashboard instead of showing up (best effort) as a terminated task —
  // using whatever phase activity also survived, if any, or a bare
  // terminal record with no known start time when none did.
  for (const [runId, endedEntries] of state.taskEnded.entries()) {
    if (state.taskStarted.has(runId)) continue;

    const end = latest(endedEntries);
    if (!end) continue;

    const phases = phasesByRunId.get(runId) ?? [];
    const endPayload = end.payload;
    const durationMs = typeof endPayload.durationMs === 'number' ? endPayload.durationMs : undefined;
    const startTime =
      phases.length > 0
        ? earliestPhaseStart(phases)
        : durationMs !== undefined
          ? new Date(Date.parse(end.timestamp) - durationMs).toISOString()
          : end.timestamp;

    tasks.push({
      runId,
      taskId: readTaskId({}, endPayload),
      description: readDescription(runId, {}, endPayload),
      startTime: truncateForDisplay(startTime),
      endTime: truncateForDisplay(end.timestamp),
      durationMs: durationMs ?? safeDurationMs(startTime, end.timestamp),
      status: readTerminalStatus(endPayload.terminalStatus),
      isRunning: false,
      phasesTotal: typeof endPayload.phasesTotal === 'number' ? endPayload.phasesTotal : phases.length,
      phasesCompleted:
        typeof endPayload.phasesCompleted === 'number'
          ? endPayload.phasesCompleted
          : phases.filter((p) => p.outcome === 'completed').length,
      phasesSkipped:
        typeof endPayload.phasesSkipped === 'number'
          ? endPayload.phasesSkipped
          : phases.filter((p) => p.outcome === 'skipped').length,
      totalCostUsd: sumCostUsd(phases),
      totalBackendInvocations: phases.reduce((sum, p) => sum + p.backendInvocations, 0),
      phases,
      source: 'task-lifecycle'
    });
  }

  return tasks;
}
