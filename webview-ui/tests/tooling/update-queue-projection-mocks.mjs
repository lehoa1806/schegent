#!/usr/bin/env node
// Feature 065 BUG-009 T083 (FR-029 — test-infrastructure leg)
//
// AST-aware mock-projection updater. Scans every `*.ts`, `*.js`, and inline
// `<script>` block inside `*.svelte` files under
// `webview-ui/src/**/__tests__/**` and injects `orderedItems: []` into any
// object literal that matches the `QueueProjection` shape (presence of
// `inFlight`, `pending`, AND `recent` keys; OR a TypeScript annotation
// declaring the value as `QueueProjection`) AND that is missing the
// `orderedItems` key.
//
// **This script is the PRESCRIBED REMEDIATION** when test mocks drift away
// from the `QueueProjection` shape. Engineers MUST NOT use `git checkout`
// or broad regex substitution to repair mock projections — the `git
// checkout` shortcut is what caused the T067 regression discussed in
// BUG-009 issue 4 / issue 7 (inline `<li>` template re-introduced after
// a fixture rollback).
//
// Two modes:
//   - default (no flag): writes updates in-place.
//   - `--check`: dry-run; prints a list of files that would be modified
//     and exits with code 1 if any were found. Wired into CI via the
//     `npm run test:mocks:check` package.json script.
//
// The script is constrained: it ONLY touches files under
// `webview-ui/src/**/__tests__/**`. It refuses to modify production code,
// host code, or any path outside that prefix.
//
// Implementation notes:
//   - Uses the bundled TypeScript compiler API (already a transitive dev
//     dependency through `svelte-check`/`typescript`) to parse `.ts` and
//     `.js` files into a real AST. NO regex matching on the source.
//   - For `.svelte` files, the script extracts the first `<script
//     lang="ts">` or `<script>` block and parses it with the same TS API;
//     the surrounding template / `<style>` is left byte-identical.
//   - Idempotent: when `orderedItems` is already present (even as `[]`
//     or as a non-empty array), the literal is left untouched.

import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { resolve, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const WEBVIEW_UI_ROOT = resolve(SCRIPT_DIR, '..', '..');
const SRC_ROOT = join(WEBVIEW_UI_ROOT, 'src');
const ALLOWED_PREFIX = SRC_ROOT + sep;

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');

function isUnderTestDir(absPath) {
  // Allow only files whose path contains a `__tests__` segment AND that
  // sit under `webview-ui/src/`.
  if (!absPath.startsWith(ALLOWED_PREFIX)) return false;
  const parts = relative(SRC_ROOT, absPath).split(sep);
  return parts.includes('__tests__');
}

function collectCandidateFiles(rootDir) {
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (!/\.(ts|js|svelte)$/.test(name)) continue;
      if (!isUnderTestDir(full)) continue;
      out.push(full);
    }
  }
  walk(rootDir);
  return out;
}

function extractScriptBlock(svelteSource) {
  const m = svelteSource.match(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/);
  if (!m) return null;
  const open = m[0].indexOf(m[2]);
  return {
    body: m[2],
    bodyStart: m.index + open,
    bodyEnd: m.index + open + m[2].length
  };
}

function objectHasKey(objLit, keyName) {
  for (const prop of objLit.properties) {
    if (
      (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
      prop.name &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
      prop.name.text === keyName
    ) {
      return true;
    }
    if (ts.isSpreadAssignment(prop)) {
      // We cannot statically prove what a spread expands to. Be conservative —
      // assume the spread may already contribute the key and skip insertion.
      if (keyName === 'orderedItems') return true;
    }
  }
  return false;
}

function isQueueProjectionShape(objLit) {
  // A literal is treated as a full `QueueProjection` only when it carries
  // all four discriminating keys. `Partial<QueueProjection>` override
  // literals (e.g., `buildQueue({ inFlight, pending, recent })` arguments)
  // typically omit `paused`, so requiring it keeps the tool from injecting
  // an empty `orderedItems` that would override a helper's derivation.
  return (
    objectHasKey(objLit, 'inFlight') &&
    objectHasKey(objLit, 'pending') &&
    objectHasKey(objLit, 'recent') &&
    objectHasKey(objLit, 'paused')
  );
}

function hasQueueProjectionAnnotation(node) {
  // The literal is treated as annotated ONLY when the annotation applies
  // directly to it — `const x: QueueProjection = { ... }` or `{ ... } as
  // QueueProjection` or `Object.freeze({ ... }) as QueueProjection`. The
  // walk must NOT cross into a CallExpression-as-argument or another
  // enclosing ObjectLiteral, otherwise nested literals (e.g. a
  // `buildQueueItem({...})` argument inside a `QueueProjection`-annotated
  // variable) would be falsely flagged.
  let current = node.parent;
  let crossedFreeze = false;
  while (current) {
    if (
      (ts.isVariableDeclaration(current) ||
        ts.isParameter(current) ||
        ts.isPropertySignature(current) ||
        ts.isPropertyDeclaration(current)) &&
      current.type &&
      ts.isTypeReferenceNode(current.type) &&
      ts.isIdentifier(current.type.typeName) &&
      current.type.typeName.text === 'QueueProjection'
    ) {
      return true;
    }
    if (
      ts.isAsExpression(current) &&
      ts.isTypeReferenceNode(current.type) &&
      ts.isIdentifier(current.type.typeName) &&
      current.type.typeName.text === 'QueueProjection'
    ) {
      return true;
    }
    // Allow at most one `Object.freeze({...})` wrapper, then stop.
    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      const isObjectFreeze =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'Object' &&
        callee.name.text === 'freeze';
      if (isObjectFreeze && !crossedFreeze) {
        crossedFreeze = true;
        current = current.parent;
        continue;
      }
      return false;
    }
    // Stop on enclosing object literals, arrays, return statements — these
    // contexts mean the annotation (if any) applies to the enclosing scope
    // rather than to `node` directly.
    if (
      ts.isObjectLiteralExpression(current) ||
      ts.isArrayLiteralExpression(current) ||
      ts.isReturnStatement(current) ||
      ts.isArrowFunction(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isMethodDeclaration(current)
    ) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

function findInsertions(sourceFile) {
  const insertions = [];
  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const shapeMatches = isQueueProjectionShape(node);
      const annotated = !shapeMatches && hasQueueProjectionAnnotation(node);
      if ((shapeMatches || annotated) && !objectHasKey(node, 'orderedItems')) {
        insertions.push(computeInsertion(sourceFile, node));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return insertions;
}

function computeInsertion(sourceFile, objLit) {
  // Strategy: insert right after the opening `{` so the new key appears as
  // the FIRST property — that keeps diffs small and avoids issues with
  // trailing commas / closing-brace whitespace.
  const text = sourceFile.text;
  const openBracePos = objLit.getStart(sourceFile); // position of `{`
  const afterBrace = openBracePos + 1;
  // Detect indentation of the next existing property to match style.
  const firstProp = objLit.properties[0];
  let indent = '';
  if (firstProp) {
    const propStart = firstProp.getStart(sourceFile);
    const lineStart = text.lastIndexOf('\n', propStart - 1) + 1;
    indent = text.slice(lineStart, propStart);
  }
  // If the object is single-line (`{ a: 1, b: 2 }`), keep it single-line.
  const closeBracePos = objLit.getEnd() - 1;
  const between = text.slice(afterBrace, closeBracePos);
  const isMultiLine = between.includes('\n');
  let injected;
  if (isMultiLine) {
    injected = `\n${indent}orderedItems: [],`;
  } else {
    injected = ` orderedItems: [],`;
  }
  return { offset: afterBrace, insertText: injected };
}

function applyInsertions(text, insertions) {
  // Apply from highest offset to lowest so earlier offsets remain valid.
  const sorted = [...insertions].sort((a, b) => b.offset - a.offset);
  let out = text;
  for (const ins of sorted) {
    out = out.slice(0, ins.offset) + ins.insertText + out.slice(ins.offset);
  }
  return out;
}

function processTsLikeSource(filePath, source, scriptKind) {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const insertions = findInsertions(sf);
  if (insertions.length === 0) return null;
  return applyInsertions(source, insertions);
}

function processFile(filePath) {
  const source = readFileSync(filePath, 'utf8');
  if (filePath.endsWith('.svelte')) {
    const block = extractScriptBlock(source);
    if (!block) return null;
    const updatedScript = processTsLikeSource(filePath, block.body, ts.ScriptKind.TS);
    if (updatedScript === null) return null;
    return source.slice(0, block.bodyStart) + updatedScript + source.slice(block.bodyEnd);
  }
  const kind = filePath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return processTsLikeSource(filePath, source, kind);
}

function main() {
  const files = collectCandidateFiles(SRC_ROOT);
  const modified = [];
  for (const file of files) {
    let updated;
    try {
      updated = processFile(file);
    } catch (err) {
      // Surface parse errors loudly; do not silently skip.
      process.stderr.write(`error parsing ${relative(WEBVIEW_UI_ROOT, file)}: ${err.message}\n`);
      process.exitCode = 2;
      continue;
    }
    if (updated === null) continue;
    modified.push(file);
    if (!CHECK_ONLY) {
      writeFileSync(file, updated, 'utf8');
    }
  }
  if (modified.length === 0) {
    process.stdout.write('queue-projection mocks: all in sync.\n');
    return;
  }
  const label = CHECK_ONLY ? 'would update' : 'updated';
  process.stdout.write(`queue-projection mocks: ${label} ${modified.length} file(s):\n`);
  for (const f of modified) {
    process.stdout.write(`  ${relative(WEBVIEW_UI_ROOT, f)}\n`);
  }
  if (CHECK_ONLY) {
    process.stdout.write(
      '\nRun `node webview-ui/tests/tooling/update-queue-projection-mocks.mjs` to apply.\n'
    );
    process.exit(1);
  }
}

main();
