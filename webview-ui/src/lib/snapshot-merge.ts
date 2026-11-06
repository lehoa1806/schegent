// Snapshot synchronization, omitted-slice reconstruction, and unchanged-slice
// reference preservation for SnapshotStore (FR-R5-F12).

import {
  SNAPSHOT_RESYNC_REQUEST,
  SUPPRESSIBLE_SNAPSHOT_SLICES,
  type SnapshotResyncRequestMessage,
  type SnapshotSyncMeta
} from '../../../src/contracts/snapshot-bounds.js';
import type { WorkflowSnapshot } from './snapshot-types';

export const RECONCILED_SLICE_KEYS = [
  ...SUPPRESSIBLE_SNAPSHOT_SLICES,
  'queues',
  'queue',
  'monitor',
  'generalSettings',
  'queueSettings',
  'availableModels',
  'configuredModels',
  'availableBackends',
  'launchables',
  'connectedRuns',
  'sessionArtifacts',
  'evidenceHealth',
  'telemetry'
] as const;

export type ReconcileSnapshotOutcome =
  | { readonly outcome: 'ignore-malformed' }
  | { readonly outcome: 'unknown-schema'; readonly schemaVersion: unknown }
  | { readonly outcome: 'malformed-queues' }
  | { readonly outcome: 'ignore-stale'; readonly receivedRevision: number }
  | {
      readonly outcome: 'resync-needed';
      readonly request: SnapshotResyncRequestMessage;
    }
  | {
      readonly outcome: 'applied';
      readonly snapshot: WorkflowSnapshot;
      readonly revision: number | null;
    };

function slicesEqual(prev: unknown, next: unknown): boolean {
  if (prev === next) return true;
  if (prev === undefined || next === undefined || prev === null || next === null) {
    return false;
  }
  if (typeof prev !== 'object' || typeof next !== 'object') {
    return false;
  }
  if (Array.isArray(prev) && Array.isArray(next)) {
    if (prev.length !== next.length) return false;
    if (prev.length === 0) return true;
    let allSameRef = true;
    for (let i = 0; i < prev.length; i += 1) {
      if (prev[i] !== next[i]) {
        allSameRef = false;
        break;
      }
    }
    if (allSameRef) return true;
  }
  return JSON.stringify(prev) === JSON.stringify(next);
}

export function reconcileSnapshotMessage(
  current: WorkflowSnapshot | null,
  lastRevision: number | null,
  incoming: WorkflowSnapshot,
  sync?: SnapshotSyncMeta
): ReconcileSnapshotOutcome {
  if (!incoming || typeof incoming !== 'object') {
    return { outcome: 'ignore-malformed' };
  }

  if (sync !== undefined) {
    if (lastRevision !== null && sync.revision <= lastRevision) {
      return { outcome: 'ignore-stale', receivedRevision: sync.revision };
    }
    if (
      sync.mode === 'routine' &&
      (current === null || lastRevision === null || sync.baseRevision !== lastRevision)
    ) {
      return {
        outcome: 'resync-needed',
        request: {
          type: SNAPSHOT_RESYNC_REQUEST,
          lastRevision
        }
      };
    }
  }

  const incomingRecord = incoming as unknown as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...incomingRecord };

  if (current !== null && sync?.mode === 'routine' && Array.isArray(sync.omittedSlices)) {
    const currentRecord = current as unknown as Record<string, unknown>;
    for (const slice of sync.omittedSlices) {
      if (slice in currentRecord) {
        merged[slice] = currentRecord[slice];
      }
    }
  }

  if (merged.schemaVersion !== 4) {
    return { outcome: 'unknown-schema', schemaVersion: merged.schemaVersion };
  }
  if (!Array.isArray(merged.queues)) {
    return { outcome: 'malformed-queues' };
  }

  if (current !== null) {
    const currentRecord = current as unknown as Record<string, unknown>;
    for (const key of RECONCILED_SLICE_KEYS) {
      if (key in merged && key in currentRecord) {
        if (slicesEqual(currentRecord[key], merged[key])) {
          merged[key] = currentRecord[key];
        }
      }
    }
  }

  return {
    outcome: 'applied',
    snapshot: merged as unknown as WorkflowSnapshot,
    revision: sync !== undefined ? sync.revision : null
  };
}
