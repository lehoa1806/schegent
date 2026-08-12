export const SECONDARY_REJECT = 'secondary-window-readonly';

/**
 * Rejection cause for mutating IPC commands attempted while the workspace
 * is not trusted (VS Code Workspace Trust). Mirrors the `SECONDARY_REJECT`
 * shape so the webview's existing ack-rejection branch handles both
 * causes uniformly. The operator-facing message is set by the host
 * `notifyWarning` callback at the gate site, not derived from this token.
 */
export const UNTRUSTED_REJECT = 'untrusted-workspace';

// Canonical RFC 4122 UUIDv4 — 36 chars, lowercase hex, version=4,
// variant in 8-b. Pinned client-side and host-side as defense in depth.
export const UUIDV4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const ILLEGAL_STATE_MESSAGES: Record<string, string> = {
  'illegal-state': 'Action not allowed in current state',
  'not-found': 'Queue item not found',
  'no-peer': 'No other pending items to reorder',
  'at-edge': 'Already at the edge of the pending list',
  'unknown-task-id': 'Queue item not found',
  'task-not-in-pending-state': 'Cannot remove: task is no longer pending',
  'missing-confirmation': 'Deletion was not confirmed',
  'unknown-phase-id': 'Phase not found',
  'phase-already-removed': 'Phase already removed',
  // Feature 030 (US2, T032) — unified reorder helper cause codes.
  'invalid-position': 'Already at the edge of the pending list',
  'task-not-pending': 'Cannot reorder: task is no longer pending',
  'no-op': 'Item is already at that position'
};
