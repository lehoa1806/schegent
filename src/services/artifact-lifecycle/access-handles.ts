/**
 * FR-R6-F05 (US5, FR-023, AC-10, SC-008) — qualified artifact access for agent sessions.
 *
 * `qualifyAccess` issues a handle only when, in this order: the request is well formed (a path or
 * URI is refused `invalid-input` before anything is resolved), the F13 policy admits the attempt
 * and session, the artifact is managed, immutable, present and carries the expected digest, the
 * attempt holds an active protective reference, and the bytes still hash to the recorded digest.
 * Bytes that no longer match mark the artifact `corrupt` and are refused `content-conflict`.
 *
 * `materializeCopy` writes a qualified artifact's bytes beneath the workspace through
 * `openWithinRoot`. The copy shares the source identity: it is recorded as an extra location of
 * the source `artifact_id`, with its own pin owner (`owner_export_id` = the copy id) that always
 * expires. Neither function adds a reference row, so agent sessions, wire logs and provider
 * history never pin an artifact implicitly.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13). Nothing here logs.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import {
  MATERIALIZED_COPY_DEFAULT_TTL_MS,
  MATERIALIZED_COPY_MAX_TTL_MS,
  type MaterializedCopy,
  type QualifyAccessRequest
} from '../../contracts/artifact-lifecycle/access-types';
import type {
  ArtifactAccessHandle,
  ArtifactDigest,
  ArtifactRecord,
  LifecycleResult
} from '../../contracts/artifact-lifecycle/lifecycle-types';
import { validateAccessHandle, validateQualifyAccessRequest } from '../../contracts/validators/artifact-access';
import { openWithinRoot, segmentsUnderRoot } from '../../lib/safe-open';
import type { NodeSqliteConnection } from '../sqlite-store';
import type { ArtifactByteProbe, ArtifactLocator, ArtifactRecordStore } from './artifact-records';
import type { LifecycleContext } from './lifecycle-context';
import type { ArtifactAccessPolicy, ArtifactByteReader } from './lifecycle-ports';
import { inImmediateTransaction, isOpaqueId, ok, refuse } from './lifecycle-results';
import type { ReferenceStore } from './references';

export type { ArtifactAccessPolicy, ArtifactByteReader } from './lifecycle-ports';

/** F04 `artifact_pins.reason` for a materialized copy's own pin. */
const COPY_PIN_REASON = 'materialized-copy';
const COPY_FILE_SUFFIX = '.copy';
/** Issued handles this instance remembers; past it the oldest is forgotten and must be requalified. */
const ISSUED_HANDLES_MAX = 1024;

export interface AccessHandleDependencies {
  readonly conn: NodeSqliteConnection;
  readonly nowMs: () => number;
  readonly newId: () => string;
  readonly records: ArtifactRecordStore;
  readonly references: ReferenceStore;
  readonly probe: ArtifactByteProbe;
  /** Absent: no copy can be materialized (`unavailable`). */
  readonly reader?: ArtifactByteReader;
  /** Absolute; every copy destination must lie beneath it. Absent: no copy can be materialized. */
  readonly workspaceRoot?: string;
}

export interface MaterializeCopyOptions {
  /** The copy's lifetime; defaults to {@link MATERIALIZED_COPY_DEFAULT_TTL_MS}. */
  readonly ttlMs?: number;
}

export interface ArtifactAccessHandles {
  qualifyAccess(request: QualifyAccessRequest, policy: ArtifactAccessPolicy): Promise<LifecycleResult<ArtifactAccessHandle>>;
  materializeCopy(
    handle: ArtifactAccessHandle,
    destinationRoot: string,
    options?: MaterializeCopyOptions
  ): Promise<LifecycleResult<MaterializedCopy>>;
  /** A live copy by id; an expired one is `unavailable`. */
  resolveMaterializedCopy(copyId: string): LifecycleResult<MaterializedCopy>;
}

/** The access dependencies a lifecycle service already holds, so wiring it is one call. */
export function accessDependenciesFromContext(ctx: LifecycleContext, reader?: ArtifactByteReader): AccessHandleDependencies {
  const { conn, nowMs, probe, workspaceRoot } = ctx.deps;
  return {
    conn,
    nowMs,
    newId: ctx.newId,
    records: ctx.records,
    references: ctx.references,
    probe,
    ...(reader === undefined ? {} : { reader }),
    ...(workspaceRoot === undefined ? {} : { workspaceRoot })
  };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function denied<T>(): LifecycleResult<T> {
  return refuse('access-denied', 'artifact access is not authorized for this attempt and session');
}

function admitted(policy: ArtifactAccessPolicy, request: QualifyAccessRequest): boolean {
  try {
    const { artifactId, attemptId, sessionId, mode } = request;
    return policy.admits({ artifactId, attemptId, sessionId, mode }) === true;
  } catch {
    return false;
  }
}

/** The record's own standing for access: managed, immutable, present and the expected version. */
function judgeRecord(record: ArtifactRecord, expected: ArtifactDigest): LifecycleResult<ArtifactRecord> {
  if (!record.managed) return denied();
  if (record.immutability !== 'immutable' || record.digest === null) {
    return refuse('unavailable', 'artifact is still growing', record.artifactId);
  }
  if (record.availability !== 'present') return refuse('unavailable', 'artifact bytes are not available', record.artifactId);
  if (record.digest.value !== expected.value) {
    return refuse('content-conflict', 'artifact version differs from the expected digest', record.artifactId);
  }
  return ok(record);
}

function readTtl(ttlMs: number | undefined): number | null {
  if (ttlMs === undefined) return MATERIALIZED_COPY_DEFAULT_TTL_MS;
  const bounded = Number.isSafeInteger(ttlMs) && ttlMs >= 1 && ttlMs <= MATERIALIZED_COPY_MAX_TTL_MS;
  return bounded ? ttlMs : null;
}

/** The destination's segments beneath the workspace root; `null` when it is not beneath it. */
function destinationSegments(workspaceRoot: string, destinationRoot: string): readonly string[] | null {
  if (typeof destinationRoot !== 'string' || !path.isAbsolute(destinationRoot) || destinationRoot.includes('\0')) {
    return null;
  }
  const resolved = path.resolve(destinationRoot);
  if (resolved === path.resolve(workspaceRoot)) return [];
  return segmentsUnderRoot(workspaceRoot, resolved);
}

/**
 * The fields a presented handle must repeat exactly as they were issued. The digest algorithm is a
 * single literal, already enforced by `validateAccessHandle`.
 */
function sameHandle(issued: ArtifactAccessHandle, presented: ArtifactAccessHandle): boolean {
  return (
    issued.artifactId === presented.artifactId &&
    issued.digest.value === presented.digest.value &&
    issued.sessionScope.attemptId === presented.sessionScope.attemptId &&
    issued.sessionScope.sessionId === presented.sessionScope.sessionId &&
    issued.mode === presented.mode &&
    issued.pinReferenceId === presented.pinReferenceId
  );
}

interface CopyRow {
  readonly artifact_id: string;
  readonly expires_at_ms: number | null;
  readonly uri_or_relpath: string;
}

export function createArtifactAccessHandles(deps: AccessHandleDependencies): ArtifactAccessHandles {
  const issued = new Map<string, ArtifactAccessHandle>();
  const markCorrupt = (record: ArtifactRecord): void => {
    deps.records.compareAndSetAvailability(record.artifactId, record.lifecycleRevision, 'corrupt');
  };

  const conflict = <T>(record: ArtifactRecord): LifecycleResult<T> => {
    markCorrupt(record);
    return refuse('content-conflict', 'artifact bytes no longer match the recorded digest', record.artifactId);
  };

  const attemptReference = (artifactId: string, attemptId: string): string | null => {
    const listed = deps.references.list(artifactId);
    if (!listed.ok) return null;
    const held = listed.value.find(
      (ref) => ref.active && ref.protective && ref.ownerType === 'attempt' && ref.ownerId === attemptId
    );
    return held?.referenceId ?? null;
  };

  const verifiedRecord = (artifactId: string, expected: ArtifactDigest): LifecycleResult<ArtifactRecord> => {
    const found = deps.records.get(artifactId);
    return found.ok ? judgeRecord(found.value, expected) : denied();
  };

  const verifyBytes = async (record: ArtifactRecord): Promise<LifecycleResult<ArtifactLocator>> => {
    const locator = deps.records.locatorOf(record.artifactId);
    if (locator === null) return refuse('unavailable', 'artifact bytes are not available', record.artifactId);
    const observed = await deps.probe.digestSha256(locator).catch(() => null);
    if (observed === null) return refuse('unavailable', 'artifact bytes could not be verified', record.artifactId);
    return observed === record.digest?.value ? ok(locator) : conflict(record);
  };

  const qualifyAccess: ArtifactAccessHandles['qualifyAccess'] = async (input, policy) => {
    const valid = validateQualifyAccessRequest(input);
    if (!valid.ok) return valid;
    const request = valid.value;
    if (!admitted(policy, request)) return denied();
    const record = verifiedRecord(request.artifactId, request.expectedDigest);
    if (!record.ok) return record;
    const pinReferenceId = attemptReference(request.artifactId, request.attemptId);
    if (pinReferenceId === null) return denied();
    const bytes = await verifyBytes(record.value);
    if (!bytes.ok) return bytes;
    const handle: ArtifactAccessHandle = {
      handleId: deps.newId(),
      artifactId: request.artifactId,
      digest: request.expectedDigest,
      sessionScope: { attemptId: request.attemptId, sessionId: request.sessionId },
      mode: request.mode,
      pinReferenceId
    };
    remember(handle);
    return ok(handle);
  };

  /** Bounded, oldest first out: a handle evicted here must be qualified again. */
  const remember = (handle: ArtifactAccessHandle): void => {
    issued.set(handle.handleId, handle);
    if (issued.size <= ISSUED_HANDLES_MAX) return;
    const oldest = issued.keys().next();
    if (oldest.done !== true) issued.delete(oldest.value);
  };

  /**
   * Only a handle this instance issued, presented unaltered, may be used; then its reference must
   * still be the attempt's active protective one on this artifact.
   */
  const handleStanding = (handle: ArtifactAccessHandle): LifecycleResult<ArtifactRecord> => {
    const original = issued.get(handle.handleId);
    if (original === undefined || !sameHandle(original, handle)) return denied();
    const reference = deps.references.getById(handle.pinReferenceId);
    if (!reference.ok) return denied();
    const ref = reference.value;
    const holds =
      ref.active &&
      ref.protective &&
      ref.artifactId === handle.artifactId &&
      ref.ownerType === 'attempt' &&
      ref.ownerId === handle.sessionScope.attemptId;
    return holds ? verifiedRecord(handle.artifactId, handle.digest) : denied();
  };

  const recordCopy = (artifactId: string, copyId: string, relpath: string, expiresAtMs: number): void => {
    inImmediateTransaction(deps.conn, () => {
      deps.conn.run(
        `INSERT INTO artifact_locations (location_id, artifact_id, storage_tier, uri_or_relpath, inline_bytes, verified_at_ms)
         VALUES (?, ?, 'workspace_file', ?, NULL, ?)`,
        `${artifactId}#copy:${copyId}`,
        artifactId,
        relpath,
        deps.nowMs()
      );
      deps.conn.run(
        `INSERT INTO artifact_pins (pin_id, artifact_id, owner_export_id, reason, pinned_at_ms, expires_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        `copy:${copyId}`,
        artifactId,
        copyId,
        COPY_PIN_REASON,
        deps.nowMs(),
        expiresAtMs
      );
    });
  };

  const forgetCopy = (artifactId: string, copyId: string): void => {
    inImmediateTransaction(deps.conn, () => {
      deps.conn.run(`DELETE FROM artifact_pins WHERE pin_id = ?`, `copy:${copyId}`);
      deps.conn.run(`DELETE FROM artifact_locations WHERE location_id = ?`, `${artifactId}#copy:${copyId}`);
    });
  };

  const writeCopy = async (
    root: string,
    segments: readonly string[],
    bytes: Uint8Array
  ): Promise<LifecycleResult<true>> => {
    const opened = await openWithinRoot(root, segments, { flags: 'wx', fileMode: 0o600 });
    if (opened.outcome === 'refused') {
      return opened.reason === 'io-failed'
        ? refuse('unavailable', 'the copy could not be written')
        : refuse('containment-violation', 'the copy destination is not contained');
    }
    try {
      await opened.handle.writeFile(bytes);
      return ok(true);
    } catch {
      return refuse('unavailable', 'the copy could not be written');
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  };

  const materializeCopy: ArtifactAccessHandles['materializeCopy'] = async (input, destinationRoot, options = {}) => {
    const valid = validateAccessHandle(input);
    if (!valid.ok) return valid;
    const handle = valid.value;
    const ttlMs = readTtl(options.ttlMs);
    if (ttlMs === null) return refuse('invalid-input', 'ttlMs is malformed');
    const { workspaceRoot, reader } = deps;
    if (workspaceRoot === undefined || reader === undefined) return refuse('unavailable', 'copies cannot be materialized here');
    const segments = destinationSegments(workspaceRoot, destinationRoot);
    if (segments === null) return refuse('containment-violation', 'the copy destination is not contained');
    const record = handleStanding(handle);
    if (!record.ok) return record;
    const locator = deps.records.locatorOf(handle.artifactId);
    const bytes = locator === null ? null : await reader.read(locator).catch(() => null);
    if (bytes === null) return refuse('unavailable', 'artifact bytes are not available', handle.artifactId);
    if (sha256Hex(bytes) !== handle.digest.value) return conflict(record.value);

    const copyId = deps.newId();
    if (!isOpaqueId(copyId)) return refuse('unavailable', 'the copy could not be named');
    const fileName = `${copyId}${COPY_FILE_SUFFIX}`;
    const target = [...segments, fileName];
    const expiresAtMs = deps.nowMs() + ttlMs;
    recordCopy(handle.artifactId, copyId, target.join('/'), expiresAtMs);
    const written = await writeCopy(workspaceRoot, target, bytes);
    if (!written.ok) {
      forgetCopy(handle.artifactId, copyId);
      return written;
    }
    return ok({ copyId, artifactId: handle.artifactId, digest: handle.digest, fileName, expiresAtMs });
  };

  const resolveMaterializedCopy: ArtifactAccessHandles['resolveMaterializedCopy'] = (copyId) => {
    if (!isOpaqueId(copyId)) return refuse('invalid-input', 'copyId must be an opaque id');
    const row = deps.conn.get<CopyRow>(
      `SELECT p.artifact_id, p.expires_at_ms, loc.uri_or_relpath
       FROM artifact_pins p
       JOIN artifact_locations loc ON loc.location_id = p.artifact_id || '#copy:' || p.owner_export_id
       WHERE p.pin_id = ? AND p.reason = ?`,
      `copy:${copyId}`,
      COPY_PIN_REASON
    );
    if (row === undefined) return refuse('not-found', 'no such materialized copy');
    if (row.expires_at_ms === null || row.expires_at_ms <= deps.nowMs()) {
      return refuse('unavailable', 'the materialized copy has expired', row.artifact_id);
    }
    const source = deps.records.get(row.artifact_id);
    if (!source.ok || source.value.digest === null) return refuse('unavailable', 'the copy source is not available', row.artifact_id);
    return ok({
      copyId,
      artifactId: row.artifact_id,
      digest: source.value.digest,
      fileName: path.posix.basename(row.uri_or_relpath),
      expiresAtMs: row.expires_at_ms
    });
  };

  return { qualifyAccess, materializeCopy, resolveMaterializedCopy };
}
