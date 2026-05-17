// Mirror of src/lib/retry-condition.ts — parity verified by
// tests/parity/retry-condition-parity.test.ts (Feature 011 SC-011).
// Do not modify without updating both files in lockstep.
//
// Retry-Condition DSL — feature 010-pipeline-resilience.
//
// Hand-rolled lexer + recursive-descent parser + tree-walking evaluator for
// the operator-authored `retryCondition` expression on `PhaseDef`.
//
// Grammar (normative): specs/010-pipeline-resilience/contracts/retry-condition-grammar.ebnf
//
// Operator precedence (highest first):
//   1. 'not' / '!'   (unary, prefix-only, right-associative)
//   2. '>' '>=' '<' '<=' '==' '!='   (binary, non-associative — chains rejected)
//   3. 'and' / '&&'  (binary, left-associative)
//   4. 'or'  / '||'  (binary, left-associative)
//
// Reserved keywords are lowercase only and case-sensitive (FR-009). The `-`
// sign is part of a numeric literal token; unary `-` on identifiers or
// sub-expressions is rejected. The evaluator NEVER throws — runtime errors
// are returned as `{ ok: false; error }` (FR-013).

export type NumericLiteralExpr = { kind: 'number'; value: number };
export type IdentifierExpr = { kind: 'identifier'; name: string };
export type CompareOp = '>' | '>=' | '<' | '<=' | '==' | '!=';
export type CompareTerm = NumericLiteralExpr | IdentifierExpr;
export type CompareExpr = {
  kind: 'compare';
  op: CompareOp;
  left: CompareTerm;
  right: CompareTerm;
};
export type LogicalOp = 'and' | 'or';
export type LogicalExpr = {
  kind: 'logical';
  op: LogicalOp;
  left: Expression;
  right: Expression;
};
export type NotExpr = { kind: 'not'; expr: Expression };

export type Expression = CompareExpr | LogicalExpr | NotExpr;

export interface ValidationOk {
  readonly ok: true;
  readonly expression: Expression;
  readonly source: string;
}

export interface ValidationErr {
  readonly ok: false;
  readonly error: string;
}

export type ParseResult = ValidationOk | ValidationErr;

export interface EvaluationResult {
  readonly value: boolean;
  readonly missingKeys: ReadonlyArray<string>;
}

export interface EvaluationError {
  readonly error: string;
}

export type EvaluatorResult =
  | { readonly ok: true; readonly evaluation: EvaluationResult }
  | { readonly ok: false; readonly error: EvaluationError };

// ============================================================
// Lexer
// ============================================================

type TokenKind =
  | 'number'
  | 'identifier'
  | 'and'
  | 'or'
  | 'not'
  | 'lparen'
  | 'rparen'
  | 'op'
  | 'eof';

interface Token {
  kind: TokenKind;
  text: string;
  pos: number;
  value?: number; // for number tokens
  op?: CompareOp; // for op tokens
}

const IDENT_START = /[a-zA-Z_]/;
const IDENT_CONT = /[a-zA-Z0-9_]/;
const DIGIT = /[0-9]/;

class LexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LexError';
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    // whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    // parens
    if (ch === '(') {
      tokens.push({ kind: 'lparen', text: '(', pos: i });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen', text: ')', pos: i });
      i++;
      continue;
    }
    // logical && ||
    if (ch === '&' && source[i + 1] === '&') {
      tokens.push({ kind: 'and', text: '&&', pos: i });
      i += 2;
      continue;
    }
    if (ch === '|' && source[i + 1] === '|') {
      tokens.push({ kind: 'or', text: '||', pos: i });
      i += 2;
      continue;
    }
    // logical not !  (must check !=  first)
    if (ch === '!' && source[i + 1] !== '=') {
      tokens.push({ kind: 'not', text: '!', pos: i });
      i++;
      continue;
    }
    // compare operators
    if (ch === '>' || ch === '<' || ch === '=' || ch === '!') {
      const next = source[i + 1];
      let op: CompareOp | null = null;
      let len = 1;
      if (ch === '>' && next === '=') {
        op = '>=';
        len = 2;
      } else if (ch === '<' && next === '=') {
        op = '<=';
        len = 2;
      } else if (ch === '=' && next === '=') {
        op = '==';
        len = 2;
      } else if (ch === '!' && next === '=') {
        op = '!=';
        len = 2;
      } else if (ch === '>') {
        op = '>';
      } else if (ch === '<') {
        op = '<';
      }
      if (op === null) {
        throw new LexError(`unexpected '${ch}' at position ${i}`);
      }
      tokens.push({ kind: 'op', text: op, pos: i, op });
      i += len;
      continue;
    }
    // signed numeric literal — '-' is part of the number token
    if (ch === '-' && DIGIT.test(source[i + 1] ?? '')) {
      const start = i;
      i++;
      while (DIGIT.test(source[i] ?? '')) i++;
      if (source[i] === '.') {
        i++;
        if (!DIGIT.test(source[i] ?? '')) {
          throw new LexError(`malformed number at position ${start}`);
        }
        while (DIGIT.test(source[i] ?? '')) i++;
      }
      const text = source.slice(start, i);
      tokens.push({ kind: 'number', text, pos: start, value: Number(text) });
      continue;
    }
    if (ch === '-') {
      // Bare '-' that is not part of a literal token. Surface as an error so
      // unary-minus on identifiers or sub-expressions is rejected.
      throw new LexError(`unary minus is only permitted on numeric literals (position ${i})`);
    }
    // unsigned numeric literal
    if (DIGIT.test(ch)) {
      const start = i;
      while (DIGIT.test(source[i] ?? '')) i++;
      if (source[i] === '.') {
        i++;
        if (!DIGIT.test(source[i] ?? '')) {
          throw new LexError(`malformed number at position ${start}`);
        }
        while (DIGIT.test(source[i] ?? '')) i++;
      }
      const text = source.slice(start, i);
      tokens.push({ kind: 'number', text, pos: start, value: Number(text) });
      continue;
    }
    // identifier or keyword
    if (IDENT_START.test(ch)) {
      const start = i;
      while (IDENT_CONT.test(source[i] ?? '')) i++;
      const text = source.slice(start, i);
      if (text === 'and') tokens.push({ kind: 'and', text, pos: start });
      else if (text === 'or') tokens.push({ kind: 'or', text, pos: start });
      else if (text === 'not') tokens.push({ kind: 'not', text, pos: start });
      else tokens.push({ kind: 'identifier', text, pos: start });
      continue;
    }
    throw new LexError(`unexpected character '${ch}' at position ${i}`);
  }
  tokens.push({ kind: 'eof', text: '', pos: source.length });
  return tokens;
}

// ============================================================
// Parser (recursive descent)
// ============================================================

class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expect(kind: TokenKind): Token {
    const tok = this.next();
    if (tok.kind !== kind) {
      throw new ParseError(`expected ${kind} at position ${tok.pos}, got ${tok.kind} '${tok.text}'`);
    }
    return tok;
  }

  parse(): Expression {
    const expr = this.parseOr();
    const trailing = this.peek();
    if (trailing.kind !== 'eof') {
      throw new ParseError(`unexpected token '${trailing.text}' at position ${trailing.pos}`);
    }
    return expr;
  }

  // OrExpr := AndExpr ( 'or' AndExpr )*
  private parseOr(): Expression {
    let left: Expression = this.parseAnd();
    while (this.peek().kind === 'or') {
      this.next();
      const right = this.parseAnd();
      left = { kind: 'logical', op: 'or', left, right };
    }
    return left;
  }

  // AndExpr := NotExpr ( 'and' NotExpr )*
  private parseAnd(): Expression {
    let left: Expression = this.parseNot();
    while (this.peek().kind === 'and') {
      this.next();
      const right = this.parseNot();
      left = { kind: 'logical', op: 'and', left, right };
    }
    return left;
  }

  // NotExpr := 'not' NotExpr | CompareExpr
  private parseNot(): Expression {
    if (this.peek().kind === 'not') {
      this.next();
      const expr = this.parseNot();
      return { kind: 'not', expr };
    }
    return this.parseCompare();
  }

  // CompareExpr := Primary CompareOp Primary | '(' Expression ')'
  private parseCompare(): Expression {
    if (this.peek().kind === 'lparen') {
      this.next();
      const inner = this.parseOr();
      this.expect('rparen');
      // Reject function-call shape: a '(' immediately following an identifier
      // would have been consumed at a higher level, so we don't need a check
      // here — the grammar has no production that allows it.
      return inner;
    }
    const left = this.parsePrimary();
    const opTok = this.peek();
    if (opTok.kind !== 'op' || opTok.op === undefined) {
      throw new ParseError(`expected comparison operator at position ${opTok.pos}, got '${opTok.text}'`);
    }
    this.next();
    const right = this.parsePrimary();
    // Reject chained comparison: 'a > b > c'.
    const after = this.peek();
    if (after.kind === 'op') {
      throw new ParseError(`chained comparisons are not permitted at position ${after.pos}`);
    }
    return { kind: 'compare', op: opTok.op, left, right };
  }

  // Primary := Number | Identifier
  private parsePrimary(): CompareTerm {
    const tok = this.peek();
    if (tok.kind === 'number') {
      this.next();
      return { kind: 'number', value: tok.value as number };
    }
    if (tok.kind === 'identifier') {
      this.next();
      // Reject member access ('.') and function call ('(') after identifier.
      // member access tokens never appear in our lexer (no '.'), and a '(' here
      // would be interpreted as a sub-expression — but that requires a
      // comparison operator after, which the loop above enforces.
      // Reject explicit '(' to disallow function-call shape.
      if (this.peek().kind === 'lparen') {
        throw new ParseError(`function-call syntax is not permitted at position ${this.peek().pos}`);
      }
      return { kind: 'identifier', name: tok.text };
    }
    throw new ParseError(`expected number or identifier at position ${tok.pos}, got '${tok.text}'`);
  }
}

export function validate(source: string): ParseResult {
  if (typeof source !== 'string' || source.trim() === '') {
    return { ok: false, error: 'retryCondition source is empty' };
  }
  let tokens: Token[];
  try {
    tokens = tokenize(source);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  try {
    const expr = new Parser(tokens).parse();
    return { ok: true, expression: expr, source };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ============================================================
// Evaluator
// ============================================================

export function evaluate(
  expression: Expression,
  metrics: Readonly<Record<string, number>>
): EvaluatorResult {
  try {
    const missingKeys = new Set<string>();
    const value = evalExpr(expression, metrics, missingKeys);
    if (typeof value !== 'boolean') {
      return { ok: false, error: { error: 'top-level expression did not produce a boolean' } };
    }
    return {
      ok: true,
      evaluation: { value, missingKeys: Object.freeze([...missingKeys]) }
    };
  } catch (e) {
    return { ok: false, error: { error: (e as Error).message } };
  }
}

function evalExpr(
  expr: Expression,
  metrics: Readonly<Record<string, number>>,
  missingKeys: Set<string>
): boolean {
  switch (expr.kind) {
    case 'compare': {
      const left = resolveTerm(expr.left, metrics, missingKeys);
      const right = resolveTerm(expr.right, metrics, missingKeys);
      switch (expr.op) {
        case '>':
          return left > right;
        case '>=':
          return left >= right;
        case '<':
          return left < right;
        case '<=':
          return left <= right;
        case '==':
          return left === right;
        case '!=':
          return left !== right;
      }
      throw new Error(`unreachable comparison operator: ${String((expr as { op: unknown }).op)}`);
    }
    case 'logical': {
      // Short-circuit semantics.
      const left = evalExpr(expr.left, metrics, missingKeys);
      if (expr.op === 'and') {
        if (!left) return false;
        return evalExpr(expr.right, metrics, missingKeys);
      }
      if (left) return true;
      return evalExpr(expr.right, metrics, missingKeys);
    }
    case 'not':
      return !evalExpr(expr.expr, metrics, missingKeys);
  }
}

function resolveTerm(
  term: CompareTerm,
  metrics: Readonly<Record<string, number>>,
  missingKeys: Set<string>
): number {
  if (term.kind === 'number') return term.value;
  if (Object.prototype.hasOwnProperty.call(metrics, term.name)) {
    return metrics[term.name];
  }
  missingKeys.add(term.name);
  return 0;
}
