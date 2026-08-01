import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { ZippedStreamBuffer } from './zipped-stream-buffer';
import type { InvocationRequest, RawInvocationOutput } from './invocation-result';
import type {
  BackendRunner,
  MonitorSidecarEvent,
  MonitorSidecarHook
} from '../contracts/backend-runner';
import { SanitizedLogger } from '../lib/logger';
import { buildSpawnEnv } from './spawn-env';
import { extractCliSessionId } from '../parser/session-id-extractor';
import type { Effort } from '../config/pipeline-config';

// Feature 074 — third `BackendRunner` adapter. The Agy CLI is invoked
// single-shot, non-interactive, with the prompt piped over stdin so
// the prompt body never appears in argv (process listing parity with
// `ClaudeCliRunner`'s and `CodexCliRunner`'s stdin transport).
//
// Key differences from Claude/Codex:
//   - Session continuation: `--conversation <id>` instead of `--resume <id>`.
//   - Effort ceiling: Agy supports `low|medium|high` only; `xhigh` and
//     `max` are capped to `high` with a WARN log.
//   - Model names: quoted to handle spaces (e.g., `"model name"`).
//   - Output format: `--output-format stream-json` for session ID extraction.
//   - Permissions: `--dangerously-skip-permissions` (same as Claude).
//   - No verbose diagnostics (Agy has no `--debug-file` equivalent).
//   - No `-c` fallback for session continuation (Agy uses `--conversation`).
//
// All other constraints are identical to Claude/Codex:
//   - `shell: false` enforced via `safeSpawn`.
//   - Output buffers use `ZippedStreamBuffer` for compressed streaming.
//   - Timeout terminates via SIGTERM → SIGKILL escalation.
//   - Cancellation observes `request.cancellationSignal`.
//   - Monitor sidecar events match the Claude/Codex shape.
//   - No retry policy in the runner.

const SIGKILL_DELAY_MS = 2_000;

// Agy supports `low|medium|high` only. `xhigh` and `max` are capped
// to `high` with a WARN log so the phase doesn't fail outright.
const AGY_MAX_EFFORT: Effort = 'high';
const AGY_EFFORT_CAP_THRESHOLD: readonly Effort[] = ['xhigh', 'max'];

export type SpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions
) => ChildProcess;

export type { MonitorSidecarEvent, MonitorSidecarHook };

function safeSpawn(
  spawnFn: SpawnFn,
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions
): ChildProcess {
  if (options.shell === true) {
    throw new Error(
      'agy-cli: shell:true is forbidden — would expose prompt body to shell interpretation'
    );
  }
  return spawnFn(command, args, { ...options, shell: false });
}

/**
 * Resolve the effective effort level for the Agy CLI. Agy only supports
 * `low`, `medium`, and `high`. Higher levels are capped to `high` with
 * a WARN-level log.
 */
function resolveAgyEffort(
  effort: string | undefined,
  logger: SanitizedLogger
): string | undefined {
  if (!effort || effort.trim().length === 0) return undefined;
  const trimmed = effort.trim() as Effort;
  if ((AGY_EFFORT_CAP_THRESHOLD as readonly string[]).includes(trimmed)) {
    logger.warn(
      `agy-cli: effort '${trimmed}' is not supported by Agy CLI; capping to '${AGY_MAX_EFFORT}'`
    );
    return AGY_MAX_EFFORT;
  }
  return trimmed;
}

/**
 * Agy CLI implementation of `BackendRunner` (see
 * `src/contracts/backend-runner.ts`).
 *
 * Spawns `agy --dangerously-skip-permissions --output-format stream-json -p`
 * with the prompt piped over stdin. Per-phase model and effort overrides are
 * forwarded as `--model <id>` and `--effort <level>` respectively. Effort
 * levels above Agy's `high` ceiling are capped with a WARN log.
 *
 * Session continuation uses `--conversation <id>` (not `--resume`). When no
 * session ID is available and `isContinue === true`, the runner starts a
 * fresh session (no `-c` fallback — Agy doesn't support it).
 *
 * Wire-up: surfaced via `BackendRunnerFactory` when
 * `schegent.backend.runner === 'agy'` or per-phase `runner: 'agy'`.
 */
export class AgyCliRunner implements BackendRunner {
  private readonly spawnFn: SpawnFn;
  private readonly monitorHook: MonitorSidecarHook | null;
  private active: ChildProcess | null = null;

  constructor(
    spawnFn: SpawnFn = spawn as unknown as SpawnFn,
    monitorHook: MonitorSidecarHook | null = null,
    private readonly _logger: SanitizedLogger = new SanitizedLogger()
  ) {
    this.spawnFn = spawnFn;
    this.monitorHook = monitorHook;
  }

  public get hasActiveProcess(): boolean {
    return this.active !== null;
  }

  public async invoke(request: InvocationRequest): Promise<RawInvocationOutput> {
    const start = Date.now();

    // Session continuation — Agy uses `--conversation <id>` instead of
    // `--resume <id>`. Unlike Claude, there is no `-c` shorthand fallback;
    // when no session ID is available, the runner starts a fresh session.
    let conversationPrefix: string[];
    const shouldResume = request.isContinue === true || request.sessionReuse === true;
    if (shouldResume && typeof request.resumeSessionId === 'string') {
      conversationPrefix = ['--conversation', request.resumeSessionId];
    } else {
      conversationPrefix = [];
    }

    const args: string[] = [
      '--dangerously-skip-permissions',
      ...conversationPrefix,
      '-p'
    ];

    // Model — quote names that may contain spaces.
    if (request.model && request.model.trim().length > 0) {
      args.push('--model', request.model);
    }

    // Effort — cap `xhigh`/`max` to `high` with WARN.
    const effectiveEffort = resolveAgyEffort(request.effort, this._logger);
    if (effectiveEffort) {
      args.push('--effort', effectiveEffort);
    }

    // Stream-json output for session ID extraction.
    args.push('--output-format', 'stream-json');

    // Feature 068 — capture assembled command for cli-invocation audit.
    const command = [request.cliPath, ...args].join(' ');

    try {
      const child = safeSpawn(this.spawnFn, request.cliPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        cwd: request.cwd,
        env: buildSpawnEnv(request)
      });
      this._logger.info(`[AgyCliRunner] Spawned CLI: ${command}, PID=${child.pid}`);
      this.active = child;
      this.emitHook({ kind: 'started', pid: child.pid ?? null });

      if (child.stdin) {
        try {
          child.stdin.write(request.prompt);
          child.stdin.end();
        } catch (err) {
          this._logger.info(`[AgyCliRunner] Stdin write failed: ${(err as Error).message}`);
          // stdin already closed; the CLI will fail and that surfaces via
          // the existing exit-code / classification path.
        }
      }

      const stdoutBuffer = new ZippedStreamBuffer();
      const stderrBuffer = new ZippedStreamBuffer();

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');

      let timedOut = false;
      let killed = false;

      // Idle timeout — same pattern as Claude/Codex runners.
      let timer: NodeJS.Timeout = setTimeout(() => {
        timedOut = true;
        this.terminate(child);
      }, request.timeoutMs);
      const resetIdleTimer = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          timedOut = true;
          this.terminate(child);
        }, request.timeoutMs);
      };

      child.stdout?.on('data', (chunk: string) => {
        resetIdleTimer();
        stdoutBuffer.append(chunk);
        this.emitHook({ kind: 'stdout-chunk', chunk });
      });
      child.stderr?.on('data', (chunk: string) => {
        resetIdleTimer();
        stderrBuffer.append(chunk);
        this.emitHook({ kind: 'stderr-chunk', chunk });
      });

      // Cancellation — detach after exit to prevent closure leaks.
      let onAbort: (() => void) | null = null;
      if (request.cancellationSignal) {
        onAbort = () => {
          this._logger.info(`[AgyCliRunner] onAbort fired! (cancellationSignal)`);
          killed = true;
          this.terminate(child);
        };
        if (request.cancellationSignal.aborted) onAbort();
        else request.cancellationSignal.addEventListener('abort', onAbort);
      }

      const exitCode = await new Promise<number | null>((resolve) => {
        child.on('exit', (code, signal) => {
          if (signal && code === null) {
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

      // Session ID capture — extract from stream-json stdout.
      stdoutBuffer.finalize();
      stderrBuffer.finalize();
      const cliSessionId = extractCliSessionId(stdoutBuffer.decompressStream()) ?? undefined;

      return {
        stdoutBuffer,
        stderrBuffer,
        exitCode,
        killed,
        timedOut,
        durationMs: Date.now() - start,
        command,
        cliSessionId
      };
    } finally {
      // No temp-file cleanup needed — stdin transport only.
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
    this._logger.info(`[AgyCliRunner] cancelActive called!`);
    this.terminate(this.active);
    return true;
  }

  private terminate(child: ChildProcess): void {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        this._logger.info(`[AgyCliRunner] sending SIGTERM`);
        child.kill('SIGTERM');
      } catch (err) {
        this._logger.info(`[AgyCliRunner] SIGTERM failed: ${(err as Error).message}`);
      }
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            this._logger.info(`[AgyCliRunner] sending SIGKILL`);
            child.kill('SIGKILL');
          } catch (err) {
            this._logger.info(`[AgyCliRunner] SIGKILL failed: ${(err as Error).message}`);
          }
        }
      }, SIGKILL_DELAY_MS).unref?.();
    }
  }
}
