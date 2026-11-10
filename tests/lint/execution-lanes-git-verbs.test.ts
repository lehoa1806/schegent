// FR-R6-F10 T041 (FR-013, docs/hard-rules.md) — the lane engine names no destructive Git verb.
//
// The engine runs Git through argument vectors, so every verb it can ever pass is a string
// literal somewhere under the lane source tree. This gate parses each file with TypeScript's own
// parser, takes every string literal and template text, splits it on whitespace, and fails on any
// token in the forbidden set: `--force`, `-f`, `reset`, `rebase`, `stash`, `push`, `checkout`,
// `clean`, `--hard`. Splitting on whitespace means `reset --hard` inside one literal is caught, and
// a word inside a longer identifier such as `lane-not-clean` is not.
//
// `-f` is refused anywhere in the tree, not only beside `worktree`: no lane command needs it, and
// the stricter rule cannot miss a vector assembled across two literals.
//
// A planted source string proves the extractor matches, and a floor on the literals that name
// `worktree` proves the walk reaches the engine at all.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const LANE_TREE = join(REPO_ROOT, 'src', 'services', 'execution-lanes');
const FORBIDDEN = new Set(['--force', '-f', 'reset', 'rebase', 'stash', 'push', 'checkout', 'clean', '--hard']);
const WORKTREE_TOKEN = 'worktree';
/** Measured 2026-11-10: five engine files pass `worktree` to Git. A floor, not a ratchet. */
const MIN_WORKTREE_LITERALS = 3;

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly token: string;
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(absolute));
    else if (entry.name.endsWith('.ts')) files.push(absolute);
  }
  return files;
}

function isLiteralText(node: ts.Node): node is ts.StringLiteralLike | ts.TemplateLiteralLikeNode {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  );
}

/** Every whitespace-separated token of every string literal and template text in `text`. */
function literalTokens(fileName: string, text: string): { readonly token: string; readonly line: number }[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const tokens: { token: string; line: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (isLiteralText(node)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      for (const token of node.text.split(/\s+/)) if (token.length > 0) tokens.push({ token, line });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return tokens;
}

function forbiddenHits(fileName: string, text: string): Hit[] {
  return literalTokens(fileName, text)
    .filter(({ token }) => FORBIDDEN.has(token))
    .map(({ token, line }) => ({ file: fileName, line, token }));
}

describe('FR-R6-F10 lane engine: no destructive Git verb (T041)', () => {
  it('the extractor finds a planted forbidden verb in every literal form', () => {
    const planted = [
      "run(['worktree', 'remove', '-f', path]);",
      "const verb = 'reset --hard';",
      'const tail = `git ${x} rebase`;',
      'const plain = `stash`;',
      "const fine = 'lane-not-clean';"
    ].join('\n');
    const hits = forbiddenHits('planted.ts', planted).map((hit) => `${hit.line}:${hit.token}`);
    expect(hits).toEqual(['1:-f', '2:reset', '2:--hard', '3:rebase', '4:stash']);
  });

  it('the walk reaches the engine: several literals name worktree', () => {
    const count = sourceFiles(LANE_TREE)
      .flatMap((file) => literalTokens(file, readFileSync(file, 'utf8')))
      .filter(({ token }) => token === WORKTREE_TOKEN).length;
    expect(count).toBeGreaterThanOrEqual(MIN_WORKTREE_LITERALS);
  });

  it('no literal under the lane source tree carries a forbidden verb', () => {
    const hits = sourceFiles(LANE_TREE).flatMap((file) =>
      forbiddenHits(relative(REPO_ROOT, file), readFileSync(file, 'utf8'))
    );
    expect(hits).toEqual([]);
  });
});
