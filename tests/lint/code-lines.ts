// FR-R7-08 — TypeScript lexical code-line counter for LoC budget gates.
//
// Counts distinct lines containing at least one non-comment, non-whitespace
// TypeScript syntax token, so explanatory comments, JSDoc blocks, and blank
// spacing never trip a size ceiling or force a budget-bump ceremony.
//
// Uses `ts.createSourceFile` AST leaf-token traversal rather than regexes or a
// bare scanner: regexes misread comment markers inside strings/templates/regex
// literals, and a bare scanner without parser re-scan mis-lexes template tails
// after `${expr}` and includes leading trivia in `getTokenPos()`.
import { readFileSync } from 'node:fs';
import ts from 'typescript';

export interface FunctionCodeLineSpan {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly lines: number;
}

function codeLineIndicesFromSourceFile(sourceFile: ts.SourceFile): ReadonlySet<number> {
  const codeLines = new Set<number>();

  const markRange = (start: number, end: number): void => {
    if (end <= start) return;
    const startLine = sourceFile.getLineAndCharacterOfPosition(start).line;
    const endLine = sourceFile.getLineAndCharacterOfPosition(end - 1).line;
    for (let line = startLine; line <= endLine; line += 1) {
      codeLines.add(line);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJSDoc(node)) return;
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      if (
        node.kind !== ts.SyntaxKind.EndOfFileToken &&
        node.kind !== ts.SyntaxKind.SyntaxList
      ) {
        markRange(node.getStart(sourceFile, false), node.getEnd());
      }
      return;
    }
    for (const child of children) {
      visit(child);
    }
  };

  visit(sourceFile);
  return codeLines;
}

/**
 * Returns the set of 0-based line indices that contain at least one non-trivia
 * TypeScript syntax token (excluding single-line comments, block comments,
 * JSDoc blocks, and blank/whitespace-only lines).
 */
export function codeLineIndices(content: string, fileName = 'file.ts'): ReadonlySet<number> {
  if (content.length === 0) return new Set();
  const sourceFile = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  return codeLineIndicesFromSourceFile(sourceFile);
}

/** Count of distinct code lines in a TypeScript source string. */
export function countCodeLines(content: string, fileName = 'file.ts'): number {
  return codeLineIndices(content, fileName).size;
}

/** Count of distinct code lines in a TypeScript source file on disk. */
export function countFileCodeLines(absPath: string): number {
  return countCodeLines(readFileSync(absPath, 'utf8'), absPath);
}

/** Count of code lines within an inclusive 0-based line range `[startLine0, endLine0]`. */
export function countCodeLinesInRange(
  codeLines: ReadonlySet<number>,
  startLine0: number,
  endLine0: number
): number {
  let count = 0;
  for (let line = startLine0; line <= endLine0; line += 1) {
    if (codeLines.has(line)) count += 1;
  }
  return count;
}

/**
 * Top-level function declarations in a TypeScript source string and their
 * code-line counts (excluding comments and blank lines inside the function).
 */
export function topLevelFunctionCodeLines(
  content: string,
  fileName = 'file.ts'
): ReadonlyArray<FunctionCodeLineSpan> {
  if (content.length === 0) return [];
  const sourceFile = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const codeLines = codeLineIndicesFromSourceFile(sourceFile);
  const found: FunctionCodeLineSpan[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || statement.name === undefined) continue;
    const startLine0 = sourceFile.getLineAndCharacterOfPosition(
      statement.getStart(sourceFile, false)
    ).line;
    const endLine0 = sourceFile.getLineAndCharacterOfPosition(statement.getEnd()).line;
    found.push({
      name: statement.name.text,
      startLine: startLine0 + 1,
      endLine: endLine0 + 1,
      lines: countCodeLinesInRange(codeLines, startLine0, endLine0)
    });
  }
  return found;
}

/**
 * Counts code lines of the first class method matching `signatureSubstring`
 * (checked against the method's non-trivia declaration text), or `-1` when not found.
 */
export function methodCodeLineCount(
  content: string,
  signatureSubstring: string,
  fileName = 'file.ts'
): number {
  if (content.length === 0) return -1;
  const sourceFile = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const codeLines = codeLineIndicesFromSourceFile(sourceFile);

  let result = -1;
  const visit = (node: ts.Node): void => {
    if (result !== -1) return;
    if (ts.isMethodDeclaration(node)) {
      const startPos = node.getStart(sourceFile, false);
      const bodyStart = node.body !== undefined ? node.body.getStart(sourceFile, false) : node.getEnd();
      const header = content.slice(startPos, bodyStart);
      if (header.includes(signatureSubstring)) {
        const startLine0 = sourceFile.getLineAndCharacterOfPosition(startPos).line;
        const endLine0 = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line;
        result = countCodeLinesInRange(codeLines, startLine0, endLine0);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}
