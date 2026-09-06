import { describe, it, expect } from 'vitest';
import { SanitizedLogger } from '../../../src/lib/logger';

/**
 * FR-R3-166 — the sanitizer must not lose the one key it cannot assign.
 *
 * `sanitizeValue`'s object branch rebuilds each object onto a fresh `{}` and
 * copies enumerated keys with `out[key] = cleaned`. For an own `__proto__`
 * key — exactly what `JSON.parse` produces from model or CLI output — that
 * assignment creates no own property; it invokes the
 * `Object.prototype.__proto__` setter. A string value vanishes. An object
 * value becomes the result's prototype.
 *
 * Every input below is built with `JSON.parse` rather than an object literal,
 * because an object literal's `__proto__:` is the prototype-setting syntax and
 * would not produce the own key this defect needs.
 */

const logger = new SanitizedLogger();

function record(json: string): Record<string, unknown> {
  return logger.sanitizeRecord(JSON.parse(json) as Record<string, unknown>);
}

describe('SanitizedLogger.sanitizeRecord — own __proto__ key, top level (FR-R3-166)', () => {
  it('keeps Object.prototype and answers no read from the input __proto__ object', () => {
    const out = record('{"__proto__":{"isAdmin":true},"a":1}');

    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.isAdmin).toBeUndefined();
    expect(out.a).toBe(1);
  });

  it('preserves the object value under the renamed key', () => {
    const out = record('{"__proto__":{"isAdmin":true},"a":1}');

    expect(Object.hasOwn(out, '[__proto__]')).toBe(true);
    expect((out['[__proto__]'] as Record<string, unknown>).isAdmin).toBe(true);
  });

  it('preserves a string value under the renamed key instead of losing it', () => {
    const out = record('{"__proto__":"x","a":1}');

    // SC-002 states both halves as one criterion: the value is present under
    // the renamed key, and no key named `__proto__` is emitted. Asserting them
    // together keeps the second from reading as a passing test on the
    // pre-change tree, where the value is simply lost.
    expect(Object.hasOwn(out, '[__proto__]')).toBe(true);
    expect(out['[__proto__]']).toBe('x');
    expect(Object.hasOwn(out, '__proto__')).toBe(false);
    expect(Object.keys(out)).not.toContain('__proto__');
    expect(out.a).toBe(1);
  });
});

describe('SanitizedLogger.sanitizeRecord — cycle through a __proto__ key (FR-R3-166)', () => {
  it('marks the cycle [CIRCULAR] under the renamed key', () => {
    const input = JSON.parse('{"__proto__":{"a":1}}') as Record<string, unknown>;
    (input['__proto__'] as Record<string, unknown>).self = input;

    const out = logger.sanitizeRecord(input);
    const renamed = out['[__proto__]'] as Record<string, unknown>;

    expect(renamed.a).toBe(1);
    expect(renamed.self).toBe('[CIRCULAR]');
  });
});

describe('SanitizedLogger.sanitizeRecord — own __proto__ key, nested (FR-R3-166)', () => {
  it('keeps Object.prototype on a nested object carrying the key', () => {
    const out = record('{"outer":{"__proto__":{"isAdmin":true},"a":1}}');
    const inner = out.outer as Record<string, unknown>;

    expect(Object.getPrototypeOf(inner)).toBe(Object.prototype);
    expect(inner.isAdmin).toBeUndefined();
    expect((inner['[__proto__]'] as Record<string, unknown>).isAdmin).toBe(true);
  });

  it('preserves a nested string value under the renamed key', () => {
    const out = record('{"outer":{"__proto__":"x","a":1}}');
    const inner = out.outer as Record<string, unknown>;

    expect(Object.hasOwn(inner, '[__proto__]')).toBe(true);
    expect(inner['[__proto__]']).toBe('x');
    expect(Object.hasOwn(inner, '__proto__')).toBe(false);
  });
});

describe('SanitizedLogger.sanitizeRecord — rename collision (FR-R3-166)', () => {
  it('displaces neither value when the input already carries [__proto__]', () => {
    const out = record('{"__proto__":"from-proto","[__proto__]":"from-bracket","a":1}');

    expect(out['[__proto__]']).toBe('from-bracket');
    expect(out['[__proto__](2)']).toBe('from-proto');
    expect(out.a).toBe(1);
  });

  it('walks the sequence past every occupied candidate', () => {
    const out = record(
      '{"__proto__":"from-proto","[__proto__]":"a","[__proto__](2)":"b","[__proto__](3)":"c"}'
    );

    expect(out['[__proto__]']).toBe('a');
    expect(out['[__proto__](2)']).toBe('b');
    expect(out['[__proto__](3)']).toBe('c');
    expect(out['[__proto__](4)']).toBe('from-proto');
  });

  it('picks the target from the input key set, not from enumeration order', () => {
    const first = record('{"__proto__":"p","[__proto__]":"b"}');
    const second = record('{"[__proto__]":"b","__proto__":"p"}');

    expect(first).toEqual(second);
    expect(second['[__proto__]']).toBe('b');
    expect(second['[__proto__](2)']).toBe('p');
  });
});

/**
 * Regression guards. These pass before and after the fix — they are controls,
 * not [RED] assertions. A guard that fails on the unmodified tree would mean
 * the change is broader than FR-006 allows.
 */
describe('SanitizedLogger.sanitizeRecord — unchanged behaviour (FR-006)', () => {
  it('emits no renamed key for a __proto__ value that sanitizes to undefined', () => {
    const input = JSON.parse('{"a":1}') as Record<string, unknown>;
    Object.defineProperty(input, '__proto__', {
      value: () => undefined,
      enumerable: true,
      writable: true,
      configurable: true
    });

    const out = logger.sanitizeRecord(input);

    expect(Object.hasOwn(out, '[__proto__]')).toBe(false);
    expect(Object.hasOwn(out, '__proto__')).toBe(false);
    expect(out.a).toBe(1);
  });

  it('leaves a record with no own __proto__ key untouched', () => {
    const out = logger.sanitizeRecord({
      a: 1,
      b: 'plain',
      c: { d: [1, 2, 'three'], e: null },
      f: true
    });

    expect(out).toEqual({ a: 1, b: 'plain', c: { d: [1, 2, 'three'], e: null }, f: true });
    expect(Object.keys(out)).toEqual(['a', 'b', 'c', 'f']);
  });

  it('still marks a cycle reached through an ordinary key as [CIRCULAR]', () => {
    const input: Record<string, unknown> = { outer: { a: 1 } };
    (input.outer as Record<string, unknown>).self = input;

    const out = logger.sanitizeRecord(input);
    const inner = out.outer as Record<string, unknown>;

    expect(inner.a).toBe(1);
    expect(inner.self).toBe('[CIRCULAR]');
  });

  it('returns Object.prototype even for a null-prototype input', () => {
    const input = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 });

    const out = logger.sanitizeRecord(input);

    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.a).toBe(1);
  });

  it('does not pollute the global Object.prototype', () => {
    record('{"__proto__":{"isAdmin":true}}');

    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
    expect(Object.hasOwn(Object.prototype, 'isAdmin')).toBe(false);
  });
});
