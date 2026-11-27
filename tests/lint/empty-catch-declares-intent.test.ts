// Feature 112 (FR-023, FR-024, FR-025) — a catch that discards an error says why.
//
// `no-empty` is configured with `allowEmptyCatch: true`, and that is not a relaxation
// of this rule but the reason this gate exists. The real requirement is "empty, but
// commented", which ESLint cannot express: its rule sees an empty block and has no
// opinion about the trivia inside it. So the rule permits the shape and this gate
// pins the convention.
//
// What it catches is a `catch {}` added in a hurry. That form typechecks, passes
// every test, and reads as deliberate — while the next reader of the file cannot tell
// a decision from an oversight, and a swallowed error that was never meant to be
// swallowed is the hardest class of bug to find from a log. The convention was
// already followed at 81 of 82 sites when this feature measured it; one bare
// `catch {}` in src/parser/invocation-usage.ts was the exception, and this gate is
// what stops the 83rd from being the next one.
//
// The parse is TypeScript's own, not a brace scan: `catch` blocks nest inside
// closures, template literals and object literals, and a scanner that gets that wrong
// either misses clauses or invents them. `.svelte` files are covered by parsing their
// script blocks — all of them, since Svelte 5 components carry a `<script module>`
// alongside the instance script, and a catch in either is a catch.
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** The trees a catch clause of this repository can live in. */
const SCANNED = ['src', 'tests', 'webview-ui/src'] as const;

const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'coverage', '.vscode-test']);
const PARSED = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.svelte']);

/**
 * Refreshed census, measured 2026-11-27 (principal-review-2026-11-27-r2 §3.3):
 * 1,464 catch clauses across `src`, `tests`, and `webview-ui/src`, of which 251
 * are statement-free and carry an intent comment (originally measured 2026-08-22
 * at 455 total / 82 statement-free).
 *
 * The floor below is a tripwire for a gate that has stopped looking — a moved
 * directory, a broken walk, a parser that no longer understands the syntax — not a
 * ratchet on how many catches the repository may have. It stays well below the
 * total clause count (1,464) so ordinary churn never trips it, while the per-tree
 * checks pin coverage of `src`, `tests`, and `webview-ui/src` separately.
 */
const KNOWN_STATEMENT_FREE = 251;

/**
 * principal-review-2026-11-27-r2 §3.3 — Shrink-only ratchet for promise
 * `.catch(() => undefined | null | {} | void 0)` handlers in `src/` (including
 * empty-block `.catch(() => {})` and single-return silent handlers).
 *
 * Measured 2026-11-27 after fixing silent compensating-rollback and wakeup
 * catches in `workflow-launcher.ts` (2) and `control-wakeup-planner.ts` (1):
 * 171 sites across `src/` (157 `() => undefined`, 9 `() => null`, 5 empty-block
 * `() => { ... }`, 0 `() => ({})` / `() => void 0`). This ceiling may only shrink.
 */
const MAX_SILENT_PROMISE_CATCHES_IN_SRC = 171;

interface Clause {
  readonly file: string;
  readonly line: number;
  readonly statementFree: boolean;
  readonly inner: string;
}

interface SilentPromiseCatch {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function isSilentReturnExpression(expr: ts.Expression): boolean {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  if (ts.isIdentifier(current) && current.text === 'undefined') return true;
  if (current.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isObjectLiteralExpression(current) && current.properties.length === 0) return true;
  if (
    ts.isVoidExpression(current) &&
    ts.isNumericLiteral(current.expression) &&
    current.expression.text === '0'
  ) {
    return true;
  }
  return false;
}

function isSilentPromiseCatchHandler(node: ts.Expression): boolean {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
  if (ts.isBlock(node.body)) {
    if (node.body.statements.length === 0) return true;
    if (node.body.statements.length === 1) {
      const only = node.body.statements[0];
      if (ts.isReturnStatement(only)) {
        return only.expression === undefined || isSilentReturnExpression(only.expression);
      }
    }
    return false;
  }
  return isSilentReturnExpression(node.body);
}

export function collectSilentPromiseCatchesInSource(
  source: string,
  file: string
): SilentPromiseCatch[] {
  const found: SilentPromiseCatch[] = [];
  const parsed = ts.createSourceFile(
    `${file}.ts`,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS
  );
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'catch' &&
      node.arguments.length >= 1
    ) {
      const handler = node.arguments[0];
      if (isSilentPromiseCatchHandler(handler)) {
        const start = node.getStart(parsed);
        found.push({
          file,
          line: source.slice(0, start).split('\n').length,
          text: source.slice(handler.getStart(parsed), handler.end).replace(/\s+/g, ' ')
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);
  return found;
}

function walk(dir: string, onFile: (absolute: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(absolute, onFile);
      continue;
    }
    if (PARSED.has(extname(absolute))) onFile(absolute);
  }
}

/**
 * Every script block of a component, or the whole file for anything else. Each range
 * is parsed on its own, with its offset carried so reported line numbers point into
 * the original file.
 */
function scriptRanges(source: string, file: string): Array<{ offset: number; text: string }> {
  if (extname(file) !== '.svelte') return [{ offset: 0, text: source }];

  const ranges: Array<{ offset: number; text: string }> = [];
  const open = /<script[^>]*>/g;
  let match = open.exec(source);
  while (match !== null) {
    const start = match.index + match[0].length;
    const close = source.indexOf('</script>', start);
    if (close < 0) break;
    ranges.push({ offset: start, text: source.slice(start, close) });
    open.lastIndex = close;
    match = open.exec(source);
  }
  return ranges;
}

function collect(): Clause[] {
  const clauses: Clause[] = [];

  for (const tree of SCANNED) {
    walk(resolve(REPO_ROOT, tree), absolute => {
      const file = relative(REPO_ROOT, absolute).replace(/\\/g, '/');
      const source = readFileSync(absolute, 'utf8');

      for (const range of scriptRanges(source, absolute)) {
        const parsed = ts.createSourceFile(
          `${file}.ts`,
          range.text,
          ts.ScriptTarget.ES2022,
          true,
          ts.ScriptKind.TS
        );

        const visit = (node: ts.Node): void => {
          if (ts.isCatchClause(node)) {
            // Statements are zero, so anything between the braces is trivia — a
            // comment, or nothing at all. That is precisely the distinction this gate
            // is about, so it reads the text rather than asking the AST.
            const blockStart = node.block.getStart(parsed);
            const inner = range.text.slice(blockStart + 1, node.block.end - 1).trim();
            clauses.push({
              file,
              line: source.slice(0, range.offset + blockStart).split('\n').length,
              statementFree: node.block.statements.length === 0,
              inner
            });
          }
          ts.forEachChild(node, visit);
        };
        ts.forEachChild(parsed, visit);
      }
    });
  }

  return clauses;
}

function collectSilentPromiseCatchesInSrc(): SilentPromiseCatch[] {
  const found: SilentPromiseCatch[] = [];
  walk(resolve(REPO_ROOT, 'src'), absolute => {
    const file = relative(REPO_ROOT, absolute).replace(/\\/g, '/');
    const source = readFileSync(absolute, 'utf8');
    found.push(...collectSilentPromiseCatchesInSource(source, file));
  });
  return found;
}

const CLAUSES = collect();
const STATEMENT_FREE = CLAUSES.filter(clause => clause.statementFree);
const SILENT_PROMISE_CATCHES_IN_SRC = collectSilentPromiseCatchesInSrc();

describe('Feature 112 empty catches declare intent', () => {
  it(`finds at least the ${KNOWN_STATEMENT_FREE} catch clauses this gate was written against`, () => {
    expect(
      CLAUSES.length,
      `only ${CLAUSES.length} catch clauses found across ${SCANNED.join(', ')}. This gate ` +
        `passes trivially when it finds nothing, so a count this low means the walk or ` +
        `the parse stopped working, not that the catches went away.`
    ).toBeGreaterThanOrEqual(KNOWN_STATEMENT_FREE);
  });

  it.each(SCANNED)('reaches %s', tree => {
    const seen = CLAUSES.filter(clause => clause.file.startsWith(`${tree}/`));
    expect(
      seen.length,
      `no catch clause found anywhere under ${tree}, so this gate is not looking at it`
    ).toBeGreaterThan(0);
  });

  it('reaches inside component script blocks', () => {
    const seen = CLAUSES.filter(clause => clause.file.endsWith('.svelte'));
    expect(
      seen.length,
      `no catch clause found in any .svelte file. Either every component stopped ` +
        `catching, or the script-block extraction stopped working — and the second ` +
        `costs nothing to check while the first would be a surprise.`
    ).toBeGreaterThan(0);
  });

  it('finds statement-free catches, so the check below is not vacuous', () => {
    expect(STATEMENT_FREE.length).toBeGreaterThan(0);
  });

  it('every statement-free catch says why the error is discarded', () => {
    const silent = STATEMENT_FREE.filter(
      clause => !clause.inner.includes('//') && !clause.inner.includes('/*')
    ).map(clause => `${clause.file}:${clause.line}`);

    expect(
      silent,
      `these catches discard an error with no statement and no comment, so a reader ` +
        `cannot tell a decision from an oversight. Say what is being swallowed and why ` +
        `— one line is enough:\n  ${silent.join('\n  ')}`
    ).toEqual([]);
  });

  it(`ratchets silent promise .catch(() => undefined|null|{}|void 0) handlers in src/ at ≤ ${MAX_SILENT_PROMISE_CATCHES_IN_SRC}`, () => {
    expect(
      SILENT_PROMISE_CATCHES_IN_SRC.length,
      'anti-vacuity: expected live silent promise .catch handlers in src/ to be observed'
    ).toBeGreaterThan(50);

    const overLimitMessage =
      `Found ${SILENT_PROMISE_CATCHES_IN_SRC.length} silent promise .catch handlers in src/ ` +
      `(ratchet ceiling ${MAX_SILENT_PROMISE_CATCHES_IN_SRC}). Log a sanitized warning or handle ` +
      `the rejection explicitly instead of adding a new silent .catch(() => undefined|null|{}|void 0):\n  ` +
      SILENT_PROMISE_CATCHES_IN_SRC.map(hit => `${hit.file}:${hit.line} (${hit.text})`).join('\n  ');

    expect(SILENT_PROMISE_CATCHES_IN_SRC.length, overLimitMessage).toBeLessThanOrEqual(
      MAX_SILENT_PROMISE_CATCHES_IN_SRC
    );

    const inWakeupPlanner = SILENT_PROMISE_CATCHES_IN_SRC.filter(
      hit => hit.file === 'src/services/workflow-execution/control-wakeup-planner.ts'
    );
    expect(
      inWakeupPlanner,
      'control-wakeup-planner.ts must not reintroduce silent promise .catch handlers'
    ).toEqual([]);
  });

  it('NON-VACUITY: detects every silent promise .catch shape and ignores logging handlers', () => {
    const synthetic = [
      'async function sample(p: Promise<void>, log: { warn(m: string): void }) {',
      '  await p.catch(() => undefined);',
      '  await p.catch(() => null);',
      '  await p.catch(() => ({}));',
      '  await p.catch(() => void 0);',
      '  await p.catch(() => {});',
      '  await p.catch((_err) => { return undefined; });',
      '  await p.catch(function () { return null; });',
      '  await p.catch((err) => { log.warn(String(err)); });',
      '}'
    ].join('\n');

    const hits = collectSilentPromiseCatchesInSource(synthetic, 'fixture/sample.ts');
    expect(hits.map(h => h.line)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });
});
