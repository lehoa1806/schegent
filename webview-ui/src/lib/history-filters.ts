// Feature 103 (T041, T042, T044 — FR-016 to FR-021, FR-054, FR-057, FR-058,
// FR-060) — narrowing the cross-queue list.
//
// A pure module over `HistoryRow[]`, with no transport in it and none reachable
// from it. That is FR-023 held by construction: filtering cannot become a host
// round trip without an import that `tests/contract/history-filtering-is-local.test.ts`
// fails on. The clock is a parameter for the same reason the row list is —
// `applyFilters` is a function of its inputs, so a relative window is assertable
// without freezing time for every other suite in the directory.

import { provenanceLabels, type CatalogNames, type HistoryRow, type HistoryRowStatus } from './history-rows';

/**
 * FR-016 — "kind" in the FR-013 sense: how the run was *started*.
 *
 * Never the sort of definition a version identifies. A Workflow member froze a
 * Pipeline, so its row reads `origin.kind === 'workflow-member'` and
 * `catalogVersion.kind === 'pipeline'` at once, and a predicate reading the
 * second to answer the first returns the empty set on exactly the rows it was
 * meant to find.
 */
export type HistoryOriginFilter = 'all' | 'standalone' | 'workflow-member';

/**
 * The kind control's values, beside the union they belong to.
 *
 * Listed here rather than spelled out in the markup for the reason
 * `RUN_STATUS_FILTERS` is: a control that enumerates its own options drifts from
 * the union the moment the union gains an arm, and drifts silently.
 */
export const HISTORY_ORIGIN_FILTERS: readonly { value: HistoryOriginFilter; label: string }[] =
  Object.freeze([
    { value: 'all', label: 'All kinds' },
    { value: 'standalone', label: 'Pipeline' },
    { value: 'workflow-member', label: 'Workflow member' }
  ] as const);

/** FR-060 — the relative windows the range control offers. */
export type HistoryRelativeWindow = '1h' | '24h' | '7d' | '30d';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface HistoryRelativeWindowOption {
  readonly value: HistoryRelativeWindow;
  readonly label: string;
  readonly ms: number;
}

export const HISTORY_RELATIVE_WINDOWS: readonly HistoryRelativeWindowOption[] = Object.freeze([
  { value: '1h', label: 'Last hour', ms: HOUR_MS },
  { value: '24h', label: 'Last 24 hours', ms: 24 * HOUR_MS },
  { value: '7d', label: 'Last 7 days', ms: 7 * DAY_MS },
  { value: '30d', label: 'Last 30 days', ms: 30 * DAY_MS }
] as const);

const WINDOW_MS: Record<HistoryRelativeWindow, number> = Object.freeze(
  Object.fromEntries(HISTORY_RELATIVE_WINDOWS.map((w) => [w.value, w.ms]))
) as Record<HistoryRelativeWindow, number>;

/**
 * FR-060 — both shapes, resolving to the same inclusive bounds (FR-019).
 *
 * Two arms rather than one nullable pair because they answer different
 * questions. "Every failure last week" is relative and moves with the clock;
 * "did anything change when I published this version" needs a boundary at a
 * specific moment and must not drift while the operator reads the list.
 */
export type HistoryTimeRange =
  | { readonly kind: 'all' }
  | { readonly kind: 'relative'; readonly window: HistoryRelativeWindow }
  | {
      readonly kind: 'absolute';
      /** `YYYY-MM-DD` or a full ISO instant; `null` is unbounded on that side. */
      readonly from: string | null;
      readonly to: string | null;
    };

export const ALL_TIME: HistoryTimeRange = Object.freeze({ kind: 'all' });

/**
 * FR-016 — the six filters, and only those six.
 *
 * `status` is one flat member holding both the terminal outcomes and the
 * non-terminal states (FR-054). A second member splitting them would make "the
 * paused one" and "the failed one" two different questions, which is the
 * arrangement the story exists to remove — and this interface is where that
 * second member would have to appear.
 */
export interface HistoryFilterSet {
  readonly origin: HistoryOriginFilter;
  readonly definitionId: string | null;
  /** FR-018 — offered only once `definitionId` is set; version labels are unique within a definition. */
  readonly versionId: string | null;
  readonly status: HistoryRowStatus | 'all';
  /** FR-058 — `HISTORY_UNATTRIBUTED_QUEUE_ID` is an ordinary value here, not an absence. */
  readonly queueId: string | null;
  readonly range: HistoryTimeRange;
}

/**
 * FR-057 — what History opens with, every time.
 *
 * Frozen, and the only way to spell "unfiltered": a surface that opens already
 * narrowed shows a partial list and states no reason why. Nothing persists this
 * value or reads a persisted one — it is a constant, which is the strongest
 * form the requirement can take.
 */
export const EMPTY_HISTORY_FILTERS: HistoryFilterSet = Object.freeze({
  origin: 'all',
  definitionId: null,
  versionId: null,
  status: 'all',
  queueId: null,
  range: ALL_TIME
});

/**
 * FR-020 — where the operator is inside History: what they narrowed to, and
 * which run they opened.
 *
 * Deliberately not a fourth arm of `DashboardLocation` in `dashboard/routes.ts`.
 * That union is the Queues drill-down and none of its tiers carries a filter
 * set; widening it would put a History concern in the middle of a queue
 * navigation every other surface reads.
 */
export interface HistoryLocation {
  readonly filters: HistoryFilterSet;
  readonly selectedRunId: string | null;
}

/** The location History mounts at, and the one "clear filters" returns to. */
export const HISTORY_HOME: HistoryLocation = Object.freeze({
  filters: EMPTY_HISTORY_FILTERS,
  selectedRunId: null
});

/** Whether anything is set — what FR-022's "clear them" offer keys off. */
export function isFiltered(filters: HistoryFilterSet): boolean {
  return (
    filters.origin !== 'all' ||
    filters.definitionId !== null ||
    filters.versionId !== null ||
    filters.status !== 'all' ||
    filters.queueId !== null ||
    filters.range.kind !== 'all'
  );
}

// ---------------------------------------------------------------------------
// Time bounds
// ---------------------------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One end of an absolute range, in epoch milliseconds.
 *
 * A bare `YYYY-MM-DD` — what a date input hands back — expands to that whole
 * *local* calendar day, because that is what an operator picking "the 19th"
 * means. An unparseable value reads as unbounded rather than as an empty range:
 * a date input reports every keystroke, and a half-typed bound that blanks the
 * list looks like the runs disappeared.
 */
function boundMs(value: string | null, edge: 'start' | 'end'): number {
  const open = edge === 'start' ? -Infinity : Infinity;
  if (value === null || value.length === 0) return open;
  const literal = DATE_ONLY.test(value)
    ? `${value}T${edge === 'start' ? '00:00:00.000' : '23:59:59.999'}`
    : value;
  const parsed = Date.parse(literal);
  return Number.isFinite(parsed) ? parsed : open;
}

export interface HistoryRangeBounds {
  readonly fromMs: number;
  readonly toMs: number;
}

/** FR-019 — the inclusive bounds a range resolves to, or `null` for unbounded. */
export function resolveRangeBounds(
  range: HistoryTimeRange,
  nowMs: number
): HistoryRangeBounds | null {
  switch (range.kind) {
    case 'all':
      return null;
    case 'relative':
      return { fromMs: nowMs - WINDOW_MS[range.window], toMs: nowMs };
    case 'absolute':
      return { fromMs: boundMs(range.from, 'start'), toMs: boundMs(range.to, 'end') };
  }
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

type RowPredicate = (row: HistoryRow) => boolean;

function predicatesFor(filters: HistoryFilterSet, nowMs: number): readonly RowPredicate[] {
  const predicates: RowPredicate[] = [];

  if (filters.origin !== 'all') {
    // An absent origin matches neither arm. The run was never asked how it
    // started, and listing it under 'standalone' would answer for it.
    predicates.push((row) => row.origin?.kind === filters.origin);
  }
  if (filters.definitionId !== null) {
    predicates.push((row) => row.definitionId === filters.definitionId);
  }
  if (filters.versionId !== null) {
    predicates.push((row) => row.catalogVersion?.versionId === filters.versionId);
  }
  if (filters.status !== 'all') {
    predicates.push((row) => row.status === filters.status);
  }
  if (filters.queueId !== null) {
    predicates.push((row) => row.queueId === filters.queueId);
  }

  const bounds = resolveRangeBounds(filters.range, nowMs);
  if (bounds !== null) {
    // FR-019 — a finished run by its end time, an in-flight one by its start.
    // Both are `orderingKey`, which is the single key FR-005 already reduced
    // the two sources to; reading `completedAt` here would drop every live run
    // the moment any range is set.
    predicates.push((row) => {
      if (row.orderingKey === null) return false;
      const at = Date.parse(row.orderingKey);
      return Number.isFinite(at) && at >= bounds.fromMs && at <= bounds.toMs;
    });
  }

  return predicates;
}

/**
 * FR-017 — a conjunction, as a fold of independent predicates.
 *
 * No predicate consults another, and an inactive filter contributes none at
 * all, so adding a filter can only ever remove rows. Input order is preserved:
 * the list arrives ordered by `composeHistoryRows`, and that function owns the
 * order.
 */
export function applyFilters(
  rows: readonly HistoryRow[],
  filters: HistoryFilterSet,
  nowMs: number = Date.now()
): readonly HistoryRow[] {
  const predicates = predicatesFor(filters, nowMs);
  if (predicates.length === 0) return rows;
  return rows.filter((row) => predicates.every((matches) => matches(row)));
}

// ---------------------------------------------------------------------------
// Options — FR-018, FR-021, FR-058
// ---------------------------------------------------------------------------

export interface HistoryFilterOption {
  readonly value: string;
  readonly label: string;
  /**
   * FR-021 — selected, but no row carries it any more: a pruned version, a
   * deleted queue, a removed definition. Kept in the list and flagged rather
   * than dropped, because dropping it changes what the operator is looking at
   * without telling them, and the next thing they do is trust the list.
   */
  readonly missing: boolean;
}

export interface HistoryFilterOptions {
  readonly definitions: readonly HistoryFilterOption[];
  /** FR-018 — empty until exactly one definition is selected. */
  readonly versions: readonly HistoryFilterOption[];
  readonly queues: readonly HistoryFilterOption[];
}

function byLabel(a: HistoryFilterOption, b: HistoryFilterOption): number {
  return a.label.localeCompare(b.label);
}

/**
 * Collect one filter's offerable values, then re-add the selected one if the
 * rows no longer contain it.
 *
 * The re-add is the whole of FR-021's display half. The matching half needs no
 * code: a value nothing carries simply fails its predicate.
 */
function optionsFrom(
  present: ReadonlyMap<string, string>,
  selected: string | null
): readonly HistoryFilterOption[] {
  const options = [...present].map(([value, label]) => ({ value, label, missing: false }));
  if (selected !== null && !present.has(selected)) {
    options.push({ value: selected, label: selected, missing: true });
  }
  return options.sort(byLabel);
}

/**
 * The values each control offers, given the rows in hand.
 *
 * Derived from the rows rather than from the catalog, for two reasons. A
 * definition the catalog dropped still has runs in history and must stay
 * selectable, and a definition the catalog holds with no runs would be an
 * option that always matches nothing. The catalog is consulted only for
 * display names, and the id stands in when it has none (FR-021).
 */
export function buildFilterOptions(
  rows: readonly HistoryRow[],
  filters: HistoryFilterSet,
  names: CatalogNames
): HistoryFilterOptions {
  const definitions = new Map<string, string>();
  const versions = new Map<string, string>();
  const queues = new Map<string, string>();

  for (const row of rows) {
    if (row.definitionId !== null) {
      definitions.set(row.definitionId, provenanceLabels(row, names).definition);
      if (row.definitionId === filters.definitionId && row.catalogVersion !== null) {
        versions.set(row.catalogVersion.versionId, row.catalogVersion.versionId);
      }
    }
    // The row already carries the queue's display name, including the written
    // out label for the unattributed partition (FR-058).
    queues.set(row.queueId, row.queueName);
  }

  return {
    definitions: optionsFrom(definitions, filters.definitionId),
    // FR-018 — no definition selected, no version list. Version labels are
    // unique within a definition and not across them, so an unscoped list would
    // offer the same label twice and mean two different things by it.
    versions:
      filters.definitionId === null ? [] : optionsFrom(versions, filters.versionId),
    queues: optionsFrom(queues, filters.queueId)
  };
}
