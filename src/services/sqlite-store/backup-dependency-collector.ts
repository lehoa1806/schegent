/**
 * FR-R7-14 (14-01, 14-02) — Lifecycle-aware external dependency classification,
 * deterministic collection, and symmetric creation/verification bound enforcement
 * for SQLite store backups.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 * Zero filesystem mutations (read-only SQL queries and pure bound checks).
 */

import {
  MAX_BACKUP_EXTERNAL_DEPENDENCIES,
  MAX_BACKUP_EXTERNAL_DEPENDENCY_BYTES,
  type BackupDependencyManifest,
  type BackupExternalDependency,
  type BackupRestoreRejectionCode
} from '../../contracts/sqlite-store/schema-types';
import { MAX_BACKUP_DATABASE_BYTES, MAX_BACKUP_MANIFEST_BYTES } from './backup-manifest-store';
import type { NodeSqliteConnection } from './sqlite-driver';

export type ArtifactDependencyDisposition = 'required-live' | 'tombstoned-deleted';

export interface ClassifiedExternalDependency {
  readonly artifactId: string;
  readonly locationId: string;
  readonly storageTier: 'cas_blob' | 'workspace_file';
  readonly relativePath: string;
  readonly disposition: ArtifactDependencyDisposition;
  readonly expectedSha256: string;
  readonly expectedByteSize: number;
}

export interface BackupCreationBounds {
  readonly maxExternalDependencies: number;
  readonly maxExternalDependencyBytes: number;
  readonly maxManifestBytes: number;
  readonly maxDatabaseBytes: number;
  readonly maxRestoreDatabaseBytes?: number | undefined;
}

export interface BackupBoundsOverrides {
  readonly maxExternalDependencies?: number | undefined;
  readonly maxExternalDependencyBytes?: number | undefined;
  readonly maxManifestBytes?: number | undefined;
  readonly maxDatabaseBytes?: number | undefined;
  readonly bounds?: Partial<BackupCreationBounds> | undefined;
}

export interface ResolvedBackupBounds {
  readonly maxExternalDependencies: number;
  readonly maxExternalDependencyBytes: number;
  readonly maxManifestBytes: number;
  readonly maxDatabaseBytes: number;
}

export const DEFAULT_BACKUP_CREATION_BOUNDS: ResolvedBackupBounds = Object.freeze({
  maxExternalDependencies: MAX_BACKUP_EXTERNAL_DEPENDENCIES,
  maxExternalDependencyBytes: MAX_BACKUP_EXTERNAL_DEPENDENCY_BYTES,
  maxManifestBytes: MAX_BACKUP_MANIFEST_BYTES,
  maxDatabaseBytes: MAX_BACKUP_DATABASE_BYTES
});

export function boundedVerificationLimit(requested: number | undefined, maximum: number): number {
  return requested === undefined || !Number.isFinite(requested)
    ? maximum
    : Math.max(0, Math.min(Math.floor(requested), maximum));
}

function tightenOptionalLimits(
  maximum: number,
  ...candidates: ReadonlyArray<number | undefined>
): number {
  let effective = maximum;
  for (const candidate of candidates) {
    effective = boundedVerificationLimit(candidate, effective);
  }
  return effective;
}

/**
 * Resolves effective backup creation/verification bounds. Caller-supplied overrides
 * may only tighten limits and can never raise the published safety ceilings.
 */
export function resolveBackupBounds(overrides?: BackupBoundsOverrides): ResolvedBackupBounds {
  return {
    maxExternalDependencies: tightenOptionalLimits(
      MAX_BACKUP_EXTERNAL_DEPENDENCIES,
      overrides?.bounds?.maxExternalDependencies,
      overrides?.maxExternalDependencies
    ),
    maxExternalDependencyBytes: tightenOptionalLimits(
      MAX_BACKUP_EXTERNAL_DEPENDENCY_BYTES,
      overrides?.bounds?.maxExternalDependencyBytes,
      overrides?.maxExternalDependencyBytes
    ),
    maxManifestBytes: tightenOptionalLimits(
      MAX_BACKUP_MANIFEST_BYTES,
      overrides?.bounds?.maxManifestBytes,
      overrides?.maxManifestBytes
    ),
    maxDatabaseBytes: tightenOptionalLimits(
      MAX_BACKUP_DATABASE_BYTES,
      overrides?.bounds?.maxRestoreDatabaseBytes,
      overrides?.bounds?.maxDatabaseBytes,
      overrides?.maxDatabaseBytes
    )
  };
}

export function hasTableInConn(conn: NodeSqliteConnection, table: string): boolean {
  return (
    conn.get<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      table
    ) !== undefined
  );
}

/**
 * Determines whether an artifact location row represents an intentionally
 * lifecycle-deleted/expired or fallback-evicted tombstone whose on-disk bytes are
 * expected to be absent. Every other state — including `'present'`, `'pending'`,
 * `'unverified'`, `'missing'`, `'corrupt'`, and absent lifecycle/availability rows —
 * remains `'required-live'` (fail-closed).
 */
export function classifyArtifactAvailabilityDisposition(
  lifecycleRowPresent: boolean,
  lifecycleAvailability: string | null,
  availabilityRowPresent: boolean,
  availabilityState: string | null
): ArtifactDependencyDisposition {
  if (lifecycleRowPresent) {
    if (lifecycleAvailability === 'deleted' || lifecycleAvailability === 'expired') {
      return 'tombstoned-deleted';
    }
    return 'required-live';
  }
  if (availabilityRowPresent && availabilityState === 'evicted') {
    return 'tombstoned-deleted';
  }
  return 'required-live';
}

interface RawArtifactJoinRow {
  readonly artifact_id: string;
  readonly location_id: string;
  readonly storage_tier: 'cas_blob' | 'workspace_file';
  readonly content_sha256: string;
  readonly byte_length: number;
  readonly uri_or_relpath: string;
  readonly lifecycle_present: number;
  readonly lifecycle_availability: string | null;
  readonly availability_present: number;
  readonly availability_state: string | null;
}

/**
 * Classifies all external (`cas_blob` / `workspace_file`) artifact rows in deterministic
 * `(artifact_id ASC, location_id ASC)` order into `'required-live'` vs `'tombstoned-deleted'`.
 */
export function classifyExternalArtifactDependencies(
  conn: NodeSqliteConnection
): readonly ClassifiedExternalDependency[] {
  if (!hasTableInConn(conn, 'artifacts') || !hasTableInConn(conn, 'artifact_locations')) {
    return [];
  }
  const hasLifecycle = hasTableInConn(conn, 'artifact_lifecycle');
  const hasAvailability = hasTableInConn(conn, 'artifact_availability');

  const lifecycleSelect = hasLifecycle
    ? `CASE WHEN al.artifact_id IS NOT NULL THEN 1 ELSE 0 END AS lifecycle_present,
       al.availability AS lifecycle_availability`
    : `0 AS lifecycle_present, NULL AS lifecycle_availability`;
  const availabilitySelect = hasAvailability
    ? `CASE WHEN av.artifact_id IS NOT NULL THEN 1 ELSE 0 END AS availability_present,
       av.state AS availability_state`
    : `0 AS availability_present, NULL AS availability_state`;
  const lifecycleJoin = hasLifecycle
    ? `LEFT JOIN artifact_lifecycle al ON al.artifact_id = a.artifact_id`
    : '';
  const availabilityJoin = hasAvailability
    ? `LEFT JOIN artifact_availability av ON av.artifact_id = a.artifact_id`
    : '';

  const rows = conn.all<RawArtifactJoinRow>(
    `SELECT a.artifact_id,
            loc.location_id,
            loc.storage_tier,
            a.content_sha256,
            a.byte_length,
            loc.uri_or_relpath,
            ${lifecycleSelect},
            ${availabilitySelect}
     FROM artifacts a
     INNER JOIN artifact_locations loc ON loc.artifact_id = a.artifact_id
     ${lifecycleJoin}
     ${availabilityJoin}
     WHERE loc.storage_tier IN ('cas_blob', 'workspace_file')
     ORDER BY a.artifact_id ASC, loc.location_id ASC`
  );

  return rows.map((row) => ({
    artifactId: row.artifact_id,
    locationId: row.location_id,
    storageTier: row.storage_tier,
    relativePath: row.uri_or_relpath,
    disposition: classifyArtifactAvailabilityDisposition(
      row.lifecycle_present === 1,
      row.lifecycle_availability,
      row.availability_present === 1,
      row.availability_state
    ),
    expectedSha256: row.content_sha256,
    expectedByteSize: row.byte_length
  }));
}

/**
 * Collects required-live external dependencies (`artifacts` + `artifact_locations`,
 * `log_segments`, and caller-supplied `auditLogDependencies`) while excluding ONLY
 * lifecycle-deleted/expired or fallback-evicted tombstones so deletion history
 * survives backup, verification, and restore without weakening live-file checks.
 */
export function collectExternalDependenciesFromConn(
  conn: NodeSqliteConnection,
  auditLogDependencies: readonly BackupExternalDependency[] = [],
  limit = MAX_BACKUP_EXTERNAL_DEPENDENCIES + 1
): readonly BackupExternalDependency[] {
  const deps: BackupExternalDependency[] = [];

  if (hasTableInConn(conn, 'artifacts') && hasTableInConn(conn, 'artifact_locations')) {
    const hasLifecycle = hasTableInConn(conn, 'artifact_lifecycle');
    const hasAvailability = hasTableInConn(conn, 'artifact_availability');

    let joinSql = '';
    let exclusionSql = '';
    if (hasLifecycle && hasAvailability) {
      joinSql = `LEFT JOIN artifact_lifecycle al ON al.artifact_id = a.artifact_id
                 LEFT JOIN artifact_availability av ON av.artifact_id = a.artifact_id`;
      // Guard every nullable column with IS NOT NULL + COALESCE so SQL three-valued logic
      // never excludes rows whose lifecycle and availability rows are both absent.
      exclusionSql = `AND NOT (
        (al.artifact_id IS NOT NULL AND COALESCE(al.availability, '') IN ('deleted', 'expired'))
        OR (al.artifact_id IS NULL AND av.artifact_id IS NOT NULL AND COALESCE(av.state, '') = 'evicted')
      )`;
    } else if (hasLifecycle) {
      joinSql = `LEFT JOIN artifact_lifecycle al ON al.artifact_id = a.artifact_id`;
      exclusionSql = `AND NOT (
        al.artifact_id IS NOT NULL AND COALESCE(al.availability, '') IN ('deleted', 'expired')
      )`;
    } else if (hasAvailability) {
      joinSql = `LEFT JOIN artifact_availability av ON av.artifact_id = a.artifact_id`;
      exclusionSql = `AND NOT (
        av.artifact_id IS NOT NULL AND COALESCE(av.state, '') = 'evicted'
      )`;
    }

    const artifactRows = conn.all<{
      artifact_id: string;
      content_sha256: string;
      byte_length: number;
      uri_or_relpath: string;
    }>(
      `SELECT a.artifact_id, a.content_sha256, a.byte_length, loc.uri_or_relpath
       FROM artifacts a
       INNER JOIN artifact_locations loc ON loc.artifact_id = a.artifact_id
       ${joinSql}
       WHERE loc.storage_tier IN ('cas_blob', 'workspace_file')
       ${exclusionSql}
       ORDER BY a.artifact_id ASC, loc.location_id ASC
       LIMIT ?`,
      limit
    );

    for (const row of artifactRows) {
      deps.push({
        dependencyKind: 'artifact_blob',
        referenceId: row.artifact_id,
        relativePath: row.uri_or_relpath,
        byteLength: row.byte_length,
        sha256Digest: row.content_sha256
      });
    }
  }

  if (hasTableInConn(conn, 'log_segments') && (limit < 0 || deps.length < limit)) {
    const segmentRows = conn.all<{
      segment_id: string;
      start_byte_offset: number;
      end_byte_offset: number;
      content_sha256: string;
      relative_path: string;
    }>(
      `SELECT segment_id, start_byte_offset, end_byte_offset, content_sha256, relative_path
       FROM log_segments ORDER BY segment_id ASC LIMIT ?`,
      limit < 0 ? limit : limit - deps.length
    );

    for (const seg of segmentRows) {
      deps.push({
        dependencyKind: 'log_segment',
        referenceId: seg.segment_id,
        relativePath: seg.relative_path,
        byteLength: Math.max(0, seg.end_byte_offset - seg.start_byte_offset),
        sha256Digest: seg.content_sha256
      });
    }
  }

  deps.push(...auditLogDependencies);
  return deps;
}

export type ExternalDependencyBoundsVerdict =
  | { readonly ok: true; readonly totalBytes: number }
  | {
      readonly ok: false;
      readonly reasonCode:
        | 'EXTERNAL_DEPENDENCY_BOUND_EXCEEDED'
        | 'EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT';
      readonly message: string;
    };

/**
 * Enforces identical count and cumulative byte ceilings during both backup creation
 * and backup verification/restore.
 */
export function validateExternalDependenciesBounds(
  deps: readonly BackupExternalDependency[],
  bounds: Pick<ResolvedBackupBounds, 'maxExternalDependencies' | 'maxExternalDependencyBytes'>
): ExternalDependencyBoundsVerdict {
  if (deps.length > bounds.maxExternalDependencies) {
    return {
      ok: false,
      reasonCode: 'EXTERNAL_DEPENDENCY_BOUND_EXCEEDED',
      message:
        `Backup declares ${deps.length} external dependencies, exceeding limit ` +
        `${bounds.maxExternalDependencies}`
    };
  }
  let totalBytes = 0;
  for (const dep of deps) {
    if (!Number.isSafeInteger(dep.byteLength) || dep.byteLength < 0) {
      return {
        ok: false,
        reasonCode: 'EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT',
        message: `External dependency '${dep.referenceId}' has an invalid byteLength`
      };
    }
    totalBytes += dep.byteLength;
    if (totalBytes > bounds.maxExternalDependencyBytes) {
      return {
        ok: false,
        reasonCode: 'EXTERNAL_DEPENDENCY_BOUND_EXCEEDED',
        message:
          `Backup external dependencies exceed cumulative byte ceiling ` +
          `(${bounds.maxExternalDependencyBytes} bytes)`
      };
    }
  }
  return { ok: true, totalBytes };
}

export function externalDependencyKey(dep: BackupExternalDependency): string {
  return JSON.stringify([
    dep.dependencyKind,
    dep.referenceId,
    dep.relativePath,
    dep.byteLength,
    dep.sha256Digest
  ]);
}

export function serializeManifestJson(manifest: BackupDependencyManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export interface ExternalDependencyState {
  readonly exists: boolean;
  readonly byteLength: number;
  readonly sha256Digest: string;
  readonly exceededByteBudget?: boolean | undefined;
}

export interface ExternalDependencyInspectOptions {
  readonly remainingBudgetBytes?: number | undefined;
}

export type ExternalDependencyInspector = (
  relativePath: string,
  options?: ExternalDependencyInspectOptions
) => ExternalDependencyState | undefined;

const ASYNC_DEP_YIELD_EVERY = 16;

const yieldEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

export function inspectOneExternalDependency(
  inspector: ExternalDependencyInspector,
  dep: BackupExternalDependency,
  remainingBudgetBytes: number,
  maxExternalBytes: number
):
  | { readonly ok: true; readonly byteLength: number }
  | { readonly ok: false; readonly reasonCode: BackupRestoreRejectionCode; readonly message: string } {
  let state: ExternalDependencyState | undefined;
  try {
    state = inspector(dep.relativePath, { remainingBudgetBytes });
  } catch {
    // A failing programmatic inspector is the same refusal as an unreadable dependency.
  }
  if (state?.exceededByteBudget) {
    return {
      ok: false,
      reasonCode: 'EXTERNAL_DEPENDENCY_BOUND_EXCEEDED',
      message: `Inspected external dependencies exceed cumulative byte ceiling (${maxExternalBytes} bytes)`
    };
  }
  if (!state || !state.exists || !Number.isSafeInteger(state.byteLength) || state.byteLength < 0) {
    return {
      ok: false,
      reasonCode: 'EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT',
      message: `External dependency verification failed for ${dep.dependencyKind} '${dep.referenceId}'`
    };
  }
  if (state.byteLength > remainingBudgetBytes) {
    return {
      ok: false,
      reasonCode: 'EXTERNAL_DEPENDENCY_BOUND_EXCEEDED',
      message: `Inspected external dependencies exceed cumulative byte ceiling (${maxExternalBytes} bytes)`
    };
  }
  if (state.byteLength !== dep.byteLength || state.sha256Digest !== dep.sha256Digest) {
    return {
      ok: false,
      reasonCode: 'EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT',
      message: `External dependency digest or size mismatch for ${dep.dependencyKind} '${dep.referenceId}'`
    };
  }
  return { ok: true, byteLength: state.byteLength };
}

export type ExternalDependenciesVerifyResult =
  | { readonly ok: true; readonly verifiedCount: number }
  | { readonly ok: false; readonly reasonCode: BackupRestoreRejectionCode; readonly message: string };

export function verifyExternalDependenciesSync(
  deps: readonly BackupExternalDependency[],
  inspector: ExternalDependencyInspector | undefined,
  maxExternalBytes: number
): ExternalDependenciesVerifyResult {
  if (deps.length === 0) return { ok: true, verifiedCount: 0 };
  if (!inspector) {
    return {
      ok: false,
      reasonCode: 'EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT',
      message:
        `Backup manifest declares ${deps.length} external ` +
        'dependency(ies) but no external dependency inspector was provided'
    };
  }
  let inspectedBytesTotal = 0;
  let verifiedCount = 0;
  for (const dep of deps) {
    const checked = inspectOneExternalDependency(
      inspector,
      dep,
      Math.max(0, maxExternalBytes - inspectedBytesTotal),
      maxExternalBytes
    );
    if (!checked.ok) return checked;
    inspectedBytesTotal += checked.byteLength;
    verifiedCount += 1;
  }
  return { ok: true, verifiedCount };
}

export async function verifyExternalDependenciesAsync(
  deps: readonly BackupExternalDependency[],
  inspector: ExternalDependencyInspector | undefined,
  maxExternalBytes: number
): Promise<ExternalDependenciesVerifyResult> {
  if (deps.length === 0) return { ok: true, verifiedCount: 0 };
  if (!inspector) {
    return {
      ok: false,
      reasonCode: 'EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT',
      message:
        `Backup manifest declares ${deps.length} external ` +
        'dependency(ies) but no external dependency inspector was provided'
    };
  }
  let inspectedBytesTotal = 0;
  let verifiedCount = 0;
  for (let i = 0; i < deps.length; i += 1) {
    const dep = deps[i]!;
    const checked = inspectOneExternalDependency(
      inspector,
      dep,
      Math.max(0, maxExternalBytes - inspectedBytesTotal),
      maxExternalBytes
    );
    if (!checked.ok) return checked;
    inspectedBytesTotal += checked.byteLength;
    verifiedCount += 1;
    if ((i + 1) % ASYNC_DEP_YIELD_EVERY === 0 || checked.byteLength >= 64 * 1024) {
      await yieldEventLoop();
    }
  }
  return { ok: true, verifiedCount };
}
