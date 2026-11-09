/**
 * FR-R6-F05 (FR-004..FR-007) — durable, idempotent artifact references.
 *
 * A reference is keyed by `(artifact_id, owner_type, owner_id, purpose)`; its
 * id is the sha256 of that key, so a repeat add or release finds the same row.
 * Owner ids are plain shared (F02) identities: no foreign key, no cascade, so
 * removing an F04 `runs` row cannot drop a pin.
 *
 * Protection fails closed (FR-006): a store written by a newer build, an
 * artifact with no lifecycle owner record, or an owner the resolver cannot
 * place all count as protected, with one bounded diagnostic.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { createHash } from 'node:crypto';
import {
  ARTIFACT_PINS_PER_OWNER_MAX,
  F05_REFERENCE_PURPOSES,
  LIFECYCLE_DIAGNOSTIC_DETAIL_MAX_CHARS,
  REFERENCE_OWNER_TYPES,
  type ArtifactReference,
  type LifecycleDiagnostic,
  type LifecycleResult,
  type ReferenceOwnerType,
  type ReferencePurpose,
  type ReferenceReleaseReason,
  type RetentionPreviewSummary
} from '../../contracts/artifact-lifecycle/lifecycle-types';
import { checkPinQuotaAdmission } from '../../contracts/shared-memory-storage/artifacts-streams-and-acp';
import { sanitizeOperatorExplanation } from '../../contracts/shared-memory-storage/inventories';
import { SQLITE_SCHEMA_CURRENT_VERSION } from '../../contracts/sqlite-store/schema-types';
import type { NodeSqliteConnection } from '../sqlite-store';
import { includesValue, inImmediateTransaction, isOpaqueId, ok, refuse } from './lifecycle-results';

/** How the host places an owner after a restart (FR-006). */
export type OwnerResolution = 'live' | 'settled' | 'unresolved';
export type OwnerResolver = (ownerType: ReferenceOwnerType, ownerId: string) => OwnerResolution;

export interface ReferenceKey {
  readonly artifactId: string;
  readonly ownerType: ReferenceOwnerType;
  readonly ownerId: string;
  readonly purpose: ReferencePurpose;
}

export interface AddReferenceInput extends ReferenceKey {
  readonly protective: boolean;
}

/** Automatic release only; an operator release goes through the preview gate. */
export interface ReleaseReferenceInput extends ReferenceKey {
  readonly reason: Exclude<ReferenceReleaseReason, 'operator-early-release'>;
}

export interface ProtectionVerdict {
  readonly protected: boolean;
  readonly diagnostic: LifecycleDiagnostic | null;
}

interface ReferenceRow {
  readonly reference_id: string;
  readonly artifact_id: string;
  readonly owner_type: ReferenceOwnerType;
  readonly owner_id: string;
  readonly purpose: ReferencePurpose;
  readonly protective: number;
  readonly created_revision: number;
  readonly released_revision: number | null;
  readonly release_reason: ReferenceReleaseReason | null;
  readonly created_at_ms: number;
  readonly released_at_ms: number | null;
}

const SURRENDERED_CAPABILITY: Readonly<Record<ReferencePurpose, string>> = {
  'active-recovery': 'resume of an active run',
  'paused-recovery': 'resume of a paused run',
  'uncertain-recovery': 'recovery of a run whose outcome is uncertain',
  'pending-handoff': 'a pending handoff',
  'report-lease': 'a report being generated',
  'export-operation': 'an export in progress',
  'phase-context': 'phase-to-phase context',
  'operator-hold': 'an operator hold'
};

export function referenceIdFor(key: ReferenceKey): string {
  const material = JSON.stringify([key.artifactId, key.ownerType, key.ownerId, key.purpose]);
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

function toReference(row: ReferenceRow): ArtifactReference {
  return {
    referenceId: row.reference_id,
    artifactId: row.artifact_id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    purpose: row.purpose,
    protective: row.protective === 1,
    active: row.released_revision === null,
    createdRevision: row.created_revision,
    releasedRevision: row.released_revision,
    releaseReason: row.release_reason,
    createdAtMs: row.created_at_ms,
    releasedAtMs: row.released_at_ms
  };
}

function diagnostic(code: LifecycleDiagnostic['code'], artifactId: string | null, detail: string): LifecycleDiagnostic {
  return {
    code,
    artifactId,
    detail: sanitizeOperatorExplanation(detail).slice(0, LIFECYCLE_DIAGNOSTIC_DETAIL_MAX_CHARS)
  };
}

function isValidKey(key: ReferenceKey): boolean {
  return (
    isOpaqueId(key.artifactId) &&
    isOpaqueId(key.ownerId) &&
    includesValue(REFERENCE_OWNER_TYPES, key.ownerType) &&
    includesValue(F05_REFERENCE_PURPOSES, key.purpose)
  );
}

const RELEASE_REASONS = ['owner-durable', 'expired'] as const;

const PROTECTED: ProtectionVerdict = { protected: true, diagnostic: null };
const UNPROTECTED: ProtectionVerdict = { protected: false, diagnostic: null };

export class ReferenceStore {
  private readonly conn: NodeSqliteConnection;
  private readonly nowMs: () => number;

  public constructor(conn: NodeSqliteConnection, nowMs: () => number) {
    this.conn = conn;
    this.nowMs = nowMs;
  }

  /**
   * Idempotent: a repeat add of an active key returns the existing row unchanged, except that a
   * protective add upgrades an active non-protective row in place, bumping the revision. Protection
   * is never downgraded by a later non-protective add; only a release ends it.
   */
  public add(input: AddReferenceInput): LifecycleResult<ArtifactReference> {
    if (!isValidKey(input) || typeof input.protective !== 'boolean') {
      return refuse('invalid-input', 'reference key or protective flag is malformed');
    }
    const artifactExists = this.conn.scalar<number>('SELECT 1 FROM artifacts WHERE artifact_id = ?', input.artifactId);
    if (artifactExists !== 1) return refuse('not-found', 'no such artifact', input.artifactId);
    const referenceId = referenceIdFor(input);
    return inImmediateTransaction(this.conn, () => {
      const existing = this.readRow(referenceId);
      if (existing !== undefined && existing.released_revision === null) {
        if (!input.protective || existing.protective === 1) return ok(toReference(existing));
        this.conn.run(
          `UPDATE artifact_references SET protective = 1, created_revision = ? WHERE reference_id = ?`,
          this.bumpRevision(input.artifactId),
          referenceId
        );
        return this.getById(referenceId);
      }
      const admission = checkPinQuotaAdmission({
        currentPinnedCount: this.activeCountForOwner(input.ownerType, input.ownerId),
        maxPinQuota: ARTIFACT_PINS_PER_OWNER_MAX,
        settlementReservePins: 0,
        isSettlementWork: false
      });
      if (admission.status !== 'accepted') {
        return refuse<ArtifactReference>('pin-quota-reached', 'this owner already holds the maximum number of pins');
      }
      const revision = this.bumpRevision(input.artifactId);
      const now = this.nowMs();
      if (existing === undefined) {
        this.conn.run(
          `INSERT INTO artifact_references (reference_id, artifact_id, owner_type, owner_id, purpose, protective,
             created_revision, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          referenceId,
          input.artifactId,
          input.ownerType,
          input.ownerId,
          input.purpose,
          input.protective ? 1 : 0,
          revision,
          now
        );
      } else {
        this.conn.run(
          `UPDATE artifact_references SET protective = ?, created_revision = ?, created_at_ms = ?,
             released_revision = NULL, release_reason = NULL, released_at_ms = NULL WHERE reference_id = ?`,
          input.protective ? 1 : 0,
          revision,
          now,
          referenceId
        );
      }
      return this.getById(referenceId);
    });
  }

  /** Idempotent: a repeat release returns the already-released row unchanged. */
  public release(input: ReleaseReferenceInput): LifecycleResult<ArtifactReference> {
    if (!isValidKey(input) || !includesValue(RELEASE_REASONS, input.reason)) {
      return refuse('invalid-input', 'reference key or release reason is malformed');
    }
    return this.markReleased(referenceIdFor(input), input.reason);
  }

  /** Host-internal: the effect behind an authorized early release. */
  public releaseEarly(referenceId: string): LifecycleResult<ArtifactReference> {
    return this.markReleased(referenceId, 'operator-early-release');
  }

  public getById(referenceId: string): LifecycleResult<ArtifactReference> {
    const row = /^[0-9a-f]{64}$/.test(referenceId) ? this.readRow(referenceId) : undefined;
    return row === undefined ? refuse('not-found', 'no such reference') : ok(toReference(row));
  }

  public list(artifactId: string): LifecycleResult<readonly ArtifactReference[]> {
    if (!isOpaqueId(artifactId)) return refuse('invalid-input', 'artifact id is malformed');
    const rows = this.conn.all<ReferenceRow>(
      'SELECT * FROM artifact_references WHERE artifact_id = ? ORDER BY reference_id',
      artifactId
    );
    return ok(rows.map(toReference));
  }

  public isProtected(artifactId: string, resolveOwner: OwnerResolver): ProtectionVerdict {
    if (this.storeIsFromNewerBuild()) {
      return {
        protected: true,
        diagnostic: diagnostic('unknown-version', isOpaqueId(artifactId) ? artifactId : null, 'the store was written by a newer build; references are preserved, not interpreted')
      };
    }
    if (!isOpaqueId(artifactId)) {
      return { protected: true, diagnostic: diagnostic('ownership-unresolved', null, 'artifact id is malformed') };
    }
    const managed = this.conn.scalar<number>('SELECT 1 FROM artifact_lifecycle WHERE artifact_id = ?', artifactId);
    if (managed !== 1) {
      return { protected: true, diagnostic: diagnostic('ownership-unresolved', artifactId, 'artifact has no lifecycle owner record') };
    }
    const active = this.conn.all<ReferenceRow>(
      'SELECT * FROM artifact_references WHERE artifact_id = ? AND released_revision IS NULL ORDER BY reference_id',
      artifactId
    );
    if (active.some((row) => row.protective === 1)) return PROTECTED;
    const unresolved = active.find((row) => resolveOwner(row.owner_type, row.owner_id) === 'unresolved');
    if (unresolved === undefined) return UNPROTECTED;
    return {
      protected: true,
      diagnostic: diagnostic('ownership-unresolved', artifactId, `the ${unresolved.owner_type} owning a ${unresolved.purpose} reference cannot be resolved`)
    };
  }

  /** Run ids holding an active protective reference: the checkpoint sweeper's `pinnedRunIds` shape. */
  public protectedRunIds(): ReadonlySet<string> {
    const rows = this.conn.all<{ owner_id: string }>(
      `SELECT DISTINCT owner_id FROM artifact_references
        WHERE owner_type = 'run' AND protective = 1 AND released_revision IS NULL`
    );
    return new Set(rows.map((row) => row.owner_id));
  }

  /** Staleness basis for an early-release preview: changes whenever the reference does. */
  public earlyReleaseBasis(reference: ArtifactReference): string {
    return `early-release:${reference.referenceId}:${reference.createdRevision}:${reference.releasedRevision ?? 'active'}`;
  }

  public earlyReleaseSummary(reference: ArtifactReference, byteSize: number): RetentionPreviewSummary {
    const capability = SURRENDERED_CAPABILITY[reference.purpose];
    return {
      affectedCount: 1,
      affectedBytes: byteSize,
      protectedCount: 0,
      protectedBytes: 0,
      unclassifiedCount: 0,
      unclassifiedBytes: 0,
      perClass: [],
      protectedExceptions: [],
      coverage: 'complete',
      notes: [
        sanitizeOperatorExplanation(
          `Releasing this ${reference.purpose} reference surrenders ${capability} for ${reference.ownerType} ${reference.ownerId}.`
        )
      ]
    };
  }

  private markReleased(referenceId: string, reason: ReferenceReleaseReason): LifecycleResult<ArtifactReference> {
    return inImmediateTransaction(this.conn, () => {
      const existing = this.readRow(referenceId);
      if (existing === undefined) return refuse<ArtifactReference>('not-found', 'no such reference');
      if (existing.released_revision !== null) return ok(toReference(existing));
      const revision = this.bumpRevision(existing.artifact_id);
      this.conn.run(
        `UPDATE artifact_references SET released_revision = ?, release_reason = ?, released_at_ms = ?
          WHERE reference_id = ? AND released_revision IS NULL`,
        revision,
        reason,
        this.nowMs(),
        referenceId
      );
      return this.getById(referenceId);
    });
  }

  private readRow(referenceId: string): ReferenceRow | undefined {
    return this.conn.get<ReferenceRow>('SELECT * FROM artifact_references WHERE reference_id = ?', referenceId);
  }

  private activeCountForOwner(ownerType: ReferenceOwnerType, ownerId: string): number {
    return (
      this.conn.scalar<number>(
        `SELECT COUNT(*) FROM artifact_references WHERE owner_type = ? AND owner_id = ? AND released_revision IS NULL`,
        ownerType,
        ownerId
      ) ?? 0
    );
  }

  /** A reference change is a lifecycle change: stale previews of the artifact must notice it. */
  private bumpRevision(artifactId: string): number {
    this.conn.run(
      `UPDATE artifact_lifecycle SET lifecycle_revision = lifecycle_revision + 1, updated_at_ms = ? WHERE artifact_id = ?`,
      this.nowMs(),
      artifactId
    );
    return this.conn.scalar<number>('SELECT lifecycle_revision FROM artifact_lifecycle WHERE artifact_id = ?', artifactId) ?? 0;
  }

  private storeIsFromNewerBuild(): boolean {
    const applied = this.conn.scalar<number>('SELECT MAX(version) FROM schema_migrations') ?? 0;
    return applied > SQLITE_SCHEMA_CURRENT_VERSION;
  }
}
