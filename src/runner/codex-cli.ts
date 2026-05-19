import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import type { InvocationRequest, RawInvocationOutput } from './invocation-result';
import type {
  BackendRunner,
  MonitorSidecarEvent,
  MonitorSidecarHook
} from '../contracts/backend-runner';
import { SanitizedLogger } from '../lib/logger';
import { buildSpawnEnv } from './spawn-env';

// Feature 034 Item 050 — second `BackendRunner` adapter. The Codex CLI is
// invoked single-shot, non-interactive, with the prompt piped over stdin so
// the prompt body never appears in argv (process listing parity with
// `ClaudeCliRunner`'s `stdin` transport). Output cap, timeout enforcement,
// cancellation, and monitor sidecar are identical to `ClaudeCliRunner`.
//
// Constraints honored (mirrors `src/contracts/backend-runner.ts`):
//   - `shell: false` enforced via `safeSpawn`. `shell: true` is forbidden
//     because it would expose the prompt body to shell interpretation.
//   - Output buffers capped at `MAX_BUFFER_BYTES` per stream; overflow is
//     observable via `stdoutTruncated` / `stderrTruncated` (feature 042).
//   - Timeout terminates the subprocess via SIGTERM, escalating to SIGKILL
//     after `SIGKILL_DELAY_MS`. `timedOut` reflects this.
//   - Cancellation observes `request.cancellationSignal`; abort also routes
//     through the same `terminate()`. `killed` reflects this.
//   - Monitor sidecar (`MonitorSidecarHook`) receives `started` / `stdout-chunk`
//     / `stderr-chunk` / `exited` events identical to the Claude adapter.
//   - No retry policy in the runner — retries live in the controller.
//
// Out of scope for v1:
//   - Per-phase `-c` (continue) support (Codex's session API may differ; the
//     plan explicitly notes "does NOT need feature-flagged -c support yet").
//   - Prompt-transport probing — Codex uses stdin universally; no help-text
//     probe is needed.
//   - Verbose diagnostic tees — Codex has no equivalent of Claude's
//     `--debug-file` / `--output-format stream-json` today. The runner
//     simply ignores `request.verboseDiagnostics` if set; the controller
//     emits the existing "diagnostic-warnings" channel empty.

const SIGKILL_DELAY_MS = 2_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

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
      'codex-cli: shell:true is forbidden — would expose prompt body to shell interpretation'
    );
  }
  return spawnFn(command, args, { ...options, shell: false });
}

/**
 * Codex CLI implementation of `BackendRunner` (see
 * `src/contracts/backend-runner.ts`).
 *
 * Spawns `codex exec --no-stream` (single-shot, non-interactive) with the
 * prompt piped over stdin. Per-phase model and reasoning effort overrides
 * are forwarded as `--model <id>` and `--effort <level>` respectively,
 * matching the Claude CLI's argv shape so the controller doesn't branch on
 * backend identity.
 *
 * Wire-up: surfaced via `BackendRunnerFactory` when
 * `schegent.backend.runner === 'codex'`. The default remains `'claude'`.
 */
export class CodexCliRunner implements BackendRunner {
  private readonly spawnFn: SpawnFn;
  private readonly monitorHook: MonitorSidecarHook | null;
  private active: ChildProcess | null = null;

  constructor(
    spawnFn: SpawnFn = spawn as unknown as SpawnFn,
    monitorHook: MonitorSidecarHook | null = null,
    // Logger reserved for forward-compat (probe diagnostics, fallback warns).
    // The Codex CLI has no help-probe today; the parameter is accepted so the
    // factory's constructor shape matches `ClaudeCliRunner` without branching.
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
    const args: string[] = ['exec', '--no-stream'];
    if (request.model && request.model.trim().length > 0) {
      args.push('--model', request.model);
    }
    if (request.effort && request.effort.trim().length > 0) {
      args.push('--effort', request.effort);
    }

    const child = safeSpawn(this.spawnFn, request.cliPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
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
        // stdin already closed; the CLI will fail and that surfaces via the
        // existing exit-code / classification path.
      }
    }

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk, 'utf8');
      if (stdoutBytes <= MAX_BUFFER_BYTES) {
        stdout += chunk;
      } else {
        stdoutTruncated = true;
      }
      this.emitHook({ kind: 'stdout-chunk', chunk });
    });
    child.stderr?.on('data', (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk, 'utf8');
      if (stderrBytes <= MAX_BUFFER_BYTES) {
        stderr += chunk;
      } else {
        stderrTruncated = true;
      }
      this.emitHook({ kind: 'stderr-chunk', chunk });
    });

    let timedOut = false;
    let killed = false;

    const timer = setTimeout(() => {
      timedOut = true;
      this.terminate(child);
    }, request.timeoutMs);

    // Keep `onAbort` referenced so we can detach after exit. See the
    // matching note in `claude-cli.ts`: the controller shares one signal
    // across every phase in a `driveRun`, so an undetached listener leaks
    // a child-process closure per phase for the lifetime of the run.
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

    return {
      stdout,
      stderr,
      exitCode,
      killed,
      timedOut,
      durationMs: Date.now() - start,
      stdoutTruncated,
      stderrTruncated
    };
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
    if (!child.killed) {
      try {
        child.kill('SIGTERM');
      } catch {
        // child may already be exiting
      }
      setTimeout(() => {
        if (!child.killed) {
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
