// FR-R3-200 — a script under scripts/ asks "was Node started on me?" in one place.
//
// WHAT WENT WRONG. The secret scan ended with a line that compared its own module URL with
// the path Node was started on. A module URL is percent-encoded and names the file with its
// symlinks resolved; the start path is neither. So when the checkout's path held a space, an
// accented letter or a symlinked directory, the comparison was false, the scan never ran,
// and the gate that runs it passed. Eight other scripts had written the same question by
// hand. Only the link checker's version resolved symlinks on both sides, and it kept that
// to itself in a private function.
//
// WHY A GATE. The fix is one shared function, `invokedAsScript`. Fixing the nine call sites
// does nothing about a tenth script that writes the comparison afresh the next time someone
// needs an entry check, and writes it the short way. This gate makes the short way fail: no
// file under scripts/ may read the start path, except the shared module that answers the
// question.
//
// HOW A READ IS FOUND. By syntax tree, not by text: the start path is `process.argv[1]`, and a
// text match for it would flag a comment that mentions it and miss `process['argv'][1]`. A read
// is an element access of index 1 on `process.argv`, with the names and the index written as
// literals, through any parentheses, `!`, `as`, angle-bracket assertion or `satisfies`. The
// planted cases at the foot run the matcher on source this file writes, so the matcher is
// proved on both sides and not only against the tree as it happens to be today.
//
// A second check keeps the first from being satisfied by deleting the guard: each of the nine
// guarded scripts must import the function by its own name, and a call with its own module URL
// must decide a top-level `if`, as its condition or through a `const` the condition names. A
// negated condition counts only with an `else`, which is where the canary does its work. A
// script that defines a local `invokedAsScript`, or makes the call and ignores the answer,
// fails it. What the branch it decides then does is not checked.
//
// WHAT IT DOES NOT SEE. A read written some other way, for example through `globalThis.process`,
// a named import of `argv` from `node:process`, an alias such as `const args = process.argv`
// read as `args[1]`, destructuring, `process.argv.at(1)`, a non-literal index such as
// `process.argv[START_INDEX]`, or `process.argv` defaulted with `??` or `||`. None exists under
// scripts/ today. A call that reaches the start path is not followed.
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { filesUnder } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** Every extension a script under the scripts directory can carry. */
const EXTENSIONS = ['.mjs', '.js', '.cjs', '.mts', '.cts', '.ts'] as const;

/** The one file allowed to read the start path, excluded by its path from the repository root. */
const SHARED_MODULE = 'scripts/invoked-as-script.mjs';

/** How a guarded script, beside it in the scripts directory, names it in an import. */
const SHARED_SPECIFIER = './invoked-as-script.mjs';

/** The name the shared module exports and each guarded script imports. */
const SHARED_FUNCTION = 'invokedAsScript';

/** The scripts that do their work only when started, and are otherwise imported. */
const GUARDED_SCRIPTS = [
  'scripts/backend-canary-run.mjs',
  'scripts/census-lint-gates.mjs',
  'scripts/check-doc-links.mjs',
  'scripts/check-gate-coverage-parity.mjs',
  'scripts/check-manifest-versions.mjs',
  'scripts/check-vsix-smoke.mjs',
  'scripts/current-control-facts.mjs',
  'scripts/gate-distance.mjs',
  'scripts/scan-secrets.mjs'
] as const;

interface Read {
  readonly line: number;
  readonly text: string;
}

function parse(name: string, text: string): ts.SourceFile {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
}

const SCANNED = filesUnder(resolve(REPO_ROOT, 'scripts'), { extensions: EXTENSIONS }).map(
  file => ({
    path: relative(REPO_ROOT, file).replace(/\\/g, '/'),
    source: parse(file, readFileSync(file, 'utf8'))
  })
);

/** The expression with every wrapper that changes its type and not its value taken off. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isLiteral(node: ts.Node, text: string): boolean {
  if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return false;
  return node.text === text;
}

function isProcess(node: ts.Expression): boolean {
  const inner = unwrap(node);
  return ts.isIdentifier(inner) && inner.text === 'process';
}

/** `process.argv` or `process['argv']`, optional chaining included. */
function isArgv(node: ts.Expression): boolean {
  const inner = unwrap(node);
  if (ts.isPropertyAccessExpression(inner)) {
    return inner.name.text === 'argv' && isProcess(inner.expression);
  }
  if (ts.isElementAccessExpression(inner)) {
    return isLiteral(unwrap(inner.argumentExpression), 'argv') && isProcess(inner.expression);
  }
  return false;
}

/** The index that names the path Node was started on: `1`, `1n`, or the string `'1'`. */
function isStartIndex(node: ts.Expression): boolean {
  const inner = unwrap(node);
  if (ts.isNumericLiteral(inner)) return Number(inner.text) === 1;
  if (ts.isBigIntLiteral(inner)) return Number(inner.text.slice(0, -1)) === 1;
  return isLiteral(inner, '1');
}

function readsIn(source: ts.SourceFile): Read[] {
  const reads: Read[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isElementAccessExpression(node) &&
      isStartIndex(node.argumentExpression) &&
      isArgv(node.expression)
    ) {
      reads.push({
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        text: node.getText(source).replace(/\s+/g, ' ')
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reads;
}

/** `import { invokedAsScript } from './invoked-as-script.mjs'`, with no rename. */
function importsSharedFunction(source: ts.SourceFile): boolean {
  return source.statements.some(statement => {
    if (!ts.isImportDeclaration(statement)) return false;
    if (!isLiteral(statement.moduleSpecifier, SHARED_SPECIFIER)) return false;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) return false;
    return bindings.elements.some(
      element => element.propertyName === undefined && element.name.text === SHARED_FUNCTION
    );
  });
}

/** `import.meta.url`. */
function isOwnUrl(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'url' &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.expression.name.text === 'meta'
  );
}

/** A call of the shared function with exactly one argument, the script's own URL. */
function isOwnUrlCall(node: ts.Expression): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === SHARED_FUNCTION &&
    node.arguments.length === 1 &&
    node.arguments.every(isOwnUrl)
  );
}

/** Names a top-level `const` binds to that call, as the canary binds `isEntryPoint`. */
function namesBoundToOwnUrlCall(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const { name, initializer } of statement.declarationList.declarations) {
      if (ts.isIdentifier(name) && initializer !== undefined && isOwnUrlCall(unwrap(initializer))) {
        names.add(name.text);
      }
    }
  }
  return names;
}

/** No statement, `;`, or `{}`. */
function isEmpty(statement: ts.Statement | undefined): boolean {
  if (statement === undefined || ts.isEmptyStatement(statement)) return true;
  return ts.isBlock(statement) && statement.statements.length === 0;
}

/**
 * A top-level `if` the call decides: its condition is the call, or a `const` bound to it, and
 * the branch taken when the script was started is not empty. Under a negated condition that
 * branch is the `else`.
 */
function guardsWithOwnUrl(source: ts.SourceFile): boolean {
  const bound = namesBoundToOwnUrlCall(source);
  const isAnswer = (node: ts.Expression): boolean => {
    const inner = unwrap(node);
    return isOwnUrlCall(inner) || (ts.isIdentifier(inner) && bound.has(inner.text));
  };
  return source.statements.some(statement => {
    if (!ts.isIfStatement(statement)) return false;
    const condition = unwrap(statement.expression);
    if (isAnswer(condition)) return !isEmpty(statement.thenStatement);
    const negated =
      ts.isPrefixUnaryExpression(condition) &&
      condition.operator === ts.SyntaxKind.ExclamationToken &&
      isAnswer(condition.operand);
    return negated && !isEmpty(statement.elseStatement);
  });
}

/** Source text, and the name it is parsed under: `.mjs` for JavaScript, `.ts` for types. */
type Planted = [source: string, name: string];

const FLAGGED: Planted[] = [
  ['if (import.meta.url === `file://${process.argv[1]}`) main();', 'planted.mjs'],
  ['if (resolve(process.argv[1]) === here) main();', 'planted.mjs'],
  ["process['argv'][1]", 'planted.mjs'],
  ["process.argv['1']", 'planted.mjs'],
  ['process.argv[`1`]', 'planted.mjs'],
  ['process.argv[(1)]', 'planted.mjs'],
  ['process.argv[1n]', 'planted.mjs'],
  ['process.argv?.[1]', 'planted.mjs'],
  ['process?.argv[1]', 'planted.mjs'],
  ['(process.argv)[1]', 'planted.mjs'],
  ['(process).argv[1]', 'planted.mjs'],
  ["process[('argv')][1]", 'planted.mjs'],
  ['process.argv![1]', 'planted.ts'],
  ['(process.argv as string[])[1]', 'planted.ts'],
  ['(<string[]>process.argv)[1]', 'planted.ts'],
  ['(process.argv satisfies string[])[1]', 'planted.ts'],
  ["process['argv' as const][1]", 'planted.ts']
];

const NOT_FLAGGED: Planted[] = [
  ['// compare process.argv[1] with the module URL', 'planted.mjs'],
  ["const note = 'process.argv[1]';", 'planted.mjs'],
  ['process.argv[2]', 'planted.mjs'],
  ['process.argv[2n]', 'planted.mjs'],
  ['process.argv.slice(2)', 'planted.mjs'],
  ["process.argv.includes('--check')", 'planted.mjs']
];

/** A shape a guarded script's entry check can take, and source text that has it. */
type Shape = [shape: string, source: string];

/** Shapes in which the call decides whether the script does its work. */
const GUARDING: Shape[] = [
  ['the call deciding a block', 'if (invokedAsScript(import.meta.url)) {\n  main();\n}'],
  ['the call deciding a statement', 'if (invokedAsScript(import.meta.url)) main();'],
  [
    'a const bound to the call, negated, with the work in its else',
    [
      'const isEntryPoint = invokedAsScript(import.meta.url);',
      'if (!isEntryPoint) {',
      '  console.error(note);',
      '} else {',
      '  main();',
      '}'
    ].join('\n')
  ]
];

/** Shapes that make the call and let its answer decide nothing. */
const NOT_GUARDING: Shape[] = [
  ['the call as a statement, the work after it', 'invokedAsScript(import.meta.url);\nmain();'],
  ['the call negated, with no else', 'if (!invokedAsScript(import.meta.url)) {\n  main();\n}'],
  [
    'a const bound to the call that no condition reads',
    'const started = invokedAsScript(import.meta.url);\nmain();'
  ],
  ['the call deciding an empty block', 'if (invokedAsScript(import.meta.url)) {}\nmain();'],
  [
    'the call deciding inside a function',
    'function start() {\n  if (invokedAsScript(import.meta.url)) main();\n}\nstart();'
  ]
];

describe('no script under scripts/ reads process.argv[1] except through invokedAsScript (FR-R3-200)', () => {
  it('reads at least one script', () => {
    expect(SCANNED.length).toBeGreaterThan(0);
  });

  it('reads each of the nine guarded scripts', () => {
    const paths = SCANNED.map(file => file.path);
    expect(GUARDED_SCRIPTS.filter(path => !paths.includes(path))).toEqual([]);
  });

  it('reads the shared module the exclusion names', () => {
    expect(SCANNED.filter(file => file.path === SHARED_MODULE).length).toBeGreaterThan(0);
  });

  it('finds reads in the shared module, so the matcher still matches real code', () => {
    const shared = SCANNED.find(file => file.path === SHARED_MODULE);
    const reads = shared === undefined ? [] : readsIn(shared.source);
    expect(reads.length).toBeGreaterThan(0);
  });

  it('has no read of the start path outside the shared module', () => {
    const offenders = SCANNED.filter(file => file.path !== SHARED_MODULE)
      .flatMap(file => readsIn(file.source).map(read => `${file.path}:${read.line} ${read.text}`))
      .sort();
    expect(offenders).toEqual([]);
  });

  it('has each guarded script import the function and branch on it with its own URL', () => {
    const lacking = GUARDED_SCRIPTS.filter(path => {
      const file = SCANNED.find(scanned => scanned.path === path);
      return (
        file === undefined || !importsSharedFunction(file.source) || !guardsWithOwnUrl(file.source)
      );
    });
    expect(lacking).toEqual([]);
  });

  describe('the matcher, on source text it is given', () => {
    it.each(FLAGGED)('flags %s', (source, name) => {
      expect(readsIn(parse(name, source)).length).toBe(1);
    });

    it.each(NOT_FLAGGED)('does not flag %s', (source, name) => {
      expect(readsIn(parse(name, source)).length).toBe(0);
    });
  });

  describe('the positive control, on source text it is given', () => {
    it.each(GUARDING)('accepts %s', (_shape, source) => {
      expect(guardsWithOwnUrl(parse('planted.mjs', source))).toBe(true);
    });

    it.each(NOT_GUARDING)('refuses %s', (_shape, source) => {
      expect(guardsWithOwnUrl(parse('planted.mjs', source))).toBe(false);
    });
  });
});
