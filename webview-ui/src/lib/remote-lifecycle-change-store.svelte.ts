// Feature 065 (T049a) — shared, session-scoped flag signaling that the
// queue lifecycle transitioned out from under an open chooser surface
// (FR-019a). When set, `QueueListView.svelte` surfaces a non-modal,
// dismissible notice prompting the operator to refresh. The chooser
// surface (QueueInputForm / ScheduledStartIndicator) sets it on silent
// close; the notice clears it on dismiss.
//
// This is a webview-local UI signal: it never persists across reloads
// and is independent of any host-state migration.

const state = $state({ active: false });

export const remoteLifecycleChangeStore = {
  get active(): boolean {
    return state.active;
  },
  notifyChangedElsewhere(): void {
    state.active = true;
  },
  dismiss(): void {
    state.active = false;
  }
};
