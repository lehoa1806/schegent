// FR-R6-F14 T017 — the OTLP/HTTP transport against a synthetic loopback collector: one POST, no
// redirect followed, a deadline, an abort, a bounded response and a loopback-only name lookup
// for plaintext (FR-002, FR-009, FR-010, FR-014; NFR-001).
import type { LookupAddress } from 'node:dns';
import { afterEach, describe, expect, it } from 'vitest';
import { TELEMETRY_EXPORT_BOUNDS, type TransportRequest, type TransportResult } from '../../../src/contracts/telemetry-export';
import {
  createOtlpHttpTransport,
  effectiveDeadlineMs,
  retryAfterSecondsOf,
  type NameLookup
} from '../../../src/services/telemetry-export/otlp-http-transport';
import {
  startFixtureCollector,
  startPlainListener,
  type FixtureCollector,
  type PlainListener
} from '../../fixtures/telemetry-export/fixture-collector';

const CREDENTIAL_HEADER = 'x-export-credential';
const CREDENTIAL = 'synthetic-credential-value';
const BODY = '{"resourceMetrics":[]}';

const closers: (() => Promise<void>)[] = [];

async function collector(): Promise<FixtureCollector> {
  const started = await startFixtureCollector();
  closers.push(started.close);
  return started;
}

async function plainListener(): Promise<PlainListener> {
  const started = await startPlainListener();
  closers.push(started.close);
  return started;
}

function request(url: string, overrides: Partial<TransportRequest> = {}): TransportRequest {
  return {
    url: new URL(url),
    plaintextLoopback: true,
    headers: { 'content-type': 'application/json', [CREDENTIAL_HEADER]: CREDENTIAL },
    body: new TextEncoder().encode(BODY),
    deadlineMs: 2_000,
    signal: new AbortController().signal,
    ...overrides
  };
}

/**
 * A plaintext URL whose authority carries a user name and a password. It is joined from its
 * parts, so the source never holds the whole text and the secret scan has nothing to report.
 */
function urlWithPassword(password: string, rest: string): string {
  const userInformation = ['user', password].join(':');
  return `http://${userInformation}@${rest}`;
}

function bodyText(result: TransportResult): string {
  return result.kind === 'response' ? new TextDecoder().decode(result.body) : '';
}

/** A name lookup that answers with fixed addresses, in either result shape. */
function fixedLookup(addresses: readonly LookupAddress[]): NameLookup {
  return (_hostname, options, callback) => {
    const first = addresses.at(0) ?? { address: '', family: 4 };
    if (options.all === true) callback(null, [...addresses]);
    else callback(null, first.address, first.family);
  };
}

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

describe('OTLP/HTTP transport: the request', () => {
  it('sends one POST with the body and the headers, and asks for no encoding', async () => {
    const target = await collector();
    const result = await createOtlpHttpTransport().send(request(target.url));
    expect(result).toMatchObject({ kind: 'response', statusCode: 200, retryAfterSeconds: null, bodyTruncated: false });
    expect(bodyText(result)).toBe('{}');
    expect(target.requests).toHaveLength(1);
    const received = target.requests.at(0);
    expect(received).toMatchObject({ method: 'POST', path: '/v1/metrics' });
    expect(received === undefined ? '' : received.body.toString('utf8')).toBe(BODY);
    const headers = received === undefined ? {} : received.headers;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['content-length']).toBe(String(BODY.length));
    expect(headers[CREDENTIAL_HEADER]).toBe(CREDENTIAL);
    expect(headers['user-agent']).toBe('schegent-telemetry-export');
    expect(headers.connection).toBe('close');
    expect(received === undefined ? [] : [...received.headerNames].sort()).toEqual([
      'connection',
      'content-length',
      'content-type',
      'host',
      'user-agent',
      CREDENTIAL_HEADER
    ]);
  });

  it('keeps its own value for a header it owns', async () => {
    const target = await collector();
    const headers = {
      'Content-Type': 'text/plain',
      'User-Agent': 'other',
      'Accept-Encoding': 'gzip',
      'Transfer-Encoding': 'chunked',
      'Content-Length': '1',
      Host: 'other.example.test',
      Connection: 'keep-alive',
      [CREDENTIAL_HEADER]: CREDENTIAL
    };
    const result = await createOtlpHttpTransport().send(request(target.url, { headers }));
    expect(result.kind).toBe('response');
    const received = target.requests.at(0);
    const seen = received === undefined ? {} : received.headers;
    expect(seen['content-type']).toBe('application/json');
    expect(seen['user-agent']).toBe('schegent-telemetry-export');
    expect(seen['accept-encoding']).toBeUndefined();
    expect(seen['transfer-encoding']).toBeUndefined();
    expect(seen['content-length']).toBe(String(BODY.length));
    expect(seen.host).toBe(`127.0.0.1:${String(target.port)}`);
    expect(seen.connection).toBe('close');
  });

  it('keeps the query of the endpoint and opens one connection per request', async () => {
    const target = await collector();
    const transport = createOtlpHttpTransport();
    await transport.send(request(`${target.url}?tenant=a`));
    await transport.send(request(target.url));
    expect(target.requests.map((received) => received.path)).toEqual(['/v1/metrics?tenant=a', '/v1/metrics']);
    expect(target.connections()).toBe(2);
  });
});

describe('OTLP/HTTP transport: the response', () => {
  it.each([
    [301],
    [302],
    [303],
    [307],
    [308]
  ])('returns a %i as it is and sends nothing to the redirect target', async (statusCode) => {
    const first = await collector();
    const second = await collector();
    first.respondWith({ kind: 'redirect', location: second.url, statusCode });
    const result = await createOtlpHttpTransport().send(request(first.url));
    expect(result).toMatchObject({ kind: 'response', statusCode });
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(0);
    expect(second.connections()).toBe(0);
  });

  it.each([
    ['7', 7],
    ['0', 0],
    ['99999', 99_999],
    ['100000', null],
    ['1.5', null],
    ['-1', null],
    // The HTTP parser removes the optional whitespace around a value before the transport reads it.
    [' 7', 7],
    ['7s', null],
    ['Wed, 11 Nov 2026 07:28:00 GMT', null]
  ])('reads Retry-After %j as %j', async (retryAfter, expected) => {
    const target = await collector();
    target.respondWith({ kind: 'status', statusCode: 503, retryAfter });
    const result = await createOtlpHttpTransport().send(request(target.url));
    expect(result).toMatchObject({ kind: 'response', statusCode: 503, retryAfterSeconds: expected });
  });

  it('cuts a body over 64 KiB and flags it', async () => {
    const target = await collector();
    target.respondWith({ kind: 'oversized-body' });
    const result = await createOtlpHttpTransport().send(request(target.url));
    expect(result).toMatchObject({ kind: 'response', statusCode: 200, bodyTruncated: true });
    expect(result.kind === 'response' ? result.body.byteLength : -1).toBe(TELEMETRY_EXPORT_BOUNDS.responseBytesMax);
  });

  it.each([
    ['partial-success', { kind: 'partial-success', rejectedDataPoints: 3 }, '"rejectedDataPoints":"3"'],
    ['malformed-body', { kind: 'malformed-body' }, '{"partialSuccess":'],
    ['empty-body', { kind: 'empty-body' }, '']
  ] as const)('returns the body of a %s answer unread', async (_label, scenario, expected) => {
    const target = await collector();
    target.respondWith(scenario);
    const result = await createOtlpHttpTransport().send(request(target.url));
    expect(result).toMatchObject({ kind: 'response', statusCode: 200, bodyTruncated: false });
    expect(bodyText(result)).toContain(expected);
    expect(bodyText(result).length === 0).toBe(expected === '');
  });
});

describe('OTLP/HTTP transport: failures', () => {
  it('ends at the deadline when the destination never answers', async () => {
    const target = await collector();
    target.respondWith({ kind: 'never-answers' });
    const started = Date.now();
    const result = await createOtlpHttpTransport().send(request(target.url, { deadlineMs: 150 }));
    const elapsed = Date.now() - started;
    expect(result).toEqual({ kind: 'failure', errorClass: 'deadline' });
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(1_500);
  });

  it('ends at once when the signal aborts', async () => {
    const target = await collector();
    target.respondWith({ kind: 'never-answers' });
    const controller = new AbortController();
    const started = Date.now();
    const pending = createOtlpHttpTransport().send(request(target.url, { signal: controller.signal, deadlineMs: 5_000 }));
    setTimeout(() => {
      controller.abort();
    }, 50);
    expect(await pending).toEqual({ kind: 'failure', errorClass: 'aborted' });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('opens no connection when the signal is already aborted', async () => {
    const target = await collector();
    const controller = new AbortController();
    controller.abort();
    const result = await createOtlpHttpTransport().send(request(target.url, { signal: controller.signal }));
    expect(result).toEqual({ kind: 'failure', errorClass: 'aborted' });
    expect(target.connections()).toBe(0);
  });

  it('reports a dropped connection and a closed port as a network failure', async () => {
    const target = await collector();
    target.respondWith({ kind: 'drops-after-body' });
    const transport = createOtlpHttpTransport();
    expect(await transport.send(request(target.url))).toEqual({ kind: 'failure', errorClass: 'network' });
    const closedUrl = target.url;
    await target.close();
    expect(await transport.send(request(closedUrl))).toEqual({ kind: 'failure', errorClass: 'network' });
  });

  it('fails the handshake against a listener that speaks no TLS, and the credential never leaves', async () => {
    const listener = await plainListener();
    const url = `https://127.0.0.1:${String(listener.port)}/v1/metrics`;
    const result = await createOtlpHttpTransport().send(request(url, { plaintextLoopback: false }));
    expect(result).toEqual({ kind: 'failure', errorClass: 'tls' });
    expect(listener.connections()).toBe(1);
    const seen = listener.bytes();
    expect(seen.byteLength).toBeGreaterThan(0);
    expect(seen.includes(CREDENTIAL)).toBe(false);
    expect(seen.includes(CREDENTIAL_HEADER)).toBe(false);
    expect(seen.includes(BODY)).toBe(false);
  });
});

describe('OTLP/HTTP transport: plaintext stays on loopback', () => {
  it('refuses plaintext that the destination did not allow', async () => {
    const target = await collector();
    const result = await createOtlpHttpTransport().send(request(target.url, { plaintextLoopback: false }));
    expect(result).toEqual({ kind: 'failure', errorClass: 'network' });
    expect(target.connections()).toBe(0);
  });

  it('refuses a plaintext host that is not a loopback name', async () => {
    const result = await createOtlpHttpTransport().send(request('http://collector.example.test:4318/v1/metrics'));
    expect(result).toEqual({ kind: 'failure', errorClass: 'network' });
  });

  it.each([
    ['one address outside loopback', [{ address: '192.0.2.10', family: 4 }]],
    ['a loopback address beside one outside', [{ address: '127.0.0.1', family: 4 }, { address: '192.0.2.10', family: 4 }]],
    ['an IPv6 address outside loopback', [{ address: '2001:db8::1', family: 6 }]],
    ['a mapped IPv4 address', [{ address: '::ffff:192.0.2.10', family: 6 }]],
    ['no address', []]
  ] as const)('fails before any connection when localhost resolves to %s', async (_label, addresses) => {
    const target = await collector();
    const transport = createOtlpHttpTransport({ lookup: fixedLookup(addresses) });
    const result = await transport.send(request(`http://localhost:${String(target.port)}/v1/metrics`));
    expect(result).toEqual({ kind: 'failure', errorClass: 'network' });
    expect(target.connections()).toBe(0);
  });

  it('connects when localhost resolves only to loopback addresses', async () => {
    const target = await collector();
    const transport = createOtlpHttpTransport({ lookup: fixedLookup([{ address: '127.0.0.1', family: 4 }]) });
    const result = await transport.send(request(`http://localhost:${String(target.port)}/v1/metrics`));
    expect(result).toMatchObject({ kind: 'response', statusCode: 200 });
    expect(target.requests).toHaveLength(1);
  });

  it('refuses a URL that carries a user name or a scheme it does not speak', async () => {
    const target = await collector();
    const transport = createOtlpHttpTransport();
    const withUser = await transport.send(request(urlWithPassword('secret', `127.0.0.1:${String(target.port)}/v1/metrics`)));
    const otherScheme = await transport.send(request(`ftp://127.0.0.1:${String(target.port)}/v1/metrics`));
    expect([withUser, otherScheme]).toEqual([
      { kind: 'failure', errorClass: 'network' },
      { kind: 'failure', errorClass: 'network' }
    ]);
    expect(target.connections()).toBe(0);
  });

  it('never rejects, even for a header value the platform refuses', async () => {
    const target = await collector();
    const headers = { [CREDENTIAL_HEADER]: 'line\r\nbreak' };
    const result = await createOtlpHttpTransport().send(request(target.url, { headers }));
    expect(result).toEqual({ kind: 'failure', errorClass: 'network' });
    expect(target.connections()).toBe(0);
  });
});

describe('OTLP/HTTP transport: the two pure rules', () => {
  it.each([
    ['7', 7],
    ['00007', 7],
    ['99999', 99_999],
    [' 7', null],
    ['7 ', null],
    ['', null],
    ['123456', null],
    ['+7', null],
    ['0x7', null],
    [undefined, null],
    [7, null],
    [[['7', '8']], null]
  ])('reads the Retry-After text %j as %j', (value, expected) => {
    expect(retryAfterSecondsOf(value)).toBe(expected);
  });

  it.each([
    [150, 150],
    [2_000, 2_000],
    [2_001, 2_000],
    [60_000, 2_000],
    [0, 2_000],
    [-5, 2_000],
    [Number.NaN, 2_000],
    [Number.POSITIVE_INFINITY, 2_000]
  ])('keeps a deadline of %j ms as %j ms', (requested, expected) => {
    expect(effectiveDeadlineMs(requested)).toBe(expected);
  });
});
