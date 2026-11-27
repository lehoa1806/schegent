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
export const CONTROL_ACTION_KINDS = readStringArray('src/contracts/sidebar-ipc/workflow-run.ts', 'CONTROL_ACTION_KINDS');
export const CONTROL_COMMAND_REFUSAL_REASONS = readStringArray('src/contracts/sidebar-ipc/workflow-run.ts', 'CONTROL_COMMAND_REFUSAL_REASONS');
export const SUPPRESSIBLE_SNAPSHOT_SLICES = readStringArray('src/contracts/snapshot-bounds.ts', 'SUPPRESSIBLE_SNAPSHOT_SLICES');
export const CANDIDATE_AVAILABILITY_POLICIES = readStringArray('src/contracts/workflow-controls.ts', 'CANDIDATE_AVAILABILITY_POLICIES');
export const CANDIDATE_BUDGET_MODES = readStringArray('src/contracts/workflow-controls.ts', 'CANDIDATE_BUDGET_MODES');
export const REPEAT_ON_EXHAUSTED_POLICIES = readStringArray('src/contracts/workflow-controls.ts', 'REPEAT_ON_EXHAUSTED_POLICIES');
export const FOR_EACH_ON_ITEM_ERROR_POLICIES = readStringArray('src/contracts/workflow-controls.ts', 'FOR_EACH_ON_ITEM_ERROR_POLICIES');
export const RETRY_CAP_OUTCOMES = readStringArray('src/contracts/process-definitions.ts', 'RETRY_CAP_OUTCOMES');
export const PHASE_EFFORT_LEVELS = readStringArray('src/contracts/process-definitions.ts', 'PHASE_EFFORT_LEVELS');
export const PHASE_SIDE_EFFECTS = readStringArray('src/contracts/process-definitions.ts', 'PHASE_SIDE_EFFECTS');
export const PHASE_EVIDENCE_POLICIES = readStringArray('src/contracts/process-definitions.ts', 'PHASE_EVIDENCE_POLICIES');
export const EVIDENCE_POLICY_ORIGINS = readStringArray('src/contracts/process-definitions.ts', 'EVIDENCE_POLICY_ORIGINS');
export const PHASE_HOST_VERIFICATIONS = readStringArray('src/contracts/process-definitions.ts', 'PHASE_HOST_VERIFICATIONS');
export const NATIVE_REVIEW_KINDS = readStringArray('src/contracts/process-definitions.ts', 'NATIVE_REVIEW_KINDS');
export const ALL_PHASE_CAPABILITIES = readStringArray('src/contracts/phase-capabilities.ts', 'ALL_PHASE_CAPABILITIES');
export const RUN_OUTPUT_STATUSES = readStringArray('src/contracts/run-results.ts', 'RUN_OUTPUT_STATUSES');
export const CONTAINMENT_EFFECTS = readStringArray('src/contracts/containment-qualification.ts', 'CONTAINMENT_EFFECTS');
export const EFFECT_OUTCOMES = readStringArray('src/contracts/containment-qualification.ts', 'EFFECT_OUTCOMES');
export const EVIDENCE_BASES = readStringArray('src/contracts/containment-qualification.ts', 'EVIDENCE_BASES');
export const IDENTITY_STATES = readStringArray('src/contracts/containment-qualification.ts', 'IDENTITY_STATES');
export const EXECUTION_BRANCH_DISPOSITIONS = readStringArray('src/contracts/execution-decision-observation.ts', 'EXECUTION_BRANCH_DISPOSITIONS');
export const EXECUTION_DECISION_EXIT_REASONS = readStringArray('src/contracts/execution-decision-observation.ts', 'EXECUTION_DECISION_EXIT_REASONS');
export const EXECUTION_DECISION_LIMIT_ORIGINS = readStringArray('src/contracts/execution-decision-observation.ts', 'EXECUTION_DECISION_LIMIT_ORIGINS');
export const WORKFLOW_NODE_KINDS = readStringArray('src/contracts/workflow-definitions.ts', 'WORKFLOW_NODE_KINDS');
export const WORKFLOW_HANDOFF_MODES = readStringArray('src/contracts/workflow-definitions.ts', 'WORKFLOW_HANDOFF_MODES');
export const WORKFLOW_SELECTION_RULES = readStringArray('src/contracts/workflow-definitions.ts', 'WORKFLOW_SELECTION_RULES');
export const WORKFLOW_CONDITION_OPERATORS = readStringArray('src/contracts/workflow-definitions.ts', 'WORKFLOW_CONDITION_OPERATORS');
export const DECISION_FIELD_TYPES = readStringArray('src/contracts/decision-results.ts', 'DECISION_FIELD_TYPES');
export const RESULT_OPERATOR_KINDS = readStringArray('src/contracts/decision-results.ts', 'RESULT_OPERATOR_KINDS');
export const RESULT_CONTRACT_SOURCE_KINDS = readStringArray('src/contracts/decision-results.ts', 'RESULT_CONTRACT_SOURCE_KINDS');
export const TYPED_CONDITION_OPERATORS = readStringArray('src/contracts/decision-results.ts', 'TYPED_CONDITION_OPERATORS');
export const APPROVAL_MODES = readStringArray('src/contracts/phase-context/context-policy.ts', 'APPROVAL_MODES');
export const SESSION_POLICIES = readStringArray('src/contracts/phase-context/context-policy.ts', 'SESSION_POLICIES');
