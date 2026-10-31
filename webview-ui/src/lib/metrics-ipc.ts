// Feature 073 T012 — metrics IPC helper. The SINGLE call site for
// `CMD_READ_METRICS`. Mirrors the `correlatedRequest` pattern from
// `phase-log-ipc.ts`.
//
// Webview components MUST NOT import CMD_READ_METRICS directly — they
// route through this module. The lint regression at
// `tests/lint/no-inline-read-metrics-ipc.test.ts` fails the build on any
// drift (contracts/cmd-read-metrics.md's "Invariants (test-enforced)").
//
// No dedicated MSG_METRICS_RESULT push message exists (metrics has no
// streaming counterpart to the phase-log tail feed) — this helper only
// ever resolves a single request/response ack.

import {
  CMD_READ_METRICS,
  type CommandType,
  type MetricsRunSummary,
  type ReadMetricsRequest,
  type ReadMetricsResponse
} from './messages';
import { OUTCOME_NOT_YET_KNOWN_TEXT, boundaryRefusalText } from './boundary-refusal-text';
import { postCommand } from './vscode-api';
import { sendIntent, type IntentWaitOptions } from './intent-ledger';
import { isValidReadMetricsResponse } from '../../../src/contracts/runtime-validators';

const ACK_TIMEOUT_MS = 5000;

export type ReadMetricsResult =
  | ({ readonly outcome: 'success' } & ReadMetricsResponse)
  // FR-R4-F05 (O1, O7) — `refusalText` is set when the failure was a refusal (the router's
  // gate, or a dispatch that threw); `reason` keeps the wire's closed union.
  | {
      readonly outcome: 'failure';
      readonly reason: 'internal-error';
      readonly refusalText?: string;
    };

// Read the aggregated metrics-dashboard payload. Resolves with the typed
// wire response on accepted ack, or a synthetic failure when the host
// rejects, the ack carries no result, or the 5-second timeout fires.
export function readMetrics(
  req: ReadMetricsRequest = {},
  wait?: IntentWaitOptions<ReadMetricsResult>
): Promise<ReadMetricsResult> {
  return correlatedRequest<ReadMetricsResult, ReadMetricsRequest>(
    CMD_READ_METRICS,
    req,
    (correlationId, payload) => {
      postCommand(CMD_READ_METRICS, payload, { correlationId });
    },
    (ack) => {
      if (ack.status === 'accepted' && isValidReadMetricsResponse(ack.result)) {
        return { outcome: 'success', ...ack.result };
      }
      return {
        outcome: 'failure',
        reason: 'internal-error',
        ...(ack.status === 'rejected' && ack.reason !== undefined
          ? { refusalText: boundaryRefusalText(ack.reason) }
          : {})
      };
    },
    // FR-R4-F05 (I5, O3) — a timeout is not an internal error: the host may still answer.
    { outcome: 'failure', reason: 'internal-error', refusalText: OUTCOME_NOT_YET_KNOWN_TEXT },
    wait
  );
}

// Feature 103 (T094, FR-026) — the run detail's read. Three outcomes, not
// two: `read` with a summary (the run reported), `read` with `null` (the read
// landed and the run has no rollup record), and `unavailable` (nobody looked).
// Collapsing the last two would tell an operator a run was free when the truth
// is that the host never answered.
export type RunSummaryResult =
  | { readonly outcome: 'read'; readonly summary: MetricsRunSummary | null }
  | { readonly outcome: 'unavailable' };

// Read one run's rollup figures. Scoped at the request, not filtered from a
// corpus-wide read: FR-023 rules out the second store a whole-history read
// would need to stay affordable.
export async function readRunSummary(
  runId: string,
  wait: IntentWaitOptions<RunSummaryResult> = {}
): Promise<RunSummaryResult> {
  const toSummary = (result: ReadMetricsResult): RunSummaryResult => {
    // An absent `runSummaries` is not an empty one. The field is only present
    // when the host honoured the scope, so its absence means the answer never
    // came back — indistinguishable, from here, from a refusal.
    if (result.outcome !== 'success' || result.runSummaries === undefined) {
      return { outcome: 'unavailable' };
    }
    const summary = result.runSummaries.find((entry) => entry.runId === runId);
    return { outcome: 'read', summary: summary ?? null };
  };
  // FR-R4-F05 (I6, FR-024) — a late answer reaches the caller through the same projection.
  const { onLateOutcome } = wait;
  return toSummary(
    await readMetrics(
      { runIds: [runId] },
      {
        ...(wait.signal === undefined ? {} : { signal: wait.signal }),
        ...(onLateOutcome === undefined ? {} : { onLateOutcome: (late) => onLateOutcome(toSummary(late)) })
      }
    )
  );
}

// Shared ack-correlation primitive. FR-R4-F05 (I4): it sends through the intent ledger, so an
// identical retry of an unresolved read reuses its identity and payload. On the 5-second
// timeout it resolves with the supplied fallback (the outcome is not yet known).
function correlatedRequest<T, P>(
  type: CommandType,
  payload: P,
  post: (correlationId: string, payload: P) => void,
  project: (ack: {
    readonly status: 'accepted' | 'rejected';
    readonly reason?: string;
    readonly result?: unknown;
  }) => T,
  onTimeout: T,
  wait: IntentWaitOptions<T> = {}
): Promise<T> {
  return sendIntent({
    type,
    payload,
    post,
    timeoutMs: ACK_TIMEOUT_MS,
    ...(wait.signal === undefined ? {} : { signal: wait.signal }),
    ...(wait.onLateOutcome === undefined
      ? {}
      : { onLateOutcome: (ack) => wait.onLateOutcome?.(project(ack)) })
  }).then((result) => (result.kind === 'ack' ? project(result.ack) : onTimeout));
}
