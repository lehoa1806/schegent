import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { MonitorSidecarEvent, MonitorSidecarHook } from '../contracts/backend-runner';
import type { SanitizedLogger } from '../lib/logger';
import { waitForChildCompletion } from './child-completion';
import { awaitStdinDelivery, writePromptToStdin } from './child-stdin';
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
  /**
   * Feature 093 (T046a) — every live subprocess, not just the newest.
   *
   * `BackendRunnerRegistry` caches one runner per backend kind for the
   * workspace lifetime, so concurrent Runs on the same kind share this
   * instance. A single `ChildProcess | null` slot made the second spawn
   * overwrite the first's handle and the first exit clear the slot for both,
   * which left `cancelAll()` at deactivation orphaning every child but one and
   * `hasActiveProcess` reporting `false` while a subprocess was still alive.
   *
   * Keyed by a per-runner invocation token rather than by run id: an
   * invocation need not name a Run (contract harnesses do not), so a run-keyed
   * map would collide anonymous invocations onto one entry and reintroduce the
   * same clobber. The token also makes the exit-path delete exact — an
   * invocation removes its own entry and no other.
   */
  private readonly active = new Map<number, ChildProcess>();
  private nextInvocationToken = 1;

  constructor(
    private readonly spawnFn: ProcessSpawnFn = spawn as unknown as ProcessSpawnFn,
    private readonly monitorHook: MonitorSidecarHook | null,
    private readonly logger: SanitizedLogger,
    private readonly label: string
  ) {}

  public get hasActiveProcess(): boolean { return this.active.size > 0; }

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
    const invocationToken = this.nextInvocationToken++;
    this.active.set(invocationToken, child);
    // Feature 093 (T046a) — `finally`, not a trailing statement. A single slot
    // self-healed on a throw because the next spawn overwrote it; a map entry
    // would leak, and a leaked entry makes `hasActiveProcess` permanently true.
    try {
      this.emit({ kind: 'started', runId: request.runId ?? null, pid: child.pid ?? null });
      // FR-R3-047 — attach-then-write through the shared helper. The previous
      // shape was a synchronous try/catch around the write, which cannot see the
      // asynchronous 'error' event; with no listener anywhere, EPIPE reached the
      // extension host as an uncaught exception and killed it.
      //
      // Started, NOT awaited here. The helper attaches its `'error'` listener
      // synchronously before returning, so protection is in place immediately —
      // but awaiting at this point would delay every listener below by a turn of
      // the event loop, and a child that exits inside that window emits `'exit'`
      // before anything is listening, leaving the invocation waiting forever.
      // Observed as a hung suite. The answer is consumed where it is needed,
      // beside the completion result.
      const deliveryPromise = writePromptToStdin(child, request.prompt);
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
        if (!backpressure.isBlocked) reset(); this.emit({ kind: 'stdout-chunk', runId: request.runId ?? null, chunk });
      });
      child.stderr?.on('data', (chunk: string) => {
        stderrBuffer.append(chunk); backpressure.write('stderr', child.stderr!, chunk);
        if (!backpressure.isBlocked) reset(); this.emit({ kind: 'stderr-chunk', runId: request.runId ?? null, chunk });
      });
      let onAbort: (() => void) | null = null;
      if (request.cancellationSignal) {
        onAbort = () => { killed = true; this.terminate(child); };
        if (request.cancellationSignal.aborted) onAbort();
        else request.cancellationSignal.addEventListener('abort', onAbort);
      }
      // FR-R3-047 (M-01) — no second argument. It used to be
      // `outputSink !== undefined`, which let the transcript MODE select the
      // completion SEMANTICS: with capture off the runner stopped at `exit` and
      // lost anything buffered before `close`, including the terminal result
      // line and the session id. A privacy setting must not decide correctness.
      const completion = await waitForChildCompletion(child);
      // Disarm the idle timer BEFORE reading the delivery result. The child has
      // completed, so from here the timer can only mislabel: a delivery result
      // that settles slowly used to be awaited inside the still-armed window,
      // and an expiry landing in that gap flips `timedOut` on a run that had
      // already exited cleanly.
      idleTimerActive = false; clearTimeout(timer);
      // Detached here too, and for the same reason: the bounded delivery read
      // below is a NEW await after the child has already completed, and an abort
      // landing inside it would flip `killed` on an invocation that had
      // finished. Before this await existed there was no such window.
      if (onAbort) request.cancellationSignal?.removeEventListener?.('abort', onAbort);
      // FR-R3-047 — a child that never started (ENOENT on `cliPath`) breaks the
      // stdin pipe as well, so the write fails EPIPE with nothing on the far
      // end. That is not a delivery defect: reporting it as one would name the
      // wrong cause for the commonest misconfiguration there is, and the
      // condition outranks every other arm of the phase-runner chain. The read
      // is skipped entirely in that case: `processError` already decides the
      // classification, so the up-to-2s grace would be paid for a result
      // discarded by construction.
      const delivery = completion.processError === true
        ? { delivered: true as const }
        : await awaitStdinDelivery(deliveryPromise);
      const stdinDeliveryFailed = !delivery.delivered;
      if (stdinDeliveryFailed) {
        this.logger.warn(`${this.label}: prompt delivery failed (${delivery.errorCode ?? 'unknown'})`);
      }
      if (completion.signal && completion.exitCode === null) killed = true;
      if (completion.stdioCloseTimedOut) this.logger.warn(`${this.label}: stdio close grace expired`);
      const signal = completion.signal ?? (child as { signalCode?: NodeJS.Signals | null }).signalCode ?? null;
      this.emit({
        kind: 'exited', runId: request.runId ?? null,
        exitCode: completion.exitCode, signal, killed, timedOut
      });
      stdoutBuffer.finalize(); stderrBuffer.finalize();
      return { stdoutBuffer, stderrBuffer, exitCode: completion.exitCode, killed, timedOut,
        durationMs: Date.now() - start, command: input.commandDisplay,
        // FR-R3-047 — see the note in claude-cli.ts: the allowlisted code rides
        // `diagnosticWarnings` so a truncated prompt is recorded even on a
        // non-clean invocation, where the phase-runner arm deliberately does not
        // fire. Without it the cause would live only in the transient log.
        ...(stdinDeliveryFailed
          ? {
              stdinDeliveryFailed: true,
              stdinErrorCode: delivery.errorCode,
              diagnosticWarnings: ['stdin-delivery-failed']
            }
          : {}) };
    } finally {
      this.active.delete(invocationToken);
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
    for (const child of this.active.values()) this.terminate(child);
    return true;
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
