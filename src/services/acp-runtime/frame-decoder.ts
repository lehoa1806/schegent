/**
 * FR-R6-F13 (FR-013, FR-017, NFR-002, research R2) — newline-delimited JSON framing with byte
 * bounds.
 *
 * The undecoded remainder is kept as bytes and split on 0x0A, so a multi-byte character split
 * across chunks is whole before it is decoded. One trailing 0x0D is dropped and blank lines are
 * skipped. Each line is decoded with a fatal UTF-8 decoder, then parsed.
 *
 * - A chunk that would bring the held remainder plus the chunk over the pending bound fails
 *   `pending-bytes-exceeded` before it is copied.
 * - A complete line, or a remainder without a newline, over the message bound fails
 *   `frame-oversized`, so no message over the bound is ever decoded.
 * - A line that is not UTF-8 or not JSON fails `malformed-frame`. It is never skipped: a skipped
 *   line could be the response the host is waiting for.
 *
 * After a failure every push returns the same failure. Zero `vscode` imports.
 */
import { ACP_RUNTIME_LIMITS } from '../../contracts/acp-runtime';

export type FrameFailureReason = 'malformed-frame' | 'frame-oversized' | 'pending-bytes-exceeded';

export type FrameDecodeResult =
  | { readonly ok: true; readonly messages: unknown[] }
  | { readonly ok: false; readonly reason: FrameFailureReason };

export interface FrameLimits {
  readonly maxMessageBytes: number;
  readonly maxPendingBytes: number;
}

type LineOutcome =
  | { readonly kind: 'message'; readonly value: unknown }
  | { readonly kind: 'blank' }
  | { readonly kind: 'failed'; readonly reason: FrameFailureReason };

const BLANK_LINE: LineOutcome = { kind: 'blank' };

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const WHITESPACE_ONLY = /^\s*$/;

export class FrameDecoder {
  private remainder: Uint8Array = new Uint8Array(0);
  private failure: FrameFailureReason | null = null;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });

  constructor(private readonly limits: FrameLimits = ACP_RUNTIME_LIMITS) {}

  push(chunk: Uint8Array): FrameDecodeResult {
    if (this.failure !== null) return { ok: false, reason: this.failure };
    if (this.remainder.byteLength + chunk.byteLength > this.limits.maxPendingBytes) {
      return this.fail('pending-bytes-exceeded');
    }
    const data = this.join(chunk);
    const messages: unknown[] = [];
    let start = 0;
    let newline = data.indexOf(NEWLINE, start);
    while (newline !== -1) {
      const outcome = this.decodeLine(data.subarray(start, newline));
      if (outcome.kind === 'failed') return this.fail(outcome.reason);
      if (outcome.kind === 'message') messages.push(outcome.value);
      start = newline + 1;
      newline = data.indexOf(NEWLINE, start);
    }
    if (data.byteLength - start > this.limits.maxMessageBytes) return this.fail('frame-oversized');
    this.remainder = data.slice(start);
    return { ok: true, messages };
  }

  private join(chunk: Uint8Array): Uint8Array {
    if (this.remainder.byteLength === 0) return chunk;
    const joined = new Uint8Array(this.remainder.byteLength + chunk.byteLength);
    joined.set(this.remainder, 0);
    joined.set(chunk, this.remainder.byteLength);
    return joined;
  }

  private decodeLine(raw: Uint8Array): LineOutcome {
    const line = raw.byteLength > 0 && raw.at(-1) === CARRIAGE_RETURN ? raw.subarray(0, -1) : raw;
    if (line.byteLength > this.limits.maxMessageBytes) return { kind: 'failed', reason: 'frame-oversized' };
    let text: string;
    try {
      text = this.decoder.decode(line);
    } catch {
      return { kind: 'failed', reason: 'malformed-frame' };
    }
    if (WHITESPACE_ONLY.test(text)) return BLANK_LINE;
    try {
      return { kind: 'message', value: JSON.parse(text) as unknown };
    } catch {
      return { kind: 'failed', reason: 'malformed-frame' };
    }
  }

  private fail(reason: FrameFailureReason): FrameDecodeResult {
    this.failure = reason;
    this.remainder = new Uint8Array(0);
    return { ok: false, reason };
  }
}
