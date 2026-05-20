export type HostTransportMessageHandler = (message: unknown) => void;

export interface HostTransport {
  postMessage(message: unknown): void;
  onMessage(handler: HostTransportMessageHandler): () => void;
  getState<T = unknown>(): T | undefined;
  setState(state: unknown): void;
}

export type HostTransportFactory = () => HostTransport;

let defaultHostTransportFactory: HostTransportFactory = createNoopHostTransport;
let activeHostTransport: HostTransport | null = null;

export function configureDefaultHostTransport(factory: HostTransportFactory): void {
  defaultHostTransportFactory = factory;
}

export function getHostTransport(): HostTransport {
  if (activeHostTransport === null) {
    activeHostTransport = defaultHostTransportFactory();
  }
  return activeHostTransport;
}

export function setHostTransport(transport: HostTransport): () => void {
  const previous = activeHostTransport;
  activeHostTransport = transport;
  return () => {
    activeHostTransport = previous;
  };
}

export function resetHostTransport(): void {
  activeHostTransport = null;
}

function createNoopHostTransport(): HostTransport {
  return {
    postMessage() {},
    onMessage() {
      return () => {};
    },
    getState() {
      return undefined;
    },
    setState() {}
  };
}
