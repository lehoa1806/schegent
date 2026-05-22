// Feature 063 — T029. Host-side reader for the
// `schegent.ui.confirmations.enable` config flag. The value flows into
// the snapshot envelope (T030) so the webview can short-circuit the
// `useConfirm` modal without an extra IPC round-trip.
//
// The value is re-read on every snapshot rebuild (the projector calls
// `isConfirmationsEnabled()`), so toggling the workspace setting takes
// effect on the next projection push. The accessor is `vscode`-aware
// but isolated; the projector imports it directly.

import * as vscode from 'vscode';

const CONFIG_NAMESPACE = 'schegent';
const KEY = 'ui.confirmations.enable';
const DEFAULT_VALUE = true;

/**
 * Returns whether destructive-action confirmation prompts are enabled
 * for the current workspace. Defaults to `true` if the setting is
 * missing or malformed.
 */
export function isConfirmationsEnabled(): boolean {
  const value = vscode.workspace.getConfiguration(CONFIG_NAMESPACE).get<unknown>(KEY);
  if (typeof value !== 'boolean') return DEFAULT_VALUE;
  return value;
}
