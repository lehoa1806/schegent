/**
 * Backend runner interface.
 *
 * Schegent currently invokes Claude CLI as the only implemented backend
 * (`src/runner/claude-cli.ts`). The orchestrator depends on the **shape** of
 * any spawn-based backend, not on Claude-specific invocation. This module
 * declares that shape so future backends (different CLI, IPC bridge, etc.)
 * can plug in without changes to the workflow controller.
 *
 * Constraints any backend MUST honor:
 *  1. Single-shot, non-interactive: each `invoke()` returns when the
 *     subprocess terminates or the per-phase timeout fires.
 *  2. Output cap: stdout/stderr buffers are capped (currently 4 MiB per
 *     stream). Truncation is **observable** — `RawInvocationOutput.stdoutTruncated`
 *     and `RawInvocationOutput.stderrTruncated` reflect whether the
 *     runner discarded chunks past the cap (feature 042).
 *  3. Timeout: the runner aborts the subprocess when `request.timeoutMs`
 *     elapses. The `timedOut` flag in `RawInvocationOutput` reflects this.
 *  4. Cancellation: the runner observes `cancellationSignal` and aborts the
 *     subprocess when the signal fires. `killed` reflects this in the output.
 *  5. Monitor sidecar: every backend SHOULD emit a `MonitorSidecarEvent`
 *     stream so the audit pipeline can hydrate live monitor events.
 *  6. No retry: retry policy lives in the controller, not the runner.
 *
 * This interface is documentary. There is no runtime registry — each
 * implementation is wired in `src/extension.ts` directly.
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
  InvocationRequest,
  RawInvocationOutput
} from '../runner/invocation-result';

export type { InvocationRequest, RawInvocationOutput };

export type MonitorSidecarEvent =
  | { readonly kind: 'started'; readonly pid: number | null }
  | { readonly kind: 'stdout-chunk'; readonly chunk: string }
  | { readonly kind: 'stderr-chunk'; readonly chunk: string }
  | {
      readonly kind: 'exited';
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly killed: boolean;
      readonly timedOut: boolean;
    };

export type MonitorSidecarHook = (event: MonitorSidecarEvent) => void;

export interface BackendRunner {
  /** Whether an invocation is currently running. */
  readonly hasActiveProcess: boolean;
  /** Run a single phase invocation. Resolves when the subprocess terminates. */
  invoke(request: InvocationRequest): Promise<RawInvocationOutput>;
  /** Cancel any in-flight invocation. Returns true if a process was killed. */
  cancelActive(): boolean;
}
