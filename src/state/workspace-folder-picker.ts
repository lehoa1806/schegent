// Feature 058 (Option B per docs/plans/workspace-isolation-strategy.md) —
// canonical workspace-folder accessor. Single source of truth for selecting
// the Schegent canonical workspace folder.
//
// The picker is the ONLY module in `repo/src/` permitted to read
// `workspaceFolders[0]` or `workspaceFolders?.[0]`. The
// `no-direct-first-workspace-folder` lint regression enforces this.
//
// Contract: specs/058-multi-root-workspace/contracts/workspace-folder-picker-contract.md
//
// Behavior:
//   - Returns `vscode.workspace.workspaceFolders[0]` (the first folder listed
//     in the active `.code-workspace`) when at least one folder is open,
//     otherwise `undefined`.
//   - The result is memoized on first call. The cache is invalidated when
//     `vscode.workspace.onDidChangeWorkspaceFolders` fires, or when the
//     module is disposed.
//   - The change subscription is lazy (created on first read) so importing
//     this module from a workspace-less context does not pre-subscribe.
//   - Read-only — never mutates workspace folders or calls
//     `updateWorkspaceFolders`.
//
// Out-of-scope for v1: operator-chosen canonical folder, persisted preference.
// Those would extend (not replace) this contract with a mutator and memento.

import * as vscode from 'vscode';

let cached: vscode.WorkspaceFolder | undefined;
let cachePopulated = false;
let changeSubscription: vscode.Disposable | undefined;

function ensureSubscribed(): void {
  if (changeSubscription) return;
  changeSubscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    cached = undefined;
    cachePopulated = false;
  });
}

export function getCanonicalWorkspaceRoot(): vscode.WorkspaceFolder | undefined {
  ensureSubscribed();
  if (cachePopulated) return cached;
  const folders = vscode.workspace.workspaceFolders;
  cached = folders && folders.length > 0 ? folders[0] : undefined;
  cachePopulated = true;
  return cached;
}

export function disposeWorkspaceFolderPicker(): void {
  if (changeSubscription) {
    try {
      changeSubscription.dispose();
    } catch {
      // Best-effort: dispose must never throw.
    }
    changeSubscription = undefined;
  }
  cached = undefined;
  cachePopulated = false;
}
