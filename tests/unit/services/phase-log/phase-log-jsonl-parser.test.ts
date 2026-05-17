// Feature 020 T014 — `parseStreamJsonlBytes` JSONL parsing,
// malformed-line tolerance, partial-trailing-buffer behavior. See
// specs/020-phase-level-logs/contracts/phase-log-service.md §3.

import { describe, expect, it } from 'vitest';
import { parseStreamJsonlBytes } from '../../../../src/services/phase-log/phase-log-jsonl-parser';

describe('Feature 020 T014 — parseStreamJsonlBytes', () => {
  it('parses \\n-delimited lines correctly', () => {
    const bytes = '{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n';
    const result = parseStreamJsonlBytes(bytes, '');
    expect(result.parsedLines).toHaveLength(3);
    expect((result.parsedLines[0] as { type: string }).type).toBe('a');
    expect((result.parsedLines[2] as { type: string }).type).toBe('c');
    expect(result.skippedLines).toBe(0);
    expect(result.partialTrailingBuffer).toBe('');
  });

  it('counts malformed lines into skippedLines but continues parsing', () => {
    const bytes = '{"type":"a"}\nnot-json\n{"type":"c"}\n';
    const result = parseStreamJsonlBytes(bytes, '');
    expect(result.parsedLines).toHaveLength(2);
    expect(result.skippedLines).toBe(1);
    expect(result.partialTrailingBuffer).toBe('');
  });

  it('holds an unterminated trailing chunk as partialTrailingBuffer', () => {
    const bytes = '{"type":"a"}\n{"type":"b-trail';
    const result = parseStreamJsonlBytes(bytes, '');
    expect(result.parsedLines).toHaveLength(1);
    expect(result.partialTrailingBuffer).toBe('{"type":"b-trail');
    expect(result.skippedLines).toBe(0);
  });

  it('joins partialPrefix with new bytes before splitting', () => {
    const result = parseStreamJsonlBytes('rest"}\n{"type":"x"}\n', '{"type":"a-st');
    expect(result.parsedLines).toHaveLength(2);
    expect((result.parsedLines[0] as { type: string }).type).toBe('a-strest');
    expect((result.parsedLines[1] as { type: string }).type).toBe('x');
    expect(result.partialTrailingBuffer).toBe('');
  });

  it('accepts a Buffer input', () => {
    const buf = Buffer.from('{"type":"a"}\n{"type":"b"}\n', 'utf8');
    const result = parseStreamJsonlBytes(buf, '');
    expect(result.parsedLines).toHaveLength(2);
    expect(result.skippedLines).toBe(0);
  });

  it('skips empty lines without counting them as malformed', () => {
    const bytes = '{"type":"a"}\n\n{"type":"c"}\n';
    const result = parseStreamJsonlBytes(bytes, '');
    expect(result.parsedLines).toHaveLength(2);
    expect(result.skippedLines).toBe(0);
  });
});
