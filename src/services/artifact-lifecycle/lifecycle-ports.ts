/**
 * FR-R6-F05 — injected ports of the lifecycle service. Production
 * implementations live beside the activation wiring; tests inject fakes so
 * every fault (ENOSPC, EACCES, a link swapped between check and use,
 * interruption) is reachable (NFR-005).
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import type { ArtifactStoreKind, RetentionClassId } from '../../contracts/artifact-lifecycle/lifecycle-types';
import type { ArtifactLocator } from './artifact-records';

/** Reads a stored artifact's bytes for a materialized copy (FR-023); `null` when they are not there. */
export interface ArtifactByteReader {
  read(locator: ArtifactLocator): Promise<Uint8Array | null>;
}

/** `lstat` result; links are never followed. */
export interface LifecycleFsEntry {
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

/** Filesystem effects of the lifecycle service. Unlink is only reached after containment. */
export interface LifecycleFs {
  lstat(absolutePath: string): Promise<LifecycleFsEntry | null>;
  readdir(absolutePath: string): Promise<readonly string[]>;
  realpath(absolutePath: string): Promise<string>;
  unlink(absolutePath: string): Promise<void>;
}

/** A declared directory the inventory scanner walks (contracts/surfaces-and-wiring.md §3). */
export interface StorageScanRoot {
  readonly rootId: string;
  readonly root: string;
  readonly retentionClass: RetentionClassId;
  readonly storeKind: ArtifactStoreKind;
  /** Owner run id from the entry's path segments under `root`, when the layout encodes one. */
  readonly ownerRunId?: (segments: readonly string[]) => string | undefined;
}

/** The F13 admission interface for artifact access handles (FR-023). */
export interface ArtifactAccessPolicy {
  admits(request: {
    readonly artifactId: string;
    readonly attemptId: string;
    readonly sessionId: string;
    readonly mode: 'embed' | 'read';
  }): boolean;
}

/** Denies every access; the default until F13 supplies a policy. */
export const DENY_ALL_ACCESS_POLICY: ArtifactAccessPolicy = { admits: () => false };
