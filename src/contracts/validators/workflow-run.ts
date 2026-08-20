// Feature 088 (T032) — ingress validators for the two connected-run commands.
//
// Same job and same limits as `launch-pipeline.ts`: answer whether the thing on
// the wire is *shaped* like the command, and stop there. Whether the Workflow
// exists, whether the node is a legal start, whether the request names that
// node's Pipeline, and whether the revision is current are gates 1-5 of the
// command handlers — every one of them needs the catalog or the stored run,
// which this layer has no access to and no business consulting.
//
// The nested `RunRequest` shape is imported rather than re-stated. A second
// copy would drift, and a drifted ingress rule is invisible: the envelope is
// dropped one layer before any handler, which is exactly how bulk-0 ledger
// entry B0-P01 stayed hidden through a correct handler and a correct emitter.

import {
  CMD_CONTINUE_WORKFLOW,
  CMD_LAUNCH_WORKFLOW,
  type SidebarCommand
} from '../sidebar-ipc';
import { validRunRequest } from './run-request-shape';
import { QUEUE_ID_MAX, fail, hasUnexpectedKeys, ok, type IpcValidationResult } from './shared';

const ID_MAX = 64;
/** A connected run identifier is host-minted, so this is a sanity bound, not a contract. */
const RUN_ID_MAX = 128;

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function boundedId(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

export function validateLaunchWorkflow(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = record(obj.payload);
  if (payload === null) {
    return fail('missing-payload', { type: CMD_LAUNCH_WORKFLOW, correlationId });
  }
  // Feature 092 (T080, FR-041) — `queueId` joins the allowlist under the same
  // `QUEUE_ID_MAX` bound every other queue-addressing command applies, and
  // stays optional so a launch that names no queue is still shaped correctly.
  const queueId = payload.queueId;
  if (
    hasUnexpectedKeys(payload, ['workflowId', 'startNodeId', 'request', 'queueId']) ||
    !boundedId(payload.workflowId, ID_MAX) ||
    !boundedId(payload.startNodeId, ID_MAX) ||
    (queueId !== undefined && !boundedId(queueId, QUEUE_ID_MAX)) ||
    !validRunRequest(payload.request)
  ) {
    return fail('invalid-payload', { type: CMD_LAUNCH_WORKFLOW, correlationId });
  }
  return ok({
    type: CMD_LAUNCH_WORKFLOW,
    correlationId,
    payload: {
      workflowId: payload.workflowId,
      startNodeId: payload.startNodeId,
      request: payload.request,
      ...(queueId !== undefined ? { queueId } : {})
    }
  } as SidebarCommand);
}

export function validateContinueWorkflow(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = record(obj.payload);
  if (payload === null) {
    return fail('missing-payload', { type: CMD_CONTINUE_WORKFLOW, correlationId });
  }
  // `expectedRevision` is bounded below and not above: a caller echoes back what
  // the host gave it, and a value the store has moved past is gate 2's answer
  // (`rejected-stale`), not a transport defect. Only a non-integer or a negative
  // number is a shape the wire type cannot produce.
  const revision = payload.expectedRevision;
  if (
    hasUnexpectedKeys(payload, ['connectedRunId', 'expectedRevision', 'nodeId', 'request']) ||
    !boundedId(payload.connectedRunId, RUN_ID_MAX) ||
    !Number.isInteger(revision) ||
    (revision as number) < 0 ||
    !boundedId(payload.nodeId, ID_MAX) ||
    !validRunRequest(payload.request)
  ) {
    return fail('invalid-payload', { type: CMD_CONTINUE_WORKFLOW, correlationId });
  }
  return ok({
    type: CMD_CONTINUE_WORKFLOW,
    correlationId,
    payload: {
      connectedRunId: payload.connectedRunId,
      expectedRevision: revision,
      nodeId: payload.nodeId,
      request: payload.request
    }
  } as SidebarCommand);
}
