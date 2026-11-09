/**
 * FR-R6-F05 (FR-001..003, FR-022) — artifact lifecycle records.
 *
 * Registration writes the F04 `artifacts`, `artifact_locations` and
 * `artifact_availability` rows and the F05 `artifact_lifecycle` row in one
 * transaction, so a crash never leaves half a registration. The host locator
 * (`uri_or_relpath`) is stored and handed to the injected byte probe only; it
 * never appears in a returned record.
 *
 * Reconciliation compares the stored producer identity, generation, extent and
 * digest with what the probe observes, and moves availability with a CAS on
 * `lifecycle_revision`. It never deletes the record or its references, so the
 * fact that an execution referenced the artifact survives (FR-022).
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import * as path from 'node:path';
import {
  ARTIFACT_IMMUTABILITIES,
  ARTIFACT_SENSITIVITIES,
  ARTIFACT_STORE_KINDS,
  type ArtifactAvailabilityState,
  type ArtifactDigest,
  type ArtifactImmutability,
  type ArtifactRecord,
  type ArtifactSensitivity,
  type ArtifactStoreKind,
  type LifecycleResult,
  type RetentionClassId
} from '../../contracts/artifact-lifecycle/lifecycle-types';
import { RETENTION_CLASS_IDS } from '../../contracts/shared-memory-storage/consumer-and-retention-inventories';
import type { NodeSqliteConnection } from '../sqlite-store';
import { isArtifactAvailabilityState, resolveAvailability } from './availability-mapping';
import {
  inImmediateTransaction,
  includesValue,
  isNonNegativeInteger,
  isOpaqueId,
  ok,
  refuse,
  sanitizeDisplayName
} from './lifecycle-results';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const DIGEST_ALGORITHMS = ['sha256'] as const;
/** F04 `artifacts.content_sha256` is NOT NULL; a growing artifact has no digest yet. */
const GROWING_CONTENT_SHA256_SENTINEL = '0'.repeat(64);
const STORAGE_TIERS = ['inline_db', 'cas_blob', 'workspace_file'] as const;
const MAX_MEDIA_TYPE_CHARS = 128;
const MAX_LOCATOR_CHARS = 4096;
const UNMANAGED_RETENTION_CLASS: RetentionClassId = 'transcripts-diagnostics-checkpoints-audit-catalog';
/** Availability a reconciliation never revives: removal was an explicit lifecycle decision. */
const SETTLED_AVAILABILITY: readonly ArtifactAvailabilityState[] = ['deleted', 'expired'];

export interface ArtifactLocator {
  readonly storageTier: (typeof STORAGE_TIERS)[number];
  /** Host-private. Never returned to a caller. */
  readonly uriOrRelpath: string;
}

export interface RegisterArtifactInput {
  readonly artifactId: string;
  readonly ownerRunId?: string | undefined;
  readonly ownerAttemptId?: string | undefined;
  readonly sensitivity: ArtifactSensitivity;
  readonly retentionClass: RetentionClassId;
  readonly storeKind: ArtifactStoreKind;
  readonly immutability: ArtifactImmutability;
  readonly digest?: ArtifactDigest | undefined;
  readonly generation?: number | undefined;
  readonly extentBytes?: number | undefined;
  readonly byteSize: number;
  readonly mediaType: string;
  readonly displayName: string;
  readonly producerIdentity: string;
  readonly locator: ArtifactLocator;
}

export interface ArtifactByteObservation {
  readonly exists: boolean;
  readonly sizeBytes: number;
  /** Writer identity read from the bytes' own header or sidecar; null when the format carries none. */
  readonly producerIdentity: string | null;
  readonly generation: number | null;
}

/** Injected by the host; resolves the private locator to bytes. */
export interface ArtifactByteProbe {
  observe(locator: ArtifactLocator): Promise<ArtifactByteObservation>;
  /** SHA-256 of the complete bytes, lowercase hex; null when unreadable. */
  digestSha256(locator: ArtifactLocator): Promise<string | null>;
}

export interface ManagedPageRequest {
  readonly after?: { readonly retentionClass: string; readonly artifactId: string } | undefined;
  readonly retentionClass?: RetentionClassId | undefined;
  readonly limit: number;
}

interface LifecycleRow {
  readonly artifact_id: string;
  readonly lifecycle_revision: number;
  readonly owner_run_id: string | null;
  readonly owner_attempt_id: string | null;
  readonly sensitivity: string;
  readonly retention_class: string;
  readonly store_kind: string;
  readonly immutability: string;
  readonly digest_value: string | null;
  readonly generation: number | null;
  readonly extent_bytes: number | null;
  readonly byte_size: number;
  readonly availability: string;
  readonly producer_identity: string;
  readonly display_name: string;
  readonly created_at_ms: number;
  readonly terminal_settled_at_ms: number | null;
  readonly expires_at_ms: number | null;
  readonly updated_at_ms: number;
}

interface F04Row {
  readonly artifact_id: string;
  readonly content_sha256: string;
  readonly byte_length: number;
  readonly media_type: string;
  readonly kind: string;
  readonly created_by_run_id: string | null;
  readonly created_by_attempt_id: string | null;
  readonly created_at_ms: number;
  readonly state: string | null;
}

/**
 * A workspace file locator names a path beneath the workspace: never absolute, never a NUL,
 * and no `..` segment under either separator. The deletion and copy boundaries still check
 * containment on their own; this refuses the obviously escaping locator at the door.
 */
function isWorkspaceRelative(locator: string): boolean {
  if (locator.includes('\0') || path.isAbsolute(locator) || path.win32.isAbsolute(locator)) return false;
  return !locator.split(/[\\/]/).includes('..');
}

function validateRegistration(input: RegisterArtifactInput): string | null {
  if (!isOpaqueId(input.artifactId)) return 'artifactId must be an opaque id';
  if (input.ownerRunId !== undefined && !isOpaqueId(input.ownerRunId)) return 'ownerRunId must be an opaque id';
  if (input.ownerAttemptId !== undefined && !isOpaqueId(input.ownerAttemptId)) return 'ownerAttemptId must be an opaque id';
  if (!includesValue(ARTIFACT_SENSITIVITIES, input.sensitivity)) return 'unknown sensitivity';
  if (!includesValue(RETENTION_CLASS_IDS, input.retentionClass)) return 'unknown retention class';
  if (!includesValue(ARTIFACT_STORE_KINDS, input.storeKind)) return 'unknown store kind';
  if (!includesValue(ARTIFACT_IMMUTABILITIES, input.immutability)) return 'unknown immutability';
  if (!isNonNegativeInteger(input.byteSize)) return 'byteSize must be a non-negative integer';
  if (typeof input.mediaType !== 'string' || input.mediaType.length === 0 || input.mediaType.length > MAX_MEDIA_TYPE_CHARS) {
    return 'mediaType must be a bounded string';
  }
  if (!isOpaqueId(input.producerIdentity)) return 'producerIdentity must be an opaque id';
  if (typeof input.displayName !== 'string') return 'displayName must be a string';
  if (!includesValue(STORAGE_TIERS, input.locator.storageTier)) return 'unknown storage tier';
  const locator = input.locator.uriOrRelpath;
  if (typeof locator !== 'string' || locator.length === 0 || locator.length > MAX_LOCATOR_CHARS) {
    return 'locator must be a bounded string';
  }
  if (input.locator.storageTier === 'workspace_file' && !isWorkspaceRelative(locator)) {
    return 'a workspace file locator must be a relative path with no parent segment';
  }
  return input.immutability === 'immutable' ? validateImmutable(input) : validateGrowing(input);
}

function validateImmutable(input: RegisterArtifactInput): string | null {
  if (input.digest === undefined) return 'an immutable artifact needs the digest of its completed bytes';
  if (!includesValue(DIGEST_ALGORITHMS, input.digest.algorithm) || !DIGEST_PATTERN.test(input.digest.value)) {
    return 'digest must be sha256 as 64 lowercase hex characters';
  }
  if (input.generation !== undefined || input.extentBytes !== undefined) {
    return 'an immutable artifact has no generation or extent';
  }
  return null;
}

function validateGrowing(input: RegisterArtifactInput): string | null {
  if (input.digest !== undefined) return 'a growing artifact must not claim a digest';
  if (!isNonNegativeInteger(input.generation) || !isNonNegativeInteger(input.extentBytes)) {
    return 'a growing artifact needs a generation and an extent';
  }
  return null;
}

function toRecord(row: LifecycleRow, mediaType: string): ArtifactRecord {
  const availability = resolveAvailability({ availability: row.availability }, undefined).availability;
  const immutability = row.immutability as ArtifactImmutability;
  return {
    artifactId: row.artifact_id,
    managed: true,
    lifecycleRevision: row.lifecycle_revision,
    ownerRunId: row.owner_run_id,
    ownerAttemptId: row.owner_attempt_id,
    sensitivity: row.sensitivity as ArtifactSensitivity,
    retentionClass: row.retention_class as RetentionClassId,
    storeKind: row.store_kind as ArtifactStoreKind,
    immutability,
    digest: row.digest_value === null ? null : { algorithm: 'sha256', value: row.digest_value },
    generation: row.generation,
    extentBytes: row.extent_bytes,
    byteSize: row.byte_size,
    availability,
    mediaType,
    displayName: row.display_name,
    createdAtMs: row.created_at_ms,
    terminalSettledAtMs: row.terminal_settled_at_ms,
    expiresAtMs: row.expires_at_ms,
    updatedAtMs: row.updated_at_ms
  };
}

function toUnmanagedRecord(row: F04Row): ArtifactRecord {
  const resolved = resolveAvailability(undefined, row.state === null ? undefined : { state: row.state });
  const digest = DIGEST_PATTERN.test(row.content_sha256) ? row.content_sha256 : null;
  return {
    artifactId: row.artifact_id,
    managed: false,
    lifecycleRevision: 0,
    ownerRunId: row.created_by_run_id,
    ownerAttemptId: row.created_by_attempt_id,
    sensitivity: 'content',
    retentionClass: UNMANAGED_RETENTION_CLASS,
    storeKind: resolved.forcedStoreKind ?? 'unclassified',
    immutability: 'immutable',
    digest: digest === null ? null : { algorithm: 'sha256', value: digest },
    generation: null,
    extentBytes: null,
    byteSize: row.byte_length,
    availability: resolved.availability,
    mediaType: row.media_type,
    displayName: sanitizeDisplayName(row.kind),
    createdAtMs: row.created_at_ms,
    terminalSettledAtMs: null,
    expiresAtMs: null,
    updatedAtMs: row.created_at_ms
  };
}

/** Pure decision: the availability a probe observation implies for a stored record. */
export function decideReconciledAvailability(
  record: ArtifactRecord,
  producerIdentity: string,
  observation: ArtifactByteObservation,
  observedDigest: string | null
): ArtifactAvailabilityState {
  if (SETTLED_AVAILABILITY.includes(record.availability)) return record.availability;
  if (!observation.exists) return 'missing';
  if (observation.producerIdentity !== null && observation.producerIdentity !== producerIdentity) return 'corrupt';
  if (record.immutability === 'immutable') {
    if (observation.sizeBytes !== record.byteSize) return 'corrupt';
    return observedDigest !== null && observedDigest === record.digest?.value ? 'present' : 'corrupt';
  }
  if (observation.generation !== null && observation.generation !== record.generation) return 'corrupt';
  return observation.sizeBytes < (record.extentBytes ?? 0) ? 'corrupt' : 'present';
}

export class ArtifactRecordStore {
  private readonly conn: NodeSqliteConnection;
  private readonly nowMs: () => number;

  public constructor(conn: NodeSqliteConnection, nowMs: () => number) {
    this.conn = conn;
    this.nowMs = nowMs;
  }

  public register(input: RegisterArtifactInput): LifecycleResult<ArtifactRecord> {
    const invalid = validateRegistration(input);
    if (invalid !== null) return refuse('invalid-input', invalid);
    const exists = this.conn.get(`SELECT 1 AS one FROM artifacts WHERE artifact_id = ?`, input.artifactId);
    if (exists !== undefined) return refuse('identity-conflict', 'an artifact with this id already exists', input.artifactId);
    const now = this.nowMs();
    inImmediateTransaction(this.conn, () => this.insertRegistration(input, now));
    return this.get(input.artifactId);
  }

  public get(artifactId: string): LifecycleResult<ArtifactRecord> {
    if (!isOpaqueId(artifactId)) return refuse('invalid-input', 'artifactId must be an opaque id');
    const row = this.readLifecycleRow(artifactId);
    const f04 = this.readF04Row(artifactId);
    if (f04 === undefined) return refuse('not-found', 'no such artifact', artifactId);
    return ok(row === undefined ? toUnmanagedRecord(f04) : toRecord(row, f04.media_type));
  }

  /** The record, only when its bytes are usable; missing bytes never read as an empty artifact (FR-003). */
  public requireUsable(artifactId: string): LifecycleResult<ArtifactRecord> {
    const result = this.get(artifactId);
    if (!result.ok) return result;
    if (result.value.availability !== 'present') {
      return refuse('unavailable', `artifact bytes are ${result.value.availability}`, artifactId);
    }
    return result;
  }

  /** Host-internal: the private locator, for the byte probe and the deletion boundary only. */
  public locatorOf(artifactId: string): ArtifactLocator | null {
    const row = this.conn.get<{ storage_tier: string; uri_or_relpath: string }>(
      `SELECT storage_tier, uri_or_relpath FROM artifact_locations WHERE artifact_id = ? ORDER BY location_id LIMIT 1`,
      artifactId
    );
    if (row === undefined || !includesValue(STORAGE_TIERS, row.storage_tier)) return null;
    return { storageTier: row.storage_tier, uriOrRelpath: row.uri_or_relpath };
  }

  public async reconcile(artifactId: string, probe: ArtifactByteProbe): Promise<LifecycleResult<ArtifactRecord>> {
    const current = this.get(artifactId);
    if (!current.ok) return current;
    const row = this.readLifecycleRow(artifactId);
    const locator = this.locatorOf(artifactId);
    if (row === undefined || locator === null) {
      return refuse('ownership-unresolved', 'artifact is not under lifecycle management', artifactId);
    }
    const record = current.value;
    const observation = await probe.observe(locator);
    const sizeMatches = observation.exists && observation.sizeBytes === record.byteSize;
    const digest = record.immutability === 'immutable' && sizeMatches ? await probe.digestSha256(locator) : null;
    const next = decideReconciledAvailability(record, row.producer_identity, observation, digest);
    if (next === record.availability) return current;
    const moved = this.compareAndSetAvailability(artifactId, record.lifecycleRevision, next);
    if (!moved) return refuse('content-conflict', 'artifact changed during reconciliation; retry', artifactId);
    return this.get(artifactId);
  }

  /** CAS on `lifecycle_revision`; false when another change landed first. */
  public compareAndSetAvailability(
    artifactId: string,
    expectedRevision: number,
    availability: ArtifactAvailabilityState
  ): boolean {
    if (!isArtifactAvailabilityState(availability)) return false;
    const result = this.conn.run(
      `UPDATE artifact_lifecycle SET availability = ?, lifecycle_revision = lifecycle_revision + 1, updated_at_ms = ?
       WHERE artifact_id = ? AND lifecycle_revision = ?`,
      availability,
      this.nowMs(),
      artifactId,
      expectedRevision
    );
    return result.changes === 1;
  }

  /**
   * Managed records after the `(retentionClass, artifactId)` keyset, in that
   * order, at most `limit`. The keyset never skips or repeats a row when rows
   * are inserted on either side of it (NFR-001).
   */
  public pageManaged(request: ManagedPageRequest): readonly ArtifactRecord[] {
    const after = request.after ?? { retentionClass: '', artifactId: '' };
    const classFilter = request.retentionClass ?? null;
    const rows = this.conn.all<LifecycleRow & { readonly media_type: string }>(
      `SELECT l.*, a.media_type FROM artifact_lifecycle l JOIN artifacts a ON a.artifact_id = l.artifact_id
       WHERE (? IS NULL OR l.retention_class = ?) AND (l.retention_class, l.artifact_id) > (?, ?)
       ORDER BY l.retention_class, l.artifact_id LIMIT ?`,
      classFilter,
      classFilter,
      after.retentionClass,
      after.artifactId,
      request.limit
    );
    return rows.map((row) => toRecord(row, row.media_type));
  }

  /** Resolved locators of managed workspace files; the scanner skips bytes a record already names. */
  public workspaceFileLocators(): readonly string[] {
    const rows = this.conn.all<{ uri_or_relpath: string }>(
      `SELECT loc.uri_or_relpath FROM artifact_locations loc
       JOIN artifact_lifecycle l ON l.artifact_id = loc.artifact_id
       WHERE loc.storage_tier = 'workspace_file'`
    );
    return rows.map((row) => row.uri_or_relpath);
  }

  private insertRegistration(input: RegisterArtifactInput, now: number): void {
    const contentSha256 = input.digest?.value ?? GROWING_CONTENT_SHA256_SENTINEL;
    // F04 creator columns reference `runs`/`attempts`; F05 owner ids are plain text (no FK, no cascade).
    this.conn.run(
      `INSERT INTO artifacts (artifact_id, content_sha256, byte_length, media_type, kind, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.artifactId,
      contentSha256,
      input.byteSize,
      input.mediaType,
      input.storeKind,
      now
    );
    this.conn.run(
      `INSERT INTO artifact_locations (location_id, artifact_id, storage_tier, uri_or_relpath, inline_bytes, verified_at_ms)
       VALUES (?, ?, ?, ?, NULL, ?)`,
      `${input.artifactId}#0`,
      input.artifactId,
      input.locator.storageTier,
      input.locator.uriOrRelpath,
      now
    );
    this.conn.run(
      `INSERT INTO artifact_availability (artifact_id, state, last_verified_at_ms, detail_json) VALUES (?, 'available', ?, '{}')`,
      input.artifactId,
      now
    );
    this.conn.run(
      `INSERT INTO artifact_lifecycle (
         artifact_id, lifecycle_revision, owner_run_id, owner_attempt_id, sensitivity, retention_class, store_kind,
         immutability, digest_algorithm, digest_value, generation, extent_bytes, byte_size, availability,
         producer_identity, display_name, created_at_ms, updated_at_ms
       ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'present', ?, ?, ?, ?)`,
      input.artifactId,
      input.ownerRunId ?? null,
      input.ownerAttemptId ?? null,
      input.sensitivity,
      input.retentionClass,
      input.storeKind,
      input.immutability,
      input.digest === undefined ? null : 'sha256',
      input.digest?.value ?? null,
      input.generation ?? null,
      input.extentBytes ?? null,
      input.byteSize,
      input.producerIdentity,
      sanitizeDisplayName(input.displayName),
      now,
      now
    );
  }

  private readLifecycleRow(artifactId: string): LifecycleRow | undefined {
    return this.conn.get<LifecycleRow>(`SELECT * FROM artifact_lifecycle WHERE artifact_id = ?`, artifactId);
  }

  private readF04Row(artifactId: string): F04Row | undefined {
    return this.conn.get<F04Row>(
      `SELECT a.artifact_id, a.content_sha256, a.byte_length, a.media_type, a.kind, a.created_by_run_id,
              a.created_by_attempt_id, a.created_at_ms, av.state
       FROM artifacts a LEFT JOIN artifact_availability av ON av.artifact_id = a.artifact_id
       WHERE a.artifact_id = ?`,
      artifactId
    );
  }
}
