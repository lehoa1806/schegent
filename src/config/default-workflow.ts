// Feature 285 (OD-2, FR-005, research D1) — which Workflow the surfaces open on.
//
// `schegent.defaultWorkflowId` holds a Workflow ID. The deprecated `schegent.defaultPipelineId`
// is read as a fallback only when the new key is unset at every scope, and counts only when it
// names an effective Workflow, so a stored Pipeline ID is ignored. This is a read: neither key is
// ever written here or by any caller on the operator's behalf (FR-006).
//
// Pure and synchronous, so every case of FR-005 is testable without VS Code.

import type { WorkflowDefinition } from '../contracts/workflow-definitions';

export type DefaultWorkflowScope = 'user' | 'workspace';

/**
 * The two settings reads the resolution needs. Each returns only an explicitly set value at
 * that scope, never the package default, so an unset key reads as `undefined` (research D2).
 * The values are `unknown` because a settings file is operator-edited and may hold anything.
 */
export interface DefaultWorkflowReader {
  getDefaultWorkflowId(scope: DefaultWorkflowScope): unknown;
  getDeprecatedDefaultPipelineId(scope: DefaultWorkflowScope): unknown;
}

/** `''` means "no default" throughout, as it did for the Pipeline default. */
const NO_DEFAULT = '';

function mostSpecific(read: (scope: DefaultWorkflowScope) => unknown): unknown {
  const workspace = read('workspace');
  return workspace !== undefined ? workspace : read('user');
}

/**
 * Resolve the default Workflow ID against the effective Workflows.
 *
 * The new key wins whenever it is set at either scope, including an explicit `''` (the operator
 * chose no default) and a value that names nothing effective. Within a key, workspace beats
 * user. A value that is not a string or names no effective Workflow gives `''`.
 */
export function resolveDefaultWorkflowId(
  reader: DefaultWorkflowReader | undefined,
  effectiveWorkflows: readonly Pick<WorkflowDefinition, 'workflowId'>[]
): string {
  if (reader === undefined) return NO_DEFAULT;
  const current = mostSpecific((scope) => reader.getDefaultWorkflowId(scope));
  const chosen =
    current !== undefined
      ? current
      : mostSpecific((scope) => reader.getDeprecatedDefaultPipelineId(scope));
  if (typeof chosen !== 'string' || chosen === NO_DEFAULT) return NO_DEFAULT;
  return effectiveWorkflows.some((workflow) => workflow.workflowId === chosen) ? chosen : NO_DEFAULT;
}
