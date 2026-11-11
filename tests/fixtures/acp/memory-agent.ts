/**
 * FR-R6-F13 T002 — an in-memory ACP agent for unit tests.
 *
 * SYNTHETIC. It is not a recording of any real agent. The test scripts the agent side: a reply
 * per method (a result, a JSON-RPC error, or silence), notifications and agent requests sent on
 * demand, raw bytes for hostile-transport cases, and a close. Every line the client writes is
 * kept, parsed, in order. Delivery to the client is asynchronous (one microtask), as a real pipe
 * is, so a client cannot depend on a reply arriving inside its own `write`.
 */
import type { AcpClock, AcpTimer, AcpTransport } from '../../../src/contracts/acp-runtime';

export type ScriptedReply =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } }
  | 'silent';

export type ReplyScript = (params: unknown, id: number | string) => ScriptedReply;

const ENCODER = new TextEncoder();

interface WrittenMessage {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

export class MemoryAgent implements AcpTransport {
  /** Every message the client wrote, parsed, in order. */
  readonly written: WrittenMessage[] = [];
  closeCalls = 0;
  private readonly scripts = new Map<string, ReplyScript>();
  private readonly stdoutListeners: ((chunk: Uint8Array) => void)[] = [];
  private readonly stderrListeners: ((chunk: Uint8Array) => void)[] = [];
  private readonly closeListeners: (() => void)[] = [];
  private closed = false;

  /** Replies to every later request for `method`. */
  on(method: string, script: ReplyScript): this {
    this.scripts.set(method, script);
    return this;
  }

  write(line: string): void {
    if (this.closed) throw new Error('memory agent closed');
    if (!line.endsWith('\n')) throw new Error('unframed write');
    const message = JSON.parse(line) as WrittenMessage;
    this.written.push(message);
    if (message.method === undefined || message.id === undefined) return;
    const script = this.scripts.get(message.method);
    if (script === undefined) return;
    const reply = script(message.params, message.id);
    if (reply === 'silent') return;
    const id = message.id;
    this.sendLater('result' in reply ? { jsonrpc: '2.0', id, result: reply.result } : { jsonrpc: '2.0', id, error: reply.error });
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
    this.closeCalls += 1;
    this.closeFromAgent();
    return Promise.resolve();
  }

  /** Sends one JSON message to the client, framed, on the next microtask. */
  sendLater(message: unknown): void {
    this.rawLater(`${JSON.stringify(message)}\n`);
  }

  /** Sends a notification to the client. */
  notify(method: string, params: unknown): void {
    this.sendLater({ jsonrpc: '2.0', method, params });
  }

  /** Sends a request from the agent to the client. */
  request(id: number | string, method: string, params: unknown): void {
    this.sendLater({ jsonrpc: '2.0', id, method, params });
  }

  /** Sends a `session/update` for `sessionId`. */
  update(sessionId: string, update: Record<string, unknown>): void {
    this.notify('session/update', { sessionId, update });
  }

  /** Sends raw text or bytes to the client's stdout, on the next microtask. */
  rawLater(data: string | Uint8Array): void {
    const chunk = typeof data === 'string' ? ENCODER.encode(data) : data;
    queueMicrotask(() => {
      if (this.closed) return;
      for (const listener of this.stdoutListeners) listener(chunk);
    });
  }

  /** Sends stderr bytes to the client at once. */
  stderr(text: string): void {
    const chunk = ENCODER.encode(text);
    for (const listener of this.stderrListeners) listener(chunk);
  }

  /** The agent side goes away. */
  closeFromAgent(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }

  /** The written messages for one method, in order. */
  sent(method: string): WrittenMessage[] {
    return this.written.filter((message) => message.method === method);
  }

  /** The written responses (result or error) to agent request `id`. */
  answersTo(id: number | string): WrittenMessage[] {
    return this.written.filter((message) => message.method === undefined && message.id === id);
  }
}

/** A clock whose timers fire only when the test advances it. */
export class FakeClock implements AcpClock {
  private nowMs = Date.parse('2026-11-11T00:00:00.000Z');
  private readonly timers = new Set<{ due: number; callback: () => void }>();

  nowUtc(): string {
    return new Date(this.nowMs).toISOString();
  }

  setTimer(callback: () => void, delayMs: number): AcpTimer {
    const timer = { due: this.nowMs + delayMs, callback };
    this.timers.add(timer);
    return { cancel: () => this.timers.delete(timer) };
  }

  get pendingTimers(): number {
    return this.timers.size;
  }

  /** Moves time forward, firing each due timer once, in due order. */
  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      const next = [...this.timers].filter((timer) => timer.due <= target).sort((a, b) => a.due - b.due).at(0);
      if (next === undefined) break;
      this.timers.delete(next);
      this.nowMs = next.due;
      next.callback();
    }
    this.nowMs = target;
  }
}

/** Lets every queued microtask and promise continuation run. */
export async function flush(rounds = 10): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await Promise.resolve();
  }
}
