import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { MonitorSidecarEvent, MonitorSidecarHook } from '../contracts/backend-runner';
import type { SanitizedLogger } from '../lib/logger';
import { waitForChildCompletion } from './child-completion';
import type { InvocationOutputSink, InvocationRequest, RawInvocationOutput } from './invocation-result';
import { OutputSinkBackpressure } from './output-sink-backpressure';
import { ZippedStreamBuffer } from './zipped-stream-buffer';

const SIGKILL_DELAY_MS = 2_000;
export type ProcessSpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions
) => ChildProcess;

/** Shared spawn, stream, idle-timeout, cancellation, and kill escalation. */
export class ProcessLifecycleRunner {
  private active: ChildProcess | null = null;

  constructor(
    private readonly spawnFn: ProcessSpawnFn = spawn as unknown as ProcessSpawnFn,
    private readonly monitorHook: MonitorSidecarHook | null,
    private readonly logger: SanitizedLogger,
    private readonly label: string
  ) {}

  public get hasActiveProcess(): boolean { return this.active !== null; }

  public async invoke(input: {
    request: InvocationRequest;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
    commandDisplay: string;
    outputSink?: InvocationOutputSink;
  }): Promise<RawInvocationOutput> {
    const start = Date.now();
    const { request, outputSink } = input;
    const child = this.spawnFn(request.cliPath, input.args, {
      stdio: ['pipe', 'pipe', 'pipe'], shell: false, cwd: request.cwd, env: input.env
    });
    this.active = child;
    this.emit({ kind: 'started', pid: child.pid ?? null });
    try { child.stdin?.write(request.prompt); child.stdin?.end(); } catch { /* exit surfaces */ }
    const stdoutBuffer = new ZippedStreamBuffer();
    const stderrBuffer = new ZippedStreamBuffer();
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    let timedOut = false;
    let killed = false;
    let idleTimerActive = true;
    let timer: NodeJS.Timeout;
    const reset = (): void => {
      clearTimeout(timer);
      if (!idleTimerActive) return;
      timer = setTimeout(() => { timedOut = true; this.terminate(child); }, request.timeoutMs);
    };
    timer = setTimeout(() => { timedOut = true; this.terminate(child); }, request.timeoutMs);
    const backpressure = new OutputSinkBackpressure(outputSink, () => clearTimeout(timer), reset);
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuffer.append(chunk); backpressure.write('stdout', child.stdout!, chunk);
      if (!backpressure.isBlocked) reset(); this.emit({ kind: 'stdout-chunk', chunk });
    });
    child.stderr?.on('data', (chunk: string) => {
      stderrBuffer.append(chunk); backpressure.write('stderr', child.stderr!, chunk);
      if (!backpressure.isBlocked) reset(); this.emit({ kind: 'stderr-chunk', chunk });
    });
    let onAbort: (() => void) | null = null;
    if (request.cancellationSignal) {
      onAbort = () => { killed = true; this.terminate(child); };
      if (request.cancellationSignal.aborted) onAbort();
      else request.cancellationSignal.addEventListener('abort', onAbort);
    }
    const completion = await waitForChildCompletion(child, outputSink !== undefined);
    if (completion.signal && completion.exitCode === null) killed = true;
    if (completion.stdioCloseTimedOut) this.logger.warn(`${this.label}: stdio close grace expired`);
    if (onAbort) request.cancellationSignal?.removeEventListener?.('abort', onAbort);
    idleTimerActive = false; clearTimeout(timer);
    const signal = completion.signal ?? (child as { signalCode?: NodeJS.Signals | null }).signalCode ?? null;
    this.emit({ kind: 'exited', exitCode: completion.exitCode, signal, killed, timedOut });
    this.active = null; stdoutBuffer.finalize(); stderrBuffer.finalize();
    return { stdoutBuffer, stderrBuffer, exitCode: completion.exitCode, killed, timedOut,
      durationMs: Date.now() - start, command: input.commandDisplay };
  }

  public cancelActive(): boolean {
    if (!this.active) return false;
    this.terminate(this.active); return true;
  }

  private emit(event: MonitorSidecarEvent): void {
    try { this.monitorHook?.(event); } catch { /* sidecar is observational */ }
  }

  private terminate(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill('SIGTERM'); } catch { return; }
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      }
    }, SIGKILL_DELAY_MS).unref?.();
  }
}
