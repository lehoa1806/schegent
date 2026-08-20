// Feature 099 (FR-R3-015) T495 — canonical JSON determinism (FR-013, SC-010).
//
// This function decides whether a save is a change, so every defect in it is
// silent: it either manufactures a version out of a no-op edit, or it swallows a
// real edit by hashing two bodies alike. The cases below are one per stated rule,
// each written so that the obvious wrong implementation fails it:
//
//   - key order              → a `localeCompare` sort passes a lowercase-only case
//                              and fails the mixed-case one.
//   - array order            → sorting arrays passes every scalar case and fails
//                              the phase-order one.
//   - absent vs `undefined`  → `JSON.stringify` already gets this right, and a
//                              hand-rolled walker that writes `"b":undefined` does
//                              not.
//   - non-finite refusal     → `JSON.stringify` gets this WRONG (`NaN` → `null`),
//                              which is why it is stated rather than inherited.
//
// The locale case is the one that cannot be caught by review on a developer
// machine: it passes under `en-US` whatever the implementation does. It is pinned
// twice — once behaviourally, once by reading the source (see `no-locale-collation`).

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CANONICAL_MAX_DEPTH, canonicalJson } from '../../../src/catalog/canonical-json';

const CATALOG_SRC = path.resolve(__dirname, '../../../src/catalog');

/** The canonical text, or a failure naming the refusal — never a silent `undefined`. */
function canonicalText(body: unknown): string {
  const result = canonicalJson(body);
  if (result.outcome !== 'canonical') {
    throw new Error(`expected canonical text, got ${result.outcome}: ${result.reason} at ${result.at}`);
  }
  return result.text;
}

describe('canonicalJson: object key order', () => {
  it('sorts keys by UTF-16 code unit, not by authored order', () => {
    expect(canonicalText({ zebra: 1, alpha: 2, mango: 3 })).toBe('{"alpha":2,"mango":3,"zebra":1}');
  });

  it('produces identical text for the same keys authored in any order', () => {
    const one = canonicalText({ name: 'x', id: 'a', version: 2 });
    const other = canonicalText({ version: 2, name: 'x', id: 'a' });
    expect(one).toBe(other);
  });

  it('puts uppercase before lowercase, which code-unit order does and collation does not', () => {
    // The discriminator. `'B'` is U+0042 and `'a'` is U+0061, so code-unit order
    // is B, a. Every common collation — `localeCompare`, `Intl.Collator`, a case-
    // insensitive sort — puts `a` first. An implementation that reached for the
    // "nicer" comparator passes every other case in this file and fails this one.
    expect(canonicalText({ a: 1, B: 2 })).toBe('{"B":2,"a":1}');
  });

  it('orders punctuation by code unit too, where locales disagree most', () => {
    // `-` is U+002D, `_` is U+005F, and digits sit between them. Collations
    // routinely treat `-` as ignorable punctuation and sort `a-b` next to `ab`.
    expect(canonicalText({ 'a_b': 1, 'a-b': 2, 'a0b': 3 })).toBe('{"a-b":2,"a0b":3,"a_b":1}');
  });

  it('sorts nested object keys by the same rule', () => {
    expect(canonicalText({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });
});

describe('canonicalJson: array order', () => {
  it('preserves authored array order', () => {
    // A Pipeline's phase order IS meaning: sorting here would make two different
    // Pipelines hash alike, which is the swallow-a-real-edit failure.
    expect(canonicalText({ phaseIds: ['plan', 'implement', 'analyze'] })).toBe(
      '{"phaseIds":["plan","implement","analyze"]}'
    );
  });

  it('gives two orderings of the same elements different text', () => {
    expect(canonicalText(['a', 'b'])).not.toBe(canonicalText(['b', 'a']));
  });

  it('sorts the keys of objects inside an array without reordering the array', () => {
    expect(canonicalText([{ b: 1, a: 2 }, { d: 3, c: 4 }])).toBe(
      '[{"a":2,"b":1},{"c":4,"d":3}]'
    );
  });
});

describe('canonicalJson: absent and undefined', () => {
  it('omits a key whose value is undefined', () => {
    // A body round-tripped through the webview with an absent optional must not
    // manufacture a version (FR-014).
    expect(canonicalText({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('canonicalises absent and present-but-undefined identically', () => {
    expect(canonicalText({ a: 1, b: undefined })).toBe(canonicalText({ a: 1 }));
  });

  it('keeps null, which is a value and not an absence', () => {
    expect(canonicalText({ a: null })).toBe('{"a":null}');
    expect(canonicalText({ a: null })).not.toBe(canonicalText({}));
  });
});

describe('canonicalJson: refusals', () => {
  it('refuses NaN rather than writing it as null', () => {
    // `JSON.stringify({a: NaN})` is `{"a":null}`, so without this rule three
    // different bodies hash identically to a body that authored `null`.
    expect(canonicalJson({ a: Number.NaN })).toEqual({
      outcome: 'refused',
      reason: 'non-finite-number',
      at: '$.a'
    });
  });

  it('refuses both infinities', () => {
    expect(canonicalJson(Number.POSITIVE_INFINITY)).toMatchObject({ reason: 'non-finite-number' });
    expect(canonicalJson(Number.NEGATIVE_INFINITY)).toMatchObject({ reason: 'non-finite-number' });
  });

  it('names the position of a non-finite number inside an array', () => {
    expect(canonicalJson({ timeouts: [1, 2, Number.NaN] })).toEqual({
      outcome: 'refused',
      reason: 'non-finite-number',
      at: '$.timeouts[2]'
    });
  });

  it('refuses values that are not JSON', () => {
    for (const body of [
      { at: new Date(0) },
      { at: new Map() },
      { at: () => undefined },
      { at: 10n },
      { at: Symbol('x') }
    ]) {
      expect(canonicalJson(body)).toMatchObject({ outcome: 'refused', at: '$.at' });
    }
  });

  it('refuses a cycle instead of overflowing the stack', () => {
    const body: Record<string, unknown> = { id: 'a' };
    body.self = body;
    expect(canonicalJson(body)).toEqual({ outcome: 'refused', reason: 'cyclic', at: '$.self' });
  });

  it('refuses a body nested past the depth bound instead of throwing', () => {
    // The sibling of the cycle case, and the one a cycle check cannot catch: a
    // finite body deep enough to exhaust the stack. Every other failure in this
    // module is a returned value, and this one must be too — a `RangeError`
    // escaping here would leave the store's callers, which hold no `try`, with an
    // unhandled rejection instead of a refusal.
    let body: unknown = 1;
    for (let depth = 0; depth < 5_000; depth += 1) body = { nested: body };

    expect(canonicalJson(body)).toMatchObject({ outcome: 'refused', reason: 'too-deep' });
  });

  it('names the depth bound at a fixed position rather than at the stack limit', () => {
    // The bound is the store's, not the engine's. A body refused here is refused
    // identically on every machine, which is what SC-010 asks of canonicalisation
    // — a stack-dependent limit would make the same body canonical on one
    // machine and refused on another.
    const nest = (depth: number): unknown => {
      let body: unknown = 1;
      for (let level = 0; level < depth; level += 1) body = [body];
      return body;
    };

    expect(canonicalJson(nest(CANONICAL_MAX_DEPTH))).toMatchObject({ outcome: 'canonical' });
    expect(canonicalJson(nest(CANONICAL_MAX_DEPTH + 1))).toMatchObject({
      outcome: 'refused',
      reason: 'too-deep'
    });
  });

  it('allows the same object twice when it is not a cycle', () => {
    // Shared references are not cycles. A walker that marks `seen` and never
    // unmarks it refuses this, and refusing it would refuse a legitimate body.
    const shared = { a: 1 };
    expect(canonicalText({ one: shared, two: shared })).toBe('{"one":{"a":1},"two":{"a":1}}');
  });

  it('reports a refusal path within the body and never a filesystem path', () => {
    const refusal = canonicalJson({ phases: [{ limits: { max: Number.NaN } }] });
    expect(refusal).toMatchObject({ outcome: 'refused', at: '$.phases[0].limits.max' });
    // FR-061: `at` is dotted body notation. It starts at the body root and there
    // is nothing in it a workspace root could be mistaken for.
    if (refusal.outcome === 'refused') {
      expect(refusal.at.startsWith('$')).toBe(true);
      expect(refusal.at).not.toContain('/');
    }
  });
});

describe('canonicalJson: no locale sensitivity', () => {
  it('produces byte-identical text for a body serialised twice', () => {
    const body = { z: [3, 1, 2], a: { 'B': true, b: false }, 'ä': 1, 'a1': 2 };
    expect(canonicalText(body)).toBe(canonicalText(structuredClone(body)));
  });

  it('sorts non-ASCII keys by code unit, above every ASCII key', () => {
    // `ä` is U+00E4 — above every ASCII letter. Under a German collation it sorts
    // with `a`; under a Swedish one it sorts after `z`. Code-unit order has one
    // answer and it is neither of those by accident: it is last here because its
    // code unit is highest.
    expect(canonicalText({ 'ä': 1, z: 2, a: 3 })).toBe('{"a":3,"z":2,"ä":1}');
  });

  it('no-locale-collation: no module under src/catalog reaches for a collator', async () => {
    // The behavioural cases above pin the ordering this machine produces. They
    // cannot fail on a machine whose default locale is `en-US`, which is every
    // developer machine and every CI runner — so the rule is also stated
    // structurally, by reading the source. A future edit that swaps `.sort()` for
    // `.sort((a, b) => a.localeCompare(b))` is caught here even where its effect
    // is invisible.
    const files = (await readdir(CATALOG_SRC)).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);

    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(path.join(CATALOG_SRC, file), 'utf8');
      // Comments in `canonical-json.ts` name these on purpose, so the scan looks
      // at code only: every line with a call, minus the ones that are prose.
      const code = source
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      for (const banned of ['localeCompare', 'toLocaleString', 'toLocaleLowerCase', 'Intl.']) {
        if (code.includes(banned)) offenders.push(`${file}: ${banned}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
