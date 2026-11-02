import { describe, expect, it } from 'vitest';
import { REDACTION_SENTINEL, SECRET_KEY_NAME_WORDS, SanitizedLogger, isSecretKeyName } from '../../../src/lib/logger';

/**
 * FR-R4-F10 (contract test T8; RD1, RD4; R10; FR-022, FR-025) -- the structured walker sees a
 * key, and a string leaf under a key that names a secret is removed.
 *
 * WHY THIS EXISTS. `sanitize()` works on a string, so a record such as `{ client_secret: "..." }`
 * passed `sanitizeRecord` unchanged: the leaf holds no key for a pattern to find. With the string
 * patterns alone, the webview's phase-log message would carry `toolInput` (a JSON string) masked
 * beside `toolArguments` (the same object) in cleartext. So `isSecretKeyName` is the one predicate
 * both walkers share, derived from one word list, and this file pins it with a truth table: which
 * names are secret keys, and which look like one and are not (`input_tokens`, `tokenizer`, the
 * shell's `PWD`).
 *
 * Only a non-empty STRING leaf is replaced. Numbers, booleans and null under the same keys are kept,
 * so token-usage counts pass byte-identical, and keys, shape, array order and the `__proto__` rename
 * are untouched (FR-023).
 */
const logger = new SanitizedLogger();
const VALUE = 'Zq3K8vR2mN7pL4wT9yB6cD1f';

const SECRET_NAMES = [
  'password',
  'dbPassword',
  'db-password',
  'DB_PASSWORD',
  'client_secret',
  'clientSecret',
  'apiToken',
  'x.secret',
  'db_pwd',
  'dbPwd',
  'access_token',
  'refresh-token',
  'passwd'
];
const NOT_SECRET_NAMES = [
  'input_tokens',
  'output_tokens',
  'tokenizer',
  'secretary',
  'passwordPolicy',
  'PWD',
  'pwd',
  'OLDPWD',
  'username',
  'path',
  ''
];

describe('isSecretKeyName, the truth table (RD1)', () => {
  it.each(SECRET_NAMES.map((name) => [name] as const))('%s names a secret', (name) => {
    expect(isSecretKeyName(name)).toBe(true);
  });

  it.each(NOT_SECRET_NAMES.map((name) => [name] as const))('"%s" does not name a secret', (name) => {
    expect(isSecretKeyName(name)).toBe(false);
  });

  it('is derived from one frozen word list', () => {
    expect([...SECRET_KEY_NAME_WORDS]).toEqual(['password', 'passwd', 'pwd', 'secret', 'token']);
    expect(Object.isFrozen(SECRET_KEY_NAME_WORDS)).toBe(true);
  });
});

describe('sanitizeRecord removes a string leaf under a secret key (RD4)', () => {
  it('replaces the leaf with the sentinel, flat, nested and inside an array element', () => {
    const cleaned = logger.sanitizeRecord({
      password: VALUE,
      nested: { client_secret: VALUE, deeper: { apiToken: VALUE } },
      list: [{ db_pwd: VALUE }, { note: 'plain' }]
    });
    expect(cleaned).toEqual({
      password: REDACTION_SENTINEL,
      nested: { client_secret: REDACTION_SENTINEL, deeper: { apiToken: REDACTION_SENTINEL } },
      list: [{ db_pwd: REDACTION_SENTINEL }, { note: 'plain' }]
    });
  });

  it('keeps number, boolean and null leaves under the same keys', () => {
    const record = { token: 12345, secret: true, password: null, input_tokens: 1234, output_tokens: 5678 };
    expect(logger.sanitizeRecord(record)).toEqual(record);
  });

  it('keeps an empty string under a secret key, because there is nothing to remove', () => {
    expect(logger.sanitizeRecord({ password: '' })).toEqual({ password: '' });
  });

  it('leaves a string under a name that merely looks like a secret key as it was', () => {
    const record = { tokenizer: VALUE, secretary: VALUE, passwordPolicy: VALUE, PWD: '/tmp/example/work' };
    expect(logger.sanitizeRecord(record)).toEqual(record);
  });

  it('keeps keys, shape and array order, and the __proto__ rename', () => {
    const record = JSON.parse(
      `{"b":"1","a":["x","y","z"],"password":"${VALUE}","__proto__":{"token":"${VALUE}"},"z":{"y":{"x":"w"}}}`
    );
    const cleaned = logger.sanitizeRecord(record) as Record<string, unknown>;
    expect(Object.keys(cleaned)).toEqual(['b', 'a', 'password', '[__proto__]', 'z']);
    expect(cleaned['a']).toEqual(['x', 'y', 'z']);
    expect(cleaned['password']).toBe(REDACTION_SENTINEL);
    expect(cleaned['[__proto__]']).toEqual({ token: REDACTION_SENTINEL });
    expect(Object.getPrototypeOf(cleaned)).toBe(Object.prototype);
  });

  it('still sanitizes a string leaf under an ordinary key by pattern', () => {
    const cleaned = logger.sanitizeRecord({ note: `Bearer ${VALUE}` });
    expect(cleaned['note']).toContain(REDACTION_SENTINEL);
    expect(cleaned['note']).not.toContain(VALUE);
  });
});

/**
 * RECORDED LIMIT (FR-R4-F10, audit gap G3) -- an array or an object directly under a key that names a
 * secret is walked, and not replaced. Only a string leaf is replaced, so a string inside the container is
 * judged by the key it sits under and by the string patterns, and a value in no format a pattern knows
 * stays. The corpus records this as `a container under a secret-named key` and SECURITY.md says it under
 * "What stays". The exposure is bounded the way the `unknown-format token` limit is: a vendor token inside
 * the container is still removed by the pattern pass.
 *
 * It is pinned so that replacing the whole container, which changes the evidence shape at every sink, is a
 * decision that has to edit the record with it, and not a change this file passes over.
 */
describe('sanitizeRecord walks a container under a secret key and does not replace it (recorded limit)', () => {
  const CONTAINERS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['an array of strings', { token: [VALUE, 'plain'] }],
    ['an object', { password: { current: VALUE } }],
    ['an array of objects', { client_secret: [{ current: VALUE }] }]
  ];

  it.each(CONTAINERS)('keeps a string in a format no pattern knows in %s', (_shape, record) => {
    expect(logger.sanitizeRecord(record)).toEqual(record);
  });

  it('removes the same string when it sits directly under the key, which is what makes the limit visible', () => {
    expect(logger.sanitizeRecord({ token: VALUE })).toEqual({ token: REDACTION_SENTINEL });
  });

  it('still removes a vendor token inside the container, by pattern', () => {
    const vendorToken = `${['gh', 'p_'].join('')}${'a1B2'.repeat(9)}`;
    const cleaned = JSON.stringify(logger.sanitizeRecord({ token: [vendorToken] }));
    expect(cleaned).toContain(REDACTION_SENTINEL);
    expect(cleaned).not.toContain('a1B2a1B2');
  });
});

/**
 * A transport line or an exported JSONL row is sanitized as TEXT, and a tool result there is a JSON
 * string holding JSON, so a keyed value is followed by `\"`. The value match must stop before that
 * backslash: removing it with the value unescapes the closing quote and the line no longer parses.
 */
describe('sanitize keeps a JSON line parseable when a nested JSON value is keyed (RD4)', () => {
  it.each(['password', 'client_secret', 'apiToken'].map((key) => [key] as const))(
    'removes the %s value and both levels still parse',
    (key) => {
      const inner = JSON.stringify({ [key]: VALUE, user: 'bob' });
      const line = JSON.stringify({ type: 'tool_result', content: inner });
      const cleaned = logger.sanitize(line);
      expect(cleaned).not.toContain(VALUE);
      const outer = JSON.parse(cleaned) as { content: string };
      expect(JSON.parse(outer.content)).toEqual({ [key]: REDACTION_SENTINEL, user: 'bob' });
    }
  );

  it('keeps an escaped backslash at the end of a keyed value balanced', () => {
    const line = JSON.stringify({ content: JSON.stringify({ password: `${VALUE}\\` }) });
    const outer = JSON.parse(logger.sanitize(line)) as { content: string };
    const parsed = JSON.parse(outer.content) as { password: string };
    expect(parsed.password.startsWith(REDACTION_SENTINEL)).toBe(true);
    expect(parsed.password).not.toContain(VALUE);
  });
});

/**
 * A password may itself end in a backslash. Only a backslash that escapes the quote after it belongs to
 * the JSON around the value, so the value match gives back that one character and no other: an 8-character
 * password such as `Pa55wd!\` is removed whole in plain text, and its doubled form in a JSON string still
 * leaves the line parseable.
 */
describe('sanitize removes a short keyed value that ends in a backslash (RD4)', () => {
  const SHORT = 'Pa55wd!\\';

  it.each([`password=${SHORT}`, `password=${SHORT} next`, `db_pwd: ${SHORT}`])('removes the value from %s', (text) => {
    const cleaned = logger.sanitize(text);
    expect(cleaned).toContain(REDACTION_SENTINEL);
    expect(cleaned).not.toContain('Pa55wd!');
  });

  it('removes it from a JSON line holding JSON, and both levels still parse', () => {
    const line = JSON.stringify({ content: JSON.stringify({ password: SHORT, user: 'bob' }) });
    const cleaned = logger.sanitize(line);
    expect(cleaned).not.toContain('Pa55wd!');
    const outer = JSON.parse(cleaned) as { content: string };
    expect(JSON.parse(outer.content)).toEqual({ password: REDACTION_SENTINEL, user: 'bob' });
  });
});

describe('isSecretKeyName splits an acronym before a capitalised word (RD1)', () => {
  it.each(['APIToken', 'DBPwd', 'OAuthClientSecret', 'XMLHttpPassword'])('%s names a secret', (name) => {
    expect(isSecretKeyName(name)).toBe(true);
  });

  it.each(['APITokenizer', 'PWD', 'HTTPSecretary'])('%s does not name a secret', (name) => {
    expect(isSecretKeyName(name)).toBe(false);
  });
});
