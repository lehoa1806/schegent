import { describe, it, expect } from 'vitest';
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
