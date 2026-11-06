// FR-R5-F21 (FR-007 to FR-011) -- the declaration side of `review-cadence.mjs`, so `typecheck:tests`
// can see the cadence rules the lint gates and `review-due-report.mjs` share.

/** The review interval for a held major, in days. */
export declare const INTERVAL_DAYS: 90;

/** One hold under `## Held majors`. `line` is 1-based in the record. */
export interface HeldRow {
  readonly pkg: string;
  readonly reason: string;
  readonly lastReviewed: string;
  readonly line: number;
}

/** Why a table row under `## Held majors` is not a hold. */
export type MalformedReason = 'missing-date' | 'bad-shape' | 'impossible-date';

/** A row that could not be read. `text` is the row, truncated to 200 code units. */
export interface MalformedRow {
  readonly line: number;
  readonly text: string;
  readonly reason: MalformedReason;
}

export interface HeldMajors {
  readonly rows: HeldRow[];
  readonly malformed: MalformedRow[];
  /** Whether the `## Held majors` heading was found; without it there is no section to read. */
  readonly found: boolean;
}

/** A review marker's state in one document. */
export type ReviewMarker =
  | { readonly state: 'absent' }
  | { readonly state: 'malformed'; readonly text: string }
  | { readonly state: 'dated'; readonly date: string };

/** One record that carries a dated review. */
export interface DatedRecord {
  /** Repository-relative path. */
  readonly document: string;
  /** The HTML-comment marker name, e.g. `decline-review-date`. */
  readonly marker: string;
  /** What the record defers, for the failure message. */
  readonly defers: string;
  /** Phrases the record must keep: the conditions no gate can see. */
  readonly mustMention: readonly string[];
}

/** True only for a real `YYYY-MM-DD` calendar day. */
export declare function isCalendarDate(text: unknown): boolean;

/** Every hold and every malformed row under `## Held majors`. */
export declare function readHeldMajors(record: string): HeldMajors;

/** The holds of `readHeldMajors`. */
export declare function parseHeldRows(record: string): HeldRow[];

/** Whether `lastReviewed` is MORE than `intervalDays` old at `nowMs`, from 00:00:00Z. */
export declare function isOverdue(lastReviewed: string, nowMs: number, intervalDays: number): boolean;

/** The first instant (ms since the epoch) at which a hold reviewed on `lastReviewed` is overdue. */
export declare function holdFailsFromMs(lastReviewed: string): number;

/** The marker's state: absent, malformed with its text, or dated with its day. */
export declare function readReviewMarker(body: string, marker: string): ReviewMarker;

/** The marker's day, or `null` when it is absent or malformed. */
export declare function readReviewDate(body: string, marker: string): string | null;

/** Every review-date marker name in `body`, in order of appearance. */
export declare function reviewDateMarkerNames(body: string): string[];

/** True when `today` is on or after `reviewDate`, compared as UTC calendar days. */
export declare function reviewIsDue(reviewDate: string, today: Date): boolean;

/** The first instant (ms since the epoch) at which a review dated `reviewDate` is due. */
export declare function reviewDueFromMs(reviewDate: string): number;

/** Every record in this repository that carries a dated review. */
export declare const DATED_REVIEW_RECORDS: readonly DatedRecord[];

/** Documents excluded from the completeness scan. */
export declare const NOT_A_RECORD: readonly string[];
