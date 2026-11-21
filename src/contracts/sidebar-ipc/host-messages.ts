// Host-to-webview push message envelopes are generated from
// `scripts/contracts/ipc-descriptors/host-messages.mjs` into
// `src/contracts/generated/sidebar-ipc-types.ts`. Re-exported here so existing
// imports from `src/contracts/sidebar-ipc/host-messages` stay stable.
export type {
  StateSnapshotMessage,
  CommandAckMessage,
  PhaseLogBatchPushMessage,
  HostMessage
} from '../generated/sidebar-ipc-types';
