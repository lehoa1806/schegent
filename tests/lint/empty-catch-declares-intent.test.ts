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
 * The census this gate was written against, measured 2026-08-22: 455 catch clauses
 * across the three trees, of which 82 are statement-free and all 82 now carry a
 * comment. Only the 82 are this gate's business; the other 373 handle their error.
 *
 * The floor below is a tripwire for a gate that has stopped looking — a moved
 * directory, a broken walk, a parser that no longer understands the syntax — not a
 * ratchet on how many catches the repository may have. It is deliberately far under
 * the measured total so that ordinary churn never trips it, and the assertions that
 * actually pin coverage are the per-tree ones: a walk that silently stops reaching
 * `webview-ui/src`, or an extractor that stops finding component script blocks, is
 * still 448 clauses away from any total-count floor.
 */
const KNOWN_STATEMENT_FREE = 82;

interface Clause {
  readonly file: string;
  readonly line: number;
  readonly statementFree: boolean;
  readonly inner: string;
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

const CLAUSES = collect();
const STATEMENT_FREE = CLAUSES.filter(clause => clause.statementFree);

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
});
