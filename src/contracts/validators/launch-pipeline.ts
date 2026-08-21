// Feature 087 (T011) — CMD_LAUNCH_PIPELINE ingress validator.
//
// This gate answers exactly one question: is the thing on the wire shaped like
// a `RunRequest`? It is deliberately blind to whether any value in it is
// *correct*. An unknown port, a missing required input, an over-long
// instruction, a target that escapes the workspace — every one of those must
// reach `validateRunRequest()` at gate 6, because FR-013 requires all failing
// fields in one response and FR-012 requires the limit and the actual length.
// A payload dropped here produces no field errors at all, so anything the
// operator can plausibly fix belongs downstream, not in this file.
//
// The one thing it does own is the transport contract, and the reason it exists
// is bulk-0 ledger B0-P01: feature 085 shipped a correct handler and a correct
// emitter, and the envelope never arrived because this layer had no arm for it.

import { CMD_LAUNCH_PIPELINE, type SidebarCommand } from '../sidebar-ipc';
import { validRunRequest } from './run-request-shape';
import { fail, hasUnexpectedKeys, ok, QUEUE_ID_MAX, type IpcValidationResult } from './shared';

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function boundedId(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

// Feature 102 (T039) — `validRunRequest` and its element helpers moved to
// `./run-request-shape`, which this gate now imports like everyone else. The
// wire-contract guard in `contracts/sidebar-ipc/run-launcher.ts` needs the same
// rule and cannot import this module: the `CMD_LAUNCH_PIPELINE` import above
// comes from the barrel, and the barrel imports that guard. Not re-exported —
// one export site, so no importer has to know which of two paths is canonical.

export function validateLaunchPipeline(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = record(obj.payload);
  if (payload === null) {
    return fail('missing-payload', { type: CMD_LAUNCH_PIPELINE, correlationId });
  }
  // Feature 103 (T068, FR-059) — `queueId` joins the allowlist under the same
  // `QUEUE_ID_MAX` bound `validateLaunchWorkflow` applies to its own, and stays
  // optional so a launch that names no queue is still shaped correctly. It has
  // to be reconstructed below as well as allowlisted here: this gate rebuilds
  // the payload key by key rather than passing it through, so a field admitted
  // and not copied would be silently dropped one line later.
  const queueId = payload.queueId;
  if (
    hasUnexpectedKeys(payload, ['request', 'queueId']) ||
    (queueId !== undefined && !boundedId(queueId, QUEUE_ID_MAX)) ||
    !validRunRequest(payload.request)
  ) {
    return fail('invalid-payload', { type: CMD_LAUNCH_PIPELINE, correlationId });
  }
  return ok({
    type: CMD_LAUNCH_PIPELINE,
    correlationId,
    payload: {
      request: payload.request,
      ...(queueId !== undefined ? { queueId } : {})
    }
  } as SidebarCommand);
}
