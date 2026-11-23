// FR-R7-08 (FR-005, SC-003) — Verification of the TypeScript lexical code-line
// counter used by the LoC budget gates.
//
// Proves that:
//   - single-line comments, block comments, JSDoc blocks, and blank lines are
//     excluded from code-line counts;
//   - inline trailing/leading comments on code lines still count as code;
//   - strings, multi-line template literals (with `${expr}`), and regex
//     literals containing comment markers (`//`, `/* ... */`) are counted as code;
// The PhaseRunner ceiling control lives with its configured budget.
import { describe, expect, it } from 'vitest';
import {
  countCodeLines,
  methodCodeLineCount,
  topLevelFunctionCodeLines
} from './code-lines';

describe('FR-R7-08 — lexical TypeScript code-line counter', () => {
  it('excludes line comments, block comments, JSDoc blocks, and blank lines', () => {
    const source = [
      '// single-line comment',
      '/* single-line block comment */',
      '/*',
      ' * multi-line block comment',
      ' */',
      '/**',
      ' * JSDoc block',
      ' * @param value input value',
      ' * @returns doubled value',
      ' */',
      '',
      '   ',
      'export function double(value: number): number {',
      '  // inline-only comment inside body',
      '  return value * 2; // trailing comment stays code',
      '}'
    ].join('\n');

    expect(countCodeLines(source, 'fixture.ts')).toBe(3);
  });

  it('preserves strings, template literals, and regex literals containing comment markers', () => {
    const source = [
      'const a = "// not a comment";',
      'const b = "/* also not a comment */";',
      'const c = `line 1',
      '  // inside template',
      '  ${a}',
      '  /* still inside template */',
      '`;',
      'const re = /\\/\\* regex with comment markers \\*\\//;',
      '/* leading comment */ const d = 1;',
      'const e = /* mid-line comment start',
      '  pure comment line inside multi-line comment',
      '*/ 2;'
    ].join('\n');

    // Every line except line 11 (pure comment line inside multi-line block comment) is code.
    expect(countCodeLines(source, 'fixture.ts')).toBe(11);
  });

  it('returns 0 for empty or comments-only files', () => {
    expect(countCodeLines('', 'empty.ts')).toBe(0);
    expect(countCodeLines('// only comment\n/* block */\n\n', 'comments-only.ts')).toBe(0);
  });

  it('counts top-level function and class method bodies using code lines only', () => {
    const source = [
      'export function alpha(): number {',
      '  // comment 1',
      '  // comment 2',
      '',
      '  return 42;',
      '}',
      '',
      'export class Runner {',
      '  public async drive(): Promise<void> {',
      '    /* block comment',
      '       spanning two lines */',
      '    await Promise.resolve();',
      '  }',
      '}'
    ].join('\n');

    expect(topLevelFunctionCodeLines(source, 'fixture.ts')).toEqual([
      { name: 'alpha', startLine: 1, endLine: 6, lines: 3 }
    ]);
    expect(methodCodeLineCount(source, 'public async drive(', 'fixture.ts')).toBe(3);
    expect(methodCodeLineCount(source, 'public async missing(', 'fixture.ts')).toBe(-1);
  });
});
