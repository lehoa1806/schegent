// FR-R5-F02 (T06) — Scoped data binding resolution for composable Workflows.
//
// Control transitions (`connections`) and data bindings (`bindings`) are
// deliberately separate:
//   * A node receives ONLY the inputs explicitly bound to it from `workflow-input`
//     or a completed upstream `node-output` within the SAME `WorkflowInvocationFrame`
//     (plus any operator launch/continuation overrides).
//   * A parent Workflow receives ONLY the child Workflow's declared public
//     `outputs` resolved through `output` bindings upon completion.
//   * Failed, canceled, or unvisited upstream node attempts never satisfy a
//     `node-output` or `output` binding.
//   * Sibling or parent invocation frames are never visible to a child frame's
//     binding resolver.
//
// Pure and headless: no `vscode` import, no filesystem or network I/O.

import type {
  PipelineInputPortType,
  PipelineOutputPortType
} from '../../contracts/pipeline-definitions';
import type { ResolvedPortValue } from '../../contracts/run-request';
import type {
  WorkflowDefinition,
  WorkflowInputBinding,
  WorkflowOutputBinding,
  WorkflowSelectionRule
} from '../../contracts/workflow-definitions';
import type {
  NodeAttemptRecord,
  WorkflowInvocationFrame
} from '../../state/connected-workflow-run';

export type BindingFailureCode =
  | 'missing-required-input'
  | 'missing-required-output'
  | 'collection-selection-violation';

export type BindingResolutionResult =
  | {
      readonly ok: true;
      readonly resolvedByPort: Readonly<Record<string, ResolvedPortValue>>;
    }
  | {
      readonly ok: false;
      readonly code: BindingFailureCode;
      readonly field: string;
      readonly message: string;
    };

export interface TargetInputPortSpec {
  readonly portId: string;
  readonly type?: PipelineInputPortType;
  readonly required?: boolean;
}

export interface ResolveNodeInputBindingsInput {
  readonly workflow: WorkflowDefinition;
  readonly frame: WorkflowInvocationFrame;
  readonly targetNodeId: string;
  readonly targetInputPorts?: readonly TargetInputPortSpec[];
  readonly overrideInputsByPort?: Readonly<Record<string, ResolvedPortValue>>;
}

export interface ResolveWorkflowPublicOutputsInput {
  readonly workflow: WorkflowDefinition;
  readonly frame: WorkflowInvocationFrame;
}

/**
 * Return the most recent completed attempt for `nodeId` inside `frame`, or
 * `undefined` if `nodeId` has never completed in this invocation frame.
 *
 * Failed, canceled, and in-flight attempts are ignored so partial or faulted
 * work never leaks into downstream bindings.
 */
export function latestCompletedAttemptForNode(
  frame: WorkflowInvocationFrame,
  nodeId: string
): NodeAttemptRecord | undefined {
  const attempts = frame.attemptsByNodeId[nodeId];
  if (!attempts || attempts.length === 0) {
    return undefined;
  }
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const candidate = attempts[index];
    if (candidate !== undefined && candidate.status === 'completed') {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Apply a structured `WorkflowSelectionRule` (`'first' | 'last' | 'exactlyOne'`)
 * to a port value without any expression grammar.
 */
export function applyCollectionSelection(
  selection: WorkflowSelectionRule | undefined,
  candidate: ResolvedPortValue,
  targetPortId: string
):
  | { readonly ok: true; readonly value: ResolvedPortValue }
  | { readonly ok: false; readonly message: string } {
  if (selection === undefined) {
    return {
      ok: true,
      value: Object.freeze({
        ...candidate,
        portId: targetPortId,
        ...(candidate.items !== undefined ? { items: Object.freeze([...candidate.items]) } : {})
      })
    };
  }

  const items =
    candidate.items !== undefined
      ? candidate.items
      : candidate.value.trim().length === 0
        ? []
        : [candidate.value];

  if (selection === 'first') {
    if (items.length === 0) {
      return {
        ok: false,
        message: `Collection selection 'first' on port '${targetPortId}' requires at least 1 item, but received 0.`
      };
    }
    const chosen = items[0]!;
    return {
      ok: true,
      value: Object.freeze({
        portId: targetPortId,
        type: candidate.type,
        value: chosen,
        items: Object.freeze([chosen])
      })
    };
  }

  if (selection === 'last') {
    if (items.length === 0) {
      return {
        ok: false,
        message: `Collection selection 'last' on port '${targetPortId}' requires at least 1 item, but received 0.`
      };
    }
    const chosen = items[items.length - 1]!;
    return {
      ok: true,
      value: Object.freeze({
        portId: targetPortId,
        type: candidate.type,
        value: chosen,
        items: Object.freeze([chosen])
      })
    };
  }

  // selection === 'exactlyOne'
  if (items.length !== 1) {
    return {
      ok: false,
      message: `Collection selection 'exactlyOne' on port '${targetPortId}' requires exactly 1 item, but received ${items.length}.`
    };
  }
  const sole = items[0]!;
  return {
    ok: true,
    value: Object.freeze({
      portId: targetPortId,
      type: candidate.type,
      value: sole,
      items: Object.freeze([sole])
    })
  };
}

/**
 * Resolve all input bindings targeting `targetNodeId` within `frame`.
 */
export function resolveNodeInputBindings(
  input: ResolveNodeInputBindingsInput
): BindingResolutionResult {
  const resolved: Record<string, ResolvedPortValue> = {};

  const inputBindings = (input.workflow.bindings ?? []).filter(
    (binding): binding is WorkflowInputBinding =>
      binding.kind === 'input' && binding.nodeId === input.targetNodeId
  );

  for (const binding of inputBindings) {
    const field = `nodes.${input.targetNodeId}.inputs.${binding.inputKey}`;
    const isRequired = binding.required !== false;

    let rawSourceValue: ResolvedPortValue | undefined;
    if (binding.source.from === 'workflow-input') {
      rawSourceValue = input.frame.boundInputs[binding.source.portId];
    } else {
      const completedAttempt = latestCompletedAttemptForNode(input.frame, binding.source.nodeId);
      rawSourceValue = completedAttempt?.declaredOutputs[binding.source.portId];
    }

    if (rawSourceValue === undefined) {
      if (isRequired && input.overrideInputsByPort?.[binding.inputKey] === undefined) {
        return {
          ok: false,
          code: 'missing-required-input',
          field,
          message:
            binding.source.from === 'workflow-input'
              ? `Required input '${binding.inputKey}' on node '${input.targetNodeId}' could not be resolved from workflow input '${binding.source.portId}'.`
              : `Required input '${binding.inputKey}' on node '${input.targetNodeId}' could not be resolved from completed output '${binding.source.nodeId}.${binding.source.portId}'.`
        };
      }
      continue;
    }

    const selected = applyCollectionSelection(
      binding.selection,
      {
        ...rawSourceValue,
        ...(binding.type !== undefined ? { type: binding.type } : {})
      },
      binding.inputKey
    );
    if (!selected.ok) {
      return {
        ok: false,
        code: 'collection-selection-violation',
        field,
        message: selected.message
      };
    }

    resolved[binding.inputKey] = selected.value;
  }

  if (input.overrideInputsByPort !== undefined) {
    for (const [portId, overrideValue] of Object.entries(input.overrideInputsByPort)) {
      resolved[portId] = Object.freeze({
        ...overrideValue,
        portId,
        ...(overrideValue.items !== undefined
          ? { items: Object.freeze([...overrideValue.items]) }
          : {})
      });
    }
  }

  for (const portSpec of input.targetInputPorts ?? []) {
    if (portSpec.required !== true) continue;
    const bound = resolved[portSpec.portId];
    if (bound === undefined || bound.value.trim().length === 0) {
      return {
        ok: false,
        code: 'missing-required-input',
        field: `nodes.${input.targetNodeId}.inputs.${portSpec.portId}`,
        message: `Required input port '${portSpec.portId}' on node '${input.targetNodeId}' is missing.`
      };
    }
  }

  return {
    ok: true,
    resolvedByPort: Object.freeze(resolved)
  };
}

/**
 * Resolve the public `outputs` of `workflow` when `frame` completes along its
 * selected path (`{ kind: 'return' }` or a terminal sink node).
 */
export function resolveWorkflowPublicOutputs(
  input: ResolveWorkflowPublicOutputsInput
): BindingResolutionResult {
  const resolved: Record<string, ResolvedPortValue> = {};
  const declaredOutputsById = new Map(
    (input.workflow.outputs ?? []).map((port) => [port.portId, port])
  );

  const outputBindings = (input.workflow.bindings ?? []).filter(
    (binding): binding is WorkflowOutputBinding => binding.kind === 'output'
  );

  for (const binding of outputBindings) {
    const completedAttempt = latestCompletedAttemptForNode(input.frame, binding.nodeId);
    if (completedAttempt === undefined) {
      continue;
    }
    const sourceKey = binding.sourcePortId ?? binding.outputKey ?? binding.portId;
    const rawValue = completedAttempt.declaredOutputs[sourceKey];
    if (rawValue === undefined) {
      continue;
    }

    const declaredPort = declaredOutputsById.get(binding.portId);
    const portType: PipelineOutputPortType =
      binding.type ?? declaredPort?.type ?? (rawValue.type as PipelineOutputPortType);

    const selected = applyCollectionSelection(
      binding.selection,
      {
        ...rawValue,
        type: portType
      },
      binding.portId
    );
    if (!selected.ok) {
      return {
        ok: false,
        code: 'collection-selection-violation',
        field: `outputs.${binding.portId}`,
        message: selected.message
      };
    }

    resolved[binding.portId] = selected.value;
  }

  for (const outputPort of input.workflow.outputs ?? []) {
    const isRequired = outputPort.required !== false;
    if (!isRequired) continue;
    const value = resolved[outputPort.portId];
    if (value === undefined || value.value.trim().length === 0) {
      return {
        ok: false,
        code: 'missing-required-output',
        field: `outputs.${outputPort.portId}`,
        message: `Required public output '${outputPort.portId}' of Workflow '${input.workflow.workflowId}' was not produced on the selected path.`
      };
    }
  }

  return {
    ok: true,
    resolvedByPort: Object.freeze(resolved)
  };
}

