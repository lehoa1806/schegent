import { describe, it, expect } from 'vitest';
import {
  FATAL_SIGNATURES,
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

  it('matches the v1 signature on stdout', () => {
    const result = classifyFatal("...\nerror: unknown option\n...", '');
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.signature).toBe("error: unknown option");
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
    const result = classifyFatal(
      "error: unknown option on stdout",
      "error: unknown option on stderr"
    );
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.stream).toBe('stdout');
    }
  });
});
