import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import type { InvocationRequest, RawInvocationOutput } from './invocation-result';
import type {
  BackendRunner,
  MonitorSidecarEvent,
  MonitorSidecarHook
} from '../contracts/backend-runner';
import { VerboseDiagnosticWriter } from '../audit/verbose-diagnostic-writer';
import { SanitizedLogger } from '../lib/logger';
import { buildSpawnEnv } from './spawn-env';
import { extractCliSessionId } from '../parser/session-id-extractor';

const SIGKILL_DELAY_MS = 2_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
// Feature 030 BUG-002 — after the request's `completionMarker` appears in
// stdout, the runner waits at most this long for the process to exit on its
// own before grace-terminating it. Short enough that a lingering process does
// not stall the queue; long enough for a well-behaved CLI to flush and exit
// normally. Distinct from the idle/stall window (`timeoutMs`).
const COMPLETION_SETTLE_MS = 5_000;

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
  return spawnFn(command, args, { ...options, shell: false });
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
  private active: ChildProcess | null = null;

  constructor(
    spawnFn: SpawnFn = spawn as unknown as SpawnFn,
    monitorHook: MonitorSidecarHook | null = null,
    _options: { probeTransport?: boolean } = {},
    _logger: SanitizedLogger = new SanitizedLogger()
  ) {
    this.spawnFn = spawnFn;
    this.monitorHook = monitorHook;
  }

  public get hasActiveProcess(): boolean {
    return this.active !== null;
  }

  public async invoke(request: InvocationRequest): Promise<RawInvocationOutput> {
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

    // Feature 068 — capture the assembled command (cliPath + argv) so
    // the controller can emit a `cli-invocation` audit event whose
    // `payload.command` mirrors the exact spawned argv. The audit
    // writer's sanitizer runs the field through the redaction set.
    const command = [request.cliPath, ...args].join(' ');

    try {
      const child = safeSpawn(this.spawnFn, request.cliPath, args, {
        stdio,
        shell: false,
        cwd: request.cwd,
        env: buildSpawnEnv(request)
      });
      this.active = child;
      this.emitHook({ kind: 'started', pid: child.pid ?? null });

      if (child.stdin) {
        try {
          child.stdin.write(request.prompt);
          child.stdin.end();
        } catch {
          // stdin already closed; the CLI will fail and that surfaces via
          // the existing exit-code / classification path.
        }
      }

      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      // Feature 042 — observability for the silent buffer cap. The
      // flags flip `true` the first time the cumulative byte counter
      // exceeds MAX_BUFFER_BYTES and stay sticky for the remainder of
      // the invocation. They are returned on every exit path.
      let stdoutTruncated = false;
      let stderrTruncated = false;

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

      // Idle timeout: the timer fires only when no stdout/stderr chunk has
      // arrived for the active window. Each data event resets it. Before the
      // completion marker the window is `timeoutMs` (a long-running phase that
      // streams progress continues indefinitely; a stalled CLI with no output
      // is terminated after the configured idle window). After the marker the
      // window is the short `COMPLETION_SETTLE_MS` settle period.
      const onIdleExpiry = (): void => {
        if (sawCompletionMarker) completedAwaitingExit = true;
        else timedOut = true;
        this.terminate(child);
      };
      let timer: NodeJS.Timeout = setTimeout(onIdleExpiry, request.timeoutMs);
      const resetIdleTimer = (): void => {
        clearTimeout(timer);
        timer = setTimeout(
          onIdleExpiry,
          sawCompletionMarker ? COMPLETION_SETTLE_MS : request.timeoutMs
        );
      };

      const diagnosticWrites: Promise<void>[] = [];
      child.stdout?.on('data', (chunk: string) => {
        stdoutBytes += Buffer.byteLength(chunk, 'utf8');
        if (stdoutBytes <= MAX_BUFFER_BYTES) {
          stdout += chunk;
        } else {
          stdoutTruncated = true;
        }
        // Feature 030 BUG-002 — detect the completion marker on the recent tail
        // (bounded so detection stays O(chunk), not O(total)) so a marker that
        // spans a chunk boundary is still caught. Once seen, `resetIdleTimer`
        // arms the short settle window instead of the long idle window.
        if (!sawCompletionMarker) {
          const matchesMainMarker =
            request.completionMarker &&
            stdout
              .slice(-(chunk.length + request.completionMarker.length))
              .includes(request.completionMarker);
          const matchesStatusMarker = stdout
            .slice(-(chunk.length + 20))
            .includes('[SCHEGENT_STATUS:');
          if (matchesMainMarker || matchesStatusMarker) {
            sawCompletionMarker = true;
          }
        }
        resetIdleTimer();
        this.emitHook({ kind: 'stdout-chunk', chunk });
        if (diagnosticWriter && verboseTarget) {
          diagnosticWrites.push(diagnosticWriter.teeStream(verboseTarget, chunk));
        }
      });
      child.stderr?.on('data', (chunk: string) => {
        resetIdleTimer();
        stderrBytes += Buffer.byteLength(chunk, 'utf8');
        if (stderrBytes <= MAX_BUFFER_BYTES) {
          stderr += chunk;
        } else {
          stderrTruncated = true;
        }
        this.emitHook({ kind: 'stderr-chunk', chunk });
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
          killed = true;
          this.terminate(child);
        };
        if (request.cancellationSignal.aborted) onAbort();
        else request.cancellationSignal.addEventListener('abort', onAbort);
      }

      const exitCode = await new Promise<number | null>((resolve) => {
        child.on('exit', (code, signal) => {
          // Feature 030 BUG-002 — a grace-terminate after the completion marker
          // is NOT an operator cancellation, so do not flag it `killed` even
          // though it exits via our SIGTERM with a null code.
          if (signal && code === null && !completedAwaitingExit) {
            killed = true;
          }
          resolve(code);
        });
        child.on('error', () => resolve(null));
      });

      if (onAbort !== null) {
        request.cancellationSignal?.removeEventListener?.('abort', onAbort);
      }
      clearTimeout(timer);
      const exitSignal = (child as { signalCode?: NodeJS.Signals | null }).signalCode ?? null;
      this.emitHook({ kind: 'exited', exitCode, signal: exitSignal, killed, timedOut });
      this.active = null;

      let diagnosticWarnings: ReadonlyArray<string> | undefined;
      if (diagnosticWriter) {
        await Promise.allSettled(diagnosticWrites);
        const result = diagnosticWriter.result();
        diagnosticWarnings = result.warnings.length > 0 ? result.warnings : undefined;
      }

      // Session ID capture — extract the CLI session ID from stream-json
      // stdout so the controller can persist it for future retry/resume.
      // Returns undefined when stdout is not stream-json or when no
      // session_id field was found (the caller falls back to `-c`).
      const cliSessionId = extractCliSessionId(stdout) ?? undefined;

      return {
        stdout,
        stderr,
        exitCode,
        killed,
        timedOut,
        completedAwaitingExit,
        durationMs: Date.now() - start,
        diagnosticWarnings,
        stdoutTruncated,
        stderrTruncated,
        command,
        cliSessionId
      };
    } finally {
      // tempPromptFile cleanup logic removed.
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

  public cancelActive(): boolean {
    if (!this.active) return false;
    this.terminate(this.active);
    return true;
  }

  private terminate(child: ChildProcess): void {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        // child may already be exiting
      }
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }, SIGKILL_DELAY_MS).unref?.();
    }
  }
}
