// FR-R3-144 (T016, D-2) — the boundary check for the uncontained-grant command.
//
// This parses untrusted webview input and nothing else. It does not decide whether
// the grant is meaningful — `codex` is a well-formed payload here and is refused by
// `setUncontainedGrant` as `already-contained`, because that is a policy answer and
// the policy module owns it. Duplicating the containment question here would put a
// second authority for it at the boundary, and the two would drift the first time a
// backend's mechanism changed.
//
// What it DOES refuse is the shape: a missing payload, a field nobody declared, a
// non-boolean direction, and an id that is not a backend. The last one matters most
// — the far side of this command is a write to an application-scoped security
// setting, so an unrecognised id must not reach it even though the writer refuses
// it too. Two checks against one list (`SUPPORTED_BACKENDS`, via
// `isBackendRunnerKind`) is defence in depth; two DIFFERENT lists would be the
// defect.

import { CMD_SET_UNCONTAINED_BACKEND_GRANT, type SidebarCommand } from '../sidebar-ipc';
import { isBackendRunnerKind } from '../backend-kinds';
import { fail, hasUnexpectedKeys, ok, type IpcValidationResult } from './shared';

const ALLOWED_KEYS = ['kind', 'granted'] as const;

export function validateSetUncontainedBackendGrant(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const type = CMD_SET_UNCONTAINED_BACKEND_GRANT;
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail('missing-payload', { type, correlationId });
  }
  const p = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(p, ALLOWED_KEYS)) {
    return fail('unexpected-payload-fields', { type, correlationId });
  }
  if (!isBackendRunnerKind(p['kind'])) {
    return fail('invalid-backend-kind', { type, correlationId });
  }
  if (typeof p['granted'] !== 'boolean') {
    // Its own code rather than `invalid-payload`: an absent `granted` and a
    // `granted: 'true'` string are the two ways a caller gets the DIRECTION wrong,
    // and a revoke silently parsed as a grant is the one failure here that widens
    // a posture instead of narrowing it.
    return fail('invalid-granted', { type, correlationId });
  }
  return ok({
    type,
    correlationId,
    payload: { kind: p['kind'], granted: p['granted'] }
  } as SidebarCommand);
}
