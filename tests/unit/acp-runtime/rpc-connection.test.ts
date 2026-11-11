// FR-R6-F13 T008 — request correlation, deadlines and the outstanding-request bound (research R3,
// FR-006, FR-013, FR-020, NFR-001, NFR-002).
import { describe, expect, it } from 'vitest';

import type { AcpFailureReason } from '../../../src/contracts/acp-runtime';
import { RpcConnection } from '../../../src/services/acp-runtime/rpc-connection';
import { FakeClock, flush } from '../../fixtures/acp/memory-agent';

interface Harness {
  readonly rpc: RpcConnection;
  readonly clock: FakeClock;
  readonly lines: string[];
  readonly requests: { id: number | string; method: string }[];
  readonly notifications: string[];
  readonly failures: AcpFailureReason[];
}

function harness(write?: (line: string) => void): Harness {
  const clock = new FakeClock();
  const lines: string[] = [];
  const requests: { id: number | string; method: string }[] = [];
  const notifications: string[] = [];
  const failures: AcpFailureReason[] = [];
  const rpc = new RpcConnection(write ?? ((line) => lines.push(line)), clock, {
    onRequest: (id, method) => requests.push({ id, method }),
    onNotification: (method) => notifications.push(method),
    onFailure: (reason) => failures.push(reason)
  });
  return { rpc, clock, lines, requests, notifications, failures };
}

describe('RpcConnection', () => {
  it('numbers requests from 1 and settles each from its response', async () => {
    const h = harness();
    const first = h.rpc.request('initialize', {});
    const second = h.rpc.request('session/new', {});
    expect([first.id, second.id]).toEqual([1, 2]);
    expect(JSON.parse(h.lines.at(0) ?? '')).toMatchObject({ id: 1, method: 'initialize' });
    h.rpc.receive({ jsonrpc: '2.0', id: 2, result: { sessionId: 's' } });
    h.rpc.receive({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'no' } });
    expect(await second.settled).toEqual({ kind: 'result', value: { sessionId: 's' } });
    expect(await first.settled).toEqual({ kind: 'error', code: -32000 });
    expect(h.rpc.outstanding).toBe(0);
  });

  it('settles once and counts a second response as a duplicate', async () => {
    const h = harness();
    const call = h.rpc.request('m', {});
    h.rpc.receive({ jsonrpc: '2.0', id: 1, result: 'first' });
    h.rpc.receive({ jsonrpc: '2.0', id: 1, result: 'second' });
    expect(await call.settled).toEqual({ kind: 'result', value: 'first' });
    expect(h.rpc.counters).toEqual({ unknownResponses: 0, duplicateResponses: 1 });
  });

  it('counts a response for an id never issued, or a string id, as unknown', () => {
    const h = harness();
    h.rpc.request('m', {});
    h.rpc.receive({ jsonrpc: '2.0', id: 99, result: null });
    h.rpc.receive({ jsonrpc: '2.0', id: '1', result: null });
    expect(h.rpc.counters).toEqual({ unknownResponses: 2, duplicateResponses: 0 });
    expect(h.rpc.outstanding).toBe(1);
    expect(h.failures).toEqual([]);
  });

  it('routes agent requests and notifications to the handlers', () => {
    const h = harness();
    h.rpc.receive({ jsonrpc: '2.0', id: 'perm-1', method: 'session/request_permission', params: {} });
    h.rpc.receive({ jsonrpc: '2.0', method: 'session/update', params: {} });
    expect(h.requests).toEqual([{ id: 'perm-1', method: 'session/request_permission' }]);
    expect(h.notifications).toEqual(['session/update']);
    expect(h.rpc.outstanding).toBe(1);
    h.rpc.respond('perm-1', { outcome: { outcome: 'cancelled' } });
    expect(h.rpc.outstanding).toBe(0);
    expect(JSON.parse(h.lines.at(-1) ?? '')).toEqual({ jsonrpc: '2.0', id: 'perm-1', result: { outcome: { outcome: 'cancelled' } } });
  });

  it('fails handshake-deadline when a deadline request is unanswered, and settles it lost', async () => {
    const h = harness();
    const call = h.rpc.request('initialize', {}, 5_000);
    h.clock.advance(4_999);
    expect(h.failures).toEqual([]);
    h.clock.advance(1);
    expect(h.failures).toEqual(['handshake-deadline']);
    expect(await call.settled).toEqual({ kind: 'lost', reason: 'handshake-deadline' });
    expect(h.rpc.failure).toBe('handshake-deadline');
  });

  it('cancels the deadline when the response arrives', () => {
    const h = harness();
    h.rpc.request('initialize', {}, 5_000);
    h.rpc.receive({ jsonrpc: '2.0', id: 1, result: {} });
    expect(h.clock.pendingTimers).toBe(0);
    h.clock.advance(10_000);
    expect(h.failures).toEqual([]);
  });

  it('fails request-limit-exceeded on the 65th outbound request, which is never written', async () => {
    const h = harness();
    const calls = Array.from({ length: 64 }, () => h.rpc.request('m', {}));
    const extra = h.rpc.request('m', {});
    expect(h.lines).toHaveLength(64);
    expect(h.failures).toEqual(['request-limit-exceeded']);
    expect(await extra.settled).toEqual({ kind: 'not-dispatched', reason: 'request-limit-exceeded' });
    expect(await calls.at(0)?.settled).toEqual({ kind: 'lost', reason: 'request-limit-exceeded' });
  });

  it('counts inbound open requests against the same bound', () => {
    const h = harness();
    for (let n = 0; n < 63; n += 1) h.rpc.request('m', {});
    h.rpc.receive({ jsonrpc: '2.0', id: 'a', method: 'x' });
    expect(h.failures).toEqual([]);
    h.rpc.receive({ jsonrpc: '2.0', id: 'b', method: 'x' });
    expect(h.failures).toEqual(['request-limit-exceeded']);
    expect(h.requests.map((request) => request.id)).toEqual(['a']);
  });

  it('settles written requests lost and refuses later requests not-dispatched after a failure', async () => {
    const h = harness();
    const written = h.rpc.request('m', {});
    h.rpc.fail('transport-closed');
    h.rpc.fail('malformed-frame');
    expect(h.failures).toEqual(['transport-closed']);
    expect(await written.settled).toEqual({ kind: 'lost', reason: 'transport-closed' });
    const later = h.rpc.request('m', {});
    expect(later.id).toBeNull(); // 2026-11-11 coincidental: a JSON-RPC request handle, not a record a payload contract governs
    expect(await later.settled).toEqual({ kind: 'not-dispatched', reason: 'transport-closed' });
    expect(h.rpc.notify('session/cancel', {})).toBe(false);
  });

  it('treats a throwing write as transport-closed with that request not-dispatched', async () => {
    const h = harness(() => {
      throw new Error('EPIPE');
    });
    const call = h.rpc.request('m', {});
    expect(await call.settled).toEqual({ kind: 'not-dispatched', reason: 'transport-closed' });
    expect(h.failures).toEqual(['transport-closed']);
  });

  // Review R-2: the request is pending before its bytes leave, so no answer can beat it.
  it('settles a request that is answered from inside its own write', async () => {
    const h = harness((line) => {
      const written = JSON.parse(line) as { id: number };
      h.rpc.receive({ jsonrpc: '2.0', id: written.id, result: 'at once' });
    });
    const settled: unknown[] = [];
    const call = h.rpc.request('m', {}, 5_000);
    void call.settled.then((settlement) => settled.push(settlement));
    await flush();
    expect(call.id).toBe(1);
    expect(settled).toEqual([{ kind: 'result', value: 'at once' }]);
    expect(h.rpc.counters).toEqual({ unknownResponses: 0, duplicateResponses: 0 });
    expect(h.rpc.outstanding).toBe(0);
    expect(h.clock.pendingTimers).toBe(0);
  });

  // Review R-1: the hook runs while the answer is being routed, before any later message.
  it('runs the settle hook synchronously, once, and never for a request that was not written', async () => {
    const h = harness();
    const seen: string[] = [];
    h.rpc.request('m', {}, undefined, (settlement, id) => seen.push(`${id}:${settlement.kind}`));
    h.rpc.request('m', {}, undefined, (settlement, id) => seen.push(`${id}:${settlement.kind}`));
    h.rpc.receive({ jsonrpc: '2.0', id: 1, result: null });
    expect(seen).toEqual(['1:result']);
    h.rpc.receive({ jsonrpc: '2.0', id: 1, result: null });
    h.rpc.fail('transport-closed');
    expect(seen).toEqual(['1:result', '2:lost']);
    const late = h.rpc.request('m', {}, undefined, (settlement, id) => seen.push(`${id}:${settlement.kind}`));
    expect(await late.settled).toEqual({ kind: 'not-dispatched', reason: 'transport-closed' });
    expect(seen).toEqual(['1:result', '2:lost']);
  });

  it('keeps the settle hook from a request whose write throws', async () => {
    const seen: string[] = [];
    const h = harness(() => {
      throw new Error('EPIPE');
    });
    const call = h.rpc.request('m', {}, undefined, (settlement) => seen.push(settlement.kind));
    expect(await call.settled).toEqual({ kind: 'not-dispatched', reason: 'transport-closed' });
    expect(seen).toEqual([]);
    expect(h.rpc.outstanding).toBe(0);
  });

  it('fails protocol-violation on a message that is not JSON-RPC, and ignores input after failure', async () => {
    const h = harness();
    h.rpc.receive({ hello: 'world' });
    expect(h.failures).toEqual(['protocol-violation']);
    h.rpc.receive({ jsonrpc: '2.0', method: 'session/update', params: {} });
    await flush();
    expect(h.notifications).toEqual([]);
  });
});
