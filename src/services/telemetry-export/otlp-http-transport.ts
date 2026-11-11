/**
 * FR-R6-F14 (FR-002, FR-009, FR-010, FR-014; research R5) — the OTLP/HTTP transport: one `POST`
 * per call, on a connection of its own, to the one destination it is given. It follows no
 * redirect, verifies certificates the default way with no option to change that, reads at most
 * 64 KiB of the answer, and ends at the deadline or when the signal aborts.
 *
 * Plaintext is sent only when the destination allowed it and the host is a loopback name; a
 * name is then accepted only when every address it resolves to is loopback.
 *
 * The result is closed: a status code, a `Retry-After` in seconds, the bounded body, or one of
 * four failure classes. No error message, stack or other remote text leaves this module, and
 * `send` never rejects.
 *
 * This is the only module in `src` that imports `node:http`, `node:https` or `node:dns`. It
 * creates no server and no listener. Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest, type RequestOptions as SecureRequestOptions } from 'node:https';
import type { LookupFunction } from 'node:net';
import {
  TELEMETRY_EXPORT_BOUNDS,
  type TelemetryTransport,
  type TransportFailureClass,
  type TransportRequest,
  type TransportResult
} from '../../contracts/telemetry-export';
import { RESERVED_HEADERS, isLoopbackHostname } from './destination-policy';

/** The name lookup of `node:net`; the default is `dns.lookup`. */
export type NameLookup = LookupFunction;

export interface OtlpHttpTransportOptions {
  /**
   * Replaces the name lookup of a plaintext request. Its answers pass the same loopback check
   * as the default lookup's; it cannot widen what the transport connects to. For tests.
   */
  readonly lookup?: NameLookup;
}

const BOUNDS = TELEMETRY_EXPORT_BOUNDS;
const USER_AGENT = 'schegent-telemetry-export';
const CONTENT_TYPE = 'application/json';
const RETRY_AFTER_SECONDS = /^[0-9]{1,5}$/;
const LOOPBACK_IPV4_ADDRESS = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const LOOPBACK_IPV6_ADDRESS = '::1';
/** Error codes of a failed handshake or a refused certificate. Only the code is read. */
const TLS_ERROR_CODE = /^(?:ERR_SSL_|ERR_TLS_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH$|EPROTO$)/;

function failed(errorClass: TransportFailureClass): TransportResult {
  return { kind: 'failure', errorClass };
}

/** The request deadline: the one asked for, never above the bound; the bound when it is not a positive number. */
export function effectiveDeadlineMs(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return BOUNDS.requestDeadlineMs;
  return Math.min(requested, BOUNDS.requestDeadlineMs);
}

/** `Retry-After` as whole seconds; a date, a fraction, a sign or more than five digits is `null`. */
export function retryAfterSecondsOf(value: unknown): number | null {
  return typeof value === 'string' && RETRY_AFTER_SECONDS.test(value) ? Number(value) : null;
}

function isLoopbackAddress(address: string): boolean {
  return address === LOOPBACK_IPV6_ADDRESS || LOOPBACK_IPV4_ADDRESS.test(address);
}

function failureClassOf(error: unknown): TransportFailureClass {
  const code: unknown = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && TLS_ERROR_CODE.test(code) ? 'tls' : 'network';
}

/** A lookup that fails unless every address the inner lookup answers with is loopback. */
function loopbackOnly(inner: NameLookup): NameLookup {
  return (hostname, options, callback) => {
    inner(hostname, options, (error, address, family) => {
      if (error !== null) {
        callback(error, address, family);
        return;
      }
      const addresses = typeof address === 'string' ? [address] : address.map((entry) => entry.address);
      if (addresses.length === 0 || !addresses.every(isLoopbackAddress)) {
        callback(Object.assign(new Error('lookup-not-loopback'), { code: 'ENOTFOUND' }), [], family);
        return;
      }
      callback(null, address, family);
    });
  };
}

function defaultLookup(): NameLookup {
  return (hostname, options, callback) => {
    dnsLookup(hostname, options, callback);
  };
}

/** The headers of the request: the caller's, minus every name the transport owns, plus its own. */
function headersOf(request: TransportRequest): Record<string, string> {
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (!RESERVED_HEADERS.has(lower)) headers.set(lower, value);
  }
  headers.set('content-type', CONTENT_TYPE);
  headers.set('content-length', String(request.body.byteLength));
  headers.set('user-agent', USER_AGENT);
  return Object.fromEntries(headers);
}

type Target =
  | { readonly secure: true; readonly options: SecureRequestOptions }
  | { readonly secure: false; readonly options: RequestOptions };

/** The request options, or `null` when the URL is one this transport does not send to. */
function optionsOf(request: TransportRequest, lookup: NameLookup): Target | null {
  const { url } = request;
  if (url.username !== '' || url.password !== '' || url.hostname === '') return null;
  const secure = url.protocol === 'https:';
  if (!secure && !(url.protocol === 'http:' && request.plaintextLoopback && isLoopbackHostname(url.hostname))) return null;
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const base: RequestOptions = {
    method: 'POST',
    agent: false,
    hostname,
    path: `${url.pathname}${url.search}`,
    headers: headersOf(request),
    insecureHTTPParser: false
  };
  if (url.port !== '') base.port = Number(url.port);
  if (secure) return { secure: true, options: { ...base, rejectUnauthorized: true } };
  return { secure: false, options: { ...base, lookup: loopbackOnly(lookup) } };
}

function sendOnce(request: TransportRequest, lookup: NameLookup, resolve: (result: TransportResult) => void): void {
  if (request.signal.aborted) {
    resolve(failed('aborted'));
    return;
  }
  const target = optionsOf(request, lookup);
  if (target === null) {
    resolve(failed('network'));
    return;
  }

  let settled = false;
  let outgoing: ClientRequest | undefined;
  const onAbort = (): void => {
    finish(failed('aborted'));
  };
  const deadline = setTimeout(() => {
    finish(failed('deadline'));
  }, effectiveDeadlineMs(request.deadlineMs));

  function finish(result: TransportResult): void {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    request.signal.removeEventListener('abort', onAbort);
    if (outgoing !== undefined) outgoing.destroy();
    resolve(result);
  }

  function collect(response: IncomingMessage): void {
    const chunks: Buffer[] = [];
    let size = 0;
    const answered = (bodyTruncated: boolean): TransportResult => ({
      kind: 'response',
      statusCode: response.statusCode ?? 0,
      retryAfterSeconds: retryAfterSecondsOf(response.headers['retry-after']),
      body: Buffer.concat(chunks),
      bodyTruncated
    });
    response.on('data', (chunk: Buffer) => {
      const room = BOUNDS.responseBytesMax - size;
      if (chunk.byteLength > room) {
        chunks.push(chunk.subarray(0, room));
        finish(answered(true));
        return;
      }
      chunks.push(chunk);
      size += chunk.byteLength;
    });
    response.on('end', () => {
      finish(answered(false));
    });
    response.on('error', () => {
      finish(failed('network'));
    });
    response.on('close', () => {
      finish(failed('network'));
    });
  }

  request.signal.addEventListener('abort', onAbort, { once: true });
  try {
    outgoing = target.secure ? httpsRequest(target.options) : httpRequest(target.options);
    outgoing.on('response', collect);
    outgoing.on('error', (error: unknown) => {
      finish(failed(failureClassOf(error)));
    });
    outgoing.end(request.body);
  } catch {
    finish(failed('network'));
  }
}

/** The production transport of the exporter (contracts/telemetry-export.md). */
export function createOtlpHttpTransport(options: OtlpHttpTransportOptions = {}): TelemetryTransport {
  const lookup = options.lookup ?? defaultLookup();
  return {
    send(request) {
      return new Promise((resolve) => {
        try {
          sendOnce(request, lookup, resolve);
        } catch {
          resolve(failed('network'));
        }
      });
    }
  };
}
