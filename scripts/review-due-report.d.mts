// FR-R5-F21 (FR-010 to FR-014) -- the declaration side of `review-due-report.mjs`, so
// `typecheck:tests` can see the report's evaluation.

/** What an obligation is: a held major, a registered dated review, or a marker the registry lacks. */
export type ObligationKind = 'hold' | 'review' | 'marker';

/** Where an obligation stands at the evaluated instant. */
export type ObligationStatus = 'current' | 'due' | 'overdue' | 'malformed' | 'unregistered';

/** One dated obligation. */
export interface Obligation {
  readonly kind: ObligationKind;
  /** The repository-relative document that holds it. */
  readonly owner: string;
  /** The package (hold) or the marker name (review, marker). */
  readonly subject: string;
  /** The first instant it fails, ISO-8601 UTC; `null` when it has no readable date. */
  readonly failsFrom: string | null;
  /** Why it is dated. */
  readonly trigger: string;
  readonly status: ObligationStatus;
  /** `line <n>: <reason>`, on a malformed hold only. */
  readonly detail?: string;
}

export interface Evaluation {
  /** Sorted by `failsFrom` ascending, undated last; ties by owner, then subject. */
  readonly obligations: Obligation[];
  /** Repository-relative records that could not be read. */
  readonly unreadable: string[];
}

/** Every dated obligation under `root`, judged at `nowMs`. */
export declare function evaluate(options: { readonly root: string; readonly nowMs: number }): Evaluation;

/** The stdout lines: one per obligation, then the summary line. */
export declare function formatReport(evaluation: Evaluation, nowMs: number): string[];

/** 2 when a record could not be read, else 1 when anything needs attention, else 0. */
export declare function exitCodeOf(evaluation: Evaluation): 0 | 1 | 2;

/** The evaluation root and instant, or `null` on a usage error. */
export declare function parseArgs(
  argv: readonly string[],
  defaultNowMs: number
): { root: string; nowMs: number } | null;
