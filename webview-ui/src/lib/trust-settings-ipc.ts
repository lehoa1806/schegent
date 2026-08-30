// FR-R3-143 (T039) — the one call site for `CMD_OPEN_TRUST_SETTINGS`.
//
// A helper rather than an inline `postCommand` in the component, following
// `openVerboseSetting` (`phase-log-ipc.ts:122`) and the convention its caller
// states at `PhaseLogEmptyStates.svelte:8`: IPC posts live in `lib/`, so the
// dispatcher lint can see every sender in one place.
//
// Fire-and-forget. The host opens the settings editor; nothing here waits for
// the ack, because there is no UI state to advance — the operator changes the
// setting in the editor, and the next projection carries the new value.

import { CMD_OPEN_TRUST_SETTINGS } from './messages';
import { postCommand } from './vscode-api';

/** Open the VS Code Settings editor filtered to the `schegent.trust.*` keys. */
export function openTrustSettings(): void {
  postCommand(CMD_OPEN_TRUST_SETTINGS);
}
