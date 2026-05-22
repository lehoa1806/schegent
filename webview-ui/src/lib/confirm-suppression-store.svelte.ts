// Feature 063 — webview-side mirror of the persisted confirmation
// suppression set. Reads from `WorkflowSnapshot.confirmSuppression`
// (wired through the snapshot store) and exposes per-action lookups
// + a mutation helper that fires `CMD_SET_CONFIRM_SUPPRESSION`.
//
// The host is the source of truth — this store does NOT cache. Each
// read consults the live snapshot so a memento change in another
// VS Code window (multi-host) is reflected immediately after the
// next snapshot push.

import { snapshotStore } from './snapshot-store.svelte';
import { CMD_SET_CONFIRM_SUPPRESSION } from './messages';
import { postCommand } from './vscode-api';
import { ACTION_COPY, type ActionKey } from './action-copy';

class ConfirmSuppressionStore {
  // Returns true if the operator previously opted out of the
  // confirmation modal for `actionKey`. Defaults to false when the
  // snapshot has not yet arrived.
  isSuppressed(actionKey: ActionKey): boolean {
    const set = snapshotStore.snapshot?.confirmSuppression?.suppressedActionKeys ?? [];
    return set.includes(actionKey);
  }

  // Snapshot of every action key currently suppressed. Order matches
  // the host's persisted memento.
  suppressedKeys(): readonly ActionKey[] {
    const set = snapshotStore.snapshot?.confirmSuppression?.suppressedActionKeys ?? [];
    // The host only writes known keys (validated against KNOWN_ACTION_KEYS),
    // but the snapshot type is `string[]`. We re-narrow here so callers see
    // the `ActionKey` union without an unsafe cast.
    return set.filter((k): k is ActionKey => k in ACTION_COPY);
  }

  // Fires the persistence write. The host handler validates the action
  // key against the closed `ActionKey` union before mutating the
  // memento; the webview just sends the typed payload.
  setSuppressed(actionKey: ActionKey, suppressed: boolean): void {
    postCommand(CMD_SET_CONFIRM_SUPPRESSION, { actionKey, suppressed });
  }
}

export const confirmSuppressionStore = new ConfirmSuppressionStore();
