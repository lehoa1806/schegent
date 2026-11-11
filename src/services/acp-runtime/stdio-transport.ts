/**
 * FR-R6-F13 (FR-002, FR-019, research R7) — the stdio transport for one ACP agent process.
 *
 * - The agent is launched with no shell, in its own process group on POSIX, with the
 *   environment the host launch resolver built; nothing here reads `process.env`.
 * - Lines are written through the shared stdin line channel (`src/runner/child-stdin.ts`), which
 *   attaches the `'error'` listener before any byte (FR-R3-047).
 * - `write` throws when stdin did not take the line: a line that was not written must never
 *   look written. A stdin error after a write the stream took is reported as a close, because
 *   an agent that cannot be written to cannot be driven, even while its process lives.
 * - stdout and stderr chunks go to their own listeners, unparsed. Framing is the decoder's job.
 * - The close is reported once, whether the child exits, fails to launch, loses its stdin, or
 *   is closed.
 * - `close()` is idempotent: it ends stdin, signals the tree with SIGTERM, escalates to SIGKILL
 *   after 2 s, and resolves on the exit or after the shared teardown bound, whichever is first.
 *   A reaped child is never signalled.
 *
 * Zero `vscode` imports.
 */
import { spawn, type ChildProcess } from 'node:child_process';

import type { AcpTransport } from '../../contracts/acp-runtime';
import { openStdinLineChannel, type StdinLineChannel } from '../../runner/child-stdin';
import {
  childIsReaped,
  processTreeSpawnOptions,
  signalProcessTree,
  TEARDOWN_BOUND_MS
} from '../../runner/process-tree';

/** The SIGTERM-to-SIGKILL delay, the same as the runner ladder's. */
const SIGKILL_ESCALATION_MS = 2_000;

/** Thrown by `write` when the agent's stdin did not take the line. Carries no agent data. */
export class AgentStdinRefusedError extends Error {
  constructor() {
    super('agent stdin did not accept the line');
    this.name = 'AgentStdinRefusedError';
  }
}

/** One resolved agent launch: no shell, the env already built by the host. */
export interface StdioLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

class StdioTransport implements AcpTransport {
  private readonly stdoutListeners: ((chunk: Uint8Array) => void)[] = [];
  private readonly stderrListeners: ((chunk: Uint8Array) => void)[] = [];
  private readonly closeListeners: (() => void)[] = [];
  private readonly exited: Promise<void>;
  private readonly channel: StdinLineChannel;
  private closeReported = false;
  private closing: Promise<void> | null = null;

  constructor(private readonly child: ChildProcess) {
    let markExited: () => void = () => undefined;
    this.exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    child.once('exit', () => markExited());
    child.once('error', () => {
      markExited();
      this.reportClose();
    });
    child.once('close', () => this.reportClose());
    this.channel = openStdinLineChannel(child, () => this.reportClose());
    child.stdout?.on('data', (chunk: Buffer) => this.emit(this.stdoutListeners, chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.emit(this.stderrListeners, chunk));
  }

  write(line: string): void {
    if (!this.channel.write(line)) throw new AgentStdinRefusedError();
  }

  onStdout(listener: (chunk: Uint8Array) => void): void {
    this.stdoutListeners.push(listener);
  }

  onStderr(listener: (chunk: Uint8Array) => void): void {
    this.stderrListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  close(): Promise<void> {
    if (this.closing !== null) return this.closing;
    this.closing = this.teardown();
    return this.closing;
  }

  private async teardown(): Promise<void> {
    this.channel.end();
    const timers: NodeJS.Timeout[] = [];
    if (!childIsReaped(this.child) && this.child.pid !== undefined) {
      this.signal('SIGTERM');
      timers.push(setTimeout(() => this.signal('SIGKILL'), SIGKILL_ESCALATION_MS));
    }
    const bound = new Promise<void>((resolve) => {
      timers.push(setTimeout(resolve, TEARDOWN_BOUND_MS));
    });
    try {
      await Promise.race([this.exited, bound]);
    } finally {
      for (const timer of timers) clearTimeout(timer);
    }
  }

  private signal(signal: NodeJS.Signals): void {
    if (childIsReaped(this.child)) return;
    signalProcessTree(this.child, signal).catch(() => undefined);
  }

  private emit(listeners: readonly ((chunk: Uint8Array) => void)[], chunk: Buffer): void {
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    for (const listener of listeners) listener(bytes);
  }

  private reportClose(): void {
    if (this.closeReported) return;
    this.closeReported = true;
    for (const listener of this.closeListeners) listener();
  }
}

/** Launch the agent and wrap its stdio as an `AcpTransport`. A launch failure is a close. */
export function spawnStdioTransport(input: StdioLaunch): AcpTransport {
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: input.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    ...processTreeSpawnOptions()
  });
  return new StdioTransport(child);
}
