/**
 * FR-R6-F15 (F15-B; F15-FR-01, F15-FR-05, F15-FR-20) — authoring & graph validation for opt-in
 * `WorkflowConnection.contextPolicy` declarations.
 *
 * Extracted from `workflow-definition-validator.ts` so both validators stay under the 1,000-line
 * entry ceiling (`tests/lint/source-loc-budget.test.ts`). Unknown future policy versions fail
 * validation with `unsupported-context-policy-version` while preserving raw display data.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { HandoffPolicy } from '../contracts/phase-context/context-policy';
import {
  WORKFLOW_ID_MAX_LEN,
  type WorkflowDefinition,
  type WorkflowFieldError
} from '../contracts/workflow-definitions';
import { parseHandoffPolicy } from '../services/phase-context/policy';
import { ancestorSets, topologicalOrder, type WorkflowGraphEdge } from './workflow-graph';

const FIELD_MAX = 48;
const CODE_MAX = 64;
const MESSAGE_MAX = 512;

function bounded(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function makeFieldError(
  workflowId: string,
  field: string,
  code: string,
  message: string
): WorkflowFieldError {
  return Object.freeze({
    workflowId: bounded(workflowId || '?', WORKFLOW_ID_MAX_LEN),
    field: bounded(field, FIELD_MAX),
    code: bounded(code, CODE_MAX),
    message: bounded(message, MESSAGE_MAX)
  });
}

export function readConnectionContextPolicy(
  raw: unknown,
  workflowId: string,
  field: string,
  errors: WorkflowFieldError[]
): { readonly ok: boolean; readonly policy: HandoffPolicy | undefined } {
  if (raw === undefined) {
    return { ok: true, policy: undefined };
  }
  const parsed = parseHandoffPolicy(raw);
  if (parsed.kind === 'absent') {
    errors.push(
      makeFieldError(workflowId, field, 'invalid-context-policy', 'Connection contextPolicy must be an object')
    );
    return { ok: false, policy: undefined };
  }
  if (parsed.kind === 'unsupported-version') {
    const versionLabel =
      typeof raw === 'object' && raw !== null && 'version' in raw
        ? String((raw as { readonly version: unknown }).version)
        : '?';
    errors.push(
      makeFieldError(
        workflowId,
        `${field}.version`,
        'unsupported-context-policy-version',
        `Unsupported handoff contextPolicy version '${versionLabel}'; only version 1 is supported`
      )
    );
    return { ok: false, policy: undefined };
  }
  if (parsed.kind === 'invalid') {
    errors.push(
      makeFieldError(
        workflowId,
        field,
        'invalid-context-policy',
        `Invalid connection contextPolicy (${parsed.detail})`
      )
    );
    return { ok: false, policy: undefined };
  }
  const frozenPolicy: HandoffPolicy = Object.freeze({
    version: parsed.policy.version,
    approval: parsed.policy.approval,
    session: parsed.policy.session,
    selectors: Object.freeze(parsed.policy.selectors.map((selector) => Object.freeze({ ...selector })))
  });
  return { ok: true, policy: frozenPolicy };
}

export interface ValidateGraphHandoffPoliciesInput {
  readonly definition: WorkflowDefinition;
  readonly nodeIds: ReadonlySet<string>;
  readonly acyclic: boolean;
  readonly edges: readonly WorkflowGraphEdge[];
}

export function validateWorkflowHandoffPoliciesInGraph(
  input: ValidateGraphHandoffPoliciesInput
): readonly WorkflowFieldError[] {
  const { definition, nodeIds, acyclic, edges } = input;
  const errors: WorkflowFieldError[] = [];
  let scopes: ReadonlyMap<string, ReadonlySet<string>> | null = null;
  if (acyclic) {
    const { order } = topologicalOrder([...nodeIds], edges);
    const ancestors = ancestorSets(order, edges);
    const map = new Map<string, ReadonlySet<string>>();
    for (const [nodeId, set] of ancestors) {
      map.set(nodeId, new Set([...set, nodeId]));
    }
    scopes = map;
  }

  definition.connections.forEach((connection, connIndex) => {
    const policy = connection.contextPolicy;
    if (policy === undefined) return;
    const policyCheck = parseHandoffPolicy(policy);
    if (policyCheck.kind === 'unsupported-version') {
      errors.push(
        makeFieldError(
          definition.workflowId,
          `connections[${connIndex}].contextPolicy.version`,
          'unsupported-context-policy-version',
          'Connection declares an unsupported contextPolicy version'
        )
      );
      return;
    }
    if (policyCheck.kind !== 'valid') {
      errors.push(
        makeFieldError(
          definition.workflowId,
          `connections[${connIndex}].contextPolicy`,
          'invalid-context-policy',
          'Connection declares an invalid contextPolicy'
        )
      );
      return;
    }

    policyCheck.policy.selectors.forEach((selector, selIndex) => {
      const rootSegment = selector.sourceNodePath.split('/')[0] ?? '';
      const field = `connections[${connIndex}].contextPolicy.selectors[${selIndex}]`;
      if (!nodeIds.has(rootSegment)) {
        errors.push(
          makeFieldError(
            definition.workflowId,
            field,
            'context-selector-unknown-node',
            `Handoff selector '${selector.selectorId}' names node '${rootSegment}', which this Workflow does not declare`
          )
        );
        return;
      }
      if (scopes !== null && !scopes.get(connection.from.nodeId)?.has(rootSegment)) {
        errors.push(
          makeFieldError(
            definition.workflowId,
            field,
            'context-selector-not-ancestor',
            `Handoff selector '${selector.selectorId}' names node '${rootSegment}', which has not run when transitioning from '${connection.from.nodeId}'`
          )
        );
      }
    });
  });

  return errors;
}
