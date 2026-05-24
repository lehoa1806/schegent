import type { CommandType, HostMessage, SidebarCommand } from './messages';
import {
  configureDefaultHostTransport,
  getHostTransport
} from './host-transport';
import { createVSCodeTransport } from './vscode-transport';

configureDefaultHostTransport(createVSCodeTransport);

function uuidv4(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface PostCommandOptions {
  correlationId?: string;
}

export type PostCommandResult = { correlationId: string };

export function postCommand<C extends SidebarCommand>(
  type: C['type'],
  payload?: C extends { payload: infer P } ? P : undefined,
  opts: PostCommandOptions = {}
): PostCommandResult {
  const correlationId = opts.correlationId ?? uuidv4();
  const message: Record<string, unknown> = { type, correlationId };
  if (payload !== undefined) message['payload'] = payload;
  getHostTransport().postMessage(message);
  return { correlationId };
}

export type HostMessageHandler<S> = (msg: HostMessage<S>) => void;

export function onHostMessage<S>(handler: HostMessageHandler<S>): () => void {
  return getHostTransport().onMessage((message) => {
    const data = message as HostMessage<S> | undefined;
    if (!data || typeof data !== 'object') return;
    handler(data);
  });
}

/**
 * Read the persisted webview state. Returns `undefined` outside a VS Code
 * webview host (e.g. unit tests). The returned object is the live state
 * object; treat reads as snapshots and merge through `setWebviewState`
 * rather than mutating in place.
 */
export function getWebviewState<T = unknown>(): T | undefined {
  return getApi().getState<T>();
}

/**
 * Persist the webview state. Pass the full next state object; VS Code
 * replaces the prior value wholesale (no shallow merge). Callers that
 * want partial updates MUST read the current state, merge, and write
 * the merged result.
 */
export function setWebviewState(state: unknown): void {
  getApi().setState(state);
}

export const __test_only = { uuidv4 };

export type { CommandType };
