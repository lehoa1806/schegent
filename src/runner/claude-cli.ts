import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { randomUUID } from 'crypto';
import type { InvocationRequest, RawInvocationOutput } from './invocation-result';
import type {
  BackendRunner,
  MonitorSidecarEvent,
  MonitorSidecarHook
} from '../contracts/backend-runner';
import { VerboseDiagnosticWriter } from '../audit/verbose-diagnostic-writer';
import { SanitizedLogger } from '../lib/logger';
import { buildSpawnEnv } from './spawn-env';

const SIGKILL_DELAY_MS = 2_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 5_000;

export type SpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions
) => ChildProcess;

export type { MonitorSidecarEvent, MonitorSidecarHook };

export interface RunnerHandle {
  cancel(): void;
}

// Feature 013 Wave 8 (US8 / T110): Claude CLI prompt-transport
// detection. Three transports, in decreasing argv-exposure order:
//   - `p-flag` (legacy default): prompt body visible in process listing.
//   - `prompt-file`: prompt written to a 0600-perm temp file; argv
//     carries only the file path.
//   - `stdin`: prompt piped over stdin; argv carries neither the body
//     nor a file path.
export type PromptTransport = 'prompt-file' | 'stdin' | 'p-flag';

// Feature 041: closed enum discriminating the two paths by which
// `detectPromptTransport` resolves to the legacy `'p-flag'` fallback.
//   - `probe-error`: spawn errored OR probe timed out.
//   - `missing-markers`: probe exited cleanly but help text contained
//     neither `--prompt-file` nor `--prompt-stdin`.
export type TransportFallbackReason = 'probe-error' | 'missing-markers';

const transportCache = new Map<string, PromptTransport>();

// Feature 041: cliPaths for which the runner has already emitted the
// fallback warn. Module-level so two `ClaudeCliRunner` instances
// pointing at the same cliPath share the warn-once invariant.
const warnedFallback = new Set<string>();

/**
 * Feature 054 — Public reset for the prompt-transport cache.
 *
 * Originally test-only (`_resetPromptTransportCacheForTests`); promoted
 * to a public API so the `schegent.redetectClaudeTransport` command
 * can clear the cache mid-session and force the next `invoke` to
 * re-probe `--help`. The test alias is preserved for backward
 * compatibility with existing call sites.
 */
export function resetPromptTransportCache(): void {
  transportCache.clear();
  warnedFallback.clear();
}

/** @deprecated Use {@link resetPromptTransportCache}. Kept for existing tests. */
export const _resetPromptTransportCacheForTests = resetPromptTransportCache;

async function runHelpProbe(cliPath: string, spawnFn: SpawnFn): Promise<string> {
  const child = safeSpawn(spawnFn, cliPath, ['--help'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false
  });
  let stdout = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    if (stdout.length < MAX_BUFFER_BYTES) stdout += chunk;
  });
  // Feature 041 — Option α: throw on probe-error (spawn error OR
  // timeout) so the catch block in detectPromptTransport routes to
  // the `probe-error` reason instead of indistinguishably collapsing
  // into `missing-markers`. The kill sequence is unchanged; the
  // existing 013-era "returns p-flag when the help spawn errors"
  // contract still holds because the catch block still falls back
  // to `'p-flag'`.
  let timedOut = false;
  let errored = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill('SIGTERM');
    } catch {
      // child may already be exiting
    }
  }, PROBE_TIMEOUT_MS);
  await new Promise<void>((resolve) => {
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.on('error', () => {
      errored = true;
      clearTimeout(timer);
      resolve();
    });
  });
  if (timedOut) {
    throw new Error('claude-cli: --help probe timed out');
  }
  if (errored) {
    throw new Error('claude-cli: --help probe errored');
  }
  return stdout;
}

export async function detectPromptTransport(
  cliPath: string,
  spawnFn: SpawnFn,
  onFallback?: (reason: TransportFallbackReason) => void
): Promise<PromptTransport> {
  const cached = transportCache.get(cliPath);
  if (cached) return cached;
  let detected: PromptTransport = 'p-flag';
  let fallbackReason: TransportFallbackReason | null = null;
  try {
    const helpOutput = await runHelpProbe(cliPath, spawnFn);
    if (helpOutput.includes('--prompt-file')) {
      detected = 'prompt-file';
    } else if (helpOutput.includes('--prompt-stdin')) {
      detected = 'stdin';
    } else {
      fallbackReason = 'missing-markers';
    }
  } catch {
    detected = 'p-flag';
    fallbackReason = 'probe-error';
  }
  if (fallbackReason !== null && onFallback) {
    onFallback(fallbackReason);
  }
  transportCache.set(cliPath, detected);
  return detected;
}

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
 * `claude --dangerously-skip-permissions -p <prompt>` and streams chunks
 * through the monitor hook. Output is capped at `MAX_BUFFER_BYTES` per
 * stream; truncation is silent. Timeout and cancellation both terminate
 * the subprocess via `terminate()`.
 *
 * Feature 013 Wave 8: when constructed with `{ probeTransport: true }`,
 * the first invoke probes `claude --help` and selects a safer transport
 * (`--prompt-file` or stdin) when supported. The legacy `-p` argv
 * transport remains the fallback. Tests default to `probeTransport:
 * false` so existing spawn fixtures keep working unchanged.
 */
export class ClaudeCliRunner implements BackendRunner {
  private readonly spawnFn: SpawnFn;
  private readonly monitorHook: MonitorSidecarHook | null;
  private readonly probeTransport: boolean;
  private readonly logger: SanitizedLogger;
  private active: ChildProcess | null = null;

  constructor(
    spawnFn: SpawnFn = spawn as unknown as SpawnFn,
    monitorHook: MonitorSidecarHook | null = null,
    options: { probeTransport?: boolean } = {},
    logger: SanitizedLogger = new SanitizedLogger()
  ) {
    this.spawnFn = spawnFn;
    this.monitorHook = monitorHook;
    this.probeTransport = options.probeTransport ?? false;
    this.logger = logger;
  }

  public get hasActiveProcess(): boolean {
    return this.active !== null;
  }

  public async invoke(request: InvocationRequest): Promise<RawInvocationOutput> {
    const start = Date.now();
    const transport: PromptTransport = this.probeTransport
      ? await detectPromptTransport(
          request.cliPath,
          this.spawnFn,
          (reason) => this.emitFallbackWarn(request.cliPath, reason)
        )
      : 'p-flag';

    let tempPromptFile: string | null = null;
    let baseArgs: string[];
    let stdio: SpawnOptions['stdio'];

    // Feature 032 — session-continuation hint. When set, the runner
    // appends the short-form `-c` (Claude CLI `--continue`) flag
    // immediately after `--dangerously-skip-permissions` and immediately
    // before the transport-specific flag. The gate condition is strict
    // `=== true`; truthy non-boolean values do NOT trigger the append.
    // See `src/runner/invocation-result.ts` `InvocationRequest.isContinue`
    // for the contract, and `specs/032-context-preserving-retries/` for
    // the full design.
    const continuePrefix: string[] = request.isContinue === true ? ['-c'] : [];

    switch (transport) {
      case 'prompt-file': {
        const fs = await import('fs/promises');
        const os = await import('os');
        const path = await import('path');
        tempPromptFile = path.join(os.tmpdir(), `schegent-prompt-${randomUUID()}.txt`);
        await fs.writeFile(tempPromptFile, request.prompt, {
          encoding: 'utf8',
          mode: 0o600
        });
        baseArgs = [
          '--dangerously-skip-permissions',
          ...continuePrefix,
          '--prompt-file',
          tempPromptFile
        ];
        stdio = ['ignore', 'pipe', 'pipe'];
        break;
      }
      case 'stdin': {
        baseArgs = ['--dangerously-skip-permissions', ...continuePrefix, '--prompt-stdin'];
        stdio = ['pipe', 'pipe', 'pipe'];
        break;
      }
      case 'p-flag':
      default:
        baseArgs = [
          '--dangerously-skip-permissions',
          ...continuePrefix,
          '-p',
          request.prompt
        ];
        stdio = ['ignore', 'pipe', 'pipe'];
        break;
    }

    const args = [...baseArgs];
    if (request.model && request.model.trim().length > 0) {
      args.push('--model', request.model);
    }
    if (request.effort && request.effort.trim().length > 0) {
      args.push('--effort', request.effort);
    }
    // FR-018 / FR-024 / FR-026: when the operator opted in, append the three
    // diagnostic flags. No client-side flag validation — unrecognized flags
    // surface through the CLI's own exit-code / error path and feed the
    // existing fail-fast classification.
    const verboseTarget = request.verboseDiagnostics;
    let diagnosticWriter: VerboseDiagnosticWriter | null = null;
    if (verboseTarget) {
      args.push('--debug-file', verboseTarget.debugFile);
      args.push('--output-format', 'stream-json');
      args.push('--verbose');
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

      if (transport === 'stdin' && child.stdin) {
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

      // Idle timeout: the timer fires only when no stdout/stderr chunk has
      // arrived for `timeoutMs`. Each data event resets it. A long-running
      // phase that streams progress continues indefinitely; a stalled CLI
      // (no output) is terminated after the configured idle window.
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

      const diagnosticWrites: Promise<void>[] = [];
      child.stdout?.on('data', (chunk: string) => {
        resetIdleTimer();
        stdoutBytes += Buffer.byteLength(chunk, 'utf8');
        if (stdoutBytes <= MAX_BUFFER_BYTES) {
          stdout += chunk;
        } else {
          stdoutTruncated = true;
        }
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

      let diagnosticWarnings: ReadonlyArray<string> | undefined;
      if (diagnosticWriter) {
        await Promise.allSettled(diagnosticWrites);
        const result = diagnosticWriter.result();
        diagnosticWarnings = result.warnings.length > 0 ? result.warnings : undefined;
      }

      return {
        stdout,
        stderr,
        exitCode,
        killed,
        timedOut,
        durationMs: Date.now() - start,
        diagnosticWarnings,
        stdoutTruncated,
        stderrTruncated,
        command
      };
    } finally {
      if (tempPromptFile) {
        try {
          const fs = await import('fs/promises');
          await fs.unlink(tempPromptFile);
        } catch {
          // best-effort cleanup; the temp file is in os.tmpdir() and will
          // be reaped by the OS eventually.
        }
      }
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

  // Feature 041 — emit exactly one fallback warn per cliPath per
  // process. The module-level `warnedFallback` set is keyed on
  // `cliPath` so two runner instances pointing at the same CLI share
  // the warn-once invariant. Logger throws are swallowed (mirrors
  // `emitHook` above) to keep runner control flow intact.
  private emitFallbackWarn(cliPath: string, reason: TransportFallbackReason): void {
    if (warnedFallback.has(cliPath)) return;
    warnedFallback.add(cliPath);
    try {
      this.logger.warn(
        'claude-cli: prompt-transport fell back to argv -p; upgrading claude is recommended',
        { cliPath, reason }
      );
    } catch {
      // Logger errors must not propagate into runner control flow.
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
