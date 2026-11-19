// FR-R7-08 (FR-005, SC-003) — Verification of the TypeScript lexical code-line
// counter used by the LoC budget gates.
//
// Proves that:
//   - single-line comments, block comments, JSDoc blocks, and blank lines are
//     excluded from code-line counts;
//   - inline trailing/leading comments on code lines still count as code;
//   - strings, multi-line template literals (with `${expr}`), and regex
//     literals containing comment markers (`//`, `/* ... */`) are counted as code;
//   - SC-003: adding a three-line comment (and a JSDoc block) to the real
//     `src/controller/phase-runner.ts` source leaves its code-line count and
//     ceiling verdict completely unchanged.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  countCodeLines,
  methodCodeLineCount,
  topLevelFunctionCodeLines
} from './code-lines';

const REPO_ROOT = resolve(__dirname, '..', '..');

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

  it('SC-003: adding a three-line comment to src/controller/phase-runner.ts changes no code-line count or ceiling result', () => {
    const phaseRunnerPath = resolve(REPO_ROOT, 'src/controller/phase-runner.ts');
    const original = readFileSync(phaseRunnerPath, 'utf8');
    const baselineCount = countCodeLines(original, phaseRunnerPath);
    expect(baselineCount, 'vacuity control: phase-runner.ts has substantial code').toBeGreaterThan(500);

    const threeLineComment = [
      '// Explanatory comment line 1 added to verify FR-R7-08 SC-003.',
      '// Explanatory comment line 2 explaining coordinator shell intent.',
      '// Explanatory comment line 3 — must not raise the measured code count.',
      '',
      '/**',
      ' * Additional JSDoc block with @remarks tag.',
      ' */',
      ''
    ].join('\n');

    const withCommentAtTop = `${threeLineComment}${original}`;
    const withCommentInBody = original.replace(
      'export class PhaseRunner',
      `${threeLineComment}export class PhaseRunner`
    );

    expect(withCommentInBody).not.toBe(original);
    expect(countCodeLines(withCommentAtTop, phaseRunnerPath)).toBe(baselineCount);
    expect(countCodeLines(withCommentInBody, phaseRunnerPath)).toBe(baselineCount);
  });
});
