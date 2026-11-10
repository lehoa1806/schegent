/**
 * FR-R6-F11 (FR-001, FR-002, FR-004) — the historical report query: its views, the dimensions,
 * filters and sorts each view carries, and the bounds every query is held to.
 *
 * One shape for the headless port and a later sidebar surface, so the two cannot disagree. Zero
 * `vscode` imports and zero Node imports (docs/hard-rules.md rule 13).
 */

export const REPORT_VIEWS = Object.freeze([
  'execution-summary',
  'attempt-detail',
  'failure-cause',
  'workflow-revision',
  'time-series',
  'usage'
] as const);
export type ReportView = (typeof REPORT_VIEWS)[number];

/** The statuses a root (a run) can hold in the store, in the store's own spelling. */
export const RUN_OUTCOMES = Object.freeze([
  'queued',
  'running',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
  'aborted'
] as const);
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** The statuses an attempt can hold in the store. */
export const ATTEMPT_STATUSES = Object.freeze([
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out'
] as const);
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/** Root statuses that enter the failure-cause view (research R12). */
export const FAILURE_VIEW_OUTCOMES: readonly RunOutcome[] = Object.freeze([
  'failed',
  'aborted',
  'cancelled'
]);

export const REPORT_FILTER_KEYS = Object.freeze([
  'rootId',
  'workflowId',
  'frozenDefinitionId',
  'outcome',
  'backend',
  'model'
] as const);
export type ReportFilterKey = (typeof REPORT_FILTER_KEYS)[number];

export const REPORT_DIMENSIONS = Object.freeze([
  'workflowId',
  'frozenDefinitionId',
  'outcome',
  'failureCause',
  'localDay',
  'backend',
  'model',
  'utcDay'
] as const);
export type ReportDimension = (typeof REPORT_DIMENSIONS)[number];

export const REPORT_SORTS = Object.freeze([
  'root-created-desc',
  'root-created-asc',
  'duration-desc',
  'outcome-asc',
  'key-asc',
  'roots-desc'
] as const);
export type ReportSort = (typeof REPORT_SORTS)[number];

/** How a view's rows are shaped and grouped (research R3). */
export interface ViewShape {
  /** Dimensions a caller may choose in `groupBy`. */
  readonly optionalDimensions: readonly ReportDimension[];
  /** Dimensions every group key of the view carries, first, whatever `groupBy` says. */
  readonly fixedDimensions: readonly ReportDimension[];
  /** The most dimensions a caller may choose. */
  readonly maxOptional: number;
  /** Used when the caller sends no `groupBy`. */
  readonly defaultGroupBy: readonly ReportDimension[];
  readonly filters: readonly ReportFilterKey[];
  /** Sorts for root rows (no grouping) and for group rows; the first of each is the default. */
  readonly rowSorts: readonly ReportSort[];
  readonly groupSorts: readonly ReportSort[];
}

const RUN_FILTERS: readonly ReportFilterKey[] = Object.freeze([
  'rootId',
  'workflowId',
  'frozenDefinitionId',
  'outcome'
]);
const GROUP_SORTS: readonly ReportSort[] = Object.freeze(['key-asc', 'roots-desc']);

export const VIEW_SHAPES: Readonly<Record<ReportView, ViewShape>> = Object.freeze({
  'execution-summary': Object.freeze({
    optionalDimensions: Object.freeze(['workflowId', 'frozenDefinitionId', 'outcome'] as const),
    fixedDimensions: Object.freeze([]),
    maxOptional: 3,
    defaultGroupBy: Object.freeze([]),
    filters: RUN_FILTERS,
    rowSorts: Object.freeze([
      'root-created-desc',
      'root-created-asc',
      'duration-desc',
      'outcome-asc'
    ] as const),
    groupSorts: GROUP_SORTS
  }),
  'attempt-detail': Object.freeze({
    optionalDimensions: Object.freeze([]),
    fixedDimensions: Object.freeze([]),
    maxOptional: 0,
    defaultGroupBy: Object.freeze([]),
    filters: RUN_FILTERS,
    rowSorts: Object.freeze(['root-created-desc', 'root-created-asc'] as const),
    groupSorts: Object.freeze([])
  }),
  'failure-cause': Object.freeze({
    optionalDimensions: Object.freeze(['workflowId', 'frozenDefinitionId'] as const),
    fixedDimensions: Object.freeze(['failureCause'] as const),
    maxOptional: 2,
    defaultGroupBy: Object.freeze([]),
    filters: RUN_FILTERS,
    rowSorts: Object.freeze([]),
    groupSorts: GROUP_SORTS
  }),
  'workflow-revision': Object.freeze({
    optionalDimensions: Object.freeze([]),
    fixedDimensions: Object.freeze(['workflowId', 'frozenDefinitionId'] as const),
    maxOptional: 0,
    defaultGroupBy: Object.freeze([]),
    filters: RUN_FILTERS,
    rowSorts: Object.freeze([]),
    groupSorts: GROUP_SORTS
  }),
  'time-series': Object.freeze({
    optionalDimensions: Object.freeze(['workflowId', 'outcome'] as const),
    fixedDimensions: Object.freeze(['localDay'] as const),
    maxOptional: 2,
    defaultGroupBy: Object.freeze([]),
    filters: RUN_FILTERS,
    rowSorts: Object.freeze([]),
    groupSorts: Object.freeze(['key-asc'] as const)
  }),
  usage: Object.freeze({
    optionalDimensions: Object.freeze(['backend', 'model', 'utcDay'] as const),
    fixedDimensions: Object.freeze([]),
    maxOptional: 3,
    defaultGroupBy: Object.freeze(['backend', 'model'] as const),
    filters: Object.freeze(['rootId', 'backend', 'model'] as const),
    rowSorts: Object.freeze([]),
    groupSorts: Object.freeze(['key-asc'] as const)
  })
});

/** Filters that take one value each, because F06 filters take one value per dimension. */
export const SINGLE_VALUE_FILTERS: readonly ReportFilterKey[] = Object.freeze(['backend', 'model']);

export const MAX_FILTER_VALUES = 64;
export const MAX_GROUP_BY = 3;
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_BYTES = 1024 * 1024;
export const DEFAULT_RANGE_DAYS = 30;
export const MAX_RANGE_DAYS = 90;
export const MAX_CURSOR_CHARS = 256;
export const MAX_TIMEZONE_CHARS = 64;
export const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReportRange {
  /** UTC milliseconds, inclusive. */
  readonly startMs: number;
  /** UTC milliseconds, exclusive. */
  readonly endMs: number;
}

export type ReportFilters = Partial<Record<ReportFilterKey, readonly string[]>>;

/** The raw request a caller sends; every field but `view` is optional. */
export interface ReportQueryInput {
  readonly view: ReportView;
  readonly range?: ReportRange;
  readonly timezone?: string;
  readonly filters?: ReportFilters;
  readonly groupBy?: readonly ReportDimension[];
  readonly sort?: ReportSort;
  readonly pageSize?: number;
}

/** A validated query in canonical form: defaults applied, filter values sorted by code point. */
export interface ReportQuery {
  readonly view: ReportView;
  readonly range: ReportRange;
  readonly timezone: string;
  readonly filters: ReportFilters;
  readonly groupBy: readonly ReportDimension[];
  readonly sort: ReportSort;
  readonly pageSize: number;
}
