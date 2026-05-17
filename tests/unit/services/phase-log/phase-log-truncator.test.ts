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
});
