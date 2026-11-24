/**
 * FR-R7-16 (`16-11`, FR-011) — restart-durable recovery envelope protection assessment.
 *
 * Maps a checkpoint directory's lossy `(runSegment, handoverSegment)` path segments back to
 * authoritative SQLite durable state (`recovery_handoffs`, `recovery_handoff_revisions`,
 * `recovery_handoff_references`, and active F05 protective pins in `artifact_references` +
 * `artifact_locations`).
 *
 * Fail-safe contract:
 * - Returns `protected: true` (`'protected'`, `'ambiguous'`, or `'lookup-error'`) whenever an
 *   envelope matches an open handoff or active F05 protective pin, collides under lossy
 *   `safeRunSegment` normalization with an open or unresolved record, sits under a run segment
 *   holding an open unsupported/future/unreadable handoff manifest, or when the SQLite store is
 *   unavailable, closed, from a newer build, or fails to query.
 * - Returns `protected: false` (`'unowned'`) ONLY when a healthy store affirmatively confirms
 *   no matching open handoff, ambiguity, or active protective pin exists.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { HANDOFF_MANIFEST_VERSION } from '../../contracts/recovery-handoff/handoff-types';
import { RECOVERY_ENVELOPE_SUFFIX, RUN_CHECKPOINT_DIRECTORY, safeRunSegment } from '../run-checkpoint-paths';
import type { NodeSqliteConnection } from '../sqlite-store';
import { isNewerBuildStore } from './handoff-pins';

export type EnvelopeProtectionDecision = 'protected' | 'ambiguous' | 'lookup-error' | 'unowned';

export interface EnvelopeProtectionAssessment {
  readonly protected: boolean;
  readonly decision: EnvelopeProtectionDecision;
}

type SegmentMatch = 'none' | 'exact' | 'lossy';

interface OpenHandoffRow {
  readonly handoff_id: string;
  readonly root_execution_id: string;
  readonly invocation_id: string;
  readonly source_attempt_id: string;
  readonly state: string;
}

interface HandoffRevisionManifestRow {
  readonly manifest_version: number;
  readonly manifest_json: string;
}

interface OpenHandoffRefLocationRow {
  readonly root_execution_id: string;
  readonly artifact_id: string;
  readonly uri_or_relpath: string | null;
}

interface ActiveProtectivePinRow {
  readonly artifact_id: string;
  readonly owner_type: string;
  readonly owner_id: string;
  readonly owner_run_id: string | null;
  readonly uri_or_relpath: string | null;
  readonly handoff_root_execution_id: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function classifyPair(
  candidateRun: string,
  candidateHandover: string,
  runSegment: string,
  handoverSegment: string
): SegmentMatch {
  if (safeRunSegment(candidateRun) !== runSegment || safeRunSegment(candidateHandover) !== handoverSegment) {
    return 'none';
  }
  return candidateRun === runSegment && candidateHandover === handoverSegment ? 'exact' : 'lossy';
}

function extractEnvelopePathSegments(
  uriOrRelpath: string
): { readonly parentDir: string | undefined; readonly filePrefix: string } | null {
  const parts = uriOrRelpath.split(/[\\/]/).filter((part) => part.length > 0);
  const leaf = parts.at(-1);
  if (leaf === undefined || !leaf.endsWith(RECOVERY_ENVELOPE_SUFFIX)) return null;
  const filePrefix = leaf.slice(0, -RECOVERY_ENVELOPE_SUFFIX.length);
  if (filePrefix.length === 0) return null;
  const parentDir = parts.length >= 2 ? parts.at(-2) : undefined;
  return { parentDir, filePrefix };
}

function assessLocationsForArtifact(
  conn: NodeSqliteConnection,
  artifactId: string,
  fallbackRun: string,
  runSegment: string,
  handoverSegment: string
): SegmentMatch {
  const rows = conn.all<{ readonly uri_or_relpath: string }>(
    `SELECT uri_or_relpath FROM artifact_locations WHERE artifact_id = ?`,
    artifactId
  );
  let best: SegmentMatch = 'none';
  for (const row of rows) {
    const extracted = extractEnvelopePathSegments(row.uri_or_relpath);
    if (extracted === null) continue;
    const match = classifyPair(
      extracted.parentDir ?? fallbackRun,
      extracted.filePrefix,
      runSegment,
      handoverSegment
    );
    if (match === 'exact') return 'exact';
    if (match === 'lossy') best = 'lossy';
  }
  return best;
}

function assessManifest(
  conn: NodeSqliteConnection,
  handoff: OpenHandoffRow,
  rev: HandoffRevisionManifestRow,
  runSegment: string,
  handoverSegment: string
): { readonly exact: boolean; readonly ambiguous: boolean } {
  if (rev.manifest_version > HANDOFF_MANIFEST_VERSION) {
    return { exact: false, ambiguous: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rev.manifest_json);
  } catch {
    return { exact: false, ambiguous: true };
  }
  if (!isPlainObject(parsed)) {
    return { exact: false, ambiguous: true };
  }
  const version = parsed['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version > HANDOFF_MANIFEST_VERSION) {
    return { exact: false, ambiguous: true };
  }

  let exact = false;
  let ambiguous = false;
  const record = (match: SegmentMatch): void => {
    if (match === 'exact') exact = true;
    else if (match === 'lossy') ambiguous = true;
  };

  const envelope = parsed['envelope'];
  if (envelope !== null && envelope !== undefined) {
    if (!isPlainObject(envelope) || typeof envelope['artifactId'] !== 'string' || envelope['artifactId'].length === 0) {
      ambiguous = true;
    } else {
      const envId = envelope['artifactId'];
      record(classifyPair(handoff.root_execution_id, envId, runSegment, handoverSegment));
      record(assessLocationsForArtifact(conn, envId, handoff.root_execution_id, runSegment, handoverSegment));
    }
  } else if (handoff.root_execution_id !== runSegment) {
    // Lossy run segment with an open handoff that records no explicit envelope identity: fail-safe.
    ambiguous = true;
  }

  const references = parsed['references'];
  if (references !== undefined) {
    if (!Array.isArray(references)) {
      ambiguous = true;
    } else {
      for (const ref of references) {
        if (!isPlainObject(ref) || typeof ref['artifactId'] !== 'string' || ref['artifactId'].length === 0) {
          ambiguous = true;
          continue;
        }
        const refId = ref['artifactId'];
        record(classifyPair(handoff.root_execution_id, refId, runSegment, handoverSegment));
        record(assessLocationsForArtifact(conn, refId, handoff.root_execution_id, runSegment, handoverSegment));
      }
    }
  }

  return { exact, ambiguous };
}

/**
 * Assesses whether `checkpoints/<runSegment>/<handoverSegment>.recovery.json` is protected by
 * durable SQLite recovery handoff state or active F05 protective pins.
 */
export function assessRecoveryEnvelopeProtection(
  conn: NodeSqliteConnection | null,
  runSegment: string,
  handoverSegment: string
): EnvelopeProtectionAssessment {
  if (conn === null || conn.isClosed()) {
    return Object.freeze({ protected: true, decision: 'lookup-error' });
  }
  if (runSegment.length === 0 || handoverSegment.length === 0) {
    return Object.freeze({ protected: true, decision: 'ambiguous' });
  }

  try {
    if (isNewerBuildStore(conn)) {
      return Object.freeze({ protected: true, decision: 'lookup-error' });
    }

    let exactProtected = false;
    let ambiguous = false;
    const record = (match: SegmentMatch): void => {
      if (match === 'exact') exactProtected = true;
      else if (match === 'lossy') ambiguous = true;
    };

    const openHandoffs = conn.all<OpenHandoffRow>(
      `SELECT handoff_id, root_execution_id, invocation_id, source_attempt_id, state
         FROM recovery_handoffs
        WHERE state NOT IN ('consumed', 'superseded')`
    );

    for (const handoff of openHandoffs) {
      if (safeRunSegment(handoff.root_execution_id) !== runSegment) continue;

      if (handoff.state === 'unsupported') {
        ambiguous = true;
        continue;
      }

      for (const candidate of [handoff.handoff_id, handoff.invocation_id, handoff.source_attempt_id]) {
        record(classifyPair(handoff.root_execution_id, candidate, runSegment, handoverSegment));
      }

      const revisions = conn.all<HandoffRevisionManifestRow>(
        `SELECT manifest_version, manifest_json
           FROM recovery_handoff_revisions
          WHERE handoff_id = ?`,
        handoff.handoff_id
      );

      if (revisions.length === 0) {
        // Open handoff without any stored revision cannot prove which envelope it owns.
        ambiguous = true;
        continue;
      }

      for (const rev of revisions) {
        const res = assessManifest(conn, handoff, rev, runSegment, handoverSegment);
        if (res.exact) exactProtected = true;
        if (res.ambiguous) ambiguous = true;
      }
    }

    const openRefs = conn.all<OpenHandoffRefLocationRow>(
      `SELECT h.root_execution_id, r.artifact_id, loc.uri_or_relpath
         FROM recovery_handoff_references r
         JOIN recovery_handoffs h ON h.handoff_id = r.handoff_id
         LEFT JOIN artifact_locations loc ON loc.artifact_id = r.artifact_id
        WHERE h.state NOT IN ('consumed', 'superseded')`
    );
    for (const row of openRefs) {
      record(classifyPair(row.root_execution_id, row.artifact_id, runSegment, handoverSegment));
      if (row.uri_or_relpath !== null) {
        const extracted = extractEnvelopePathSegments(row.uri_or_relpath);
        if (extracted !== null) {
          record(
            classifyPair(
              extracted.parentDir ?? row.root_execution_id,
              extracted.filePrefix,
              runSegment,
              handoverSegment
            )
          );
        }
      }
    }

    const activePins = conn.all<ActiveProtectivePinRow>(
      `SELECT ar.artifact_id,
              ar.owner_type,
              ar.owner_id,
              al.owner_run_id,
              loc.uri_or_relpath,
              h.root_execution_id AS handoff_root_execution_id
         FROM artifact_references ar
         LEFT JOIN artifact_lifecycle al ON al.artifact_id = ar.artifact_id
         LEFT JOIN artifact_locations loc ON loc.artifact_id = ar.artifact_id
         LEFT JOIN recovery_handoffs h ON ar.owner_type = 'handoff' AND h.handoff_id = ar.owner_id
        WHERE ar.protective = 1 AND ar.released_revision IS NULL`
    );

    for (const pin of activePins) {
      const owningRun =
        pin.owner_run_id ??
        (pin.owner_type === 'run' ? pin.owner_id : null) ??
        pin.handoff_root_execution_id;

      if (pin.uri_or_relpath !== null) {
        const extracted = extractEnvelopePathSegments(pin.uri_or_relpath);
        if (extracted !== null) {
          if (extracted.parentDir !== undefined) {
            record(classifyPair(extracted.parentDir, extracted.filePrefix, runSegment, handoverSegment));
          } else if (owningRun !== null) {
            record(classifyPair(owningRun, extracted.filePrefix, runSegment, handoverSegment));
          } else if (safeRunSegment(extracted.filePrefix) === handoverSegment) {
            ambiguous = true;
          }
        }
      }

      if (safeRunSegment(pin.artifact_id) === handoverSegment) {
        if (owningRun !== null) {
          record(classifyPair(owningRun, pin.artifact_id, runSegment, handoverSegment));
        } else {
          // Active protective pin matches handover segment with unresolved run scope: fail-safe.
          ambiguous = true;
        }
      }
    }

    if (exactProtected) return Object.freeze({ protected: true, decision: 'protected' });
    if (ambiguous) return Object.freeze({ protected: true, decision: 'ambiguous' });
    return Object.freeze({ protected: false, decision: 'unowned' });
  } catch {
    return Object.freeze({ protected: true, decision: 'lookup-error' });
  }
}

function classifyRunSegment(candidateRun: string, runSegment: string): SegmentMatch {
  if (safeRunSegment(candidateRun) !== runSegment) return 'none';
  return candidateRun === runSegment ? 'exact' : 'lossy';
}

function checkpointRunSegmentsInPath(uriOrRelpath: string): readonly string[] {
  const parts = uriOrRelpath.split(/[\\/]/).filter((part) => part.length > 0);
  const segments: string[] = [];
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (parts.at(i) === RUN_CHECKPOINT_DIRECTORY) {
      const candidate = parts.at(i + 1);
      if (candidate !== undefined) segments.push(candidate);
    }
  }
  return segments;
}

/**
 * FR-R7-16 (`SR-B2`) — assesses whether `checkpoints/<runSegment>/` is protected by durable
 * SQLite open recovery handoffs or active F05 protective pins.
 *
 * Fail-closed contract: returns `protected: true` (`'lookup-error'`, `'ambiguous'`, or
 * `'protected'`) whenever the store is unavailable, closed, from a newer build, or fails to
 * query, or when any open handoff or active F05 protective pin maps to `runSegment`.
 */
export function assessRunSegmentProtection(
  conn: NodeSqliteConnection | null,
  runSegment: string
): EnvelopeProtectionAssessment {
  if (conn === null || conn.isClosed()) {
    return Object.freeze({ protected: true, decision: 'lookup-error' });
  }
  if (runSegment.length === 0) {
    return Object.freeze({ protected: true, decision: 'ambiguous' });
  }

  try {
    if (isNewerBuildStore(conn)) {
      return Object.freeze({ protected: true, decision: 'lookup-error' });
    }

    const state = { exactProtected: false, ambiguous: false };
    const record = (match: SegmentMatch): void => {
      if (match === 'exact') state.exactProtected = true;
      else if (match === 'lossy') state.ambiguous = true;
    };

    const openHandoffs = conn.all<Pick<OpenHandoffRow, 'root_execution_id' | 'state'>>(
      `SELECT root_execution_id, state
         FROM recovery_handoffs
        WHERE state NOT IN ('consumed', 'superseded')`
    );
    for (const handoff of openHandoffs) {
      const match = classifyRunSegment(handoff.root_execution_id, runSegment);
      if (match === 'none') continue;
      if (handoff.state === 'unsupported') {
        state.ambiguous = true;
      } else {
        record(match);
      }
    }

    const openRefLocations = conn.all<{ readonly uri_or_relpath: string }>(
      `SELECT loc.uri_or_relpath
         FROM recovery_handoff_references r
         JOIN recovery_handoffs h ON h.handoff_id = r.handoff_id
         JOIN artifact_locations loc ON loc.artifact_id = r.artifact_id
        WHERE h.state NOT IN ('consumed', 'superseded')`
    );
    for (const row of openRefLocations) {
      for (const seg of checkpointRunSegmentsInPath(row.uri_or_relpath)) {
        record(classifyRunSegment(seg, runSegment));
      }
      const extracted = extractEnvelopePathSegments(row.uri_or_relpath);
      if (extracted?.parentDir !== undefined) {
        record(classifyRunSegment(extracted.parentDir, runSegment));
      }
    }

    const activePins = conn.all<ActiveProtectivePinRow>(
      `SELECT ar.artifact_id,
              ar.owner_type,
              ar.owner_id,
              al.owner_run_id,
              loc.uri_or_relpath,
              h.root_execution_id AS handoff_root_execution_id
         FROM artifact_references ar
         LEFT JOIN artifact_lifecycle al ON al.artifact_id = ar.artifact_id
         LEFT JOIN artifact_locations loc ON loc.artifact_id = ar.artifact_id
         LEFT JOIN recovery_handoffs h ON ar.owner_type = 'handoff' AND h.handoff_id = ar.owner_id
        WHERE ar.protective = 1 AND ar.released_revision IS NULL`
    );
    for (const pin of activePins) {
      if (pin.owner_run_id !== null) {
        record(classifyRunSegment(pin.owner_run_id, runSegment));
      }
      if (pin.owner_type === 'run') {
        record(classifyRunSegment(pin.owner_id, runSegment));
      }
      if (pin.handoff_root_execution_id !== null) {
        record(classifyRunSegment(pin.handoff_root_execution_id, runSegment));
      }
      if (pin.uri_or_relpath !== null) {
        for (const seg of checkpointRunSegmentsInPath(pin.uri_or_relpath)) {
          record(classifyRunSegment(seg, runSegment));
        }
        const extracted = extractEnvelopePathSegments(pin.uri_or_relpath);
        if (extracted !== null) {
          if (extracted.parentDir !== undefined) {
            record(classifyRunSegment(extracted.parentDir, runSegment));
          } else if (
            pin.owner_run_id === null &&
            pin.owner_type !== 'run' &&
            pin.handoff_root_execution_id === null
          ) {
            state.ambiguous = true;
          }
        }
      }
    }

    if (state.exactProtected) return Object.freeze({ protected: true, decision: 'protected' });
    if (state.ambiguous) return Object.freeze({ protected: true, decision: 'ambiguous' });
    return Object.freeze({ protected: false, decision: 'unowned' });
  } catch {
    return Object.freeze({ protected: true, decision: 'lookup-error' });
  }
}
