import type { Phase } from '../controller/phase';
import type { Effort } from '../config/pipeline-config';

export interface VerboseDiagnosticTarget {
  readonly directory: string;
  readonly debugFile: string;
  readonly streamFile: string;
  readonly verboseLogFile: string;
  /**
   * FR-R3-053 — the trusted root and the segments beneath it, so the writer can
   * OPEN through a symlink-refusing walk instead of `mkdir -p` on a composed
   * absolute path.
   *
   * `composeVerboseDiagnosticPath` already validated every segment and proved the
   * result does not escape lexically. That is not the same as opening it safely:
   * `mkdir` with `recursive` follows a symlink at any component, so a link placed
   * where the diagnostics directory belongs redirects the write — and these
   * diagnostics are deliberately unredacted.
   *
   * Required, not optional. An optional pair would let the writer keep a
   * permissive fallback, which is the gate-omitted-by-omission shape this round
   * has removed repeatedly.
   */
  readonly workspaceRoot: string;
  readonly segments: readonly string[];
}

/**
 * Optional disk-backed tee for raw subprocess output. Implementations must
 * never throw from `write`: runner data handlers cannot safely recover from
 * an output-sink exception. A `false` return applies Node stream
 * backpressure; the runner pauses that child stream until the matching
 * `onceDrain` callback fires.
 */
export interface InvocationOutputSink {
  write(stream: 'stdout' | 'stderr', chunk: string): boolean;
  onceDrain(stream: 'stdout' | 'stderr', callback: () => void): void;
}

export interface InvocationRequest {
  phase: Phase;
  iteration: number;
  /**
   * Feature 093 (T046) — the Run this invocation advances.
   *
   * Carried untouched and used for exactly one thing: stamping the monitor
   * sidecar events so a window observing several concurrent subprocesses can
   * attribute each chunk, stall, and exit to the Run that produced it. It does
   * NOT influence argv, env, or any spawn decision. Optional so the contract
   * harnesses and older construction sites compile unchanged; when absent the
   * events carry `runId: null` and the monitor ignores them rather than
   * attributing them to whichever Run happened to start most recently.
   */
  runId?: string;
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
  /**
   * Names-only ambient environment allowlist. When present (including an
   * empty array), the child receives required non-secret bootstrap variables,
   * matching `LC_*` locale variables, these approved names, and then the
   * Schegent-controlled `env` overlay. Values are always read from the host
   * environment at spawn time and are never persisted in configuration.
   */
  processEnvAllowlist?: readonly string[];
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
   * with all existing `InvocationRequest` construction sites (headless
   * reactor, contract test harnesses). The gate condition is strict
   * `=== true`; truthy non-boolean values do not trigger the append.
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
   * Session reuse — cost-optimization flag. When `true` AND
   * `resumeSessionId` is set, the runner uses `--resume <id>` to
   * reuse the CLI session's cached context across phase transitions
   * and loop iterations. Semantically distinct from `isContinue`:
   * session reuse starts a new task in the same session for prompt-
   * cache savings, not a continuation of an interrupted conversation.
   *
   * The gate condition is strict `=== true`; truthy non-boolean
   * values do not trigger the `--resume` append. When both
   * `isContinue` and `sessionReuse` are `true`, `isContinue` takes
   * precedence (they share the same `--resume` argv path, but the
   * audit semantics differ).
   *
   * NOT persisted on `WorkflowRun`; derived per-dispatch by the
   * controller. NOT serialized into the audit payload directly —
   * the `phase-start` audit event carries its own strict
   * `sessionReuse: boolean` field.
   */
  sessionReuse?: boolean;
  /**
   * Session ID capture — optional session ID from a prior CLI invocation.
   * When set AND (`isContinue === true` OR `sessionReuse === true`),
   * the runner uses `--resume <resumeSessionId>` instead of `-c` for
   * deterministic session targeting. When omitted or undefined and
   * `isContinue === true`, the runner falls back to `-c` (most-recent
   * session). When omitted and only `sessionReuse === true`, the
   * runner falls back to a fresh session (no `--resume`, no `-c`).
   *
   * The field is OPTIONAL on the interface to preserve backwards-compat
   * with all existing `InvocationRequest` construction sites. The gate
   * condition is `typeof resumeSessionId === 'string'`; non-string
   * values do not trigger the `--resume` append.
   */
  resumeSessionId?: string;
  /*
   * Feature 107 (FR-020) — `completionMarker?: string` stood here.
   *
   * Feature 030 BUG-002 introduced it with a real reader: the runner scanned
   * accumulated stdout for the substring and armed grace-termination on a
   * match. `e2bf9ad` (2026-08-01) replaced that reader with an envelope check
   * on the stream-json `{"type":"result"}` line and did not remove the field,
   * so from then on the phase layer passed a value nothing read.
   *
   * The field is gone rather than pinned inert because it had no reader at all;
   * the inert-pin idiom is for a field that is live at exactly one site. The
   * replacement boundary is stronger than a substring: a `result` envelope comes
   * from the CLI harness, so content inside a message cannot forge it, whereas
   * a close marker in a quoted diff could. `no-content-driven-process-control`
   * is the gate that keeps the substring reader from returning.
   */
  /**
   * Effective fatal-signature list (code-resident floor merged with the
   * operator-additive setting) for THIS invocation, so the runner can scan
   * for a fatal signature as chunks arrive rather than only over the text
   * retention happened to keep.
   *
   * Supplied per invocation and never held across one, per the
   * "never cache the operator-additive fatal-signature setting across
   * phase invocations" rule. Omitting it disables the streaming scan and
   * leaves the retained-text `classifyFatal` in `stdout-parser.ts` as the
   * only classifier — the pre-existing behavior, which is what contract
   * harnesses and fixtures get.
   */
  effectiveFatalSignatures?: ReadonlyArray<EffectiveSignature>;
}

import type { ZippedStreamBuffer } from './zipped-stream-buffer';
import type {
  EffectiveSignature,
  FatalClassification
} from '../lib/fatal-signature-registry';

export interface RawInvocationOutput {
  stdoutBuffer: ZippedStreamBuffer;
  stderrBuffer: ZippedStreamBuffer;
  exitCode: number | null;
  killed: boolean;
  timedOut: boolean;
  /**
   * Feature 030 BUG-002 — `true` iff the runner observed the invocation's
   * terminal `{"type":"result"}` stream-json line and then grace-terminated the
   * process because it had produced its terminal result but did not exit within
   * the settle window. (Until `e2bf9ad` the trigger was a `completionMarker`
   * substring in stdout; Feature 107 removed the residual field.)
   * Distinct from `timedOut` (a genuine no-output idle
   * stall): a `completedAwaitingExit` invocation carries a complete result
   * in `stdout` and is classified by its parsed outcome, not as a timeout
   * failure. `killed` stays `false` on this path so the controller does
   * not treat it as an operator cancellation. `undefined` from a
   * non-runner fixture is equivalent to `false`.
   */
  completedAwaitingExit?: boolean;
  /**
   * FR-R3-047 (H-04) — `true` iff writing the prompt to the child's stdin
   * FAILED. Absent is equivalent to `false`, so a non-runner fixture that omits
   * it reads as a healthy delivery.
   *
   * The condition is one-directional on purpose. Set, it proves the backend
   * answered a truncated prompt. Unset, it only means the write reported no
   * error — a prompt small enough to fit the OS pipe buffer is accepted even by
   * a child that reads nothing, so this is never evidence that the backend
   * consumed the prompt.
   *
   * Distinct from every neighbour here. `timedOut` is a run that produced
   * nothing for too long; `killed` is a run someone ended; a non-zero
   * `exitCode` is a run the backend itself failed. This is a run the backend
   * never fully heard: whatever it emitted is an answer to a *truncated*
   * prompt, which is why the phase runner treats it as outranking even a clean
   * termination token. A backend that certifies success on half a prompt is
   * certifying the wrong work.
   *
   * Decided by the write-completion callback, never by `stdin.bytesWritten` —
   * that counter reaches the full prompt length even when the write fails,
   * because it counts bytes handed to the stream rather than bytes the peer
   * accepted.
   */
  stdinDeliveryFailed?: boolean;
  /**
   * The errno behind `stdinDeliveryFailed` (for example `EPIPE`). An error code
   * only: the prompt is operator content and may contain anything, so no part
   * of it is ever carried here or anywhere else on this result.
   */
  stdinErrorCode?: string;
  durationMs: number;
  diagnosticWarnings?: ReadonlyArray<string>;
  /**
   * Feature 068 — the assembled CLI command (cliPath + argv) that the
   * runner spawned. Its **content is never persisted**. Audit schema v3
   * (2026-08-02) made `cli-invocation` payloads metadata-only, so
   * `payload.command` no longer exists and `phase-runner`'s `onCommand`
   * handler deliberately takes no argument — it emits runner, operation,
   * permission mode and the continuation booleans, and drops this string.
   * What the field still carries is *presence*: a non-empty value is the
   * compactor's signal that a spawn happened and an audit event is due.
   *
   * Do NOT route it into an audit payload. It contains `cliPath`,
   * `--debug-file` targets and prompt temp-file paths, so persisting it
   * would breach the v3 projection — which fails the append on residual
   * paths rather than redacting them — and the standing rule against
   * serializing workspace paths into the audit log. The prompt body is
   * additionally INCLUDED when the runner chose the legacy `-p`
   * transport. `undefined` from a non-runner fixture is equivalent to
   * "no command captured".
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
  /**
   * Result of the incremental fatal-signature scan over every byte this
   * invocation emitted, present only when the request supplied
   * `effectiveFatalSignatures`.
   *
   * `classifyFatal` in the parser sees `stdoutBuffer` / `stderrBuffer`
   * AFTER retention, so above `MAX_STREAM_BUFFER_BYTES` it reads a head
   * plus a rolling tail and a signature in the discarded middle is
   * invisible to it. This field is computed on the live stream and is
   * therefore complete regardless of truncation. It can only ever ADD a
   * fatal classification the retained-text scan would have missed; it
   * never suppresses one, so it does not widen or narrow the
   * code-resident floor.
   */
  streamFatalMatch?: FatalClassification;
}
