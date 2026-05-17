// Feature 031 T027 — unit tests for the wake-up session capture ring buffer.
//
// The runner captures stdout + stderr of the Claude CLI subprocess and
// keeps a bounded FIFO ring of the most recent 64 KB (the cap is the
// `SESSION_CAPTURE_MAX_BYTES` constant from `src/wakeup/session-log-constants.ts`).
// At end-of-invocation the captured bytes pass through
// `SanitizedLogger.sanitize` exactly once; the compact 4 KB
// `rawResponse` projection is derived from the last 4 KB AFTER that
// single sanitization pass.
//
// Coverage:
//   (a) accepts <= 64 KB of mixed OUT: / ERR: lines without truncation
//       (sessionCaptureTruncated === false).
//   (b) when total bytes exceed 64 KB, oldest bytes are dropped (FIFO)
//       and sessionCaptureTruncated === true.
//   (c) the compact 4 KB `rawResponse` is the LAST 4 KB after
//       sanitization (one pass — never two).
//   (d) the `OUT:` / `ERR:` stream prefixes are preserved verbatim in
//       both the full capture and in the 4 KB projection.
//
// Test target lives in `src/wakeup/session-capture-ring.ts` (a sibling
// of the headless runner so the runner stays slim and the buffer can
// be exercised in isolation). The module MUST remain `vscode`-free.

import { describe, it, expect } from 'vitest';
import {
  SessionCaptureRing,
  SESSION_CAPTURE_PROJECTION_BYTES
} from '../../../src/wakeup/session-capture-ring';
import { SESSION_CAPTURE_MAX_BYTES } from '../../../src/wakeup/session-log-constants';

function identitySanitize(input: string): string {
  return input;
}

describe('Feature 031 T027 — SessionCaptureRing capture invariants', () => {
  it('captures every byte under the 64 KB cap and reports not truncated', () => {
    const ring = new SessionCaptureRing();
    ring.append('out', 'hello world\n');
    ring.append('err', 'oh no\n');
    ring.append('out', 'recovered\n');

    const result = ring.finalize(identitySanitize);
    expect(result.truncated).toBe(false);
    expect(result.full).toBe(
      'OUT: hello world\nERR: oh no\nOUT: recovered\n'
    );
  });

  it('drops oldest bytes (FIFO) when capture exceeds 64 KB and flags truncated', () => {
    const ring = new SessionCaptureRing();
    // Push 70 KB of distinguishable lines: each chunk is exactly 70 bytes
    // (`OUT:` prefix added is +5 bytes per line). We use line numbers so
    // we can verify the head is dropped.
    const chunk = 'X'.repeat(63) + '\n'; // 64 bytes per call body
    let calls = 0;
    while (ring.bytesAppended() < SESSION_CAPTURE_MAX_BYTES + 6 * 1024) {
      ring.append('out', `${String(calls).padStart(5, '0')}-${chunk}`);
      calls++;
    }

    const result = ring.finalize(identitySanitize);
    expect(result.truncated).toBe(true);
    // After eviction we keep the most recent 64 KB.
    expect(Buffer.byteLength(result.full, 'utf8')).toBeLessThanOrEqual(
      SESSION_CAPTURE_MAX_BYTES
    );
    // The tail should contain the LAST chunk's index.
    expect(result.full).toContain(`${String(calls - 1).padStart(5, '0')}-`);
    // The head index `00000-` should have been evicted.
    expect(result.full).not.toContain('00000-');
  });

  it('derives the compact 4 KB projection from the LAST 4 KB after sanitization', () => {
    const ring = new SessionCaptureRing();
    // Build a clearly-tail-identifiable payload that exceeds the 4 KB
    // projection cap. We use OUT: prefix + repeating distinct sentinels
    // so we can confirm the projection picks the tail.
    const headFiller = 'A'.repeat(2048);
    const tailFiller = 'Z'.repeat(2048) + 'TAIL-MARKER';
    ring.append('out', headFiller);
    ring.append('out', tailFiller);

    let sanitizeCalls = 0;
    const sanitize = (input: string): string => {
      sanitizeCalls++;
      return input.replace(/A+/g, 'A');
    };

    const result = ring.finalize(sanitize);
    expect(sanitizeCalls).toBe(1);
    expect(result.projection.endsWith('TAIL-MARKER')).toBe(true);
    expect(Buffer.byteLength(result.projection, 'utf8')).toBeLessThanOrEqual(
      SESSION_CAPTURE_PROJECTION_BYTES
    );
  });

  it('preserves OUT: / ERR: stream prefixes in both full capture and projection', () => {
    const ring = new SessionCaptureRing();
    ring.append('out', 'first stdout line\n');
    ring.append('err', 'first stderr line\n');
    ring.append('out', 'second stdout line\n');

    const result = ring.finalize(identitySanitize);
    expect(result.full).toContain('OUT: first stdout line');
    expect(result.full).toContain('ERR: first stderr line');
    expect(result.full).toContain('OUT: second stdout line');
    // Projection is short enough that it should still hold all three.
    expect(result.projection).toContain('OUT: first stdout line');
    expect(result.projection).toContain('ERR: first stderr line');
    expect(result.projection).toContain('OUT: second stdout line');
  });

  it('sanitizes the captured bytes exactly once at finalize', () => {
    const ring = new SessionCaptureRing();
    ring.append('out', 'sk-ant-AAAAAAAAAAAAAAAAAAAAAAAAAAA\n');
    let calls = 0;
    const sanitize = (input: string): string => {
      calls++;
      return input.replace(/sk-(ant-)?[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
    };
    const result = ring.finalize(sanitize);
    expect(calls).toBe(1);
    expect(result.full).toContain('[REDACTED]');
    expect(result.projection).toContain('[REDACTED]');
  });
});
