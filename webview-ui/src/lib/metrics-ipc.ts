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
  type MetricsRunSummary,
  type ReadMetricsRequest,
  type ReadMetricsResponse
} from './messages';
import { postCommand } from './vscode-api';
import { snapshotStore } from './snapshot-store.svelte';
import { isValidReadMetricsResponse } from '../../../src/contracts/runtime-validators';

const ACK_TIMEOUT_MS = 5000;

export type ReadMetricsResult =
  | ({ readonly outcome: 'success' } & ReadMetricsResponse)
  | { readonly outcome: 'failure'; readonly reason: 'internal-error' };

// Read the aggregated metrics-dashboard payload. Resolves with the typed
// wire response on accepted ack, or a synthetic failure when the host
// rejects, the ack carries no result, or the 5-second timeout fires.
export function readMetrics(req: ReadMetricsRequest = {}): Promise<ReadMetricsResult> {
  return correlatedRequest<ReadMetricsResult>(
    () => postCommand(CMD_READ_METRICS, req).correlationId,
    (ack) => {
      if (ack.status === 'accepted' && isValidReadMetricsResponse(ack.result)) {
        return { outcome: 'success', ...ack.result };
      }
      return { outcome: 'failure', reason: 'internal-error' };
    },
    { outcome: 'failure', reason: 'internal-error' }
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
export async function readRunSummary(runId: string): Promise<RunSummaryResult> {
  const result = await readMetrics({ runIds: [runId] });
  // An absent `runSummaries` is not an empty one. The field is only present
  // when the host honoured the scope, so its absence means the answer never
  // came back — indistinguishable, from here, from a refusal.
  if (result.outcome !== 'success' || result.runSummaries === undefined) {
    return { outcome: 'unavailable' };
  }
  const summary = result.runSummaries.find((entry) => entry.runId === runId);
  return { outcome: 'read', summary: summary ?? null };
}

// Shared ack-correlation primitive: post a command, register a one-shot
// ack listener, and resolve via the supplied projection. On 5-second
// timeout, resolves with the supplied timeout fallback. The
// post-and-correlate sequence runs synchronously inside the Promise
// executor so concurrent calls never cross-resolve. Mirrors
// `phase-log-ipc.ts`'s private helper of the same name (duplicated per
// file per this codebase's existing IPC-helper convention).
function correlatedRequest<T>(
  post: () => string,
  project: (ack: {
    readonly status: 'accepted' | 'rejected';
    readonly reason?: string;
    readonly result?: unknown;
  }) => T,
  onTimeout: T
): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finalise = (result: T): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (unsubscribe !== null) {
        try {
          unsubscribe();
        } catch {
          // one-shot listener errors must not leak
        }
        unsubscribe = null;
      }
      resolve(result);
    };

    const correlationId = post();
    snapshotStore.markPending(correlationId);
    unsubscribe = snapshotStore.onceAck(correlationId, (ack) => {
      finalise(project(ack));
    });

    timer = setTimeout(() => {
      finalise(onTimeout);
    }, ACK_TIMEOUT_MS);
  });
}
