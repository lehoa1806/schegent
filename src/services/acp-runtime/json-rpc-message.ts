/**
 * FR-R6-F13 (FR-006, FR-013, FR-017) — JSON-RPC 2.0 message shapes for the ACP stdio channel.
 *
 * `classifyMessage` reads one decoded value. Anything that is not exactly one of a request, a
 * notification, a result response or an error response is `invalid`, including an error whose id
 * is null: such an error cannot be correlated, so it is a protocol violation, not noise.
 *
 * The line builders return one framed message with its trailing newline. Zero `vscode` imports.
 */
import { ACP_RUNTIME_LIMITS } from '../../contracts/acp-runtime';

export type RpcId = number | string;

export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;

export type ClassifiedMessage =
  | { readonly kind: 'request'; readonly id: RpcId; readonly method: string; readonly params: unknown }
  | { readonly kind: 'notification'; readonly method: string; readonly params: unknown }
  | { readonly kind: 'response'; readonly id: RpcId; readonly result: unknown }
  | { readonly kind: 'error-response'; readonly id: RpcId; readonly code: number }
  | { readonly kind: 'invalid' };

const INVALID: ClassifiedMessage = Object.freeze({ kind: 'invalid' });

function isRpcId(value: unknown): value is RpcId {
  if (typeof value === 'number') return Number.isSafeInteger(value);
  return typeof value === 'string' && value.length > 0 && value.length <= ACP_RUNTIME_LIMITS.identifierMaxLength;
}

function errorCode(value: unknown): number | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const error = value as Record<string, unknown>;
  const code = error['code'];
  if (typeof code !== 'number' || !Number.isSafeInteger(code) || typeof error['message'] !== 'string') return null;
  return code;
}

function classifyCall(message: Record<string, unknown>): ClassifiedMessage {
  const method = message['method'];
  if (typeof method !== 'string' || method.length === 0) return INVALID;
  if ('result' in message || 'error' in message) return INVALID;
  if (!('id' in message)) return { kind: 'notification', method, params: message['params'] };
  const id = message['id'];
  return isRpcId(id) ? { kind: 'request', id, method, params: message['params'] } : INVALID;
}

function classifyAnswer(message: Record<string, unknown>): ClassifiedMessage {
  const id = message['id'];
  const hasResult = 'result' in message;
  const hasError = 'error' in message;
  if (!isRpcId(id) || hasResult === hasError) return INVALID;
  if (hasResult) return { kind: 'response', id, result: message['result'] };
  const code = errorCode(message['error']);
  return code === null ? INVALID : { kind: 'error-response', id, code };
}

/** Classifies one decoded JSON value. */
export function classifyMessage(value: unknown): ClassifiedMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return INVALID;
  const message = value as Record<string, unknown>;
  if (message['jsonrpc'] !== '2.0') return INVALID;
  return 'method' in message ? classifyCall(message) : classifyAnswer(message);
}

function frame(message: Record<string, unknown>): string {
  return `${JSON.stringify(message)}\n`;
}

export function requestLine(id: number, method: string, params: unknown): string {
  return frame({ jsonrpc: '2.0', id, method, params });
}

export function notificationLine(method: string, params: unknown): string {
  return frame({ jsonrpc: '2.0', method, params });
}

export function resultLine(id: RpcId, result: unknown): string {
  return frame({ jsonrpc: '2.0', id, result });
}

export function errorLine(id: RpcId, code: number, message: string): string {
  return frame({ jsonrpc: '2.0', id, error: { code, message } });
}
