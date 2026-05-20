import type { HostTransport } from './host-transport';

interface AcquiredVsCodeApi {
  postMessage(message: unknown): void;
  setState(state: unknown): void;
  getState<T = unknown>(): T | undefined;
}

declare function acquireVsCodeApi(): AcquiredVsCodeApi;

export function createVSCodeTransport(win: Window = window): HostTransport {
  let cachedApi: AcquiredVsCodeApi | null = null;

  const getApi = (): AcquiredVsCodeApi => {
    if (cachedApi !== null) return cachedApi;
    if (typeof acquireVsCodeApi !== 'function') {
      cachedApi = {
        postMessage() {},
        setState() {},
        getState() {
          return undefined;
        }
      };
      return cachedApi;
    }
    cachedApi = acquireVsCodeApi();
    return cachedApi;
  };

  return {
    postMessage(message: unknown): void {
      getApi().postMessage(message);
    },
    onMessage(handler): () => void {
      const listener = (event: MessageEvent): void => {
        handler(event.data);
      };
      win.addEventListener('message', listener);
      return () => win.removeEventListener('message', listener);
    },
    getState<T = unknown>(): T | undefined {
      return getApi().getState<T>();
    },
    setState(state: unknown): void {
      getApi().setState(state);
    }
  };
}
