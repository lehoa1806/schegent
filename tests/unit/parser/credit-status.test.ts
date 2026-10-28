// FR-R4-F02 (spec 240, US6; contract W1, W2; FR-017 to FR-019; SC-006) — a `/status` poll resumes
// unattended Runs only on positive evidence.
//
// The table is contract W2's, row by row, and every fixture is synthetic: the forms are a starting
// grammar written without a real capture (observation Q1 replaces or confirms them). Before this
// classifier, an any-substring test read six of the exit-zero rows below as healthy (measurements.md,
// US6): the three negated phrases, the two quoted or structured ones, and the positive form that sat
// beside a rate-limit line.
import { describe, expect, it } from 'vitest';
import {
  CREDIT_STATUS_MAX_LINES,
  CREDIT_STATUS_MAX_LINE_CHARS,
  classifyCreditStatus,
  type CreditStatus
} from '../../../src/parser/credit-status';
import { ZippedStreamBuffer } from '../../../src/runner/zipped-stream-buffer';

const exited = (stdout: string, exitCode: number | null = 0, flags: { killed?: boolean; timedOut?: boolean } = {}) => ({
  exitCode,
  killed: flags.killed ?? false,
  timedOut: flags.timedOut ?? false,
  stdout
});

const TOOL_RESULT_LINE =
  '{"type":"user","message":{"content":[{"type":"tool_result","content":"Status: OK"}]}}';

describe('contract W2 — the exit-zero rows', () => {
  const ROWS: ReadonlyArray<readonly [string, string, CreditStatus]> = [
    ['negated: Status: not ready', 'Status: not ready', 'not-recovered'],
    ['negated: Credits not available', 'Credits not available', 'not-recovered'],
    ['negated: Quota has not reset', 'Quota has not reset', 'not-recovered'],
    ['quoted inside a JSON tool_result line', TOOL_RESULT_LINE, 'not-recovered'],
    ['a structured status object', '{"status":"ok"}', 'not-recovered'],
    ['the positive form', 'Credits: available', 'recovered'],
    ['the positive form beside a rate-limit line', 'Credits: available\nRate limit reached', 'not-recovered'],
    ['the positive form after a rate-limit line', 'Rate limit reached\nCredits: available', 'not-recovered'],
    ['empty output', '', 'not-recovered']
  ];

  it.each(ROWS)('%s', (_name, stdout, expected) => {
    expect(classifyCreditStatus(exited(stdout))).toBe(expected);
  });
});

describe('contract W1 G1 — an unreachable poll is never read for text', () => {
  const POSITIVE = 'Credits: available';

  it.each([
    ['a nonzero exit', exited(POSITIVE, 1)],
    ['a missing exit code', exited(POSITIVE, null)],
    ['a kill', exited(POSITIVE, 0, { killed: true })],
    ['a timeout', exited(POSITIVE, 0, { timedOut: true })],
    ['a thrown invocation', { thrown: true as const }]
  ])('%s is unreachable even when the text is positive', (_name, input) => {
    expect(classifyCreditStatus(input)).toBe('unreachable');
  });
});

describe('contract W2 — the positive forms', () => {
  it.each([
    'Credits: available',
    'credits: Available.',
    'Quota: restored',
    'Status:ok',
    'STATUS : HEALTHY',
    'Account status: ready',
    'account status : active.',
    '   Credits: available   '
  ])('%j is recovered', (line) => {
    expect(classifyCreditStatus(exited(line))).toBe('recovered');
  });

  it.each([
    'Your credits are available',
    'Credits: available now',
    'Credits available',
    'Plan: available',
    'Credits: unavailable',
    'Credits: availability unknown'
  ])('%j is not evidence', (line) => {
    expect(classifyCreditStatus(exited(line))).toBe('not-recovered');
  });

  it('a positive line among unrelated output is enough', () => {
    expect(classifyCreditStatus(exited('Model: sonnet\nSession: 12\nCredits: available\nTokens: 0'))).toBe('recovered');
  });
});

describe('contract W2 — the negative words are whole words, case-insensitively', () => {
  it.each([
    'Credits: available. Wait',
    'CREDITS: AVAILABLE\nLIMITED',
    'Credits: available\nretry later',
    'Credits: available\nNo issues',
    'Credits: available\nuntil 12:00',
    'Credits: available\nbudget exceeded',
    'Credits: available\nquota depleted',
    'Credits: available\nnone left'
  ])('%j is not-recovered', (text) => {
    expect(classifyCreditStatus(exited(text))).toBe('not-recovered');
  });

  it('a word that merely contains a negative word does not count', () => {
    expect(classifyCreditStatus(exited('Credits: available\nNotation: standard\nNorth region'))).toBe('recovered');
  });
});

describe('contract W2 step 1 — the bounds', () => {
  it('reads at most 50 lines: a negative 51st line is ignored', () => {
    const padding = Array.from({ length: CREDIT_STATUS_MAX_LINES - 1 }, (_unused, index) => `line ${index}`);
    const text = ['Credits: available', ...padding, 'Rate limit reached'].join('\n');
    expect(text.split('\n')).toHaveLength(CREDIT_STATUS_MAX_LINES + 1);
    expect(classifyCreditStatus(exited(text))).toBe('recovered');
  });

  it('control: the same negative line inside the first 50 lines is read', () => {
    const padding = Array.from({ length: CREDIT_STATUS_MAX_LINES - 2 }, (_unused, index) => `line ${index}`);
    const text = ['Credits: available', ...padding, 'Rate limit reached'].join('\n');
    expect(text.split('\n')).toHaveLength(CREDIT_STATUS_MAX_LINES);
    expect(classifyCreditStatus(exited(text))).toBe('not-recovered');
  });

  it('skips a line longer than 200 characters whole instead of truncating it', () => {
    const long = `Credits: available${' '.repeat(CREDIT_STATUS_MAX_LINE_CHARS)}`;
    expect(long.length).toBeGreaterThan(CREDIT_STATUS_MAX_LINE_CHARS);
    // Truncated to 200 and trimmed, this would read as the positive form; skipped, it is nothing.
    expect(classifyCreditStatus(exited(long))).toBe('not-recovered');
  });

  it('skips a long NEGATIVE line the same way, so it cannot veto a short positive one', () => {
    const long = `Rate limit reached ${'x'.repeat(CREDIT_STATUS_MAX_LINE_CHARS)}`;
    expect(classifyCreditStatus(exited(`${long}\nCredits: available`))).toBe('recovered');
  });

  it('a line of exactly 200 characters is considered', () => {
    const exact = `Credits: available${' '.repeat(CREDIT_STATUS_MAX_LINE_CHARS - 'Credits: available'.length)}`;
    expect(exact).toHaveLength(CREDIT_STATUS_MAX_LINE_CHARS);
    expect(classifyCreditStatus(exited(exact))).toBe('recovered');
  });
});

describe('contract W2 step 2 — quoted and structured lines are never evidence', () => {
  it.each(['{"status":"ok"}', '["Credits: available"]', '"Credits: available"', "'Credits: available'", '`Credits: available`'])(
    '%s alone is not-recovered',
    (line) => {
      expect(classifyCreditStatus(exited(line))).toBe('not-recovered');
    }
  );

  it('a structured line that holds a negative word does not veto a real positive line', () => {
    expect(classifyCreditStatus(exited('{"note":"no limit"}\nCredits: available'))).toBe('recovered');
  });
});

describe('the stdout the grammar reads', () => {
  it('reads the model text of a stream-json transcript, not its envelope', () => {
    const transcript = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Credits: available"}]}}'
    ].join('\n');
    expect(classifyCreditStatus(exited(transcript))).toBe('recovered');
  });

  it('reads a ZippedStreamBuffer the way it reads a string', () => {
    const buffer = new ZippedStreamBuffer();
    buffer.append('Credits: available');
    buffer.finalize();
    expect(classifyCreditStatus({ exitCode: 0, killed: false, timedOut: false, stdout: buffer })).toBe('recovered');
  });

  it('never returns text: the answer is one of three fixed strings', () => {
    const answers = new Set<string>(
      ['Credits: available', 'Status: not ready', '', TOOL_RESULT_LINE].map((text) => classifyCreditStatus(exited(text)))
    );
    for (const answer of answers) expect(['recovered', 'not-recovered', 'unreachable']).toContain(answer);
  });
});
