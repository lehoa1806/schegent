import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { extractCliSessionId } from "../parser/session-id-extractor";

import type {
  InvocationOutputSink,
  InvocationRequest,
  RawInvocationOutput
} from './invocation-result';
import type {
  BackendRunner,
  MonitorSidecarEvent,
  MonitorSidecarHook,
  TreeAttribution
} from '../contracts/backend-runner';
import { VerboseDiagnosticWriter } from '../audit/verbose-diagnostic-writer';
import { SanitizedLogger } from '../lib/logger';
import { buildSpawnEnv } from './spawn-env';
import { ZippedStreamBuffer } from './zipped-stream-buffer';
import {
  IncrementalFatalScanner,
  combineStreamScans
} from '../lib/incremental-fatal-scanner';
import { OutputSinkBackpressure } from './output-sink-backpressure';
import { waitForChildCompletion } from './child-completion';
import { awaitStdinDelivery, writePromptToStdin } from './child-stdin';
import { LineFramer, DEFAULT_MAX_LINE_UNITS } from '../lib/line-framer';
import { processTreeSpawnOptions, escalateAndReportTree } from './process-tree';

/** FR-R3-054 — how long after SIGKILL to check whether the group really went. */

// Feature 030 BUG-002 — after the invocation's terminal stream-json result line
// (`{"type":"result"}`) appears in stdout, the runner waits at most this long
// for the process to exit on its own before grace-terminating it. Short enough
// that a lingering process does not stall the queue; long enough for a
// well-behaved CLI to flush and exit normally. Distinct from the idle/stall
// window (`timeoutMs`).
//
// Feature 107 (FR-023) corrected this comment. It described the arming trigger
// as the request's `completionMarker` substring, which `e2bf9ad` had already
// replaced with the envelope check below — the header of
// `claude-cli-completion.test.ts` documented the same removed mechanism. The
// distinction is load-bearing, not cosmetic: a substring can be forged by
// content the model prints, a `result` envelope is emitted by the CLI harness
// and cannot be.
//
// BUG-003 (FR-026) raised this from 5 s. The bound it is derived from is a
// live turn's time-to-first-token, not a flush duration: whenever arming fires
// in error, this window is all that stands between a healthy streaming
// process and a SIGTERM, so it must exceed the longest ordinary pause between
// stream-json events. The cost of the larger value is paid only by a process
// that genuinely finished and will not exit — it lingers 15 s instead of 5 s
// before the grace-terminate, which the queue absorbs.
const COMPLETION_SETTLE_MS = 15_000;
// A resumed print-mode invocation can replay the prior turn before emitting
// the response to the newly submitted prompt. The replay may contain normal
// system/assistant/user events before its terminal result, so event shape is
// not a reliable boundary. Suppress only resumed terminal results during this
// short startup window; fresh invocations remain eligible immediately.
//
// BUG-003 (FR-026) raised this from 5 s, derived from how long a large
// conversation takes to replay. It is a wall-clock mitigation, NOT a
// structural boundary: a replay slower than this window still escapes it and
// arms the marker from a historical result, exactly as the 5 s value did. The
// value reduces how often that happens; it cannot make it impossible, because
// nothing in the stream distinguishes a replayed result from a fresh one. The
// disarm below is what bounds the damage when the escape does occur — it
// restores the full idle window as soon as the current turn emits anything,
// so the exposure is one inter-event gap rather than the whole turn. A real
// fix would need a replay/live boundary from the CLI itself.
//
// BUG-004 (FR-029) demoted this from the decision to a bound on one. Deciding
// *when* to suppress without ever deciding *what* discarded a resumed
// invocation's own result as readily as a replayed one; the boundary below
// decides, and this window now only caps how long a stream that never crosses
// it may go on suppressing. Do NOT restore it to a decision, and do not raise
// it without re-deriving the value — it is conjoined with the boundary and the
// suppressed-result bound, never consulted alone.
const RESUME_HISTORY_REPLAY_MS = 60_000;

function isTerminalResultLine(line: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;
  const record = parsed as Record<string, unknown>;
  return record.type === 'result' &&
    record.kind !== 'task-notification' &&
    record.subtype !== 'task-notification';
}

// BUG-004 (FR-029) — the structural boundary that replaced the wall-clock
// replay guess. The CLI opens every invocation with this envelope, so a
// terminal result on its far side belongs to the current turn.
//
// T075 measured what this boundary is and is not, on CLI 2.1.233 across all
// three argv prefixes the runner can build (none, `--resume <id>`, `-c`):
// `init` is the first line every time, with zero lines before it. So it has no
// separating power — nothing is ever on the near side — and "arm from a result
// after `init`" is equivalent to "always arm" on this version. What it does
// carry is the property the fix needs: `init` is always present and always
// first, so a rule keyed on it can never fail to arm, and therefore can never
// reintroduce BUG-002's stall by silently never arming. No line in the stream
// marks itself as replayed, so there is no discriminating signal to prefer.
function isSessionInitLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== 'object') return false;
    const record = parsed as Record<string, unknown>;
    return record.type === 'system' && record.subtype === 'init';
  } catch {
    return false;
  }
}

// FR-029's fallback bound. Reachable only on a CLI that emits a terminal
// result before any `init` — that is, a replaying one, which T075 found no
// reachable configuration to be. It is kept as a real safeguard rather than
// deleted because the alternative to bounding an unreachable path is an
// unbounded one: without it, a stream that never crosses the boundary
// suppresses every result it produces for the whole replay window.
const MAX_SUPPRESSED_RESULTS = 1;

function isStreamJsonEventLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== 'object') return false;
    const record = parsed as Record<string, unknown>;
    return 'type' in record &&
      record.kind !== 'task-notification' &&
      record.subtype !== 'task-notification';
  } catch {
    return false;
  }
}

export type SpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions
) => ChildProcess;

export type { MonitorSidecarEvent, MonitorSidecarHook };

export interface RunnerHandle {
  cancel(): void;
}

// Prompt transport detection has been removed. The CLI natively
// supports reading the prompt securely from stdin when -p is passed
// without a trailing prompt body argument.

function safeSpawn(
  spawnFn: SpawnFn,
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions
): ChildProcess {
  if (options.shell === true) {
    throw new Error(
      'claude-cli: shell:true is forbidden — would expose prompt body to shell interpretation'
    );
  }
  // FR-R3-054 (H-05) — its own process group, so the terminate ladder can reach
  // descendants rather than only the direct child.
  return spawnFn(command, args, { ...options, shell: false, ...processTreeSpawnOptions() });
}

/**
 * Claude CLI implementation of `BackendRunner` (see
 * `src/contracts/backend-runner.ts`). The runner spawns
 * `claude --dangerously-skip-permissions -p` and streams chunks
 * through the monitor hook. The prompt is passed via `stdin`
 * to avoid argv exposure. Output is capped at `MAX_BUFFER_BYTES` per
 * stream; truncation is silent. Timeout and cancellation both terminate
 * the subprocess via `terminate()`.
 */
export class ClaudeCliRunner implements BackendRunner {
  private readonly spawnFn: SpawnFn;
  private readonly monitorHook: MonitorSidecarHook | null;
  /**
   * Feature 093 (T046a) — every live subprocess, not just the newest.
   *
   * `BackendRunnerRegistry` caches one runner per backend kind for the
   * workspace lifetime, so concurrent Runs on the same kind share this
   * instance. A single `ChildProcess | null` slot made the second spawn
   * overwrite the first's handle and the first exit clear the slot for both,
   * which left `cancelActive()` at deactivation orphaning every child but one
   * and `hasActiveProcess` reporting `false` while a subprocess was alive.
   *
   * Keyed by a per-runner invocation token rather than by run id: an
   * invocation need not name a Run (contract harnesses do not), so a run-keyed
   * map would collide anonymous invocations onto one entry and reintroduce the
   * same clobber. The token also makes the exit-path delete exact — an
   * invocation removes its own entry and no other.
   */
  /**
   * FR-R3-083 — the run id travels WITH the child, so `cancelActive()` (which
   * iterates this map and had no run id to offer) can still attribute a
   * `tree-unconfirmed` report. Deactivation-time cancellation is one of the paths
   * FR-R3-054 was written for, and an anonymous record there would be the least
   * useful one.
   */
  private readonly active = new Map<
    number,
    TreeAttribution & { readonly child: ChildProcess }
  >();
  private nextInvocationToken = 1;

  /**
   * FR-R3-083 — children whose escalation ladder is already running.
   *
   * `terminate` is reached from four places (idle expiry, the absolute deadline,
   * the cancellation signal, and `cancelActive`) and more than one of them fires
   * on the same child routinely: an idle expiry is normally followed by the
   * controller's own abort. The `exitCode`/`signalCode` guard only catches a
   * SECOND call after the child has already died, which is exactly the case a
   * hung child does not present — and a hung child is the only case that can
   * reach the `tree-unconfirmed` report at the end of the ladder. Two ladders
   * meant two audit entries for one surviving group, which reads as two.
   */
  private readonly terminating = new WeakSet<ChildProcess>();

  constructor(
    spawnFn: SpawnFn = spawn as unknown as SpawnFn,
    monitorHook: MonitorSidecarHook | null = null,
    _options: { probeTransport?: boolean } = {},
    private readonly _logger: SanitizedLogger = new SanitizedLogger()
  ) {
    this.spawnFn = spawnFn;
    this.monitorHook = monitorHook;
  }

  public get hasActiveProcess(): boolean {
    return this.active.size > 0;
  }

  public async invoke(
    request: InvocationRequest,
    outputSink?: InvocationOutputSink
  ): Promise<RawInvocationOutput> {
    const start = Date.now();

    // Feature 032 — session-continuation hint. When `resumeSessionId`
    // is set, the runner uses `--resume <id>` for deterministic session
    // targeting instead of `-c` (which resumes the most recent session).
    // Falls back to `-c` when `isContinue === true` but no session ID
    // is available. See `src/runner/invocation-result.ts`
    // `InvocationRequest.isContinue` / `resumeSessionId` for the
    // contract, and `specs/032-context-preserving-retries/` for the
    // original `-c` design.
    //
    // Session reuse — when `sessionReuse === true`, the same `--resume`
    // argv path is used for cost-optimization (prompt cache reuse).
    // Unlike `isContinue`, session reuse does NOT fall back to `-c`
    // when no session ID is available — it starts a fresh session.
    let continuePrefix: string[];
    const shouldResume = request.isContinue === true || request.sessionReuse === true;
    if (shouldResume && typeof request.resumeSessionId === 'string') {
      continuePrefix = ['--resume', request.resumeSessionId];
    } else if (request.isContinue === true) {
      continuePrefix = ['-c'];
    } else {
      continuePrefix = [];
    }

    const baseArgs = [
      '--dangerously-skip-permissions',
      ...continuePrefix,
      '-p'
    ];
    const stdio: SpawnOptions['stdio'] = ['pipe', 'pipe', 'pipe'];

    const args = [...baseArgs];
    if (request.model && request.model.trim().length > 0) {
      args.push('--model', request.model);
    }
    if (request.effort && request.effort.trim().length > 0) {
      args.push('--effort', request.effort);
    }
    // Session reuse — always request stream-json output so the session
    // ID can be extracted from stdout via `extractCliSessionId()`. Without
    // this, session reuse cannot activate because no session ID is ever
    // captured.
    args.push('--output-format', 'stream-json');
    // Claude CLI >= 2.1.220 requires --verbose when using --output-format stream-json
    // in print mode (-p), otherwise it throws an error.
    args.push('--verbose');

    // FR-018 / FR-024 / FR-026: when the operator opted in, append the
    // diagnostic flags. No client-side flag validation — unrecognized flags
    // surface through the CLI's own exit-code / error path and feed the
    // existing fail-fast classification.
    const verboseTarget = request.verboseDiagnostics;
    let diagnosticWriter: VerboseDiagnosticWriter | null = null;
    if (verboseTarget) {
      args.push('--debug-file', verboseTarget.debugFile);
      diagnosticWriter = new VerboseDiagnosticWriter(new SanitizedLogger());
      await diagnosticWriter.prepare(verboseTarget);
    }

    // Feature 068 — capture the assembled command (cliPath + argv). Audit
    // schema v3 (2026-08-02) made `cli-invocation` payloads metadata-only,
    // so this string is never persisted; it survives as a presence signal
    // that a spawn occurred. It carries cliPath, `--debug-file` targets and
    // prompt temp-file paths, so it must not be routed into a payload —
    // see the `command` field's contract in `invocation-result.ts`.
    const command = [request.cliPath, ...args].join(' ');

    // Feature 093 (T046a) — declared outside the `try` so the `finally` below
    // can retire this invocation's entry on every exit path, thrown included.
    // A single slot self-healed on a throw because the next spawn overwrote it;
    // a map entry would leak, and a leaked entry makes `hasActiveProcess`
    // permanently true.
    const invocationToken = this.nextInvocationToken++;
    const attribution: TreeAttribution = {
      runId: request.runId ?? null,
      phase: request.phase,
      iteration: request.iteration
    };
    try {
      const child = safeSpawn(this.spawnFn, request.cliPath, args, {
        stdio,
        shell: false,
        cwd: request.cwd,
        env: buildSpawnEnv(request)
      });
      this._logger.info(`[ClaudeCliRunner] Spawned CLI: ${command}, PID=${child.pid}`);
      this.active.set(invocationToken, { child, ...attribution });
      this.emitHook({ kind: 'started', runId: request.runId ?? null, pid: child.pid ?? null });

      // FR-R3-047 — attach-then-write through the shared helper. The previous
      // shape caught synchronously around the write, and the comment claiming the
      // failure "surfaces via the existing exit-code / classification path" was
      // the defect in one sentence: an asynchronous 'error' with no listener is an
      // uncaught exception, fatal to the extension host rather than to this
      // invocation. Only the errno is logged; the prompt is operator content.
      // Started, not awaited: see the note in process-lifecycle-runner.ts. The
      // `'error'` listener is attached synchronously inside the helper, so the
      // host is protected from this point on; awaiting here would delay the
      // stream and lifecycle listeners below and lose a fast child's `'exit'`.
      this._logger.info(`[ClaudeCliRunner] Writing to CLI stdin`);
      const deliveryPromise = writePromptToStdin(child, request.prompt);

      const stdoutBuffer = new ZippedStreamBuffer();
      const stderrBuffer = new ZippedStreamBuffer();

      // Fatal-signature scan on the live stream. The buffers above retain a
      // bounded head/tail, so past the cap the parser's own `classifyFatal`
      // reads incomplete text; these scanners read every byte. Constructed
      // per invocation from the request's list and discarded with it.
      const scanFatal = request.effectiveFatalSignatures !== undefined;
      const stdoutScanner = scanFatal
        ? new IncrementalFatalScanner('stdout', request.effectiveFatalSignatures)
        : null;
      const stderrScanner = scanFatal
        ? new IncrementalFatalScanner('stderr', request.effectiveFatalSignatures)
        : null;

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');

      let timedOut = false;
      let killed = false;
      // Feature 030 BUG-002 — once the completion marker is seen in stdout, the
      // CLI has emitted its terminal result; a process that has not exited is
      // lingering, not stalling. The idle window then shrinks to
      // `COMPLETION_SETTLE_MS` and, on expiry, the runner grace-terminates and
      // reports `completedAwaitingExit` (NOT `timedOut`) so the captured result
      // is classified on its merits rather than discarded as a timeout failure.
      let sawCompletionMarker = false;
      let completedAwaitingExit = false;
      const stdoutFramer = new LineFramer();
      let reportedFramingLoss = false;
      const invocationStartedAt = Date.now();
      // BUG-004 (FR-029) — replay suppression is now decided from the stream,
      // not the clock. `sawCurrentTurnBoundary` latches on this invocation's
      // opening `system`/`init` envelope; `suppressedResults` bounds what the
      // fallback may discard when that envelope never arrives.
      let sawCurrentTurnBoundary = false;
      let suppressedResults = 0;

      // Idle timeout: the timer fires only when no stdout/stderr chunk has
      // arrived for the active window. Each data event resets it. Before the
      // completion marker the window is `timeoutMs` (a long-running phase that
      // streams progress continues indefinitely; a stalled CLI with no output
      // is terminated after the configured idle window). After the marker the
      // window is the short `COMPLETION_SETTLE_MS` settle period.
      const onIdleExpiry = (): void => {
        // BUG-003 (FR-026) — the two expiries look identical in the process
        // table and very different in cause: `settle` means the runner
        // believed the turn was over, `idle` means it saw no output at all.
        // When a settle expiry fires on a resumed invocation the replay
        // window is the first thing to suspect, so `resumed` and the elapsed
        // time are what make that diagnosable after the fact. Fixed fields
        // only — no prompt, transcript, session id, or workspace path — and
        // routed through SanitizedLogger so SECRET_PATTERNS stays the single
        // redaction source.
        this._logger.info(
          '[ClaudeCliRunner] invocation window expired ' +
            `window=${sawCompletionMarker ? 'settle' : 'idle'} ` +
            `windowMs=${sawCompletionMarker ? COMPLETION_SETTLE_MS : request.timeoutMs} ` +
            `resumed=${shouldResume} ` +
            `elapsedMs=${Date.now() - invocationStartedAt} ` +
            `phase=${request.phase} iteration=${request.iteration}`
        );
        if (sawCompletionMarker) completedAwaitingExit = true;
        else timedOut = true;
        this.terminate(child, attribution);
      };
      let timer: NodeJS.Timeout = setTimeout(onIdleExpiry, request.timeoutMs);
      let idleTimerActive = true;
      // FR-R3-075 — the absolute wall-clock deadline: armed once at spawn,
      // NEVER reset, and outside the backpressure suspension — a blocked sink
      // pauses the idle clock, not the wall. The idle window above detects a
      // stalled CLI; this bounds the invocation as a whole, so a chatty child
      // emitting a byte inside every idle window still terminates.
      let deadlineExceeded = false;
      // Read through an accessor: the flag is assigned only inside the
      // timer's closure, so top-level flow keeps the literal-false
      // narrowing and the lint's type-driven condition check would call
      // every read below unnecessary. A function entry resets narrowing.
      const deadlineFired = (): boolean => deadlineExceeded;
      const deadlineTimer =
        request.maxDurationMs !== undefined && request.maxDurationMs > 0
          ? setTimeout(() => {
              this._logger.info(
                '[ClaudeCliRunner] invocation deadline exceeded ' +
                  `maxDurationMs=${request.maxDurationMs} ` +
                  `elapsedMs=${Date.now() - invocationStartedAt} ` +
                  `phase=${request.phase} iteration=${request.iteration}`
              );
              deadlineExceeded = true;
              this.terminate(child, attribution);
            }, request.maxDurationMs)
          : null;
      const resetIdleTimer = (): void => {
        clearTimeout(timer);
        if (!idleTimerActive) return;
        timer = setTimeout(
          onIdleExpiry,
          sawCompletionMarker ? COMPLETION_SETTLE_MS : request.timeoutMs
        );
      };
      const outputBackpressure = new OutputSinkBackpressure(
        outputSink,
        () => clearTimeout(timer),
        resetIdleTimer
      );

      const diagnosticWrites: Promise<void>[] = [];
      child.stdout?.on('data', (chunk: string) => {
        stdoutBuffer.append(chunk);
        stdoutScanner?.append(chunk);
        outputBackpressure.write('stdout', child.stdout!, chunk);
        // Feature 030 BUG-002 (Fix) — parse the JSON lines to find the true final result.
        // A parsed terminal result starts the short settle window. Resumed
        // startup history is ignored even when it contains non-result events
        // before the replayed result; fresh invocations accept fast results.
        // FR-R3-052 (H-03) — the same bounded framer the monitor uses. This
        // was `stdoutLineBuffer += char`, reset only on a newline, so a stream
        // that never emitted one retained every byte the CLI produced for the
        // life of the invocation. The judgements below are unchanged: each
        // `line` is exactly what the character loop would have accumulated.
        const framed = stdoutFramer.append(chunk);
        if (framed.truncatedLines > 0 && !reportedFramingLoss) {
          reportedFramingLoss = true;
          // No silent caps. Fixed fields only, per this logger's discipline.
          this._logger.warn(
            '[ClaudeCliRunner] stdout line exceeded the framing bound ' +
              `limitUnits=${DEFAULT_MAX_LINE_UNITS} ` +
              `truncatedLines=${stdoutFramer.totals.truncatedLines} ` +
              `droppedUnits=${stdoutFramer.totals.droppedUnits} ` +
              `phase=${request.phase} iteration=${request.iteration}`
          );
        }
        for (const line of framed.lines) {
            if (isSessionInitLine(line)) sawCurrentTurnBoundary = true;
            if (isTerminalResultLine(line)) {
              const replayingHistory =
                shouldResume &&
                !sawCurrentTurnBoundary &&
                suppressedResults < MAX_SUPPRESSED_RESULTS &&
                Date.now() - invocationStartedAt < RESUME_HISTORY_REPLAY_MS;
              if (replayingHistory) {
                suppressedResults += 1;
                // FR-029 diagnosability. A suppression used to be legible only
                // as its consequence — a 90-minute idle expiry — so it is
                // logged where it happens. Fixed fields only: no prompt,
                // transcript, session id, or workspace path, and routed
                // through SanitizedLogger so SECRET_PATTERNS stays the single
                // redaction source.
                this._logger.info(
                  '[ClaudeCliRunner] suppressed terminal result ' +
                    'rule=pre-init-fallback-bound ' +
                    `resumed=${shouldResume} ` +
                    `elapsedMs=${Date.now() - invocationStartedAt} ` +
                    `windowMs=${RESUME_HISTORY_REPLAY_MS} ` +
                    `suppressedResults=${suppressedResults}/${MAX_SUPPRESSED_RESULTS} ` +
                    `phase=${request.phase} iteration=${request.iteration}`
                );
              } else {
                sawCompletionMarker = true;
              }
            } else if (isStreamJsonEventLine(line)) {
              sawCompletionMarker = false;
            }
        }
        if (!outputBackpressure.isBlocked) resetIdleTimer();
        this.emitHook({ kind: 'stdout-chunk', runId: request.runId ?? null, chunk });
        if (diagnosticWriter && verboseTarget) {
          diagnosticWrites.push(diagnosticWriter.teeStream(verboseTarget, chunk));
        }
      });
      child.stderr?.on('data', (chunk: string) => {
        stderrBuffer.append(chunk);
        stderrScanner?.append(chunk);
        outputBackpressure.write('stderr', child.stderr!, chunk);
        if (!outputBackpressure.isBlocked) resetIdleTimer();
        this.emitHook({ kind: 'stderr-chunk', runId: request.runId ?? null, chunk });
        if (diagnosticWriter && verboseTarget) {
          diagnosticWrites.push(diagnosticWriter.teeVerbose(verboseTarget, chunk));
        }
      });

      // `onAbort` is kept in scope so we can detach it after the exit
      // promise resolves. The controller reuses one AbortController.signal
      // across every phase within a `driveRun`; without the detach the
      // listener set grows by one per phase and each closure pins the
      // (already-exited) subprocess for the rest of the run.
      let onAbort: (() => void) | null = null;
      if (request.cancellationSignal) {
        onAbort = () => {
          this._logger.info(`[ClaudeCliRunner] onAbort fired! (cancellationSignal)`);
          killed = true;
          this.terminate(child, attribution);
        };
        if (request.cancellationSignal.aborted) onAbort();
        else request.cancellationSignal.addEventListener('abort', onAbort);
      }

      // FR-R3-047 (M-01) — no second argument; see child-completion.ts.
      const completion = await waitForChildCompletion(child);
      // Disarm the idle timer BEFORE reading the delivery result. The child has
      // completed, so from here the timer can only mislabel: a delivery result
      // that settles slowly used to be awaited inside the still-armed window,
      // and an expiry landing in that gap flips `timedOut` /
      // `completedAwaitingExit` on a run that had already exited.
      idleTimerActive = false;
      clearTimeout(timer);
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      // FR-R3-075 — exactly one termination reason: the deadline wins over the
      // idle stall when both elapsed in the same tick. `completedAwaitingExit`
      // is left alone — it is a classification hint, not a termination reason,
      // and a result the CLI completed before the deadline killed the lingering
      // process is still classified on its merits.
      if (deadlineFired()) timedOut = false;
      // Detach the cancellation listener here too, and for the same reason: the
      // bounded delivery read below is a NEW await after the child has already
      // completed, and an abort landing inside it would flip `killed` on an
      // invocation that had finished — reported on the result and on the
      // `exited` sidecar event. Before this await existed there was no such
      // window; closing it keeps that.
      if (onAbort !== null) {
        request.cancellationSignal?.removeEventListener?.('abort', onAbort);
      }
      // FR-R3-047 — a child that never started (ENOENT on `cliPath`) breaks the
      // stdin pipe as well: the write fails EPIPE with nothing on the far end.
      // That is not a delivery defect, and reporting it as one would name the
      // wrong cause for the commonest misconfiguration there is — while the
      // condition outranks every other arm of the phase-runner chain. The
      // child's `'error'` is observed before the write's fate is known, so this
      // is decided rather than raced. The read is skipped entirely in that case:
      // `processError` already decides the classification, so the up-to-2s grace
      // would be paid for a result discarded by construction.
      const delivery = completion.processError === true
        ? { delivered: true as const }
        : await awaitStdinDelivery(deliveryPromise);
      const stdinDeliveryFailed = !delivery.delivered;
      if (stdinDeliveryFailed) {
        this._logger.warn(
          `[ClaudeCliRunner] Prompt delivery failed: ${delivery.errorCode ?? 'unknown'}`
        );
      }
      const exitCode = completion.exitCode;
      // Feature 030 BUG-002 — a grace-terminate after the completion marker
      // is NOT an operator cancellation, so do not flag it `killed` even
      // though it exits via our SIGTERM with a null code.
      if (completion.signal && exitCode === null && !completedAwaitingExit) {
        killed = true;
      }
      if (completion.stdioCloseTimedOut) {
        this._logger.warn(
          '[ClaudeCliRunner] stdout/stderr close grace expired after process exit; local pipes closed'
        );
      }

      const exitSignal = completion.signal ??
        (child as { signalCode?: NodeJS.Signals | null }).signalCode ?? null;
      this.emitHook({
        kind: 'exited',
        runId: request.runId ?? null,
        exitCode,
        signal: exitSignal,
        killed,
        timedOut,
        ...(deadlineFired() ? { deadlineExceeded: true } : {})
      });

      let diagnosticWarnings: ReadonlyArray<string> | undefined;
      if (diagnosticWriter) {
        await Promise.allSettled(diagnosticWrites);
        const result = diagnosticWriter.result();
        diagnosticWarnings = result.warnings.length > 0 ? result.warnings : undefined;
      }
      // FR-R3-047 — a truncated prompt is recorded even when it does not decide
      // the outcome. Narrowing the phase-runner arm to a clean parse was right,
      // but it left a delivery failure on a NON-clean invocation living only in
      // the transient runtime log — and a cause that exists only there is the
      // exact shape that made a real 2026-08-16 failure undiagnosable from the
      // audit alone. This code is allowlisted in RECORDABLE_PHASE_END_WARNINGS,
      // so it is recorded rather than counted and dropped. It rides
      // `diagnosticWarnings`, which already reaches the audit payload, so the
      // evidence gap closes without touching the decision chain at all.
      if (stdinDeliveryFailed) {
        diagnosticWarnings = [...(diagnosticWarnings ?? []), 'stdin-delivery-failed'];
      }

      // Session ID capture — extract the CLI session ID from stream-json
      // stdout so the controller can persist it for future retry/resume.
      // Returns undefined when stdout is not stream-json or when no
      // session_id field was found (the caller falls back to `-c`).
      stdoutBuffer.finalize();
      stderrBuffer.finalize();
      // Classify a trailing line that arrived without a terminating newline.
      stdoutScanner?.finalize();
      stderrScanner?.finalize();
      const cliSessionId = extractCliSessionId(stdoutBuffer.decompressStream()) ?? undefined;

      return {
        stdoutBuffer,
        stderrBuffer,
        exitCode,
        killed,
        timedOut,
        ...(deadlineFired() ? { deadlineExceeded: true } : {}),
        completedAwaitingExit,
        durationMs: Date.now() - start,
        diagnosticWarnings,
        command,
        cliSessionId,
        ...(stdinDeliveryFailed
          ? { stdinDeliveryFailed: true, stdinErrorCode: delivery.errorCode }
          : {}),
        ...(stdoutScanner && stderrScanner
          ? { streamFatalMatch: combineStreamScans(stdoutScanner, stderrScanner) }
          : {})
      };
    } finally {
      this.active.delete(invocationToken);
    }
  }

  private emitHook(event: MonitorSidecarEvent): void {
    if (!this.monitorHook) return;
    try {
      this.monitorHook(event);
    } catch {
      // Hook errors must not propagate into runner control flow.
    }
  }

  /**
   * Terminate every live subprocess this runner owns, reporting whether there
   * was any. Feature 093 (T046a): the sole production caller is
   * `BackendRunnerRegistry.cancelAll()` at extension deactivation, which must
   * reach all of a shared runner's children rather than whichever one happened
   * to spawn last. Deliberately takes no run id — per-Run cancellation already
   * runs through each session's own `AbortController` and `cancellationSignal`,
   * so a run-addressed overload here would have no caller.
   */
  public cancelActive(): boolean {
    if (this.active.size === 0) return false;
    this._logger.info(`[ClaudeCliRunner] cancelActive called for ${this.active.size} subprocess(es)`);
    for (const entry of this.active.values()) {
      this.terminate(entry.child, {
        runId: entry.runId,
        phase: entry.phase,
        iteration: entry.iteration
      });
    }
    return true;
  }

  private terminate(child: ChildProcess, attribution: TreeAttribution): void {
    this._logger.info(
      `[ClaudeCliRunner] terminate called! exitCode=${child.exitCode}, signalCode=${child.signalCode}`
    );
    // FR-R3-083 — one ladder per child. See `terminating`.
    if (this.terminating.has(child)) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    this.terminating.add(child);
    escalateAndReportTree({
      child,
      attribution,
      runner: 'claude-cli',
      info: (message) => this._logger.info(`[ClaudeCliRunner] ${message}`),
      warn: (message) => this._logger.warn(`[ClaudeCliRunner] ${message}`),
      emit: (event) => this.emitHook(event)
    });
  }

}
