import { describe, it, expect } from 'vitest';
import {
  FATAL_SIGNATURES,
  MAX_DIAGNOSTIC_LINE_LENGTH,
  classifyFatal
} from '../../../src/lib/fatal-signature-registry';

describe('FATAL_SIGNATURES registry (010, T010)', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(FATAL_SIGNATURES)).toBe(true);
  });

  it('contains the v1 fatal signature verbatim', () => {
    expect(FATAL_SIGNATURES).toContain("error: unknown option");
  });
});

describe('classifyFatal (010, T010)', () => {
  it('returns no match for empty inputs', () => {
    const result = classifyFatal('', '');
    expect(result.matched).toBe(false);
  });

  it('does NOT match the v1 signature on stdout — it is stderr-scoped', () => {
    // 2026-08-16: this entry is an argument-parse diagnostic and only ever
    // originates on stderr. A stdout occurrence is text the CLI was
    // carrying, which is how a file read failed a 3.6-hour phase.
    const result = classifyFatal("...\nerror: unknown option\n...", '');
    expect(result.matched).toBe(false);
  });

  it('matches a both-streams signature on stdout', () => {
    const result = classifyFatal("...\nAutocompact is thrashing\n...", '');
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.signature).toBe("Autocompact is thrashing");
      expect(result.stream).toBe('stdout');
    }
  });

  it('matches the v1 signature on stderr', () => {
    const result = classifyFatal('', "prefix error: unknown option");
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.signature).toBe("error: unknown option");
      expect(result.stream).toBe('stderr');
    }
  });

  it('is case-sensitive — uppercase variants do NOT match', () => {
    expect(classifyFatal("ERROR: UNKNOWN OPTION", '').matched).toBe(false);
    expect(classifyFatal('', "ERROR: UNKNOWN OPTION").matched).toBe(false);
  });

  it('does NOT match a substring spanning a synthetic stdout||stderr boundary', () => {
    // FR-001: streams scanned independently — the registry MUST NOT
    // concatenate stdout and stderr when looking for a match.
    const stdoutHalf = "error: unknown";
    const stderrHalf = ' option';
    expect(classifyFatal(stdoutHalf, stderrHalf).matched).toBe(false);
  });

  it('returns stdout when both streams contain a match (pinned scan order)', () => {
    // Uses the both-streams entry, since the pinned order is only
    // observable for a signature that can match on either stream.
    const result = classifyFatal(
      "Autocompact is thrashing on stdout",
      "Autocompact is thrashing on stderr"
    );
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.stream).toBe('stdout');
    }
  });

  it('ignores a signature quoted inside a structured line (2026-08-16)', () => {
    // stream-json stdout is one JSON envelope per line, carrying tool
    // results — i.e. the text of every file the agent reads.
    const envelope = `{"type":"user","content":"docs quote \\"error: unknown option\\""}`;
    expect(classifyFatal(envelope, envelope).matched).toBe(false);
  });

  it('ignores a signature past the diagnostic line-length cap', () => {
    const long = `${'x'.repeat(MAX_DIAGNOSTIC_LINE_LENGTH)} error: unknown option`;
    expect(classifyFatal('', long).matched).toBe(false);
  });

  it('still matches a bare diagnostic line surrounded by structured ones', () => {
    const stderr = ['{"json":1}', "error: unknown option '--nope'", '{"json":2}'].join('\n');
    expect(classifyFatal('', stderr)).toMatchObject({
      matched: true,
      stream: 'stderr',
      signature: 'error: unknown option'
    });
  });
});
