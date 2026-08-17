import { describe, expect, it } from 'vitest';

import {
  IncrementalFatalScanner,
  combineStreamScans
} from '../../../src/lib/incremental-fatal-scanner';
import {
  classifyFatal,
  getEffectiveSignatures,
  MAX_DIAGNOSTIC_LINE_LENGTH,
  type FatalStream
} from '../../../src/lib/fatal-signature-registry';

/**
 * The scanner exists to answer the same question as `classifyFatal` without
 * depending on retention, so every test here is either an equivalence check
 * against it or a check of the one thing it can do that `classifyFatal`
 * cannot: see bytes that retention discarded.
 */

const BUILT_INS = getEffectiveSignatures([]);

// BUILT_INS[0] (`error: unknown option`) is stderr-scoped and BUILT_INS[1]
// (`Autocompact is thrashing`) carries both streams, so the default stream
// here is stderr — the one on which every built-in can match.
function scan(
  chunks: readonly string[],
  list = BUILT_INS,
  stream: FatalStream = 'stderr'
): IncrementalFatalScanner {
  const scanner = new IncrementalFatalScanner(stream, list);
  for (const chunk of chunks) scanner.append(chunk);
  scanner.finalize();
  return scanner;
}

function empty(list = BUILT_INS, stream: FatalStream = 'stderr'): IncrementalFatalScanner {
  return new IncrementalFatalScanner(stream, list);
}

describe('IncrementalFatalScanner', () => {
  it('reports no match on a stream with no signature', () => {
    expect(scan(['all good\n', 'still fine\n']).matchedIndex).toBeNull();
  });

  it('matches a signature contained in a single chunk', () => {
    const scanner = scan(['before\n', 'error: unknown option --nope\n', 'after\n']);
    expect(scanner.matchedSignature?.pattern).toBe('error: unknown option');
  });

  it('matches a signature split across a chunk boundary', () => {
    // The whole point of the carry. Split at every interior offset so the
    // test fails for any carry length shorter than `longest - 1`.
    const signature = 'error: unknown option';
    for (let cut = 1; cut < signature.length; cut += 1) {
      const scanner = scan(['noise ' + signature.slice(0, cut), signature.slice(cut) + ' tail']);
      expect(scanner.matchedSignature?.pattern).toBe(signature);
    }
  });

  it('matches a signature split one character at a time', () => {
    const scanner = scan([...'padding error: unknown option padding']);
    expect(scanner.matchedSignature?.pattern).toBe('error: unknown option');
  });

  it('ignores empty chunks', () => {
    const scanner = scan(['error: unknown', '', ' option']);
    expect(scanner.matchedSignature?.pattern).toBe('error: unknown option');
  });

  it('keeps the lowest registry index regardless of arrival order', () => {
    // `classifyFatal` returns the lowest-index entry that matches ANYWHERE,
    // not the earliest match in the text, so a later-arriving lower-index
    // signature must displace an earlier higher-index one.
    const [first, second] = BUILT_INS;
    const lateLow = scan([`${second.pattern}\n`, `${first.pattern}\n`]);
    const earlyLow = scan([`${first.pattern}\n`, `${second.pattern}\n`]);
    expect(lateLow.matchedSignature?.pattern).toBe(first.pattern);
    expect(earlyLow.matchedSignature?.pattern).toBe(first.pattern);
  });

  it('scans operator-additive entries after the code-resident floor', () => {
    const list = getEffectiveSignatures(['operator-only-signature']);
    const scanner = scan(['noise operator-only-signature noise'], list);
    expect(scanner.matchedSignature?.pattern).toBe('operator-only-signature');
    expect(scanner.matchedSignature?.source).toBe('operator-defined');
  });

  it('prefers the built-in floor over an operator entry that also matches', () => {
    const list = getEffectiveSignatures(['operator-only-signature']);
    const scanner = scan([`operator-only-signature ${BUILT_INS[0].pattern}`], list);
    expect(scanner.matchedSignature?.source).toBe('built-in');
  });
});

describe('combineStreamScans', () => {
  it('reports no match when neither stream matched', () => {
    expect(combineStreamScans(empty(), empty())).toEqual({ matched: false });
  });

  it('reports the stream that matched', () => {
    const stderrOnly = combineStreamScans(empty(), scan([BUILT_INS[0].pattern]));
    expect(stderrOnly).toMatchObject({ matched: true, stream: 'stderr' });
  });

  it('resolves a tie to stdout, as classifyFatal checks it first', () => {
    // BUILT_INS[1] carries both streams, so a stdout scanner can match it.
    const combined = combineStreamScans(
      scan([BUILT_INS[1].pattern], BUILT_INS, 'stdout'),
      scan([BUILT_INS[1].pattern])
    );
    expect(combined).toMatchObject({ matched: true, stream: 'stdout' });
  });

  it('prefers a lower registry index in stderr over a higher one in stdout', () => {
    const combined = combineStreamScans(
      scan([BUILT_INS[1].pattern], BUILT_INS, 'stdout'),
      scan([BUILT_INS[0].pattern])
    );
    expect(combined).toMatchObject({
      matched: true,
      stream: 'stderr',
      signature: BUILT_INS[0].pattern
    });
  });
});

describe('equivalence with classifyFatal', () => {
  const cases: ReadonlyArray<{ name: string; stdout: string; stderr: string }> = [
    { name: 'neither stream matches', stdout: 'fine', stderr: 'fine' },
    { name: 'stdout only', stdout: `x ${BUILT_INS[0].pattern} y`, stderr: 'fine' },
    { name: 'stderr only', stdout: 'fine', stderr: `x ${BUILT_INS[0].pattern} y` },
    {
      name: 'both streams, same entry',
      stdout: BUILT_INS[0].pattern,
      stderr: BUILT_INS[0].pattern
    },
    {
      name: 'lower index in stderr',
      stdout: BUILT_INS[1].pattern,
      stderr: BUILT_INS[0].pattern
    },
    {
      name: 'lower index in stdout',
      stdout: BUILT_INS[0].pattern,
      stderr: BUILT_INS[1].pattern
    }
  ];

  it.each(cases)('agrees with classifyFatal when $name', ({ stdout, stderr }) => {
    // Chunked one character at a time so agreement cannot come from the
    // scanner happening to see each stream whole.
    const combined = combineStreamScans(
      scan([...stdout], BUILT_INS, 'stdout'),
      scan([...stderr])
    );
    expect(combined).toEqual(classifyFatal(stdout, stderr, BUILT_INS));
  });
});

describe('a transported payload cannot arm a signature (2026-08-16)', () => {
  // The incident: `speckit-implement` read ARCHITECTURE.md, which documents
  // this registry and quotes a pattern verbatim. The file came back on
  // stdout inside a stream-json `tool_result`; the byte scan matched it and
  // failed the phase at 3.6 hours with exit code 0.
  const QUOTED = BUILT_INS[0].pattern;
  const ENVELOPE =
    `{"type":"user","message":{"content":[{"type":"tool_result","content":` +
    `"1156\\tThe v1 registry is a frozen array (\`\\"${QUOTED}\\"\`).\\n"}]}}\n`;

  it('does not match a signature quoted inside a stream-json envelope', () => {
    expect(scan([ENVELOPE], BUILT_INS, 'stdout').matchedIndex).toBeNull();
    expect(scan([ENVELOPE]).matchedIndex).toBeNull();
  });

  it('does not match one split across chunk boundaries inside an envelope', () => {
    expect(scan([...ENVELOPE], BUILT_INS, 'stdout').matchedIndex).toBeNull();
  });

  it('classifyFatal agrees — the two oracles share the line rule', () => {
    expect(classifyFatal(ENVELOPE, '', BUILT_INS)).toEqual({ matched: false });
  });

  it('still matches the same text as a bare diagnostic line', () => {
    const scanner = scan([`${QUOTED} '--nope'\n`]);
    expect(scanner.matchedSignature?.pattern).toBe(QUOTED);
  });

  it('does not match inside a line past the diagnostic length cap', () => {
    const padded = `${'x'.repeat(MAX_DIAGNOSTIC_LINE_LENGTH)} ${QUOTED}\n`;
    expect(scan([padded]).matchedIndex).toBeNull();
    // Chunked, so the cap is enforced as the line grows rather than at once.
    expect(scan([...padded]).matchedIndex).toBeNull();
  });

  it('recovers on the next line after an oversized one', () => {
    const scanner = scan([`${'x'.repeat(MAX_DIAGNOSTIC_LINE_LENGTH + 1)}\n`, `${QUOTED}\n`]);
    expect(scanner.matchedSignature?.pattern).toBe(QUOTED);
  });
});

describe('per-signature stream scope', () => {
  it('does not match a stderr-scoped signature on stdout', () => {
    const bare = `${BUILT_INS[0].pattern} '--nope'\n`;
    expect(scan([bare], BUILT_INS, 'stdout').matchedIndex).toBeNull();
    expect(scan([bare]).matchedIndex).toBe(0);
  });

  it('matches a both-streams signature on either stream', () => {
    const bare = `${BUILT_INS[1].pattern}\n`;
    expect(scan([bare], BUILT_INS, 'stdout').matchedIndex).toBe(1);
    expect(scan([bare]).matchedIndex).toBe(1);
  });

  it('scans operator additions on both streams, as they declare no scope', () => {
    const list = getEffectiveSignatures(['operator-only-signature']);
    const bare = 'operator-only-signature\n';
    expect(scan([bare], list, 'stdout').matchedSignature?.source).toBe('operator-defined');
    expect(scan([bare], list).matchedSignature?.source).toBe('operator-defined');
  });
});
