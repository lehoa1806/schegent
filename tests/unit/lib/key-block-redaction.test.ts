import { describe, expect, it } from 'vitest';
import {
  KeyBlockLineRedactor,
  MAX_KEY_BLOCK_LINES,
  SanitizedLogger
} from '../../../src/lib/logger';
import {
  ADJACENT_BLOCKS,
  BODY_SENTINEL,
  FAKE_MARKER_IN_BODY,
  FOOTER_MARK,
  PRIVATE_KEY_CASES,
  PUBLIC_KEY_BLOCK,
  SINGLE_LINE_BLOCK,
  UNTERMINATED_CASE
} from '../../fixtures/key-block-corpus';

/**
 * FR-R3-048 / H-07 — the sanitizer must remove the key, not the line announcing it.
 *
 * WHY THIS FILE EXISTS AND WHAT SHAPE IT HAS
 *
 * The defect survived a suite of 8468 tests because the existing assertions read
 *
 *     expect(out).not.toContain('-----BEGIN OPENSSH PRIVATE KEY-----')
 *
 * which passes against output still containing every byte of the body and the
 * footer. That is the detection/redaction confusion the source comment made
 * explicit ("the header alone is enough to redact"): true for deciding THAT
 * something is a secret, false for deciding WHAT to remove.
 *
 * So every assertion here is about the body and the footer. The header is not
 * mentioned, because its absence is not the property that matters.
 *
 * Nothing prints the protected string on failure — assertions compare booleans and
 * counts. A redaction test that echoes the secret when it fails leaks in CI.
 */

const logger = new SanitizedLogger([]);

describe('whole-string sinks redact the complete block (SC-001)', () => {
  for (const testCase of PRIVATE_KEY_CASES) {
    it(`removes body and footer: ${testCase.name}`, () => {
      const out = logger.sanitize(testCase.text);
      for (const secret of testCase.mustNotSurvive) {
        // `toBe(false)` rather than `not.toContain(secret)`: on failure vitest
        // prints the boolean, never the string being protected.
        expect(out.includes(secret)).toBe(false);
      }
      expect(out.includes('[REDACTED]')).toBe(true);
    });
  }

  it('redacts an unterminated block rather than releasing its tail (SC-004)', () => {
    const out = logger.sanitize(UNTERMINATED_CASE.text);
    for (const secret of UNTERMINATED_CASE.mustNotSurvive) {
      expect(out.includes(secret)).toBe(false);
    }
  });

  it('redacts an entire block delivered on one line (FR-009)', () => {
    const out = logger.sanitize(SINGLE_LINE_BLOCK);
    expect(out.includes(BODY_SENTINEL)).toBe(false);
    expect(out.includes(FOOTER_MARK)).toBe(false);
  });

  it('redacts two adjacent blocks independently, keeping the text between (FR-005)', () => {
    const out = logger.sanitize(ADJACENT_BLOCKS);
    expect(out.includes('firstBodyFiller')).toBe(false);
    expect(out.includes('secondBodyFiller')).toBe(false);
    // Non-greedy: the first block's footer must not swallow through to the second.
    expect(out.includes('ordinary text between the blocks')).toBe(true);
  });

  it('is not fooled by a body line shaped like a marker (SC-009)', () => {
    const out = logger.sanitize(FAKE_MARKER_IN_BODY);
    expect(out.includes(BODY_SENTINEL)).toBe(false);
  });

  it('keeps surrounding prose on both sides of a block (FR-003)', () => {
    const out = logger.sanitize(`before survives\n${PRIVATE_KEY_CASES[0]!.text}\nafter survives`);
    expect(out.includes('before survives')).toBe(true);
    expect(out.includes('after survives')).toBe(true);
    expect(out.includes(BODY_SENTINEL)).toBe(false);
  });
});

describe('public keys are preserved (SC-006)', () => {
  it('passes a PUBLIC KEY block through byte-identical', () => {
    expect(logger.sanitize(PUBLIC_KEY_BLOCK)).toBe(PUBLIC_KEY_BLOCK);
  });

  it('does not treat a PUBLIC KEY header inside a private body as a reason to stop', () => {
    const nested = [
      '-----BEGIN RSA PRIVATE KEY-----',
      '-----BEGIN PUBLIC KEY-----',
      BODY_SENTINEL,
      '-----END RSA PRIVATE KEY-----'
    ].join('\n');
    expect(logger.sanitize(nested).includes(BODY_SENTINEL)).toBe(false);
  });
});

describe('strengthen-only: the pre-change corpus stays redacted (SC-005)', () => {
  /**
   * Enumerated, not sampled. `AGENTS.md` forbids weakening this set, and the only
   * way to know a change did not is to list what it covered before. Each entry is
   * a string the pre-change patterns matched.
   */
  const PRE_CHANGE_CORPUS: ReadonlyArray<readonly [string, string]> = [
    ['RSA header', '-----BEGIN RSA PRIVATE KEY-----'],
    ['DSA header', '-----BEGIN DSA PRIVATE KEY-----'],
    ['EC header', '-----BEGIN EC PRIVATE KEY-----'],
    ['OPENSSH header', '-----BEGIN OPENSSH PRIVATE KEY-----'],
    ['PGP header, legacy spelling', '-----BEGIN PGP PRIVATE KEY-----'],
    ['ENCRYPTED header', '-----BEGIN ENCRYPTED PRIVATE KEY-----'],
    ['GCP service-account envelope', '"private_key": "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n"'],
    ['Bearer token', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'],
    ['api_key assignment', 'api_key="abcdefghijklmnopqrstuvwx"'],
    ['x-api-key header', 'x-api-key: abcdefghijklmnopqrstuvwx']
  ];

  for (const [label, sample] of PRE_CHANGE_CORPUS) {
    it(`still redacts: ${label}`, () => {
      expect(logger.sanitize(sample).includes('[REDACTED]')).toBe(true);
    });
  }
});

describe('line-oriented sinks suppress the whole block (SC-002, SC-003)', () => {
  const lineRedactor = (): KeyBlockLineRedactor =>
    new KeyBlockLineRedactor((s) => logger.sanitize(s));

  for (const testCase of PRIVATE_KEY_CASES) {
    it(`writes no body or footer line: ${testCase.name}`, () => {
      const redactor = lineRedactor();
      const written = testCase.text.split('\n').map((l) => redactor.sanitizeLine(l));
      for (const secret of testCase.mustNotSurvive) {
        expect(written.some((l) => l.includes(secret))).toBe(false);
      }
      // One record per suppressed line, not a gap: the transport aggregate's line
      // counts are the only surviving record of how much the CLI emitted.
      expect(written).toHaveLength(testCase.text.split('\n').length);
    });
  }

  it('resumes ordinary output after the END marker (FR-008)', () => {
    const redactor = lineRedactor();
    const lines = [...PRIVATE_KEY_CASES[0]!.text.split('\n'), 'ordinary output resumes'];
    const written = lines.map((l) => redactor.sanitizeLine(l));
    expect(written[written.length - 1]).toBe('ordinary output resumes');
    expect(redactor.isOpen).toBe(false);
  });

  it('handles a block split across chunk boundaries identically (SC-003)', () => {
    // The marker, body and footer arriving as separate calls is the transport
    // sink's normal case; it must match the unsplit result.
    const redactor = lineRedactor();
    const written = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'chunkedBodyFiller',
      BODY_SENTINEL,
      '-----END OPENSSH PRIVATE KEY-----'
    ].map((l) => redactor.sanitizeLine(l));
    expect(written.some((l) => l.includes(BODY_SENTINEL))).toBe(false);
    expect(written.some((l) => l.includes('chunkedBodyFiller'))).toBe(false);
  });

  it('keeps two streams independent (FR-007)', () => {
    const stdout = lineRedactor();
    const stderr = lineRedactor();
    stdout.sanitizeLine('-----BEGIN RSA PRIVATE KEY-----');
    // stdout is mid-key; stderr must be unaffected.
    expect(stderr.sanitizeLine('ordinary stderr line')).toBe('ordinary stderr line');
    expect(stdout.sanitizeLine(BODY_SENTINEL).includes(BODY_SENTINEL)).toBe(false);
    expect(stderr.isOpen).toBe(false);
  });

  it('redacts a whole block delivered on one line without opening (FR-009)', () => {
    const redactor = lineRedactor();
    const out = redactor.sanitizeLine(SINGLE_LINE_BLOCK);
    expect(out.includes(BODY_SENTINEL)).toBe(false);
    expect(redactor.isOpen).toBe(false);
  });
});

describe('the line redactor is bounded and conservative (SC-004)', () => {
  const lineRedactor = (): KeyBlockLineRedactor =>
    new KeyBlockLineRedactor((s) => logger.sanitize(s));

  it('releases nothing when a block never closes (FR-011)', () => {
    const redactor = lineRedactor();
    const written = UNTERMINATED_CASE.text.split('\n').map((l) => redactor.sanitizeLine(l));
    for (const secret of UNTERMINATED_CASE.mustNotSurvive) {
      expect(written.some((l) => l.includes(secret))).toBe(false);
    }
    // Still open at "stream end". Nothing was buffered, so there is nothing to
    // release -- which is the point of holding no lines.
    expect(redactor.isOpen).toBe(true);
  });

  it('keeps redacting past the line cap rather than resuming (FR-013)', () => {
    const redactor = lineRedactor();
    redactor.sanitizeLine('-----BEGIN RSA PRIVATE KEY-----');
    let leaked = 0;
    for (let i = 0; i < MAX_KEY_BLOCK_LINES + 50; i += 1) {
      if (redactor.sanitizeLine(`body-${i}-${BODY_SENTINEL}`).includes(BODY_SENTINEL)) leaked += 1;
    }
    expect(leaked).toBe(0);
    expect(redactor.isOpen).toBe(true);
  });

  it('does not nest on a second BEGIN (FR-014)', () => {
    const redactor = lineRedactor();
    redactor.sanitizeLine('-----BEGIN RSA PRIVATE KEY-----');
    redactor.sanitizeLine('-----BEGIN EC PRIVATE KEY-----');
    // One END closes it: the state is a single open block, not a stack.
    redactor.sanitizeLine('-----END RSA PRIVATE KEY-----');
    expect(redactor.isOpen).toBe(false);
  });

  it('is not closed by a body line that merely resembles a marker (SC-009)', () => {
    const redactor = lineRedactor();
    const written = FAKE_MARKER_IN_BODY.split('\n').map((l) => redactor.sanitizeLine(l));
    expect(written.some((l) => l.includes(BODY_SENTINEL))).toBe(false);
    expect(redactor.isOpen).toBe(false);
  });

  it('does not stop suppressing on a PUBLIC KEY header inside a private body', () => {
    const redactor = lineRedactor();
    redactor.sanitizeLine('-----BEGIN RSA PRIVATE KEY-----');
    redactor.sanitizeLine('-----BEGIN PUBLIC KEY-----');
    expect(redactor.isOpen).toBe(true);
    expect(redactor.sanitizeLine(BODY_SENTINEL).includes(BODY_SENTINEL)).toBe(false);
  });
});
