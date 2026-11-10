// FR-R6-F07 (FR-002, FR-005, FR-006, FR-015) — opaque `plc1` live-log cursors.
// See specs/306-recoverable-live-logs/research.md R2 for the validation order.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CURSOR_MAX_LENGTH,
  generationOf,
  issueCursor,
  parseCursor,
  streamDigest,
  validateCursor,
  fingerprintOf
} from '../../../../src/services/phase-log/live-log-cursor';

const ROOT = '/ws/project-a';
const SELECTION = {
  queueId: 'q1',
  taskId: 'task-123',
  pipelineId: 'pipe',
  phaseId: 'implement',
  iterationN: 2
};
const CONTENT = Buffer.from('{"type":"a"}\n{"type":"b"}\n', 'utf8');
const STAT = { dev: 16777220, ino: 9876543, birthtimeMs: 1700000000123.5, size: CONTENT.length };

function readerOver(bytes: Buffer) {
  return async (offset: number, length: number): Promise<Buffer> =>
    bytes.subarray(offset - length, offset);
}

function cursorAt(offset: number, bytes: Buffer = CONTENT): string {
  return issueCursor({
    digest: streamDigest(ROOT, SELECTION),
    generation: generationOf(STAT, 'darwin'),
    offset,
    fingerprint: fingerprintOf(bytes.subarray(Math.max(0, offset - 64), offset))
  });
}

function expectation(size = CONTENT.length) {
  return {
    digest: streamDigest(ROOT, SELECTION),
    generation: generationOf(STAT, 'darwin'),
    size
  };
}

describe('live-log cursor (FR-R6-F07)', () => {
  it('round-trips an issued cursor through parse', () => {
    const text = cursorAt(13);
    const parsed = parseCursor(text);
    expect(parsed.outcome).toBe('parsed');
    if (parsed.outcome !== 'parsed') return;
    expect(parsed.fields.offset).toBe(13);
    expect(parsed.fields.digest).toBe(streamDigest(ROOT, SELECTION));
    expect(parsed.fields.generation).toBe(generationOf(STAT, 'darwin'));
  });

  it('stays within the length bound and carries no path fragment', () => {
    const text = cursorAt(CONTENT.length);
    expect(text.length).toBeLessThanOrEqual(CURSOR_MAX_LENGTH);
    for (const fragment of ['ws', 'project-a', 'task-123', 'implement', 'pipe']) {
      expect(text.includes(fragment)).toBe(false);
    }
    expect(text.startsWith('plc1.')).toBe(true);
  });

  it('accepts a valid cursor at a record boundary', async () => {
    const result = await validateCursor(cursorAt(13), expectation(), readerOver(CONTENT));
    expect(result).toEqual({ outcome: 'accepted', offset: 13 });
  });

  it('accepts offset 0 with an empty fingerprint', async () => {
    const text = cursorAt(0);
    expect(text.endsWith('.0.')).toBe(true);
    const result = await validateCursor(text, expectation(), readerOver(CONTENT));
    expect(result).toEqual({ outcome: 'accepted', offset: 0 });
  });

  it('reports a future version as unknown-version before any other check', async () => {
    const text = cursorAt(13).replace(/^plc1/, 'plc2');
    expect(parseCursor(text).outcome).toBe('unknown-version');
    const result = await validateCursor(text, { digest: 'x', generation: 'y', size: 0 }, readerOver(CONTENT));
    expect(result.outcome).toBe('unknown-version');
  });

  it('resets a malformed cursor', async () => {
    for (const bad of ['', 'plc1', 'plc1.zz.1-2.13.', 'plc1.' + 'a'.repeat(200), 'nonsense']) {
      const result = await validateCursor(bad, expectation(), readerOver(CONTENT));
      expect(result).toEqual({ outcome: 'reset', cause: 'malformed' });
    }
  });

  it('resets a cursor from another workspace or selection', async () => {
    const foreign = issueCursor({
      digest: streamDigest('/ws/other', SELECTION),
      generation: generationOf(STAT, 'darwin'),
      offset: 13,
      fingerprint: fingerprintOf(CONTENT.subarray(0, 13))
    });
    const result = await validateCursor(foreign, expectation(), readerOver(CONTENT));
    expect(result).toEqual({ outcome: 'reset', cause: 'foreign-stream' });
    const otherIteration = streamDigest(ROOT, { ...SELECTION, iterationN: 3 });
    expect(otherIteration).not.toBe(streamDigest(ROOT, SELECTION));
  });

  it('resets a cursor from another file generation', async () => {
    const other = { ...expectation(), generation: generationOf({ ...STAT, ino: 1 }, 'darwin') };
    const result = await validateCursor(cursorAt(13), other, readerOver(CONTENT));
    expect(result).toEqual({ outcome: 'reset', cause: 'generation-changed' });
  });

  it('resets a cursor past the end of the file', async () => {
    const result = await validateCursor(cursorAt(26), expectation(20), readerOver(CONTENT));
    expect(result).toEqual({ outcome: 'reset', cause: 'offset-past-size' });
  });

  it('resets a cursor that does not follow a newline', async () => {
    const text = issueCursor({
      digest: streamDigest(ROOT, SELECTION),
      generation: generationOf(STAT, 'darwin'),
      offset: 5,
      fingerprint: fingerprintOf(CONTENT.subarray(0, 5))
    });
    const result = await validateCursor(text, expectation(), readerOver(CONTENT));
    expect(result).toEqual({ outcome: 'reset', cause: 'not-at-boundary' });
  });

  it('resets a cursor whose preceding bytes changed (truncate and regrow)', async () => {
    const regrown = Buffer.from('{"type":"X"}\n{"type":"Y"}\n', 'utf8');
    const result = await validateCursor(cursorAt(13), expectation(), readerOver(regrown));
    expect(result).toEqual({ outcome: 'reset', cause: 'fingerprint-mismatch' });
  });

  it('reports the first failing check when a cursor is wrong in several ways', async () => {
    const regrown = Buffer.from('{"type":"X"}\n{"type":"Y"}\n', 'utf8');
    const otherGeneration = generationOf({ ...STAT, ino: 1 }, 'darwin');
    const unaligned = (digest: string): string =>
      issueCursor({
        digest,
        generation: generationOf(STAT, 'darwin'),
        offset: 5,
        // Bytes the regrown file does not hold, so the fingerprint check fails too.
        fingerprint: fingerprintOf(Buffer.from('other', 'utf8'))
      });
    const cases: readonly { readonly text: string; readonly expected: ReturnType<typeof expectation>; readonly bytes: Buffer; readonly cause: string }[] = [
      {
        text: unaligned(streamDigest('/ws/other', SELECTION)),
        expected: { ...expectation(2), generation: otherGeneration },
        bytes: regrown,
        cause: 'foreign-stream'
      },
      { text: cursorAt(26), expected: { ...expectation(20), generation: otherGeneration }, bytes: regrown, cause: 'generation-changed' },
      { text: cursorAt(26), expected: expectation(20), bytes: regrown, cause: 'offset-past-size' },
      { text: unaligned(streamDigest(ROOT, SELECTION)), expected: expectation(), bytes: regrown, cause: 'not-at-boundary' }
    ];
    for (const { text, expected, bytes, cause } of cases) {
      const result = await validateCursor(text, expected, readerOver(bytes));
      expect(result, cause).toEqual({ outcome: 'reset', cause });
    }
  });

  it('derives the stream digest from SHA-256 and never exposes the raw inputs', () => {
    const digest = streamDigest(ROOT, SELECTION);
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    const full = createHash('sha256').update(ROOT).digest('hex');
    expect(full.startsWith(digest)).toBe(false);
  });

  it('adds the creation time to the generation on win32', () => {
    expect(generationOf(STAT, 'win32')).not.toBe(generationOf(STAT, 'darwin'));
    expect(generationOf({ ...STAT, ino: 0 }, 'win32')).toMatch(/^[0-9a-z]+-0-[0-9a-z]+$/);
  });
});
