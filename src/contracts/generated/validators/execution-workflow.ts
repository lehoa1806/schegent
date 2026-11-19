// GENERATED FILE — do not edit.
//
// Emitted from scripts/contracts/ipc-descriptors/execution-workflow.mjs by scripts/generate-contract-schemas.mjs.
// Edit the descriptor and run: npm run contracts:generate

import {
  CMD_CONTINUE_WORKFLOW,
  CMD_DECIDE_PHASE_HANDOFF,
  CMD_LAUNCH_PIPELINE,
  CMD_LAUNCH_WORKFLOW,
  CMD_OPEN_CHANGE_REVIEW,
  CMD_READ_EXECUTION_VISIBILITY,
  type ContinueWorkflowCommand,
  type DecidePhaseHandoffCommand,
  type LaunchPipelineCommand,
  type LaunchWorkflowCommand,
  type OpenChangeReviewCommand,
  type ReadExecutionVisibilityCommand
} from '../../sidebar-ipc';
import { fail, isSafePathSegment, hasUnexpectedKeys, ok, type IpcValidationResult } from '../../validators/shared';
import { IDENTIFIER_PATTERN } from '../../phase-context/context-policy';
import { isControlCommandEnvelope } from '../../sidebar-ipc/workflow-run';
import { validRunRequest } from '../../validators/run-request-shape';
import type { ControlCommandEnvelope, WorkflowControlAction } from '../../sidebar-ipc/workflow-run';

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 256 && (isSafePathSegment(value) || IDENTIFIER_PATTERN.test(value));
}

const BASE64URL_CURSOR = /^[A-Za-z0-9_-]+$/;

export function validateLaunchPipeline(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_LAUNCH_PIPELINE, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['request', 'queueId'])) {
    return fail('invalid-payload', { type: CMD_LAUNCH_PIPELINE, correlationId });
  }
  const validated_requestRaw: unknown = validatedObj['request'];
  if (!validRunRequest(validated_requestRaw)) {
    return fail('invalid-payload', { type: CMD_LAUNCH_PIPELINE, correlationId });
  }
  const validated_request = validated_requestRaw;
  const validated_queueIdRaw: unknown = validatedObj['queueId'];
  let validated_queueId: string | undefined;
  if (validated_queueIdRaw !== undefined) {
    if (typeof validated_queueIdRaw !== 'string') {
      return fail('invalid-payload', { type: CMD_LAUNCH_PIPELINE, correlationId });
    }
    if (validated_queueIdRaw.length < 1 || validated_queueIdRaw.length > 256) {
      return fail('invalid-payload', { type: CMD_LAUNCH_PIPELINE, correlationId });
    }
    const validated_queueIdChecked: string = validated_queueIdRaw;
    validated_queueId = validated_queueIdChecked;
  }
  const validated = { request: validated_request, ...(validated_queueId === undefined ? {} : { queueId: validated_queueId }) };
  const command: LaunchPipelineCommand = { type: CMD_LAUNCH_PIPELINE, correlationId, payload: validated };
  return ok(command);
}

export function validateLaunchWorkflow(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_LAUNCH_WORKFLOW, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['workflowId', 'startNodeId', 'request', 'queueId'])) {
    return fail('invalid-payload', { type: CMD_LAUNCH_WORKFLOW, correlationId });
  }
  const validated_workflowIdRaw: unknown = validatedObj['workflowId'];
  if (typeof validated_workflowIdRaw !== 'string') {
    return fail('invalid-payload', { type: CMD_LAUNCH_WORKFLOW, correlationId });
  }
  if (validated_workflowIdRaw.length < 1 || validated_workflowIdRaw.length > 64) {
    return fail('invalid-payload', { type: CMD_LAUNCH_WORKFLOW, correlationId });
  }
  const validated_workflowId: string = validated_workflowIdRaw;
  const validated_startNodeIdRaw: unknown = validatedObj['startNodeId'];
  if (typeof validated_startNodeIdRaw !== 'string') {
    return fail('invalid-payload', { type: CMD_LAUNCH_WORKFLOW, correlationId });
  }
  if (validated_startNodeIdRaw.length < 1 || validated_startNodeIdRaw.length > 64) {
    return fail('invalid-payload', { type: CMD_LAUNCH_WORKFLOW, correlationId });
  }
  const validated_startNodeId: string = validated_startNodeIdRaw;
  const validated_requestRaw: unknown = validatedObj['request'];
  if (!validRunRequest(validated_requestRaw)) {
    return fail('invalid-payload', { type: CMD_LAUNCH_WORKFLOW, correlationId });
  }
  const validated_request = validated_requestRaw;
  const validated_queueIdRaw: unknown = validatedObj['queueId'];
  let validated_queueId: string | undefined;
  if (validated_queueIdRaw !== undefined) {
    if (typeof validated_queueIdRaw !== 'string') {
      return fail('invalid-payload', { type: CMD_LAUNCH_WORKFLOW, correlationId });
    }
    if (validated_queueIdRaw.length < 1 || validated_queueIdRaw.length > 256) {
      return fail('invalid-payload', { type: CMD_LAUNCH_WORKFLOW, correlationId });
    }
    const validated_queueIdChecked: string = validated_queueIdRaw;
    validated_queueId = validated_queueIdChecked;
  }
  const validated = { workflowId: validated_workflowId, startNodeId: validated_startNodeId, request: validated_request, ...(validated_queueId === undefined ? {} : { queueId: validated_queueId }) };
  const command: LaunchWorkflowCommand = { type: CMD_LAUNCH_WORKFLOW, correlationId, payload: validated };
  return ok(command);
}

export function validateContinueWorkflow(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_CONTINUE_WORKFLOW, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['connectedRunId', 'expectedRevision', 'nodeId', 'request', 'invocationId', 'operation', 'commandId', 'controlCommand'])) {
    return fail('invalid-payload', { type: CMD_CONTINUE_WORKFLOW, correlationId });
  }
  const validated_connectedRunIdRaw: unknown = validatedObj['connectedRunId'];
  if (typeof validated_connectedRunIdRaw !== 'string') {
    return fail('invalid-payload', { type: CMD_CONTINUE_WORKFLOW, correlationId });
  }
  if (validated_connectedRunIdRaw.length < 1 || validated_connectedRunIdRaw.length > 128) {
    return fail('invalid-payload', { type: CMD_CONTINUE_WORKFLOW, correlationId });
  }
  const validated_connectedRunId: string = validated_connectedRunIdRaw;
  const validated_expectedRevisionRaw: unknown = validatedObj['expectedRevision'];
  if (typeof validated_expectedRevisionRaw !== 'number' || !Number.isInteger(validated_expectedRevisionRaw) || validated_expectedRevisionRaw < 0) {
    return fail('invalid-payload', { type: CMD_CONTINUE_WORKFLOW, correlationId });
  }
  const validated_expectedRevision: number = validated_expectedRevisionRaw;
  const validated_nodeIdRaw: unknown = validatedObj['nodeId'];
  if (typeof validated_nodeIdRaw !== 'string') {
    return fail('invalid-payload', { type: CMD_CONTINUE_WORKFLOW, correlationId });
  }
  if (validated_nodeIdRaw.length < 1 || validated_nodeIdRaw.length > 64) {
    return fail('invalid-payload', { type: CMD_CONTINUE_WORKFLOW, correlationId });
  }
  const validated_nodeId: string = validated_nodeIdRaw;
  const validated_requestRaw: unknown = validatedObj['request'];
  if (!validRunRequest(validated_requestRaw)) {
    return fail('invalid-payload', { type: CMD_CONTINUE_WORKFLOW, correlationId });
  }
  const validated_request = validated_requestRaw;
  const validated_invocationIdRaw: unknown = validatedObj['invocationId'];
  let validated_invocationId: string | undefined;
  if (validated_invocationIdRaw !== undefined) {
    if (typeof validated_invocationIdRaw !== 'string') {
      return fail('invalid-payload', { type: CMD_CONTINUE_WORKFLOW, correlationId });
    }
    if (validated_invocationIdRaw.length < 1 || validated_invocationIdRaw.length > 65536) {
      return fail('invalid-payload', { type: CMD_CONTINUE_WORKFLOW, correlationId });
    }
    const validated_invocationIdChecked: string = validated_invocationIdRaw;
    validated_invocationId = validated_invocationIdChecked;
  }
  const validated_operationRaw: unknown = validatedObj['operation'];
  let validated_operation: WorkflowControlAction | undefined;
  if (validated_operationRaw !== undefined) {
    if (!(validated_operationRaw === 'pause' || validated_operationRaw === 'resume' || validated_operationRaw === 'cancel' || validated_operationRaw === 'retry-phase' || validated_operationRaw === 'retry-invocation' || validated_operationRaw === 'continue-handoff')) {
      return fail('invalid-payload', { type: CMD_CONTINUE_WORKFLOW, correlationId });
    }
    const validated_operationChecked: 'pause' | 'resume' | 'cancel' | 'retry-phase' | 'retry-invocation' | 'continue-handoff' = validated_operationRaw;
    validated_operation = validated_operationChecked;
  }
  const validated_commandIdRaw: unknown = validatedObj['commandId'];
  let validated_commandId: string | undefined;
  if (validated_commandIdRaw !== undefined) {
    if (typeof validated_commandIdRaw !== 'string') {
      return fail('invalid-payload', { type: CMD_CONTINUE_WORKFLOW, correlationId });
    }
    if (validated_commandIdRaw.length < 1 || validated_commandIdRaw.length > 65536) {
      return fail('invalid-payload', { type: CMD_CONTINUE_WORKFLOW, correlationId });
    }
    const validated_commandIdChecked: string = validated_commandIdRaw;
    validated_commandId = validated_commandIdChecked;
  }
  const validated_controlCommandRaw: unknown = validatedObj['controlCommand'];
  let validated_controlCommand: ControlCommandEnvelope | undefined;
  if (validated_controlCommandRaw !== undefined) {
    if (!isControlCommandEnvelope(validated_controlCommandRaw)) {
      return fail('invalid-payload', { type: CMD_CONTINUE_WORKFLOW, correlationId });
    }
    const validated_controlCommandChecked = validated_controlCommandRaw;
    validated_controlCommand = validated_controlCommandChecked;
  }
  const validated = { connectedRunId: validated_connectedRunId, expectedRevision: validated_expectedRevision, nodeId: validated_nodeId, request: validated_request, ...(validated_invocationId === undefined ? {} : { invocationId: validated_invocationId }), ...(validated_operation === undefined ? {} : { operation: validated_operation }), ...(validated_commandId === undefined ? {} : { commandId: validated_commandId }), ...(validated_controlCommand === undefined ? {} : { controlCommand: validated_controlCommand }) };
  const command: ContinueWorkflowCommand = { type: CMD_CONTINUE_WORKFLOW, correlationId, payload: validated };
  return ok(command);
}

export function validateReadExecutionVisibility(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_READ_EXECUTION_VISIBILITY, correlationId });
  }
  const pObj = rawPayload as Record<string, unknown>;
  const disc: unknown = pObj['op'];
  switch (disc) {
    case 'attemptDetail': {
      if (hasUnexpectedKeys(pObj, ['op', 'rootExecutionId', 'invocationId', 'attemptId'])) {
        return fail('unexpected-payload-fields', { type: CMD_READ_EXECUTION_VISIBILITY, correlationId });
      }
      const arm_rootExecutionIdRaw: unknown = pObj['rootExecutionId'];
      if (!isBoundedIdentifier(arm_rootExecutionIdRaw)) {
        return fail('invalid-rootExecutionId', { type: CMD_READ_EXECUTION_VISIBILITY, correlationId });
      }
      const arm_rootExecutionId: string = arm_rootExecutionIdRaw;
      const arm_invocationIdRaw: unknown = pObj['invocationId'];
      let arm_invocationId: string | undefined;
      if (arm_invocationIdRaw !== undefined) {
        if (!isBoundedIdentifier(arm_invocationIdRaw)) {
          return fail('invalid-invocationId', { type: CMD_READ_EXECUTION_VISIBILITY, correlationId });
        }
        const arm_invocationIdChecked: string = arm_invocationIdRaw;
        arm_invocationId = arm_invocationIdChecked;
      }
      const arm_attemptIdRaw: unknown = pObj['attemptId'];
      let arm_attemptId: string | undefined;
      if (arm_attemptIdRaw !== undefined) {
        if (!isBoundedIdentifier(arm_attemptIdRaw)) {
          return fail('invalid-attemptId', { type: CMD_READ_EXECUTION_VISIBILITY, correlationId });
        }
        const arm_attemptIdChecked: string = arm_attemptIdRaw;
        arm_attemptId = arm_attemptIdChecked;
      }
      const command: ReadExecutionVisibilityCommand = { type: CMD_READ_EXECUTION_VISIBILITY, correlationId, payload: { op: 'attemptDetail', rootExecutionId: arm_rootExecutionId, ...(arm_invocationId === undefined ? {} : { invocationId: arm_invocationId }), ...(arm_attemptId === undefined ? {} : { attemptId: arm_attemptId }) } };
      return ok(command);
    }
    case 'runtimePosture': {
      if (hasUnexpectedKeys(pObj, ['op'])) {
        return fail('unexpected-payload-fields', { type: CMD_READ_EXECUTION_VISIBILITY, correlationId });
      }
      const command: ReadExecutionVisibilityCommand = { type: CMD_READ_EXECUTION_VISIBILITY, correlationId, payload: { op: 'runtimePosture' } };
      return ok(command);
    }
    default:
      return fail('invalid-op', { type: CMD_READ_EXECUTION_VISIBILITY, correlationId });
  }
}

export function validateOpenChangeReview(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_OPEN_CHANGE_REVIEW, correlationId });
  }
  const pObj = rawPayload as Record<string, unknown>;
  const disc: unknown = pObj['op'];
  switch (disc) {
    case 'open': {
      if (hasUnexpectedKeys(pObj, ['op', 'requestId', 'expectedRevision', 'openInEditor'])) {
        return fail('unexpected-payload-fields', { type: CMD_OPEN_CHANGE_REVIEW, correlationId });
      }
      const arm_requestIdRaw: unknown = pObj['requestId'];
      if (!isBoundedIdentifier(arm_requestIdRaw)) {
        return fail('invalid-requestId', { type: CMD_OPEN_CHANGE_REVIEW, correlationId });
      }
      const arm_requestId: string = arm_requestIdRaw;
      const arm_expectedRevisionRaw: unknown = pObj['expectedRevision'];
      let arm_expectedRevision: string | undefined;
      if (arm_expectedRevisionRaw !== undefined) {
        if (!isBoundedIdentifier(arm_expectedRevisionRaw)) {
          return fail('invalid-expectedRevision', { type: CMD_OPEN_CHANGE_REVIEW, correlationId });
        }
        const arm_expectedRevisionChecked: string = arm_expectedRevisionRaw;
        arm_expectedRevision = arm_expectedRevisionChecked;
      }
      const arm_openInEditorRaw: unknown = pObj['openInEditor'];
      let arm_openInEditor: boolean | undefined;
      if (arm_openInEditorRaw !== undefined) {
        if (typeof arm_openInEditorRaw !== 'boolean') {
          return fail('invalid-openInEditor', { type: CMD_OPEN_CHANGE_REVIEW, correlationId });
        }
        const arm_openInEditorChecked: boolean = arm_openInEditorRaw;
        arm_openInEditor = arm_openInEditorChecked;
      }
      const command: OpenChangeReviewCommand = { type: CMD_OPEN_CHANGE_REVIEW, correlationId, payload: { op: 'open', requestId: arm_requestId, ...(arm_expectedRevision === undefined ? {} : { expectedRevision: arm_expectedRevision }), ...(arm_openInEditor === undefined ? {} : { openInEditor: arm_openInEditor }) } };
      return ok(command);
    }
    case 'refresh': {
      if (hasUnexpectedKeys(pObj, ['op', 'reviewId', 'openInEditor'])) {
        return fail('unexpected-payload-fields', { type: CMD_OPEN_CHANGE_REVIEW, correlationId });
      }
      const arm_reviewIdRaw: unknown = pObj['reviewId'];
      if (!isBoundedIdentifier(arm_reviewIdRaw)) {
        return fail('invalid-reviewId', { type: CMD_OPEN_CHANGE_REVIEW, correlationId });
      }
      const arm_reviewId: string = arm_reviewIdRaw;
      const arm_openInEditorRaw: unknown = pObj['openInEditor'];
      let arm_openInEditor: boolean | undefined;
      if (arm_openInEditorRaw !== undefined) {
        if (typeof arm_openInEditorRaw !== 'boolean') {
          return fail('invalid-openInEditor', { type: CMD_OPEN_CHANGE_REVIEW, correlationId });
        }
        const arm_openInEditorChecked: boolean = arm_openInEditorRaw;
        arm_openInEditor = arm_openInEditorChecked;
      }
      const command: OpenChangeReviewCommand = { type: CMD_OPEN_CHANGE_REVIEW, correlationId, payload: { op: 'refresh', reviewId: arm_reviewId, ...(arm_openInEditor === undefined ? {} : { openInEditor: arm_openInEditor }) } };
      return ok(command);
    }
    case 'classify': {
      if (hasUnexpectedKeys(pObj, ['op', 'reviewId'])) {
        return fail('unexpected-payload-fields', { type: CMD_OPEN_CHANGE_REVIEW, correlationId });
      }
      const arm_reviewIdRaw: unknown = pObj['reviewId'];
      if (!isBoundedIdentifier(arm_reviewIdRaw)) {
        return fail('invalid-reviewId', { type: CMD_OPEN_CHANGE_REVIEW, correlationId });
      }
      const arm_reviewId: string = arm_reviewIdRaw;
      const command: OpenChangeReviewCommand = { type: CMD_OPEN_CHANGE_REVIEW, correlationId, payload: { op: 'classify', reviewId: arm_reviewId } };
      return ok(command);
    }
    case 'close': {
      if (hasUnexpectedKeys(pObj, ['op', 'reviewId'])) {
        return fail('unexpected-payload-fields', { type: CMD_OPEN_CHANGE_REVIEW, correlationId });
      }
      const arm_reviewIdRaw: unknown = pObj['reviewId'];
      if (!isBoundedIdentifier(arm_reviewIdRaw)) {
        return fail('invalid-reviewId', { type: CMD_OPEN_CHANGE_REVIEW, correlationId });
      }
      const arm_reviewId: string = arm_reviewIdRaw;
      const command: OpenChangeReviewCommand = { type: CMD_OPEN_CHANGE_REVIEW, correlationId, payload: { op: 'close', reviewId: arm_reviewId } };
      return ok(command);
    }
    case 'page': {
      if (hasUnexpectedKeys(pObj, ['op', 'cursor'])) {
        return fail('unexpected-payload-fields', { type: CMD_OPEN_CHANGE_REVIEW, correlationId });
      }
      const arm_cursorRaw: unknown = pObj['cursor'];
      if (typeof arm_cursorRaw !== 'string') {
        return fail('invalid-cursor', { type: CMD_OPEN_CHANGE_REVIEW, correlationId });
      }
      if (arm_cursorRaw.length < 1 || arm_cursorRaw.length > 256 || !BASE64URL_CURSOR.test(arm_cursorRaw)) {
        return fail('invalid-cursor', { type: CMD_OPEN_CHANGE_REVIEW, correlationId });
      }
      const arm_cursor: string = arm_cursorRaw;
      const command: OpenChangeReviewCommand = { type: CMD_OPEN_CHANGE_REVIEW, correlationId, payload: { op: 'page', cursor: arm_cursor } };
      return ok(command);
    }
    case 'cancelOpen': {
      if (hasUnexpectedKeys(pObj, ['op'])) {
        return fail('unexpected-payload-fields', { type: CMD_OPEN_CHANGE_REVIEW, correlationId });
      }
      const command: OpenChangeReviewCommand = { type: CMD_OPEN_CHANGE_REVIEW, correlationId, payload: { op: 'cancelOpen' } };
      return ok(command);
    }
    default:
      return fail('invalid-op', { type: CMD_OPEN_CHANGE_REVIEW, correlationId });
  }
}

export function validateDecidePhaseHandoff(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_DECIDE_PHASE_HANDOFF, correlationId });
  }
  const pObj = rawPayload as Record<string, unknown>;
  const disc: unknown = pObj['op'];
  switch (disc) {
    case 'approve': {
      if (hasUnexpectedKeys(pObj, ['op', 'handoffId', 'expectedRevision', 'decisionId'])) {
        return fail('unexpected-payload-fields', { type: CMD_DECIDE_PHASE_HANDOFF, correlationId });
      }
      const arm_handoffIdRaw: unknown = pObj['handoffId'];
      if (!isBoundedIdentifier(arm_handoffIdRaw)) {
        return fail('invalid-handoffId', { type: CMD_DECIDE_PHASE_HANDOFF, correlationId });
      }
      const arm_handoffId: string = arm_handoffIdRaw;
      const arm_expectedRevisionRaw: unknown = pObj['expectedRevision'];
      if (typeof arm_expectedRevisionRaw !== 'number' || !Number.isSafeInteger(arm_expectedRevisionRaw) || arm_expectedRevisionRaw < 1) {
        return fail('invalid-expectedRevision', { type: CMD_DECIDE_PHASE_HANDOFF, correlationId });
      }
      const arm_expectedRevision: number = arm_expectedRevisionRaw;
      const arm_decisionIdRaw: unknown = pObj['decisionId'];
      if (!isBoundedIdentifier(arm_decisionIdRaw)) {
        return fail('invalid-decisionId', { type: CMD_DECIDE_PHASE_HANDOFF, correlationId });
      }
      const arm_decisionId: string = arm_decisionIdRaw;
      const command: DecidePhaseHandoffCommand = { type: CMD_DECIDE_PHASE_HANDOFF, correlationId, payload: { op: 'approve', handoffId: arm_handoffId, expectedRevision: arm_expectedRevision, decisionId: arm_decisionId } };
      return ok(command);
    }
    case 'edit': {
      if (hasUnexpectedKeys(pObj, ['op', 'handoffId', 'baseRevision', 'replacementSources'])) {
        return fail('unexpected-payload-fields', { type: CMD_DECIDE_PHASE_HANDOFF, correlationId });
      }
      const arm_handoffIdRaw: unknown = pObj['handoffId'];
      if (!isBoundedIdentifier(arm_handoffIdRaw)) {
        return fail('invalid-handoffId', { type: CMD_DECIDE_PHASE_HANDOFF, correlationId });
      }
      const arm_handoffId: string = arm_handoffIdRaw;
      const arm_baseRevisionRaw: unknown = pObj['baseRevision'];
      if (typeof arm_baseRevisionRaw !== 'number' || !Number.isSafeInteger(arm_baseRevisionRaw) || arm_baseRevisionRaw < 1) {
        return fail('invalid-baseRevision', { type: CMD_DECIDE_PHASE_HANDOFF, correlationId });
      }
      const arm_baseRevision: number = arm_baseRevisionRaw;
      const arm_replacementSourcesRaw: unknown = pObj['replacementSources'];
      if (!Array.isArray(arm_replacementSourcesRaw)) {
        return fail('invalid-replacementSources', { type: CMD_DECIDE_PHASE_HANDOFF, correlationId });
      }
      const arm_replacementSources: readonly unknown[] = arm_replacementSourcesRaw;
      const command: DecidePhaseHandoffCommand = { type: CMD_DECIDE_PHASE_HANDOFF, correlationId, payload: { op: 'edit', handoffId: arm_handoffId, baseRevision: arm_baseRevision, replacementSources: arm_replacementSources } };
      return ok(command);
    }
    default:
      return fail('invalid-op', { type: CMD_DECIDE_PHASE_HANDOFF, correlationId });
  }
}
