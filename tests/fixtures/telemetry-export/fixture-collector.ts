// FR-R6-F14 T002 — a synthetic collector for the transport and acceptance tests. It is a plain
// `node:http` server made for the tests: it binds only 127.0.0.1 on an ephemeral port, records
// what it receives and answers from a script. It is not an OpenTelemetry collector and no
// product was observed through it.
import { createServer as createHttpServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Server, type Socket } from 'node:net';

const LOOPBACK = '127.0.0.1';
const METRICS_PATH = '/v1/metrics';
/** Larger than the 64 KiB a transport may read. */
const OVERSIZED_BODY_BYTES = 96 * 1_024;

export type CollectorScenario =
  | { readonly kind: 'ok' }
  | { readonly kind: 'partial-success'; readonly rejectedDataPoints: number }
  | { readonly kind: 'status'; readonly statusCode: number; readonly retryAfter?: string }
  | { readonly kind: 'redirect'; readonly location: string; readonly statusCode?: number }
  | { readonly kind: 'never-answers' }
  | { readonly kind: 'drops-after-body' }
  | { readonly kind: 'oversized-body' }
  | { readonly kind: 'malformed-body' }
  | { readonly kind: 'empty-body' };

export interface CollectedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  /** Header names as they arrived, lower-cased. */
  readonly headerNames: readonly string[];
  readonly body: Buffer;
}

export interface FixtureCollector {
  /** `http://127.0.0.1:<port>/v1/metrics`. */
  readonly url: string;
  readonly port: number;
  readonly requests: readonly CollectedRequest[];
  connections(): number;
  /** Queues answers, one per request. With none queued, a request is answered `ok`. */
  respondWith(...scenarios: readonly CollectorScenario[]): void;
  close(): Promise<void>;
}

export interface PlainListener {
  readonly port: number;
  connections(): number;
  /** Every byte received, on every connection. */
  bytes(): Buffer;
  close(): Promise<void>;
}

function listenOnLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK, () => {
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}

function trackSockets(server: Server): { count: () => number; closeAll: () => Promise<void> } {
  const open = new Set<Socket>();
  let total = 0;
  server.on('connection', (socket) => {
    total += 1;
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('error', () => undefined);
  });
  return {
    count: () => total,
    closeAll: () =>
      new Promise((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => {
          resolve();
        });
      })
  };
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    request.on('error', () => {
      resolve(Buffer.concat(chunks));
    });
  });
}

function sendJson(response: ServerResponse, statusCode: number, body: string, headers: Record<string, string> = {}): void {
  response.writeHead(statusCode, { 'content-type': 'application/json', ...headers });
  response.end(body);
}

function answer(scenario: CollectorScenario, response: ServerResponse): void {
  switch (scenario.kind) {
    case 'ok':
      sendJson(response, 200, '{}');
      return;
    case 'partial-success':
      sendJson(
        response,
        200,
        JSON.stringify({ partialSuccess: { rejectedDataPoints: String(scenario.rejectedDataPoints), errorMessage: 'synthetic' } })
      );
      return;
    case 'status':
      sendJson(response, scenario.statusCode, '{}', scenario.retryAfter === undefined ? {} : { 'retry-after': scenario.retryAfter });
      return;
    case 'redirect':
      sendJson(response, scenario.statusCode ?? 307, '{}', { location: scenario.location });
      return;
    case 'never-answers':
      return;
    case 'drops-after-body':
      response.socket?.destroy();
      return;
    case 'oversized-body':
      sendJson(response, 200, `{"padding":"${'x'.repeat(OVERSIZED_BODY_BYTES)}"}`);
      return;
    case 'malformed-body':
      sendJson(response, 200, '{"partialSuccess":');
      return;
    case 'empty-body':
      response.writeHead(200);
      response.end();
      return;
  }
}

export async function startFixtureCollector(): Promise<FixtureCollector> {
  const requests: CollectedRequest[] = [];
  const script: CollectorScenario[] = [];
  const server = createHttpServer((request, response) => {
    void readBody(request).then((body) => {
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        headers: request.headers,
        headerNames: request.rawHeaders.filter((_value, index) => index % 2 === 0).map((name) => name.toLowerCase()),
        body
      });
      answer(script.shift() ?? { kind: 'ok' }, response);
    });
  });
  const sockets = trackSockets(server);
  const port = await listenOnLoopback(server);
  return {
    url: `http://${LOOPBACK}:${String(port)}${METRICS_PATH}`,
    port,
    requests,
    connections: sockets.count,
    respondWith(...scenarios) {
      script.push(...scenarios);
    },
    close: sockets.closeAll
  };
}

/**
 * A listener that speaks no TLS: it records the bytes it receives and answers the first of them
 * with a plain-text line, so a TLS client fails its handshake.
 */
export async function startPlainListener(): Promise<PlainListener> {
  const chunks: Buffer[] = [];
  const server = createTcpServer((socket) => {
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
    });
  });
  const sockets = trackSockets(server);
  const port = await listenOnLoopback(server);
  return {
    port,
    connections: sockets.count,
    bytes: () => Buffer.concat(chunks),
    close: sockets.closeAll
  };
}
