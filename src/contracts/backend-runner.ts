/**
 * Backend runner interface.
 *
 * Claude, Codex, and Agy implement this contract. The orchestrator depends on
 * the **shape** of a spawn-based backend, not CLI-specific invocation flags.
 *
 * Constraints any backend MUST honor:
 *  1. Single-shot, non-interactive: each `invoke()` returns when the
 *     subprocess terminates or the per-phase timeout fires.
 *  2. Output cap: stdout/stderr each use a bounded `ZippedStreamBuffer` that
 *     retains an ordered head and rolling tail with an explicit truncation marker.
 *  3. Timeout: the runner aborts the subprocess when `request.timeoutMs`
 *     elapses. The `timedOut` flag in `RawInvocationOutput` reflects this.
 *  4. Cancellation: the runner observes `cancellationSignal` and aborts the
 *     subprocess when the signal fires. `killed` reflects this in the output.
 *  5. Monitor sidecar: every backend SHOULD emit a `MonitorSidecarEvent`
 *     stream so the audit pipeline can hydrate live monitor events.
 *  6. No retry: retry policy lives in the controller, not the runner.
 *
 * `BackendRunnerRegistry` is the runtime construction and lifecycle owner.
 */

// `InvocationRequest` and `RawInvocationOutput` are the wire shapes between
// the controller and any concrete `BackendRunner`. The canonical
// definitions live in `src/runner/invocation-result.ts` (they include
// runner-only optional fields such as `diagnosticWarnings` and
// `verboseDiagnostics` that the controller forwards untouched). The
// contract re-exports those types so adapters and consumers see a single
// type identity and the controller doesn't need to choose between two
// near-identical shapes.
import type {
  InvocationOutputSink,
  InvocationRequest,
  RawInvocationOutput
} from '../runner/invocation-result';

export type { InvocationRequest, RawInvocationOutput };

/**
 * Feature 093 (T046) — every sidecar event names the Run whose subprocess
 * produced it.
 *
 * The hook is one window-level function shared by every runner, and before this
 * the events were anonymous: the monitor attached each chunk to whichever Run
 * had most recently called `onStart`. That was unambiguous while a window could
 * only execute one Run and silently wrong the moment it can execute several —
 * Run B's stdout would extend Run A's stall deadline and land in A's audit
 * stream. `runId` is `null` only when the invocation carried none (fakes and
 * older callers); the monitor treats that as "no attributable Run" and ignores
 * the event rather than guessing.
 */
export type MonitorSidecarEvent =
  | { readonly kind: 'started'; readonly runId: string | null; readonly pid: number | null }
  | { readonly kind: 'stdout-chunk'; readonly runId: string | null; readonly chunk: string }
  | { readonly kind: 'stderr-chunk'; readonly runId: string | null; readonly chunk: string }
  | {
      readonly kind: 'exited';
      readonly runId: string | null;
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly killed: boolean;
      readonly timedOut: boolean;
      /** FR-R3-075 — the absolute deadline fired; distinct from the idle stall. */
      readonly deadlineExceeded?: boolean;
    };

export type MonitorSidecarHook = (event: MonitorSidecarEvent) => void;

export interface BackendRunner {
  /** Whether an invocation is currently running. */
  readonly hasActiveProcess: boolean;
  /** Run a single phase invocation. Resolves when the subprocess terminates. */
  invoke(
    request: InvocationRequest,
    outputSink?: InvocationOutputSink
  ): Promise<RawInvocationOutput>;
  /** Cancel any in-flight invocation. Returns true if a process was killed. */
  cancelActive(): boolean;
}
