/**
 * FR-R6-F13 (FR-002, FR-019, research R7) — the stdio transport for one ACP agent process and
 * the managed child-process primitive shared by maintained ACP stdio bridges.
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
  processTreeIsGone,
  processTreeSpawnOptions,
  signalProcessTree,
  TEARDOWN_BOUND_MS,
  trackGroupAtExit
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

/** Extended stdio transport carrying process-tree liveness inspection for F09-FR-17 / F09-AC-08. */
export interface AcpStdioTransport extends AcpTransport {
  readonly pid: number | undefined;
  isProcessTreeGone(): boolean;
}

export interface ManagedCliExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly launchFailed: boolean;
}

/** Managed CLI child handle used by maintained ACP bridges without importing `child_process`. */
export interface ManagedCliChild {
  readonly pid: number | undefined;
  readonly exited: Promise<ManagedCliExit>;
  writeStdin(text: string): boolean;
  endStdin(): void;
  onStdout(listener: (chunk: Uint8Array) => void): void;
  onStderr(listener: (chunk: Uint8Array) => void): void;
  isProcessTreeGone(): boolean;
  terminate(): Promise<void>;
}

function spawnDetachedProcess(input: StdioLaunch): ChildProcess {
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: input.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    ...processTreeSpawnOptions()
  });
  trackGroupAtExit(child);
  return child;
}

async function teardownChildTree(
  child: ChildProcess,
  channel: StdinLineChannel,
  exited: Promise<unknown>
): Promise<void> {
  channel.end();
  const timers: NodeJS.Timeout[] = [];
  const signalTree = (sig: NodeJS.Signals): void => {
    if (childIsReaped(child)) return;
    signalProcessTree(child, sig).catch(() => undefined);
  };
  if (!childIsReaped(child) && child.pid !== undefined) {
    signalTree('SIGTERM');
    timers.push(setTimeout(() => signalTree('SIGKILL'), SIGKILL_ESCALATION_MS));
  }
  const bound = new Promise<void>((resolve) => {
    timers.push(setTimeout(resolve, TEARDOWN_BOUND_MS));
  });
  try {
    await Promise.race([exited, bound]);
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
}

class StdioTransport implements AcpStdioTransport {
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

  get pid(): number | undefined {
    return this.child.pid;
  }

  isProcessTreeGone(): boolean {
    return processTreeIsGone(this.child);
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
    this.closing = teardownChildTree(this.child, this.channel, this.exited);
    return this.closing;
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

class ManagedCliChildImpl implements ManagedCliChild {
  private readonly stdoutListeners: ((chunk: Uint8Array) => void)[] = [];
  private readonly stderrListeners: ((chunk: Uint8Array) => void)[] = [];
  private readonly channel: StdinLineChannel;
  readonly exited: Promise<ManagedCliExit>;
  private terminating: Promise<void> | null = null;

  constructor(private readonly child: ChildProcess) {
    let settleExit: (value: ManagedCliExit) => void = () => undefined;
    let settled = false;
    const finish = (value: ManagedCliExit): void => {
      if (settled) return;
      settled = true;
      settleExit(value);
    };
    this.exited = new Promise<ManagedCliExit>((resolve) => {
      settleExit = resolve;
    });
    child.once('error', () => finish({ code: null, signal: null, launchFailed: true }));
    child.once('close', (code, signal) => finish({ code, signal, launchFailed: false }));
    child.once('exit', (code, signal) => {
      if (!child.stdout && !child.stderr) finish({ code, signal, launchFailed: false });
    });
    this.channel = openStdinLineChannel(child, () => undefined);
    child.stdout?.on('data', (chunk: Buffer) => this.emit(this.stdoutListeners, chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.emit(this.stderrListeners, chunk));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  writeStdin(text: string): boolean {
    if (!this.child.stdin || this.child.stdin.destroyed || !this.child.stdin.writable) return false;
    try {
      this.child.stdin.write(text, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  endStdin(): void {
    this.channel.end();
  }

  onStdout(listener: (chunk: Uint8Array) => void): void {
    this.stdoutListeners.push(listener);
  }

  onStderr(listener: (chunk: Uint8Array) => void): void {
    this.stderrListeners.push(listener);
  }

  isProcessTreeGone(): boolean {
    return processTreeIsGone(this.child);
  }

  terminate(): Promise<void> {
    if (this.terminating !== null) return this.terminating;
    this.terminating = teardownChildTree(this.child, this.channel, this.exited);
    return this.terminating;
  }

  private emit(listeners: readonly ((chunk: Uint8Array) => void)[], chunk: Buffer): void {
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    for (const listener of listeners) listener(bytes);
  }
}

/** Launch the agent and wrap its stdio as an `AcpStdioTransport`. A launch failure is a close. */
export function spawnStdioTransport(input: StdioLaunch): AcpStdioTransport {
  return new StdioTransport(spawnDetachedProcess(input));
}

/** Launch a managed CLI child for a maintained ACP bridge, reusing the host process-tree ladder. */
export function spawnManagedCliChild(input: StdioLaunch): ManagedCliChild {
  return new ManagedCliChildImpl(spawnDetachedProcess(input));
}
