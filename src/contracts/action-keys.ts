// Feature 193 (T036, FR-001/FR-002/FR-009) — the single canonical set of
// destructive-action identifiers. Both the confirmation-suppression
// preference writer (`src/state/confirm-suppression.ts`) and the webview
// confirmation UI (`webview-ui/src/lib/action-copy.ts`, via the generated
// mirror `webview-ui/src/lib/generated/action-keys.ts`) derive from this
// tuple. No other file declares its own copy of this list — widening or
// narrowing the recognized set happens here, and only here.
//
// Contract: specs/193-mutation-ack-key-parity/contracts/action-key-contract.md
// Data model: specs/193-mutation-ack-key-parity/data-model.md

export const ACTION_KEYS = [
  'queue.clean-all',
  'queue.clear-done',
  'queue.remove-item',
  'queue.cancel-item',
  'queue.pause',
  'queue.resume',
  'run.retry-phase-now',
  'run.restart-canceled',
  'run.modify-task',
  'history.rerun',
  'workspace.reset',
  'run.skip-phase',
  'catalog.deactivate-definition',
  'catalog.discard-draft',
  'run.overwrite-output',
  'queue.delete',
  'settings.disable-confirmations',
  'backend.grant-uncontained',
  // Feature 195 (T064, FR-025) — attested completion. Recognized as a
  // destructive action because `completed` is a status no transition returns
  // from (192's invariant 4): attesting spends the operator's ability to retry
  // the task, which is exactly the loss a confirmation exists to name.
  'queue.attest-completed'
] as const;

export type ActionKey = (typeof ACTION_KEYS)[number];
