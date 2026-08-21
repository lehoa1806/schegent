import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import { PHASE_RETRY_CONDITION_MAX_LEN } from '../../../src/contracts/process-definitions';
import { validate, evaluate, type Expression } from '../../../src/lib/retry-condition';

function parsedExpr(source: string): Expression {
  const result = validate(source);
  if (!result.ok) {
    throw new Error(`expected '${source}' to parse, got error: ${result.error}`);
  }
  return result.expression;
}

function evalSource(source: string, metrics: Record<string, number> = {}): boolean {
  const expr = parsedExpr(source);
  const result = evaluate(expr, metrics);
  if (!result.ok) {
    throw new Error(`expected '${source}' to evaluate, got error: ${result.error.error}`);
  }
  return result.evaluation.value;
}

describe('retry-condition DSL — validate() syntax (010, T020)', () => {
  it.each([
    ['a > 0'],
    ['a >= 0'],
    ['a < 0'],
    ['a <= 0'],
    ['a == 0'],
    ['a != 0'],
    ['a > 0 and b > 0'],
    ['a > 0 or b > 0'],
    ['a > 0 && b > 0'],
    ['a > 0 || b > 0'],
    ['not a > 0'],
    ['!a > 0'],
    ['(a > 0)'],
    ['(a > 0) and (b > 0)'],
    ['a > -5'],
    ['a > -1.5'],
    ['a == 1.5'],
    ['unresolved_findings >= 3 and not resolved_findings == 0'],
    ['(open_questions > 0 and resolved_questions > 0) or fatal_count > 0'],
    ['!(value < 100)']
  ])('accepts %j', (source) => {
    expect(validate(source).ok).toBe(true);
  });

  it.each([
    ['a > b > c'], // chained comparison
    ['max(a, b) > 0'], // function call
    ['a.b > 0'], // member access
    ['-a > 0'], // unary minus on identifier
    ['-(a) > 0'], // unary minus on sub-expression
    ['a + b > 0'], // arithmetic
    ['a > 0 AND b > 0'], // uppercase keyword
    ['AND a > 0'], // uppercase keyword leading
    ['open_questions'], // bare identifier
    ['42'], // bare numeric literal
    [''], // empty
    ['a >'], // dangling operator
    ['a > 0 and'], // dangling logical
    ['('] // unbalanced
  ])('rejects %j', (source) => {
    expect(validate(source).ok).toBe(false);
  });

  it('not has higher precedence than and: `not a > 0 and b > 0` parses as `(not (a > 0)) and (b > 0)`', () => {
    const expr = parsedExpr('not a > 0 and b > 0');
    expect(expr.kind).toBe('logical');
    if (expr.kind === 'logical') {
      expect(expr.op).toBe('and');
      expect(expr.left.kind).toBe('not');
    }
  });

  it('and has higher precedence than or: `a > 0 or b > 0 and c > 0` parses as `(a > 0) or ((b > 0) and (c > 0))`', () => {
    const expr = parsedExpr('a > 0 or b > 0 and c > 0');
    expect(expr.kind).toBe('logical');
    if (expr.kind === 'logical') {
      expect(expr.op).toBe('or');
      expect(expr.right.kind).toBe('logical');
      if (expr.right.kind === 'logical') {
        expect(expr.right.op).toBe('and');
      }
    }
  });
});

describe('retry-condition DSL — evaluate() truth table (010, T020)', () => {
  it.each([
    // op, left, right, expected
    ['>', 1, 0, true],
    ['>', 0, 0, false],
    ['>=', 0, 0, true],
    ['>=', -1, 0, false],
    ['<', 0, 1, true],
    ['<', 0, 0, false],
    ['<=', 0, 0, true],
    ['<=', 1, 0, false],
    ['==', 0, 0, true],
    ['==', 0, 1, false],
    ['!=', 0, 1, true],
    ['!=', 0, 0, false]
  ] as const)('%s: %d vs %d → %s', (op, l, r, expected) => {
    expect(evalSource(`a ${op} b`, { a: l, b: r })).toBe(expected);
  });

  it('and is conjunctive', () => {
    expect(evalSource('a > 0 and b > 0', { a: 1, b: 1 })).toBe(true);
    expect(evalSource('a > 0 and b > 0', { a: 1, b: 0 })).toBe(false);
    expect(evalSource('a > 0 and b > 0', { a: 0, b: 1 })).toBe(false);
    expect(evalSource('a > 0 and b > 0', { a: 0, b: 0 })).toBe(false);
  });

  it('or is disjunctive', () => {
    expect(evalSource('a > 0 or b > 0', { a: 0, b: 0 })).toBe(false);
    expect(evalSource('a > 0 or b > 0', { a: 1, b: 0 })).toBe(true);
    expect(evalSource('a > 0 or b > 0', { a: 0, b: 1 })).toBe(true);
  });

  it('not negates', () => {
    expect(evalSource('not a > 0', { a: 0 })).toBe(true);
    expect(evalSource('not a > 0', { a: 1 })).toBe(false);
  });

  it('parentheses override precedence', () => {
    // 'a > 0 or b > 0 and c > 0' is `a OR (b AND c)`
    // '(a > 0 or b > 0) and c > 0' is `(a OR b) AND c`
    expect(evalSource('(a > 0 or b > 0) and c > 0', { a: 0, b: 1, c: 0 })).toBe(false);
    expect(evalSource('(a > 0 or b > 0) and c > 0', { a: 1, b: 0, c: 1 })).toBe(true);
  });

  it('signed numeric literals (negative, decimal)', () => {
    expect(evalSource('a > -5', { a: -3 })).toBe(true);
    expect(evalSource('a > -5', { a: -10 })).toBe(false);
    expect(evalSource('a > -1.5', { a: -1 })).toBe(true);
  });

  it('missing key resolves to 0 and is reported in missingKeys (FR-012)', () => {
    const expr = parsedExpr('open_questions > 0');
    const result = evaluate(expr, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evaluation.value).toBe(false);
      expect(Array.from(result.evaluation.missingKeys)).toContain('open_questions');
    }
  });

  it('missingKeys is empty when all identifiers resolve', () => {
    const expr = parsedExpr('a > b');
    const result = evaluate(expr, { a: 5, b: 2 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evaluation.missingKeys).toEqual([]);
    }
  });

  it('missingKeys aggregates resolved-but-missing identifiers without duplicates', () => {
    // disjunctive form ensures both halves are evaluated (no short-circuit kill).
    const expr = parsedExpr('a > 0 or b > 0 or a == c');
    const result = evaluate(expr, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      const keys = Array.from(result.evaluation.missingKeys).sort();
      expect(keys).toEqual(['a', 'b', 'c']);
    }
  });

  it('short-circuit on `and` does not resolve right-hand identifiers (documented)', () => {
    // The evaluator short-circuits `and` when the LHS is false. The RHS
    // identifiers do NOT get recorded in missingKeys. This is intentional —
    // the controller will surface a single per-invocation warning naming the
    // keys that WERE resolved-and-missing; a future change could pre-walk the
    // expression to collect ALL referenced identifiers if operators ask.
    const expr = parsedExpr('a > 0 and b > 0');
    const result = evaluate(expr, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.from(result.evaluation.missingKeys)).toEqual(['a']);
    }
  });
});

// ============================================================
// Feature 111 (T691–T693) — the length bound
// ============================================================

/**
 * `validate()` takes the bound as an argument rather than importing it, because
 * this module imports nothing: it is byte-mirrored into `webview-ui/src/lib/` and
 * `tests/lint/retry-condition-stays-inert.test.ts` pins its importer list at three.
 * The test may import the constant — a test is not a source module.
 */
describe('retry-condition DSL — the length bound (111, T691)', () => {
  /** A source of exactly `n` characters that would parse if length were no object. */
  function sourceOfLength(n: number): string {
    const head = 'a > 0 or ';
    const filler = 'b'.repeat(n - head.length - ' > 0'.length);
    const source = `${head}${filler} > 0`;
    expect(source.length, 'fixture builder is wrong').toBe(n);
    return source;
  }

  it('accepts a source of exactly the bound', () => {
    const result = validate(sourceOfLength(PHASE_RETRY_CONDITION_MAX_LEN), PHASE_RETRY_CONDITION_MAX_LEN);
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
  });

  it('refuses one character past the bound, naming both numbers', () => {
    const over = PHASE_RETRY_CONDITION_MAX_LEN + 1;
    const result = validate(sourceOfLength(over), PHASE_RETRY_CONDITION_MAX_LEN);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(`retryCondition is ${over} characters; the maximum is 512`);
    }
  });

  it('refuses before tokenizing, so a syntactically broken over-long source reads as a length', () => {
    // `((((` is a parse error at any length. With the bound in play the answer is
    // the length, because the length check runs first — that is the whole point:
    // the tokenizer never walks a source this size.
    const result = validate('('.repeat(4096), PHASE_RETRY_CONDITION_MAX_LEN);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('the maximum is 512');
    }
  });

  it('is inert when the parameter is omitted (SC-005a)', () => {
    // The pre-feature-111 call shape. A 1 MiB source is refused, but by the
    // parser, not by a bound — which is what every caller that omits the argument
    // still relies on.
    const long = validate('a > 0 or '.repeat(60_000));
    expect(long.ok).toBe(false);
    if (!long.ok) {
      expect(long.error).not.toContain('the maximum is');
    }
    expect(validate('a > 0').ok).toBe(true);
  });

  it('never throws at 1 MiB, in either call shape (SC-005)', () => {
    const mib = 'a'.repeat(1024 * 1024);
    expect(() => validate(mib)).not.toThrow();
    expect(() => validate(mib, PHASE_RETRY_CONDITION_MAX_LEN)).not.toThrow();
    expect(validate(mib).ok).toBe(false);
    expect(validate(mib, PHASE_RETRY_CONDITION_MAX_LEN).ok).toBe(false);
  });
});

describe('retry-condition DSL — the bound costs what a length costs (111, T692)', () => {
  /** Median of `runs` timings, in milliseconds. Median, not mean: one GC pause
   * in a 50-run sample moves a mean and does not move a median. */
  function medianMs(runs: number, body: () => void): number {
    const samples: number[] = [];
    for (let i = 0; i < runs; i += 1) {
      const started = performance.now();
      body();
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    return samples[Math.floor(samples.length / 2)];
  }

  it('refuses 1 MiB for no more than 4x what it costs to refuse 513 characters', () => {
    // No absolute millisecond figure is asserted, deliberately. An absolute
    // threshold measures the machine's spare capacity, not this code — and this
    // suite has been observed running 20x slower under CPU saturation. A ratio
    // between two operations measured in the same conditions does not have that
    // failure mode.
    //
    // The claim is that the guard is O(1) in the source length: `source.length` is
    // a property read, so a 2000x larger input must not cost 2000x more. 4x is
    // loose enough to survive one allocation of the larger string and tight enough
    // that a regression to per-character work (a tokenize-then-measure ordering)
    // fails it by three orders of magnitude.
    const small = 'a'.repeat(513);
    const large = 'a'.repeat(1024 * 1024);
    const smallMs = medianMs(50, () => validate(small, PHASE_RETRY_CONDITION_MAX_LEN));
    const largeMs = medianMs(50, () => validate(large, PHASE_RETRY_CONDITION_MAX_LEN));

    // Guard against a divide-by-zero verdict on a fast machine: at these sizes both
    // medians can round to 0 ms, which is itself the property under test.
    const ratio = smallMs === 0 ? (largeMs === 0 ? 1 : Infinity) : largeMs / smallMs;
    expect(ratio, `1 MiB cost ${largeMs}ms vs 513 chars ${smallMs}ms`).toBeLessThan(4);
  });

  it('is at least 10x cheaper than the unbounded path on the same input', () => {
    // The other direction, and the one that states what the bound buys. Both
    // operations are the same call on the same string, differing only in whether
    // the bound is passed — so this is a ratio measured in identical conditions,
    // with the same immunity to a loaded machine.
    //
    // Measured on darwin at 2026-08-22: 0.00017 ms bounded against 12.4 ms
    // unbounded, roughly 74,000x. The assertion is 10x because the figure that
    // matters is the order of magnitude, not the sample.
    const large = 'a'.repeat(1024 * 1024);
    const boundedMs = medianMs(50, () => validate(large, PHASE_RETRY_CONDITION_MAX_LEN));
    const unboundedMs = medianMs(5, () => validate(large));
    expect(
      unboundedMs / Math.max(boundedMs, Number.EPSILON),
      `bounded ${boundedMs}ms vs unbounded ${unboundedMs}ms`
    ).toBeGreaterThan(10);
  });
});

describe('retry-condition DSL — the shipped corpus fits the bound (111, T693)', () => {
  /**
   * Read from the example rather than copied into the test. A literal would let the
   * bound be tightened below what the product ships without anything going red —
   * which is the one regression this assertion exists to catch.
   */
  const CORPUS = resolve(__dirname, '../../../examples/speckit-new-feature.pipeline.yaml');

  function shippedConditions(): readonly string[] {
    const text = readFileSync(CORPUS, 'utf8');
    const found = [...text.matchAll(/^\s*retryCondition:\s*(.+?)\s*$/gm)].map((m) => m[1]);
    expect(found.length, 'the example carries no retryCondition to check').toBeGreaterThan(0);
    return found;
  }

  it('every shipped condition validates against the bound', () => {
    for (const source of shippedConditions()) {
      const result = validate(source, PHASE_RETRY_CONDITION_MAX_LEN);
      expect(result.ok, `${source} (${source.length} chars): ${result.ok ? '' : result.error}`).toBe(
        true
      );
    }
  });

  it('the longest shipped condition leaves headroom, so the bound is not a near-miss', () => {
    const longest = shippedConditions().reduce((a, b) => (b.length > a.length ? b : a));
    // Not an exact-length assertion: the example is allowed to grow. What must hold
    // is that the bound is a bound and not a fit — a corpus at 99% of 512 would
    // mean the next authored condition breaks the build.
    expect(longest.length).toBeLessThan(PHASE_RETRY_CONDITION_MAX_LEN / 2);
  });
});
