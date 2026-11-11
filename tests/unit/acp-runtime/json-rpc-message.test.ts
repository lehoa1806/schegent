// FR-R6-F13 T006 — JSON-RPC 2.0 message classification and line builders.
import { describe, expect, it } from 'vitest';

import {
  classifyMessage,
  errorLine,
  JSON_RPC_METHOD_NOT_FOUND,
  notificationLine,
  requestLine,
  resultLine
} from '../../../src/services/acp-runtime/json-rpc-message';

describe('classifyMessage', () => {
  it('classifies a request, with integer or string id', () => {
    expect(classifyMessage({ jsonrpc: '2.0', id: 3, method: 'm', params: { a: 1 } })).toEqual({
      kind: 'request',
      id: 3,
      method: 'm',
      params: { a: 1 }
    });
    expect(classifyMessage({ jsonrpc: '2.0', id: 'p-1', method: 'm' })).toEqual({
      kind: 'request',
      id: 'p-1',
      method: 'm',
      params: undefined
    });
  });

  it('classifies a notification', () => {
    expect(classifyMessage({ jsonrpc: '2.0', method: 'session/update', params: {} })).toEqual({
      kind: 'notification',
      method: 'session/update',
      params: {}
    });
  });

  it('classifies a result response, including a null result', () => {
    expect(classifyMessage({ jsonrpc: '2.0', id: 1, result: null })).toEqual({ kind: 'response', id: 1, result: null });
  });

  it('classifies an error response', () => {
    expect(classifyMessage({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'no' } })).toEqual({
      kind: 'error-response',
      id: 1,
      code: -32000
    });
  });

  it.each([
    ['not an object', 'x'],
    ['an array', [1]],
    ['a wrong version', { jsonrpc: '1.0', id: 1, result: 1 }],
    ['both result and error', { jsonrpc: '2.0', id: 1, result: 1, error: { code: 1, message: 'm' } }],
    ['neither method nor result', { jsonrpc: '2.0', id: 1 }],
    ['an error with null id', { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse' } }],
    ['a fractional id', { jsonrpc: '2.0', id: 1.5, result: 1 }],
    ['a non-integer error code', { jsonrpc: '2.0', id: 1, error: { code: 'x', message: 'm' } }],
    ['an empty method', { jsonrpc: '2.0', method: '' }],
    ['an over-long string id', { jsonrpc: '2.0', id: 'i'.repeat(257), method: 'm' }]
  ])('classifies %s as invalid', (_label, value) => {
    expect(classifyMessage(value)).toEqual({ kind: 'invalid' });
  });
});

describe('line builders', () => {
  it('frame one JSON message with a trailing newline', () => {
    expect(requestLine(1, 'initialize', { a: 1 })).toBe('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"a":1}}\n');
    expect(notificationLine('session/cancel', { sessionId: 's' })).toBe(
      '{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s"}}\n'
    );
    expect(resultLine('perm-1', { ok: true })).toBe('{"jsonrpc":"2.0","id":"perm-1","result":{"ok":true}}\n');
    expect(errorLine(7, JSON_RPC_METHOD_NOT_FOUND, 'Method not found')).toBe(
      '{"jsonrpc":"2.0","id":7,"error":{"code":-32601,"message":"Method not found"}}\n'
    );
  });
});
