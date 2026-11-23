// Feature 020 T016 — `truncateDisplayEntryBody`: 4 KiB per-field cap,
// UTF-8 boundary snap, no mutation. See
// specs/020-phase-level-logs/contracts/phase-log-service.md §5 +
// specs/020-phase-level-logs/research.md §6.

import { describe, expect, it } from 'vitest';
import type { PhaseLogDisplayEntry } from '../../../../src/services/phase-log/types';
import { truncateDisplayEntryBody } from '../../../../src/services/phase-log/phase-log-truncator';

function makeEntry(overrides: Partial<PhaseLogDisplayEntry['body']>): PhaseLogDisplayEntry {
  return {
    seq: 0,
    kind: 'assistant-text',
    ts: null,
    body: overrides,
    bodyTruncated: null
  } as PhaseLogDisplayEntry;
}

describe('Feature 020 T016 — truncateDisplayEntryBody', () => {
  it('passes a small entry through unchanged with bodyTruncated null', () => {
    const e = makeEntry({ text: 'small body' });
    const out = truncateDisplayEntryBody(e, { perFieldBytes: 4096 });
    expect(out.body.text).toBe('small body');
    expect(out.bodyTruncated).toBeNull();
  });

  it('truncates a single field that exceeds the cap and records originalLength', () => {
    const huge = 'x'.repeat(5000);
    const e = makeEntry({ text: huge });
    const out = truncateDisplayEntryBody(e, { perFieldBytes: 4096 });
    expect(Buffer.byteLength(out.body.text ?? '', 'utf8')).toBeLessThanOrEqual(4096);
    expect(out.bodyTruncated?.text?.originalLength).toBe(5000);
  });

  it('keeps fields under the cap untouched', () => {
    const huge = 'x'.repeat(5000);
    const e = makeEntry({ text: 'small', toolResult: huge });
    const out = truncateDisplayEntryBody(e, { perFieldBytes: 4096 });
    expect(out.body.text).toBe('small');
    expect(out.bodyTruncated?.text).toBeUndefined();
    expect(out.bodyTruncated?.toolResult?.originalLength).toBe(5000);
  });

  it('snaps slice to a UTF-8 char boundary so the output is valid UTF-8', () => {
    // Build a string that, in UTF-8, would land mid-codepoint at exactly 4096 bytes.
    // 'é' (U+00E9) encodes to 2 bytes (0xC3 0xA9). 2048 'é' = 4096 bytes;
    // we add one extra 'é' so the natural cut at byte 4096 would split the next 'é'.
    const s = 'é'.repeat(2049);
    const e = makeEntry({ text: s });
    const out = truncateDisplayEntryBody(e, { perFieldBytes: 4096 });
    const outText = out.body.text ?? '';
    // Valid UTF-8: re-encoding the JS string and asserting byte length ≤ cap.
    expect(Buffer.byteLength(outText, 'utf8')).toBeLessThanOrEqual(4096);
    // And the truncated string contains only whole 'é' characters.
    expect(outText.length * 2).toBe(Buffer.byteLength(outText, 'utf8'));
  });

  it('does not mutate the input entry', () => {
    const huge = 'x'.repeat(5000);
    const e = makeEntry({ text: huge });
    const before = e.body.text;
    truncateDisplayEntryBody(e, { perFieldBytes: 4096 });
    expect(e.body.text).toBe(before);
    expect(e.bodyTruncated).toBeNull();
  });

  it('truncates multiple fields independently', () => {
    const e = makeEntry({
      text: 'a'.repeat(5000),
      toolInput: 'b'.repeat(8192),
      toolResult: 'c'.repeat(100)
    });
    const out = truncateDisplayEntryBody(e, { perFieldBytes: 4096 });
    expect(out.bodyTruncated?.text?.originalLength).toBe(5000);
    expect(out.bodyTruncated?.toolInput?.originalLength).toBe(8192);
    expect(out.bodyTruncated?.toolResult).toBeUndefined();
  });

  it('truncates multi-MiB fields without losing exact byte-length accounting or UTF-8 validity', () => {
    const huge = `${'é'.repeat(2049)}${'x'.repeat(3 * 1024 * 1024)}`;
    const expectedBytes = Buffer.byteLength(huge, 'utf8');
    const out = truncateDisplayEntryBody(makeEntry({ text: huge }), { perFieldBytes: 4096 });
    const outText = out.body.text ?? '';
    expect(Buffer.byteLength(outText, 'utf8')).toBeLessThanOrEqual(4096);
    expect(outText.length * 2).toBe(Buffer.byteLength(outText, 'utf8'));
    expect(out.bodyTruncated?.text?.originalLength).toBe(expectedBytes);
  });

  it('does not re-truncate an existing toolArguments truncation sentinel under a tiny perFieldBytes cap', () => {
    const sentinel = { __truncated: true, originalBytes: 12345 };
    const out = truncateDisplayEntryBody(makeEntry({ toolArguments: sentinel }), { perFieldBytes: 24 });
    expect(out.body.toolArguments).toEqual({ __truncated: true, originalBytes: 12345 });
    expect(out.bodyTruncated).toBeNull();
  });

  it('still truncates spoofed toolArguments with extra keys or prototype-inherited __truncated', () => {
    const withExtra = { __truncated: true, originalBytes: 10, payload: 'x'.repeat(100) };
    const extraOut = truncateDisplayEntryBody(makeEntry({ toolArguments: withExtra }), { perFieldBytes: 24 });
    const expectedExtraBytes = Buffer.byteLength(JSON.stringify(withExtra), 'utf8');
    expect(extraOut.body.toolArguments).toEqual({ __truncated: true, originalBytes: expectedExtraBytes });
    expect(extraOut.bodyTruncated?.toolArguments?.originalLength).toBe(expectedExtraBytes);

    const forgedProto = Object.assign(
      Object.create({ __truncated: true, originalBytes: 10 }) as Record<string, unknown>,
      { payload: 'y'.repeat(100) }
    );
    const protoOut = truncateDisplayEntryBody(
      makeEntry({ toolArguments: forgedProto as NonNullable<PhaseLogDisplayEntry['body']['toolArguments']> }),
      { perFieldBytes: 24 }
    );
    const expectedProtoBytes = Buffer.byteLength(JSON.stringify(forgedProto), 'utf8');
    expect(protoOut.body.toolArguments).toEqual({ __truncated: true, originalBytes: expectedProtoBytes });
    expect(protoOut.bodyTruncated?.toolArguments?.originalLength).toBe(expectedProtoBytes);
  });

  it('fails closed when toolArguments cannot be JSON-stringified (cyclic, BigInt, throwing or undefined toJSON) (SR-306-2)', () => {
    const perFieldBytes = 4096;
    const expectedFallbackBytes = perFieldBytes + 1;

    const cyclic: Record<string, unknown> = { label: 'loop' };
    cyclic['self'] = cyclic;

    const withBigInt: Record<string, unknown> = { count: BigInt(42) };

    const throwingToJson: Record<string, unknown> = {
      toJSON() {
        throw new Error('boom');
      }
    };

    const undefinedToJson: Record<string, unknown> = {
      toJSON() {
        return undefined;
      }
    };

    for (const unserializable of [cyclic, withBigInt, throwingToJson, undefinedToJson]) {
      const entry = makeEntry({
        toolArguments: unserializable as NonNullable<PhaseLogDisplayEntry['body']['toolArguments']>
      });
      const out = truncateDisplayEntryBody(entry, { perFieldBytes });
      expect(out.body.toolArguments).toEqual({
        __truncated: true,
        originalBytes: expectedFallbackBytes
      });
      expect(out.bodyTruncated).toEqual({
        toolArguments: { originalLength: expectedFallbackBytes }
      });
    }
  });
});
