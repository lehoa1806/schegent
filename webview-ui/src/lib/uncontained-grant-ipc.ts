// FR-R3-144 (T033, T034) — the sole webview call site for
// CMD_SET_UNCONTAINED_BACKEND_GRANT.
//
// One module per command, matching `backend-ping-ipc.ts` next door and the rule
// `tests/lint/no-inline-backend-ping-ipc.test.ts` enforces for that one: a
// component never calls `postCommand` with a command type inline. The reason is
// the same here and stronger — this command widens what a spawned process may
// touch, so "who can send it" is a question that should be answerable by opening
// one file.
//
// It carries no confirmation of its own. Granting is confirmed at the call site
// (FR-007) and revoking deliberately is not (C7-3): a component that asked before
// *narrowing* a permission would be teaching operators to click through the prompt
// that matters.
import { CMD_SET_UNCONTAINED_BACKEND_GRANT } from './messages';
import type { BackendRunnerKind } from './snapshot-types';
import { postCommand, type PostCommandResult } from './vscode-api';

/**
 * Grant or revoke this backend's permission to run uncontained.
 *
 * The host decides whether the request is applicable — `codex` carries an
 * OS-enforced bound and is refused with `already-contained` — so this sends the
 * request rather than a decision. The webview does not know the policy and must
 * not appear to.
 */
export function setUncontainedBackendGrant(
  kind: BackendRunnerKind,
  granted: boolean
): PostCommandResult {
  return postCommand(CMD_SET_UNCONTAINED_BACKEND_GRANT, { kind, granted });
}
