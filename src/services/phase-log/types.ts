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

export type VerboseDiagnosticsBanner =
  | { readonly kind: 'enabled-with-sessions' }
  | { readonly kind: 'enabled-no-sessions-for-tuple' }
  | {
      readonly kind: 'disabled-no-sessions';
      readonly settingKey: 'schegent.logging.verbose';
    };

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
