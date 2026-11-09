/**
 * FR-R6-F05 US3 — what the legacy preservation modules share: their
 * dependencies, the resolved context, the audit emission and the preview
 * summary shape.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { randomUUID } from 'node:crypto';

import type { RetentionPreviewSummary, ScanCoverage } from '../../contracts/artifact-lifecycle/lifecycle-types';
import type { LegacyCatalogConsumerPort } from '../../contracts/artifact-lifecycle/legacy-preservation-types';
import type { NodeSqliteConnection } from '../sqlite-store';
import type { LegacyCatalogRoot } from './legacy-classification';
import type { LegacyPreservationFs } from './legacy-preservation-fs';
import { PreservationRows } from './legacy-preservation-store';
import { DEFAULT_LIFECYCLE_WORKSPACE_ID } from './lifecycle-context';
import type { LifecycleAuditSink, LifecycleMutationResult } from './mutation-authority';
import type { PreviewStore } from './previews';

/** Where quarantined copies go, workspace-relative, unless the host says otherwise. */
export const DEFAULT_QUARANTINE_SEGMENTS: readonly string[] = ['.schegent', 'quarantine', 'catalog'];

/** An operation id becomes a directory name, so it is held to a portable file-name alphabet. */
const PATH_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface LegacyPreservationDependencies {
  readonly conn: NodeSqliteConnection;
  readonly nowMs: () => number;
  readonly newId?: () => string;
  readonly workspaceId?: string;
  readonly previews: PreviewStore;
  readonly audit: LifecycleAuditSink;
  readonly catalogRoot: LegacyCatalogRoot;
  readonly files: LegacyPreservationFs;
  readonly consumers: LegacyCatalogConsumerPort;
  readonly quarantineSegments?: readonly string[];
}

export interface LegacyContext {
  readonly deps: LegacyPreservationDependencies;
  readonly rows: PreservationRows;
  readonly workspaceId: string;
  readonly quarantineSegments: readonly string[];
  /** A fresh operation id, or null when the id source produced one unfit for a directory name. */
  newOperationId(): string | null;
}

export function legacyContext(deps: LegacyPreservationDependencies): LegacyContext {
  const newId = deps.newId ?? randomUUID;
  return {
    deps,
    rows: new PreservationRows(deps.conn, deps.nowMs),
    workspaceId: deps.workspaceId ?? DEFAULT_LIFECYCLE_WORKSPACE_ID,
    quarantineSegments: deps.quarantineSegments ?? DEFAULT_QUARANTINE_SEGMENTS,
    newOperationId() {
      const id = newId();
      return PATH_SAFE_ID.test(id) ? id : null;
    }
  };
}

/** Workspace-relative segments of a persisted key. */
export function segmentsOfKey(key: string): readonly string[] {
  return key.split('/');
}

export function keyOfSegments(segments: readonly string[]): string {
  return segments.join('/');
}

/** One metadata-only audit record per accepted mutation (rule 21); counts only, no path (rule 22). */
export function auditPreservation(
  ctx: LegacyContext,
  operationId: string,
  counts: Readonly<Record<string, number>>,
  done: number,
  total: number
): void {
  const result: LifecycleMutationResult = done === total ? 'completed' : done === 0 ? 'refused' : 'partial';
  ctx.deps.audit.recordLifecycleMutation({ operationKind: 'legacy-quarantine', operationId, counts: { ...counts }, result });
}

export interface PreservationSummaryInput {
  readonly affectedCount: number;
  readonly affectedBytes: number;
  readonly protectedCount: number;
  readonly protectedBytes: number;
  readonly coverage: ScanCoverage;
  readonly notes: readonly string[];
}

export function preservationSummary(input: PreservationSummaryInput): RetentionPreviewSummary {
  return {
    ...input,
    unclassifiedCount: 0,
    unclassifiedBytes: 0,
    perClass: [],
    protectedExceptions: []
  };
}
