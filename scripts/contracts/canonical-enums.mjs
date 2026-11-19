// Reads canonical closed enumerations directly from their authoritative
// `src/contracts/*.ts` source modules so descriptors never restate them
// (coordinating cleanly with FR-R7-06 for `SUPPORTED_BACKENDS`).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function unwrap(node) {
  let current = node;
  while (
    ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  if (
    ts.isCallExpression(current)
    && ts.isPropertyAccessExpression(current.expression)
    && current.expression.getText() === 'Object.freeze'
    && current.arguments.length > 0
  ) {
    return unwrap(current.arguments[0]);
  }
  return current;
}

function readStringArray(relativePath, constName) {
  const fullPath = path.join(REPO_ROOT, relativePath);
  const text = fs.readFileSync(fullPath, 'utf8');
  const sf = ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = null;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === constName && node.initializer) {
      const arr = unwrap(node.initializer);
      if (ts.isArrayLiteralExpression(arr)) {
        found = arr.elements.map((el) => {
          const v = unwrap(el);
          if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) return v.text;
          throw new Error(`${relativePath}: non-string element in ${constName}`);
        });
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!found || found.length === 0) {
    throw new Error(`${relativePath}: could not extract string array ${constName}`);
  }
  return Object.freeze(found);
}

export const SUPPORTED_BACKENDS = readStringArray('src/contracts/backend-kinds.ts', 'SUPPORTED_BACKENDS');
export const QUEUE_FAILURE_POLICIES = readStringArray('src/contracts/queue-failure-policy.ts', 'QUEUE_FAILURE_POLICIES');
export const CATALOG_KINDS = readStringArray('src/contracts/catalog-store.ts', 'CATALOG_KINDS');
export const CATALOG_LIFECYCLE_KINDS = Object.freeze([...CATALOG_KINDS, 'pipeline']);
export const PIPELINE_INPUT_PORT_TYPES = readStringArray('src/contracts/pipeline-definitions.ts', 'PIPELINE_INPUT_PORT_TYPES');
export const PIPELINE_OUTPUT_PORT_TYPES = readStringArray('src/contracts/pipeline-definitions.ts', 'PIPELINE_OUTPUT_PORT_TYPES');
export const COMMAND_ACK_OUTCOMES = readStringArray('src/contracts/command-outcome.ts', 'COMMAND_ACK_OUTCOMES');
export const WORKFLOW_CONTROL_ACTIONS = readStringArray('src/contracts/sidebar-ipc/workflow-run.ts', 'WORKFLOW_CONTROL_ACTIONS');
