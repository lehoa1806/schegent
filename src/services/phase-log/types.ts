// Phase-log type declarations shared between the host service module
// and the IPC envelope. See `specs/020-phase-level-logs/data-model.md`.
//
// All body strings on `PhaseLogDisplayEntry` are sanitized (via
// `SanitizedLogger.sanitize`) at the IPC boundary, before the entry
// crosses host → webview. The bytes of the source `stream.jsonl` on
// disk are NEVER altered (010 T10 hard rule).

export type PhaseLogDisplayEntryKind =
  | 'assistant-text'
  | 'tool-use'
  | 'tool-result'
  | 'system'
  | 'result'
  | 'truncated-head'
  | 'tail-ended';

// Feature 029 — structured tool-call arguments preserved from the
// original `tool_use.input` object. String leaves are sanitized by the
// host-side reader before this field reaches the webview. Keys are not
// sanitized (they are well-known argument names). Deeply nested values
// are elided at depth 8.
export type ToolArgumentValue =
  | string
  | number
  | boolean
  | null
  | readonly ToolArgumentValue[]
  | { readonly [key: string]: ToolArgumentValue };

export interface PhaseLogDisplayEntry {
  readonly seq: number;
  readonly kind: PhaseLogDisplayEntryKind;
  readonly ts: string | null;
  readonly body: {
    readonly text?: string;
    readonly toolName?: string;
    readonly toolInput?: string;
    readonly toolArguments?: ToolArgumentValue;
    readonly toolResult?: string;
    readonly isError?: boolean;
    readonly systemSubtype?: string;
    readonly systemSummary?: string;
    readonly resultSummary?: string;
    readonly droppedEntryCount?: number;
    readonly reason?: 'webview-stop' | 'webview-dispose' | 'phase-complete';
  };
  readonly bodyTruncated: {
    readonly text?: { readonly originalLength: number };
    readonly toolInput?: { readonly originalLength: number };
    readonly toolArguments?: { readonly originalLength: number };
    readonly toolResult?: { readonly originalLength: number };
    readonly systemSummary?: { readonly originalLength: number };
    readonly resultSummary?: { readonly originalLength: number };
  } | null;
}

/**
 * Feature 203 (FR-001, FR-002, FR-021, D1) — the kinds of nothing a phase log
 * read can arrive at, and the one kind that is not nothing.
 *
 * WHY AN ARRAY AND NOT A UNION. `FR-024` requires that a member added without a
 * card fails a test **naming the member**. A union cannot be enumerated at
 * runtime, so a parity test written against one must restate the members by
 * hand — a fifth copy, and the one that decides whether the other four are
 * checked. With the array as the authority a new member enters every parity
 * population the moment it is declared. This is `AGENTS.md` rule 67 applied to
 * a vocabulary: a population written by hand beside the thing it checks is a
 * population that can silently stop covering it.
 *
 * EACH MEMBER IS A DISTINCT OUTCOME THE READER ACTUALLY REACHES (`FR-002`), and
 * each implies a different operator response — two members implying the same
 * response would be a defect in the enumeration rather than a detail. That test
 * is why there are eight and not nine: `record-not-readable` was struck at `Q9`
 * because it has no production site. Every refusal reaches the operator through
 * the existing `permission-denied` failure, which returns before a manifest is
 * built, so no card could ever render for it.
 */
export const PHASE_LOG_EMPTY_KINDS = [
  'entries-present',
  'phase-running-no-output',
  'phase-not-recorded',
  'diagnostics-disabled',
  'no-iteration-recorded',
  'record-path-refused',
  'record-vanished',
  'nothing-displayable'
] as const;

export type PhaseLogEmptyKind = (typeof PHASE_LOG_EMPTY_KINDS)[number];

/**
 * The carrier that takes the member across the boundary (D1, V1).
 *
 * `settingKey` stays a **literal** on the one member that needs it, rather than
 * becoming an optional field on every member: the discriminated shape is what
 * makes reading `settingKey` off any other member a compile error.
 */
export type VerboseDiagnosticsBanner =
  | { readonly kind: Exclude<PhaseLogEmptyKind, 'diagnostics-disabled'> }
  | {
      readonly kind: 'diagnostics-disabled';
      readonly settingKey: 'schegent.logging.verbose';
    };

/**
 * Feature 203 (D7, FR-016, FR-017) — progress at PHASE granularity.
 *
 * `IterationManifest.isInFlight` is task-level and stays exactly as it is: it
 * answers "is this task the running one", which is true and useful and is not
 * the question a card claiming "this phase is still producing output" needs
 * answered. `unknown` exists so that "we cannot tell" is representable rather
 * than being silently rendered as "not running" — it is treated as making no
 * progress claim, which is not the same as claiming there is no progress.
 */
export type PhaseProgress = 'running' | 'not-running' | 'unknown';

export interface PhaseLogSelection {
  readonly queueId: string;
  readonly taskId: string;
  readonly pipelineId: string;
  readonly phaseId: string;
  readonly iterationN: number | null;
}

export interface IterationManifest {
  readonly iterations: readonly number[];
  readonly selectedIteration: number | null;
  readonly entries: readonly PhaseLogDisplayEntry[];
  readonly skippedLines: number;
  readonly truncatedCount: number;
  /**
   * FR-R3-052 (H-03) — bytes at the START of the stream that were not read,
   * because the file exceeded the read bound and the tail is the useful end.
   *
   * Optional and additive, so a projection built before this field deserializes
   * unchanged. Present and nonzero is the "no silent caps" report: without it a
   * reader would show the last 8 MiB of a 4 GiB log as though it were the whole
   * log, and nothing in the UI could tell the operator otherwise.
   */
  readonly skippedLeadingBytes?: number;
  readonly verboseDiagnosticsState: VerboseDiagnosticsBanner;
  readonly isInFlight: boolean;
}

export type PhaseLogReadResult =
  | { readonly outcome: 'success'; readonly manifest: IterationManifest }
  | {
      readonly outcome: 'failure';
      readonly reason:
        | 'unknown-tuple'
        | 'permission-denied'
        | 'internal-error';
    };

export type PhaseLogTailStartResult =
  | {
      readonly outcome: 'success';
      readonly sessionId: string;
      readonly mechanism: 'fs.watch' | 'polling';
    }
  | {
      readonly outcome: 'failure';
      readonly reason:
        | 'unknown-tuple'
        | 'not-in-flight'
        | 'permission-denied'
        | 'internal-error';
    };

export interface PhaseLogTailStopResult {
  readonly outcome: 'success' | 'failure';
  readonly sessionId: string;
  readonly reason?: 'unknown-session' | 'internal-error';
}
