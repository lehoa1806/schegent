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
  /**
   * When omitted or `true`, child CLI processes inherit the VS Code extension
   * host environment and overlay Schegent-controlled `env` keys. When `false`,
   * the runner spawns with only `env`, reducing ambient secret leakage into
   * backend CLIs for hardened operator environments.
   */
  inheritProcessEnv?: boolean;
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
  /**
   * Session ID capture — optional session ID from a prior CLI invocation.
   * When set AND `isContinue === true`, the runner uses
   * `--resume <resumeSessionId>` instead of `-c` for deterministic
   * session targeting. When omitted or undefined, the runner falls back
   * to `-c` (most-recent session).
   *
   * The field is OPTIONAL on the interface to preserve backwards-compat
   * with all existing `InvocationRequest` construction sites. The gate
   * condition is `typeof resumeSessionId === 'string'`; non-string
   * values do not trigger the `--resume` append.
   */
  resumeSessionId?: string;
  /**
   * Feature 030 BUG-002 — optional completion sentinel. When set, the
   * runner watches the streamed stdout for this substring; once seen it
   * stops waiting out the long idle timeout and instead grace-terminates
   * the process after a short settle window if it has not exited on its
   * own. A CLI that emits its terminal result but fails to exit therefore
   * no longer hangs the run until the idle-timeout fires. The phase layer
   * supplies the SCHEGENT AUDIT LOG close marker (`=== END AUDIT LOG ===`).
   * Omitted by non-phase callers (wake-up runner, contract harnesses),
   * which keep the exit-only completion path unchanged.
   */
  completionMarker?: string;
}

export interface RawInvocationOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  killed: boolean;
  timedOut: boolean;
  /**
   * Feature 030 BUG-002 — `true` iff the runner observed the request's
   * `completionMarker` in stdout and then grace-terminated the process
   * because it had produced its terminal result but did not exit within
   * the settle window. Distinct from `timedOut` (a genuine no-output idle
   * stall): a `completedAwaitingExit` invocation carries a complete result
   * in `stdout` and is classified by its parsed outcome, not as a timeout
   * failure. `killed` stays `false` on this path so the controller does
   * not treat it as an operator cancellation. `undefined` from a
   * non-runner fixture is equivalent to `false`.
   */
  completedAwaitingExit?: boolean;
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
  /**
   * Feature 068 — the assembled CLI command (cliPath + argv) that the
   * runner spawned. Returned so the controller can emit a single
   * `cli-invocation` audit event whose `payload.command` mirrors the
   * exact argv (after redaction via the audit writer's sanitizer). The
   * prompt body is INCLUDED only when the runner chose the legacy
   * `-p` transport (otherwise the argv carries a temp-file path or
   * `--prompt-stdin` placeholder). `undefined` from a non-runner
   * fixture is equivalent to "no command captured".
   */
  command?: string;
  /**
   * Session ID capture — the CLI session ID extracted from the stream-json
   * output of this invocation. When present, the controller persists it
   * on `WorkflowRun.lastCliSessionId` so future retry/resume dispatches
   * can target the exact session via `--resume <id>`. `undefined` from a
   * non-runner fixture or a non-stream-json invocation is equivalent to
   * "no session ID captured"; the caller falls back to `-c`.
   */
  cliSessionId?: string;
}
