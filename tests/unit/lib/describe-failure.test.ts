// FR-R4-F05 (T10; contract F, F2, F5; data-model §3; FR-011, FR-012) — `describeFailure`
// turns anything that was thrown into one bounded, sanitized line for a log context.
//
// WHAT IT MUST NEVER DO. Throw (it runs inside a catch block that cannot itself throw),
// return an empty string (a log field that says nothing is worse than one that says
// "unreadable"), include a stack, or cut a secret in half. The last is why the order
// matters: sanitize first, then bound. A credential that straddles character 512 is
// redacted whole; bound first and the cut leaves a prefix the redaction pattern, which
// wants a minimum length, no longer recognises, and the prefix ships.

import { describe, expect, it } from 'vitest';
import {
  FAILURE_DETAIL_MAX_CHARS,
  describeFailure
} from '../../../src/lib/errors';
import { SanitizedLogger } from '../../../src/lib/logger';

const sanitizer = new SanitizedLogger();
const sanitize = (value: string): string => sanitizer.sanitize(value);

const PATH = '/synthetic/home/user-252/secret.txt';
// Built at runtime so no credential-shaped literal sits in the source.
const TOKEN_BODY = 'abcdefghijklmnopqrstuvwxyz0123456789';
const CREDENTIAL = ['Bearer', TOKEN_BODY].join(' ');
const TRUNCATION_SUFFIX = '… [truncated]';

const throwingMessage = Object.defineProperty(new Error('placeholder'), 'message', {
  configurable: true,
  get(): string {
    throw new Error('message getter exploded');
  }
}) as Error;

const THROWN: ReadonlyArray<readonly [string, unknown]> = [
  ['an Error with a path', new Error(`failed at ${PATH}`)],
  ['an Error with a credential', new Error(`boom: ${CREDENTIAL}`)],
  ['an Error with control characters', new Error(`a${String.fromCharCode(0, 7, 27)}b`)],
  ['an Error with 1 MiB of text', new Error('A'.repeat(1024 * 1024))],
  ['a string', `thrown ${PATH}`],
  ['an empty string', ''],
  ['an object with no message', { code: 'E_SYNTHETIC' }],
  ['an object with a null prototype', Object.create(null) as unknown],
  ['a number', 42],
  ['a symbol', Symbol('synthetic')],
  ['null', null],
  ['undefined', undefined],
  ['an Error whose message getter throws', throwingMessage]
];

describe('describeFailure (T10)', () => {
  it('bounds at 512 characters', () => {
    expect(FAILURE_DETAIL_MAX_CHARS).toBe(512);
  });

  it.each(THROWN)('never throws, is never empty and stays within the bound, for %s', (_label, thrown) => {
    let detail = '';
    expect(() => {
      detail = describeFailure(thrown, sanitize);
    }).not.toThrow();

    expect(detail.length).toBeGreaterThan(0);
    expect(detail.length).toBeLessThanOrEqual(FAILURE_DETAIL_MAX_CHARS);
  });

  it('ends a long detail with the truncation marker, inside the bound', () => {
    const detail = describeFailure(new Error('A'.repeat(5_000)), sanitize);

    expect(detail).toHaveLength(FAILURE_DETAIL_MAX_CHARS);
    expect(detail.endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });

  it('leaves a detail that fits unmarked', () => {
    expect(describeFailure(new Error('short message'), sanitize)).toBe('short message');
  });

  it('sanitizes before bounding: a credential that straddles the bound is redacted whole', () => {
    // 480 characters of filler, then the credential, so the token starts before the
    // bound and ends after it in the raw text, while the redacted line fits inside it.
    const filler = 'x'.repeat(480);
    const raw = `${filler} ${CREDENTIAL} tail`;
    expect(filler.length).toBeLessThan(FAILURE_DETAIL_MAX_CHARS);
    expect(filler.length + 1 + CREDENTIAL.length).toBeGreaterThan(FAILURE_DETAIL_MAX_CHARS);
    const detail = describeFailure(new Error(raw), sanitize);

    expect(detail).toContain('[REDACTED]');
    // No prefix of the token body survives: a bound-then-sanitize order leaves
    // the first ten characters behind.
    expect(detail).not.toContain(TOKEN_BODY.slice(0, 10));
  });

  it('gives a throwing message getter a fixed description', () => {
    expect(describeFailure(throwingMessage, sanitize)).toBe('unreadable thrown value');
  });

  it('survives a sanitizer that throws or returns nothing', () => {
    const throwing = (): string => {
      throw new Error('sanitizer exploded');
    };

    expect(describeFailure(new Error('boom'), throwing)).toBe('unreadable thrown value');
    expect(describeFailure(new Error('boom'), () => '')).toBe('unreadable thrown value');
  });

  it('includes no stack and no payload', () => {
    const error = new Error('boom');
    error.stack = 'Error: boom\n    at synthetic (/synthetic/home/user-252/file.ts:1:1)';

    const detail = describeFailure(error, sanitize);

    expect(detail).toBe('boom');
    expect(detail).not.toContain('user-252');
    expect(detail).not.toMatch(/\n\s+at /);
  });
});
