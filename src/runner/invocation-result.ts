import type { Phase } from '../controller/phase';
import type { Effort } from '../config/pipeline-config';

export interface VerboseDiagnosticTarget {
  readonly directory: string;
  readonly debugFile: string;
  readonly streamFile: string;
  readonly verboseLogFile: string;
}

export interface InvocationRequest {
  phase: Phase;
  iteration: number;
  prompt: string;
  timeoutMs: number;
  cliPath: string;
  cwd: string;
  env?: Record<string, string>;
  model?: string;
  effort?: Effort;
  /**
   * Minimal `AbortSignal`-shaped contract. `removeEventListener` is OPTIONAL
   * on the type because some fake signals in legacy tests only implement
   * `addEventListener` — but production AbortSignals always provide it, and
   * the runners use it (when present) to detach the per-invocation `'abort'`
   * listener once the child exits. Without that detach, a long-lived signal
   * (shared across phases within one `driveRun`) accumulates closures that
   * pin already-exited subprocesses for the remainder of the run.
   */
  cancellationSignal?: {
    aborted: boolean;
    addEventListener(event: 'abort', cb: () => void): void;
    removeEventListener?(event: 'abort', cb: () => void): void;
  };
  verboseDiagnostics?: VerboseDiagnosticTarget;
  /**
   * Feature 032 — session-control hint set by the controller's continuation
   * dispatch paths (delayed retry, operator resume, cascaded resume of a
   * queue-paused-mid-run task, breakpoint-paused resume).
   *
   * When `true`, the runner MUST append the short-form `-c` (Claude CLI
   * `--continue`) flag to the spawned argv exactly once, positioned
   * immediately after `--dangerously-skip-permissions` and immediately
   * before the transport-specific flag (`-p`, `--prompt-file`, or
   * `--prompt-stdin`).
   *
   * When `false`, `undefined`, or omitted, the runner MUST NOT append
   * `-c` (nor its long-form alias `--continue`).
   *
   * The field is OPTIONAL on the interface to preserve backwards-compat
   * with all existing `InvocationRequest` construction sites (wake-up
   * runner, headless reactor, contract test harnesses). The gate
   * condition is strict `=== true`; truthy non-boolean values do not
   * trigger the append.
   *
   * The hint is NOT persisted on `WorkflowRun`; it is derived
   * per-dispatch by the controller from existing persisted state. It
   * is NOT serialized into the audit payload directly — the
   * `phase-start` audit event carries its own strict `isContinue:
   * boolean` field (see `src/contracts/audit-events.ts` and feature
   * 032 contract `phase-start-audit-event.md`).
   *
   * The flag does NOT mutate `prompt`. The prompt body on a
   * continuation is identical to what a fresh invocation would send;
   * `-c` continues the prior conversation and the prompt body is sent
   * as the next user message.
   */
  isContinue?: boolean;
}

export interface RawInvocationOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  killed: boolean;
  timedOut: boolean;
  durationMs: number;
  diagnosticWarnings?: ReadonlyArray<string>;
  /**
   * Feature 042 — `true` iff the runner ever observed more than
   * `MAX_BUFFER_BYTES` of stdout during the invocation and therefore
   * discarded one or more chunks from the captured `stdout` string.
   * The runner always sets the field; `undefined` from a non-runner
   * fixture is equivalent to `false` (no overflow). The downstream
   * `phase-end` audit forward in `PhaseRunner.run()` uses a strict
   * `=== true` gate before emitting the field onto the payload.
   */
  stdoutTruncated?: boolean;
  /**
   * Feature 042 — `true` iff the runner ever observed more than
   * `MAX_BUFFER_BYTES` of stderr during the invocation and therefore
   * discarded one or more chunks from the captured `stderr` string.
   * Same `undefined === false` and strict `=== true` semantics as
   * `stdoutTruncated`.
   */
  stderrTruncated?: boolean;
}
