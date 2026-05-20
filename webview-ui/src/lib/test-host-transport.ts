import type {
  HostTransport,
  HostTransportMessageHandler
} from './host-transport';

export interface MemoryHostTransport extends HostTransport {
  readonly postedMessages: readonly unknown[];
  clearPostedMessages(): void;
  emitHostMessage(message: unknown): void;
}

export function createMemoryHostTransport(initialState?: unknown): MemoryHostTransport {
  const postedMessages: unknown[] = [];
  const handlers = new Set<HostTransportMessageHandler>();
  let currentState = initialState;

  return {
    get postedMessages() {
      return postedMessages;
    },
    postMessage(message: unknown): void {
      postedMessages.push(message);
    },
    onMessage(handler: HostTransportMessageHandler): () => void {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    getState<T = unknown>(): T | undefined {
      return currentState as T | undefined;
    },
    setState(state: unknown): void {
      currentState = state;
    },
    clearPostedMessages(): void {
      postedMessages.length = 0;
    },
    emitHostMessage(message: unknown): void {
      for (const handler of [...handlers]) {
        handler(message);
      }
    }
  };
}
