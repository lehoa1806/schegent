// FR-R4-F02 (spec 240, US5; contract L1, L2; FR-012, FR-013) — a rate limit is a genuine record, or
// a qualified diagnostic, and nothing that merely contains the words.
//
// At `5d700407` the stdout scan tested `line.includes('rate_limit_event')` and `out_of_credits`
// on the trailing window, so a `tool_result` that QUOTED the event name classified a completed
// turn as rate limited, and the first stderr matcher accepted any `429`, so `took 429 ms` did too.
// This file pins the replacement: stdout counts only a line that parses as a top-level
// `rate_limit_event` record whose `rate_limit_info.status` is `rejected`, whatever the JSON
// spacing; stderr counts only qualified forms, and only on lines `isDiagnosticLine()` accepts
// (hard rule 17).
//
// The matrix (`rate-limit-pinning-matrix.test.ts`) pins what existing inputs did; this file is the
// new behaviour.
import { describe, expect, it } from 'vitest';
import { detectCreditError } from '../../../src/parser/credit-error-detector';
import { ZippedStreamBuffer } from '../../../src/runner/zipped-stream-buffer';
import { MAX_DIAGNOSTIC_LINE_LENGTH } from '../../../src/lib/fatal-signature-registry';

const NO_MATCH = { matched: false, cause: '' } as const;
const RATE_LIMIT = { matched: true, cause: 'rate-limit' } as const;
const OUT_OF_CREDITS = { matched: true, cause: 'out-of-credits' } as const;

const REJECTED = '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1779520200}}';

function recordWithStatus(status: string | null): string {
  const info = status === null ? '{"resetsAt":1779520200}' : `{"status":"${status}","resetsAt":1779520200}`;
  return `{"type":"rate_limit_event","rate_limit_info":${info}}`;
}

function bufferOf(text: string): ZippedStreamBuffer {
  const buffer = new ZippedStreamBuffer();
  buffer.append(text);
  buffer.finalize();
  return buffer;
}

describe('stdout — a quoted event name is not a rate limit (US5-1)', () => {
  it('a tool_result quoting the event and the rejected status, exit 143, is not matched', () => {
    const toolResult = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: 'the log read {"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}'
          }
        ]
      }
    });
    expect(toolResult).toContain('rate_limit_event');
    expect(detectCreditError(toolResult, '', 143)).toEqual(NO_MATCH);
  });

  it('prose that quotes the type and the status on one line is not matched', () => {
    const prose = 'a note: "type":"rate_limit_event" with "status":"rejected" in the transcript';
    expect(detectCreditError(prose, '', 143)).toEqual(NO_MATCH);
  });

  it('the event nested under another top-level key is not matched', () => {
    const nested = `{"type":"assistant","event":${REJECTED}}`;
    expect(detectCreditError(nested, '', 1)).toEqual(NO_MATCH);
  });

  it('a record whose own type is something else is not matched, whatever it carries', () => {
    const other = '{"type":"result","rate_limit_info":{"status":"rejected"}}';
    expect(detectCreditError(other, '', 1)).toEqual(NO_MATCH);
  });

  it('a bare out_of_credits or event-name substring is not a record', () => {
    expect(detectCreditError('...out_of_credits...', '', 1)).toEqual(NO_MATCH);
    expect(detectCreditError('rate_limit_event', '', 1)).toEqual(NO_MATCH);
  });
});

describe('stdout — incidental 429 is not a rate limit (US5-2)', () => {
  it('429 in stdout text is not matched', () => {
    expect(detectCreditError('processed 429 files\nid 4290 ok\n', '', 1)).toEqual(NO_MATCH);
  });

  it.each(['took 429 ms to respond', 'request id 4290 finished', 'wrote 1429 bytes', 'pid=429'])(
    'stderr line "%s" is not matched',
    (line) => {
      expect(detectCreditError('', line, 1)).toEqual(NO_MATCH);
    }
  );

  it('the exit-code 429 path is kept', () => {
    expect(detectCreditError('', '', 429)).toEqual(RATE_LIMIT);
  });
});

describe('stdout — a genuine rejected record is matched in any spacing (US5-3)', () => {
  it.each([
    ['compact', '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}'],
    ['spaced', '{ "type": "rate_limit_event", "rate_limit_info": { "status": "rejected" } }'],
    ['reordered keys', '{"rate_limit_info":{"status":"rejected"},"type":"rate_limit_event"}'],
    ['with a reset epoch', REJECTED],
    ['after leading whitespace', `   ${REJECTED}`]
  ])('%s: rate-limit', (_name, line) => {
    expect(detectCreditError(line, '', 143)).toEqual(RATE_LIMIT);
  });

  it('a string property of rate_limit_info equal to out_of_credits names the cause out-of-credits', () => {
    const line =
      '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","overageDisabledReason":"out_of_credits"}}';
    expect(detectCreditError(line, '', 1)).toEqual(OUT_OF_CREDITS);
  });

  it('out_of_credits anywhere but a string property of rate_limit_info does not change the cause', () => {
    const nestedObject =
      '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","detail":{"reason":"out_of_credits"}}}';
    const otherKey =
      '{"type":"rate_limit_event","note":"out_of_credits","rate_limit_info":{"status":"rejected"}}';
    expect(detectCreditError(nestedObject, '', 1)).toEqual(RATE_LIMIT);
    expect(detectCreditError(otherKey, '', 1)).toEqual(RATE_LIMIT);
  });

  it('the most recent record decides when several appear', () => {
    const older = '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","overageDisabledReason":"out_of_credits"}}';
    const newer = REJECTED;
    expect(detectCreditError([older, '{"type":"assistant"}', newer].join('\n'), '', 1)).toEqual(RATE_LIMIT);
    expect(detectCreditError([newer, '{"type":"assistant"}', older].join('\n'), '', 1)).toEqual(OUT_OF_CREDITS);
  });

  it('keeps the 20-line trailing window and its newest-first order', () => {
    const inside = `${'{"type":"assistant"}\n'.repeat(19)}${REJECTED}`;
    const outside = `${REJECTED}\n${'{"type":"assistant"}\n'.repeat(25)}`;
    expect(detectCreditError(inside, '', 1)).toEqual(RATE_LIMIT);
    expect(detectCreditError(outside, '', 1)).toEqual(NO_MATCH);
  });

  it('a blocking record beneath a later allowed event is still found', () => {
    const stdout = [REJECTED, recordWithStatus('allowed')].join('\n');
    expect(detectCreditError(stdout, '', 1)).toEqual(RATE_LIMIT);
  });
});

describe('stdout — nonblocking statuses and exit zero (US5-4)', () => {
  it.each([
    ['allowed', 'allowed'],
    ['allowed_warning', 'allowed_warning'],
    ['the allow alias', 'allow'],
    ['an unknown status', 'throttled'],
    ['an empty status', '']
  ])('%s is not matched', (_name, status) => {
    expect(detectCreditError(recordWithStatus(status), '', 1)).toEqual(NO_MATCH);
  });

  it('an absent status is not matched', () => {
    expect(detectCreditError(recordWithStatus(null), '', 1)).toEqual(NO_MATCH);
  });

  it('an allowed event naming out_of_credits is not out-of-credits, in any spacing', () => {
    const compact =
      '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","overageDisabledReason":"out_of_credits"}}';
    const spaced =
      '{"type":"rate_limit_event","rate_limit_info":{"status": "allowed", "overageDisabledReason": "out_of_credits"}}';
    expect(detectCreditError(compact, '', 1)).toEqual(NO_MATCH);
    expect(detectCreditError(spaced, '', 1)).toEqual(NO_MATCH);
  });

  it('a genuine rejected record is never a rate limit at exit zero', () => {
    expect(detectCreditError(REJECTED, '', 0)).toEqual(NO_MATCH);
    expect(detectCreditError('', 'rate limit exceeded', 0)).toEqual(NO_MATCH);
  });
});

describe('stdout — a very long line is not read (L1 G1)', () => {
  it('a genuine record over RATE_LIMIT_RECORD_MAX_CHARS is not matched, and the same record under it is', () => {
    const padFor = (total: number): string => {
      const base = '{"type":"rate_limit_event","pad":"","rate_limit_info":{"status":"rejected"}}';
      return base.replace('"pad":""', `"pad":"${'x'.repeat(total - base.length)}"`);
    };
    const over = padFor(65_537);
    const atTheLimit = padFor(65_536);
    expect(over.length).toBe(65_537);
    expect(atTheLimit.length).toBe(65_536);
    expect(detectCreditError(over, '', 1)).toEqual(NO_MATCH);
    expect(detectCreditError(atTheLimit, '', 1)).toEqual(RATE_LIMIT);
  });
});

// Contract L2 G6. Each qualified form, on a line `isDiagnosticLine()` accepts, matches; the same
// text opening a structured envelope, or past the diagnostic length, does not (G5).
const QUALIFIED_FORMS: ReadonlyArray<readonly [string, string]> = [
  ['an HTTP status line', 'HTTP/1.1 429 Slow Down'],
  ['an HTTP/2 status line', 'HTTP/2 429'],
  ['status colon 429', 'request failed, status: 429'],
  ['code equals 429', 'error code=429 from upstream'],
  ['status space 429', 'upstream status 429'],
  ['429 beside "too many requests"', 'Error 429: too many requests'],
  ['429 beside "rate limit"', '429 rate limit hit for this key'],
  ['a rate-limit error name', 'Error: rate_limit_error: slow down'],
  ['"rate limit exceeded"', 'API Error: rate limit exceeded'],
  ['"rate limited"', 'you have been rate limited'],
  ['"rate limit reached"', 'rate limit reached, retry later'],
  ['"too many requests"', 'Too Many Requests']
];

describe('stderr — qualified forms on diagnostic lines (US5-2; G5, G6)', () => {
  it.each(QUALIFIED_FORMS)('%s on a diagnostic line is matched as rate-limit', (_name, line) => {
    expect(detectCreditError('', line, 1)).toEqual(RATE_LIMIT);
  });

  it.each(QUALIFIED_FORMS)('%s opening a structured envelope is not matched', (_name, line) => {
    expect(detectCreditError('', `{"message":"${line}"}`, 1)).toEqual(NO_MATCH);
    expect(detectCreditError('', `[${JSON.stringify(line)}]`, 1)).toEqual(NO_MATCH);
  });

  it('a qualified form on a line past the diagnostic length is not matched', () => {
    const long = `${'padding '.repeat(Math.ceil(MAX_DIAGNOSTIC_LINE_LENGTH / 8))}HTTP/1.1 429`;
    expect(long.length).toBeGreaterThan(MAX_DIAGNOSTIC_LINE_LENGTH);
    expect(detectCreditError('', long, 1)).toEqual(NO_MATCH);
  });

  it('the other matchers keep their patterns, on diagnostic lines', () => {
    expect(detectCreditError('', "You're out of extra usage", 1)).toEqual({
      matched: true,
      cause: 'out-of-usage'
    });
    expect(detectCreditError('', 'credits exhausted, please top up', 1).cause).toBe('credits-exhausted');
    expect(detectCreditError('', 'your monthly quota exceeded', 1).cause).toBe('quota-exceeded');
    expect(detectCreditError('', "You've hit your session limit · resets 6:50am", 1).cause).toBe('session-limit');
    expect(detectCreditError('', '{"detail":"session limit"}', 1)).toEqual(NO_MATCH);
  });

  it('is tested per line: a diagnostic line is found among quoted ones', () => {
    const stderr = ['{"note":"took 429 ms"}', 'HTTP/1.1 429', '[1,2,3]'].join('\n');
    expect(detectCreditError('', stderr, 1)).toEqual(RATE_LIMIT);
  });

  it('keeps the 50-line tail of a buffer', () => {
    const inside = `${'noise line\n'.repeat(49)}HTTP/1.1 429\n`;
    const outside = `HTTP/1.1 429\n${'noise line\n'.repeat(60)}`;
    expect(detectCreditError('', bufferOf(inside), 1)).toEqual(RATE_LIMIT);
    expect(detectCreditError('', bufferOf(outside), 1)).toEqual(NO_MATCH);
  });

  it('stderr still wins over stdout when both match', () => {
    expect(detectCreditError(OUT_OF_CREDITS_LINE(), 'HTTP/1.1 429', 1)).toEqual(RATE_LIMIT);
  });
});

function OUT_OF_CREDITS_LINE(): string {
  return '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","overageDisabledReason":"out_of_credits"}}';
}
