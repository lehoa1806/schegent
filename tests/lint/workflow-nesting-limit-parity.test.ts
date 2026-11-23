// FR-R7-14 (14-21) — the host workflow closure resolver and the webview
// Workflow Builder editor must agree on MAX_WORKFLOW_NESTING_DEPTH (8).
//
// Host validation (`src/config/workflow-closure-resolver.ts`) and webview
// authoring preview (`webview-ui/src/components/PipelineBuilderEditors/workflow-catalog-state.ts`)
// sit on opposite sides of the CJS/ESM bundle boundary, so each declares
// `MAX_WORKFLOW_NESTING_DEPTH`. This gate parses both declarations from source
// via the TypeScript AST and cross-checks them against the live host runtime
// export so a future edit to either side cannot silently diverge.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { MAX_WORKFLOW_NESTING_DEPTH as HOST_MAX_WORKFLOW_NESTING_DEPTH } from '../../src/config/workflow-closure-resolver';

const REPO_ROOT = resolve(__dirname, '..', '..');
const HOST_FILE = 'src/config/workflow-closure-resolver.ts';
const WEBVIEW_FILE = 'webview-ui/src/components/PipelineBuilderEditors/workflow-catalog-state.ts';
const EXPECTED_NESTING_DEPTH = 8;
const CONSTANT_NAME = 'MAX_WORKFLOW_NESTING_DEPTH';

function readExportedNumericConstant(source: string, fileName: string, name: string): number | null {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const isExported = statement.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (!isExported) continue;
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== name) continue;
      if (decl.initializer === undefined) return null;
      if (ts.isNumericLiteral(decl.initializer)) {
        return Number(decl.initializer.text);
      }
      if (
        ts.isAsExpression(decl.initializer) &&
        ts.isNumericLiteral(decl.initializer.expression)
      ) {
        return Number(decl.initializer.expression.text);
      }
      return null;
    }
  }
  return null;
}

describe('FR-R7-14 (14-21) — host and webview MAX_WORKFLOW_NESTING_DEPTH stay in lockstep', () => {
  const hostSource = readFileSync(resolve(REPO_ROOT, HOST_FILE), 'utf8');
  const webviewSource = readFileSync(resolve(REPO_ROOT, WEBVIEW_FILE), 'utf8');

  it('declares MAX_WORKFLOW_NESTING_DEPTH === 8 in the host closure resolver', () => {
    const hostDeclared = readExportedNumericConstant(hostSource, HOST_FILE, CONSTANT_NAME);
    expect(
      hostDeclared,
      `${HOST_FILE} must export numeric literal ${CONSTANT_NAME}`
    ).toBe(EXPECTED_NESTING_DEPTH);
    expect(HOST_MAX_WORKFLOW_NESTING_DEPTH).toBe(EXPECTED_NESTING_DEPTH);
  });

  it('declares the exact same MAX_WORKFLOW_NESTING_DEPTH in the webview workflow catalog state', () => {
    const webviewDeclared = readExportedNumericConstant(webviewSource, WEBVIEW_FILE, CONSTANT_NAME);
    expect(
      webviewDeclared,
      `${WEBVIEW_FILE} must export numeric literal ${CONSTANT_NAME} matching ${HOST_FILE}`
    ).toBe(HOST_MAX_WORKFLOW_NESTING_DEPTH);
    expect(webviewDeclared).toBe(EXPECTED_NESTING_DEPTH);
  });

  it('control: detects missing or drifted declarations in synthetic sources', () => {
    expect(
      readExportedNumericConstant('export const MAX_WORKFLOW_NESTING_DEPTH = 7;', 'synthetic.ts', CONSTANT_NAME)
    ).toBe(7);
    expect(
      readExportedNumericConstant('const MAX_WORKFLOW_NESTING_DEPTH = 8;', 'synthetic.ts', CONSTANT_NAME)
    ).toBeNull();
    expect(
      readExportedNumericConstant('export const OTHER_LIMIT = 8;', 'synthetic.ts', CONSTANT_NAME)
    ).toBeNull();
  });
});
