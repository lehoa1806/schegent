/**
 * FR-R6-F11 (FR-007, FR-008; research R3, R12) — the run-derived view builders.
 *
 * Each builder reads one captured population and returns frozen rows plus coverage. A root's
 * duration is its wall clock, start to end, waits and pauses included; an attempt's is its own
 * start to end. A duration with a missing or reversed end is unknown: it is counted, never
 * guessed. Distributions are nearest-rank over the known samples.
 *
 * Group keys carry the view's fixed dimensions first, then the chosen ones. Every sort ends with
 * the row's identity, and text is ordered by code point, so equal input gives equal order. The
 * per-item work runs through the slicer, so a long build yields, can be cancelled and meets the
 * deadline.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { reportOk, type ReportResult } from '../../contracts/reporting/report-outcomes';
import {
  FAILURE_VIEW_OUTCOMES,
  RUN_OUTCOMES,
  VIEW_SHAPES,
  type ReportDimension,
  type ReportQuery,
  type RunOutcome
} from '../../contracts/reporting/report-query';
import type {
  AttemptRow,
  GroupKey,
  GroupRow,
  ReportCoverage,
  ReportRow,
  RootRow
} from '../../contracts/reporting/report-rows';
import { distributionOf } from './report-percentiles';
import { createLocalDayKeyer, toUtcIso } from './report-time';
import type { CapturedRuns, SnapshotAttempt, SnapshotRoot } from './snapshot-capture';
import type { WorkSlicer } from './work-slicer';

export interface RunRows {
  readonly rows: readonly ReportRow[];
  readonly coverage: ReportCoverage;
}

export type RowSlicer = Pick<WorkSlicer, 'forEach'>;

/** Views whose group rows also carry the attempt-own distribution. */
const ATTEMPT_DISTRIBUTION_VIEWS: readonly string[] = ['workflow-revision', 'time-series'];

const SURROGATE_FIRST = 0xd800;
const SURROGATE_LAST = 0xdfff;
const PRIVATE_USE_FIRST = 0xe000;
const SURROGATE_SHIFT = 0x2000;
const BMP_TAIL_SHIFT = 0x800;

/** Moves surrogates above the rest of the BMP, so code-unit order becomes code-point order. */
function codePointRank(unit: number): number {
  if (unit >= SURROGATE_FIRST && unit <= SURROGATE_LAST) {
    return unit + SURROGATE_SHIFT;
  }
  return unit >= PRIVATE_USE_FIRST ? unit - BMP_TAIL_SHIFT : unit;
}

/** Compares two strings by Unicode code point. */
export function compareCodePoints(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.charCodeAt(index);
    const b = right.charCodeAt(index);
    if (a !== b) {
      return codePointRank(a) - codePointRank(b);
    }
  }
  return left.length - right.length;
}

function rootDurationMs(root: SnapshotRoot): number | null {
  if (root.startedAtMs === null || root.completedAtMs === null || root.completedAtMs < root.startedAtMs) {
    return null;
  }
  return root.completedAtMs - root.startedAtMs;
}

function attemptDurationMs(attempt: SnapshotAttempt): number | null {
  if (attempt.completedAtMs === null || attempt.completedAtMs < attempt.startedAtMs) {
    return null;
  }
  return attempt.completedAtMs - attempt.startedAtMs;
}

interface Population {
  readonly roots: readonly SnapshotRoot[];
  readonly attempts: readonly SnapshotAttempt[];
  readonly attemptsByRoot: ReadonlyMap<string, readonly SnapshotAttempt[]>;
}

async function populationOf(
  query: ReportQuery,
  runs: CapturedRuns,
  slicer: RowSlicer
): Promise<ReportResult<Population>> {
  const roots =
    query.view === 'failure-cause' ? runs.roots.filter((root) => FAILURE_VIEW_OUTCOMES.includes(root.status)) : runs.roots;
  const rootIds = new Set(roots.map((root) => root.rootId));
  const attempts: SnapshotAttempt[] = [];
  const attemptsByRoot = new Map<string, SnapshotAttempt[]>();
  const indexed = await slicer.forEach(runs.attempts, (attempt) => {
    if (!rootIds.has(attempt.rootId)) {
      return;
    }
    attempts.push(attempt);
    const list = attemptsByRoot.get(attempt.rootId);
    if (list === undefined) {
      attemptsByRoot.set(attempt.rootId, [attempt]);
    } else {
      list.push(attempt);
    }
  });
  return indexed.ok ? reportOk({ roots, attempts, attemptsByRoot }) : indexed;
}

function coverageOf(population: Population): ReportCoverage {
  const unknownRoots = population.roots.filter((root) => rootDurationMs(root) === null).length;
  const unknownAttempts = population.attempts.filter((attempt) => attemptDurationMs(attempt) === null).length;
  return Object.freeze({
    roots: population.roots.length,
    attempts: population.attempts.length,
    unknownDurations: unknownRoots + unknownAttempts
  });
}

type Compare<T> = (left: T, right: T) => number;

const byCreatedDesc: Compare<RootRow> = (a, b) => compareCodePoints(b.createdUtc, a.createdUtc);

const ROOT_SORTS: Readonly<Record<string, Compare<RootRow>>> = Object.freeze({
  'root-created-desc': byCreatedDesc,
  'root-created-asc': (a, b) => compareCodePoints(a.createdUtc, b.createdUtc),
  'duration-desc': (a, b) => (b.durationMs ?? -1) - (a.durationMs ?? -1),
  'outcome-asc': (a, b) => compareCodePoints(a.outcome, b.outcome)
});

/** The row of one root, with its attempt count; drill-down reuses it. */
export function toRootRow(root: SnapshotRoot, attempts: number): RootRow {
  return Object.freeze({
    kind: 'root',
    rootId: root.rootId,
    workflowId: root.workflowId,
    frozenDefinitionId: root.frozenDefinitionId,
    outcome: root.status,
    createdUtc: toUtcIso(root.createdAtMs),
    durationMs: rootDurationMs(root),
    attempts
  });
}

async function rootRows(query: ReportQuery, population: Population, slicer: RowSlicer): Promise<ReportResult<ReportRow[]>> {
  const rows: RootRow[] = [];
  const built = await slicer.forEach(population.roots, (root) => {
    rows.push(toRootRow(root, population.attemptsByRoot.get(root.rootId)?.length ?? 0));
  });
  if (!built.ok) {
    return built;
  }
  const primary = ROOT_SORTS[query.sort] ?? byCreatedDesc;
  return reportOk(rows.sort((a, b) => primary(a, b) || compareCodePoints(a.rootId, b.rootId)));
}

interface PlacedAttempt {
  readonly row: AttemptRow;
  readonly rootCreatedAtMs: number;
}

function compareAttempts(descending: boolean): Compare<PlacedAttempt> {
  return (a, b) => {
    const created = descending ? b.rootCreatedAtMs - a.rootCreatedAtMs : a.rootCreatedAtMs - b.rootCreatedAtMs;
    return (
      created ||
      compareCodePoints(a.row.rootId, b.row.rootId) ||
      a.row.stepIndex - b.row.stepIndex ||
      a.row.attemptNumber - b.row.attemptNumber ||
      compareCodePoints(a.row.attemptId, b.row.attemptId)
    );
  };
}

/** The row of one attempt; drill-down reuses it. */
export function toAttemptRow(attempt: SnapshotAttempt): AttemptRow {
  return Object.freeze({
    kind: 'attempt',
    attemptId: attempt.attemptId,
    rootId: attempt.rootId,
    attemptNumber: attempt.attemptNumber,
    stepIndex: attempt.stepIndex,
    phaseId: attempt.phaseId,
    status: attempt.status,
    exitCode: attempt.exitCode,
    startedUtc: toUtcIso(attempt.startedAtMs),
    completedUtc: attempt.completedAtMs === null ? null : toUtcIso(attempt.completedAtMs),
    durationMs: attemptDurationMs(attempt)
  });
}

async function attemptRows(
  query: ReportQuery,
  population: Population,
  slicer: RowSlicer
): Promise<ReportResult<ReportRow[]>> {
  const created = new Map(population.roots.map((root) => [root.rootId, root.createdAtMs]));
  const placed: PlacedAttempt[] = [];
  const built = await slicer.forEach(population.attempts, (attempt) => {
    placed.push({ row: toAttemptRow(attempt), rootCreatedAtMs: created.get(attempt.rootId) ?? 0 });
  });
  if (!built.ok) {
    return built;
  }
  placed.sort(compareAttempts(query.sort !== 'root-created-asc'));
  return reportOk(placed.map((entry) => entry.row));
}

interface GroupAccumulator {
  readonly key: GroupKey | null;
  readonly keyText: string;
  roots: number;
  attempts: number;
  readonly outcomes: Record<RunOutcome, number>;
  readonly rootDurations: (number | null)[];
  readonly attemptDurations: (number | null)[];
}

type DimensionReader = (root: SnapshotRoot) => string | null;

function dimensionReader(dimension: ReportDimension, query: ReportQuery): DimensionReader {
  switch (dimension) {
    case 'workflowId':
      return (root) => root.workflowId;
    case 'frozenDefinitionId':
      return (root) => root.frozenDefinitionId;
    case 'outcome':
      return (root) => root.status;
    case 'failureCause':
      return (root) => root.failureCause;
    case 'localDay': {
      const dayOf = createLocalDayKeyer(query.timezone);
      return (root) => dayOf(root.createdAtMs);
    }
    default:
      return () => null;
  }
}

function emptyOutcomes(): Record<RunOutcome, number> {
  const outcomes = {} as Record<RunOutcome, number>;
  for (const outcome of RUN_OUTCOMES) {
    outcomes[outcome] = 0;
  }
  return outcomes;
}

function accumulatorFor(groups: Map<string, GroupAccumulator>, values: readonly (string | null)[], dimensions: readonly ReportDimension[]): GroupAccumulator {
  const keyText = JSON.stringify(values);
  const existing = groups.get(keyText);
  if (existing !== undefined) {
    return existing;
  }
  const key: Partial<Record<ReportDimension, string | null>> = {};
  dimensions.forEach((dimension, index) => {
    key[dimension] = values.at(index) ?? null;
  });
  const created: GroupAccumulator = {
    key: dimensions.length === 0 ? null : Object.freeze(key),
    keyText,
    roots: 0,
    attempts: 0,
    outcomes: emptyOutcomes(),
    rootDurations: [],
    attemptDurations: []
  };
  groups.set(keyText, created);
  return created;
}

function toGroupRow(group: GroupAccumulator, withAttempts: boolean): GroupRow {
  const row: GroupRow = {
    kind: 'group',
    key: group.key,
    roots: group.roots,
    attempts: group.attempts,
    outcomes: Object.freeze(group.outcomes),
    rootDuration: distributionOf('root-wall-clock', group.rootDurations)
  };
  return Object.freeze(withAttempts ? { ...row, attemptDuration: distributionOf('attempt-own', group.attemptDurations) } : row);
}

async function groupRows(query: ReportQuery, population: Population, slicer: RowSlicer): Promise<ReportResult<ReportRow[]>> {
  const dimensions = [...VIEW_SHAPES[query.view].fixedDimensions, ...query.groupBy];
  const readers = dimensions.map((dimension) => dimensionReader(dimension, query));
  const groups = new Map<string, GroupAccumulator>();
  const built = await slicer.forEach(population.roots, (root) => {
    const group = accumulatorFor(groups, readers.map((read) => read(root)), dimensions);
    const attempts = population.attemptsByRoot.get(root.rootId) ?? [];
    group.roots += 1;
    group.attempts += attempts.length;
    group.outcomes[root.status] += 1;
    group.rootDurations.push(rootDurationMs(root));
    for (const attempt of attempts) {
      group.attemptDurations.push(attemptDurationMs(attempt));
    }
  });
  if (!built.ok) {
    return built;
  }
  const byKey: Compare<GroupAccumulator> = (a, b) => compareCodePoints(a.keyText, b.keyText);
  const order: Compare<GroupAccumulator> = query.sort === 'roots-desc' ? (a, b) => b.roots - a.roots || byKey(a, b) : byKey;
  const withAttempts = ATTEMPT_DISTRIBUTION_VIEWS.includes(query.view);
  return reportOk([...groups.values()].sort(order).map((group) => toGroupRow(group, withAttempts)));
}

/** Builds a run-derived view's rows and coverage from its captured population. */
export async function buildRunRows(
  query: ReportQuery,
  runs: CapturedRuns,
  slicer: RowSlicer
): Promise<ReportResult<RunRows>> {
  const population = await populationOf(query, runs, slicer);
  if (!population.ok) {
    return population;
  }
  const ungrouped = query.view === 'execution-summary' && query.groupBy.length === 0;
  const builder = query.view === 'attempt-detail' ? attemptRows : ungrouped ? rootRows : groupRows;
  const rows = await builder(query, population.value, slicer);
  if (!rows.ok) {
    return rows;
  }
  return reportOk(Object.freeze({ rows: Object.freeze(rows.value), coverage: coverageOf(population.value) }));
}
