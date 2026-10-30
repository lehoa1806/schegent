// Feature 249 (FR-R4-F21) — the declaration side of `advisory-report.mjs`, so `typecheck:tests` can
// see the record and the report without the script becoming TypeScript. Same arrangement as
// `gate-distance.d.mts`.
//
// The result types are imported from the compare module's declaration rather than restated: the
// record copies a result, and a second copy of its shape here would be the split that declaration
// exists to prevent.
import type {
  ComparisonResult,
  ResultReason,
  Totals,
  TreeResult
} from './advisory-compare.mjs';

/** The state of the disposition list the comparison was given. */
export interface DispositionsState {
  readonly state: 'not-supplied' | 'read' | 'unusable';
  /** Present when `state` is `unusable`: `unreadable`, `over-bound`, `malformed` or `unsupported-format`. */
  readonly defect?: string;
}

/** What the record states about the comparison besides its result. */
export interface RecordMeta {
  readonly candidate: { readonly commit: string };
  readonly base: {
    /** `null` when no base was selected. */
    readonly commit: string | null;
    readonly rule: string;
    readonly target: string | null;
  };
  /** The evaluation time, `YYYY-MM-DDTHH:MM:SS(.sss)?Z`. */
  readonly evaluatedAt: string;
  /** Not supplied when no disposition list was named. */
  readonly dispositions?: DispositionsState;
}

/** The comparison record, version 1, in the order its keys are written. */
export interface ComparisonRecord {
  readonly recordVersion: 1;
  readonly mode: 'report-only';
  readonly candidate: { readonly commit: string };
  readonly base: { readonly commit: string | null; readonly rule: string; readonly target: string | null };
  readonly evaluatedAt: string;
  readonly budgets: { readonly pairingMinutes: number; readonly freshnessHours: number };
  readonly complete: boolean;
  readonly reasons: readonly ResultReason[];
  readonly totals: Totals | null;
  readonly trees: readonly TreeResult[];
  readonly dispositions: DispositionsState;
  readonly statements: readonly string[];
  readonly limitations: readonly string[];
}

/** Build the record from a comparison result. Findings are ordered by class, tree, package and id. */
export declare function buildRecord(result: ComparisonResult, meta: RecordMeta): ComparisonRecord;

/** The record as the file the operator keeps: two-space JSON and a trailing newline. */
export declare function serializeRecord(record: ComparisonRecord): string;

/** The human report: the first four lines, reasons, provenance, every class section, limitations. */
export declare function renderReport(record: ComparisonRecord): string;

/** Replace C0, DEL and C1 controls with `\xNN`; printable text is unchanged. */
export declare function escapeForTerminal(text: unknown): string;
