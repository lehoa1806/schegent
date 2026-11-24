/**
 * FR-R6-F13 (FR-006, FR-013, FR-020, NFR-001, NFR-002, research R3) — JSON-RPC correlation for
 * one ACP connection.
 *
 * - Outbound ids are integers from 1. A response whose id is pending settles it once. An integer
 *   id below the next id that is not pending is a duplicate; any other id is unknown. Both are
 *   counted and never applied, so a new connection's ids can never settle an earlier one's.
 * - Outstanding requests in both directions count against one bound. The request that would
 *   exceed it fails the connection `request-limit-exceeded` and is never written or dispatched.
 * - A request may carry a deadline from its write. Expiry fails the connection
 *   `handshake-deadline`: a late answer could otherwise create state the host stopped waiting for.
 * - A failure settles every written request `lost` and refuses every later one `not-dispatched`.
 *   A message that is not JSON-RPC fails the connection `protocol-violation`.
 * - A request is pending before its bytes leave, so an answer routed from inside the write still
 *   finds it. A write that throws leaves nothing pending and fails the connection.
 * - A request may carry a settle hook. It runs while the answer is being routed, before the next
 *   message of the same read; the promise resolves one microtask later, which is too late for an
 *   owner whose state the next message depends on. It never runs for a request never written.
 *
 * Zero `vscode` imports.
 */
import { ACP_RUNTIME_LIMITS, type AcpClock, type AcpFailureReason, type AcpTimer } from '../../contracts/acp-runtime';
import {
  classifyMessage,
  errorLine,
  notificationLine,
  requestLine,
  resultLine,
  type RpcId
} from './json-rpc-message';

export type RpcSettlement =
  | { readonly kind: 'result'; readonly value: unknown }
  | { readonly kind: 'error'; readonly code: number }
  | { readonly kind: 'lost'; readonly reason: AcpFailureReason }
  | { readonly kind: 'not-dispatched'; readonly reason: AcpFailureReason };

export interface RpcHandlers {
  onRequest(id: RpcId, method: string, params: unknown): void;
  onNotification(method: string, params: unknown): void;
  onFailure(reason: AcpFailureReason): void;
}

export interface RpcCall {
  /** The connection-local id, or null when the request was never written. */
  readonly id: number | null;
  readonly settled: Promise<RpcSettlement>;
}

/** Runs synchronously when a written request settles: a result, an error, or `lost`. */
export type RpcSettleHook = (settlement: RpcSettlement, id: number) => void;

export interface RpcCounters {
  readonly unknownResponses: number;
  readonly duplicateResponses: number;
}

interface PendingRequest {
  readonly settle: (settlement: RpcSettlement) => void;
  readonly onSettled: RpcSettleHook | undefined;
  timer: AcpTimer | null;
}

export class RpcConnection {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly inbound = new Set<RpcId>();
  private failed: AcpFailureReason | null = null;
  private unknownResponses = 0;
  private duplicateResponses = 0;

  constructor(
    private readonly write: (line: string) => void,
    private readonly clock: AcpClock,
    private readonly handlers: RpcHandlers,
    private readonly maxOutstanding: number = ACP_RUNTIME_LIMITS.maxOutstandingRequests
  ) {}

  get failure(): AcpFailureReason | null {
    return this.failed;
  }

  get outstanding(): number {
    return this.pending.size + this.inbound.size;
  }

  get counters(): RpcCounters {
    return { unknownResponses: this.unknownResponses, duplicateResponses: this.duplicateResponses };
  }

  /** Writes one request. `deadlineMs`, when given, fails the connection if no answer arrives in time. */
  request(method: string, params: unknown, deadlineMs?: number, onSettled?: RpcSettleHook): RpcCall {
    if (this.failed !== null) return notDispatched(this.failed);
    if (this.outstanding + 1 > this.maxOutstanding) {
      this.fail('request-limit-exceeded');
      return notDispatched('request-limit-exceeded');
    }
    const id = this.nextId;
    this.nextId += 1;
    let settle: (settlement: RpcSettlement) => void = () => undefined;
    const settled = new Promise<RpcSettlement>((resolve) => {
      settle = resolve;
    });
    const entry: PendingRequest = { settle, onSettled, timer: null };
    this.pending.set(id, entry);
    try {
      this.write(requestLine(id, method, params));
    } catch {
      this.pending.delete(id);
      this.fail('transport-closed');
      return notDispatched('transport-closed');
    }
    if (deadlineMs !== undefined && this.pending.has(id)) {
      entry.timer = this.clock.setTimer(() => {
        if (this.pending.has(id)) this.fail('handshake-deadline');
      }, deadlineMs);
    }
    return { id, settled };
  }

  /** Writes one notification; false when the connection has failed or the write failed. */
  notify(method: string, params: unknown): boolean {
    if (this.failed !== null) return false;
    return this.send(notificationLine(method, params));
  }

  /** Answers an agent request with a result. */
  respond(id: RpcId, result: unknown): void {
    if (!this.inbound.delete(id) || this.failed !== null) return;
    this.send(resultLine(id, result));
  }

  /** Answers an agent request with an error. */
  respondError(id: RpcId, code: number, message: string): void {
    if (!this.inbound.delete(id) || this.failed !== null) return;
    this.send(errorLine(id, code, message));
  }

  /** Routes one decoded message. */
  receive(value: unknown): void {
    if (this.failed !== null) return;
    const message = classifyMessage(value);
    switch (message.kind) {
      case 'invalid':
        this.fail('protocol-violation');
        return;
      case 'notification':
        this.handlers.onNotification(message.method, message.params);
        return;
      case 'request':
        this.receiveRequest(message.id, message.method, message.params);
        return;
      case 'response':
        this.settleResponse(message.id, { kind: 'result', value: message.result });
        return;
      case 'error-response':
        this.settleResponse(message.id, { kind: 'error', code: message.code });
    }
  }

  /** Fails the connection once; every written request settles `lost`. */
  fail(reason: AcpFailureReason): void {
    if (this.failed !== null) return;
    this.failed = reason;
    const pending = [...this.pending];
    this.pending.clear();
    this.inbound.clear();
    for (const [id, entry] of pending) this.finish(id, entry, { kind: 'lost', reason });
    this.handlers.onFailure(reason);
  }

  private receiveRequest(id: RpcId, method: string, params: unknown): void {
    if (this.inbound.has(id)) {
      this.fail('protocol-violation');
      return;
    }
    if (this.outstanding + 1 > this.maxOutstanding) {
      this.fail('request-limit-exceeded');
      return;
    }
    this.inbound.add(id);
    this.handlers.onRequest(id, method, params);
  }

  private settleResponse(id: RpcId, settlement: RpcSettlement): void {
    const entry = typeof id === 'number' ? this.pending.get(id) : undefined;
    if (entry !== undefined && typeof id === 'number') {
      this.pending.delete(id);
      this.finish(id, entry, settlement);
      return;
    }
    if (typeof id === 'number' && id >= 1 && id < this.nextId) {
      this.duplicateResponses += 1;
      return;
    }
    this.unknownResponses += 1;
  }

  private finish(id: number, entry: PendingRequest, settlement: RpcSettlement): void {
    entry.timer?.cancel();
    entry.onSettled?.(settlement, id);
    entry.settle(settlement);
  }

  private send(line: string): boolean {
    try {
      this.write(line);
      return true;
    } catch {
      this.fail('transport-closed');
      return false;
    }
  }
}

function notDispatched(reason: AcpFailureReason): RpcCall {
  return { id: null, settled: Promise.resolve({ kind: 'not-dispatched', reason }) };
}
