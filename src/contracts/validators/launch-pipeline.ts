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
import { fail, hasUnexpectedKeys, ok, type IpcValidationResult } from './shared';

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
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
  if (hasUnexpectedKeys(payload, ['request']) || !validRunRequest(payload.request)) {
    return fail('invalid-payload', { type: CMD_LAUNCH_PIPELINE, correlationId });
  }
  return ok({
    type: CMD_LAUNCH_PIPELINE,
    correlationId,
    payload: { request: payload.request }
  } as SidebarCommand);
}
