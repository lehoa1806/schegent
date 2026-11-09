/**
 * FR-R6-F05 US3 (T034, FR-015) — a read-only preview of re-importing a
 * preserved legacy version.
 *
 * The preserved bytes are read where they sit (in place, or the newest
 * quarantined copy), their identity checked against the residue id, and their
 * body hashed with the catalog's own content hash. A version the current
 * manifest already names refuses `identity-conflict` (same content) or
 * `content-conflict` (different content); otherwise the injected admission
 * gate decides. Nothing is written: no catalog writer exists here.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { loadManifest } from '../../catalog/catalog-manifest';
import { contentHashOf } from '../../catalog/content-hash';
import type { LifecycleResult } from '../../contracts/artifact-lifecycle/lifecycle-types';
import type {
  LegacyCatalogAdmissionPort,
  LegacyCatalogVersionRef,
  LegacyReimportPreview
} from '../../contracts/artifact-lifecycle/legacy-preservation-types';
import { recordSegments, residueRefOf } from './legacy-classification';
import { keyOfSegments, segmentsOfKey, type LegacyContext } from './legacy-preservation-context';
import { classify } from './legacy-quarantine';
import { isOpaqueId, ok, refuse } from './lifecycle-results';

interface PreservedBytes {
  readonly bytes: Buffer;
  readonly source: LegacyReimportPreview['source'];
}

async function preservedBytesOf(ctx: LegacyContext, ref: LegacyCatalogVersionRef): Promise<PreservedBytes | null> {
  const sourceSegments = recordSegments(ctx.deps.catalogRoot, ref);
  const inPlace = await ctx.deps.files.readBytes(sourceSegments);
  if (inPlace.outcome === 'read') return { bytes: inPlace.bytes, source: 'in-place' };
  const latest = ctx.rows.latestBySourceKey().get(keyOfSegments(sourceSegments));
  if (latest === undefined || latest.outcome !== 'quarantined' || latest.destination_key === null) return null;
  const copy = await ctx.deps.files.readBytes(segmentsOfKey(latest.destination_key));
  return copy.outcome === 'read' ? { bytes: copy.bytes, source: 'quarantine' } : null;
}

/** The record body, when the bytes are a version record of exactly `ref`. */
function bodyOf(bytes: Buffer, ref: LegacyCatalogVersionRef): { readonly body: unknown } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || !('body' in parsed)) return null;
  const record = parsed as { versionId?: unknown; kind?: unknown; id?: unknown; body: unknown };
  if (record.versionId !== ref.versionId || record.kind !== ref.kind || record.id !== ref.id) return null;
  return { body: record.body };
}

export async function previewReimport(
  ctx: LegacyContext,
  residueId: string,
  admission: LegacyCatalogAdmissionPort
): Promise<LifecycleResult<LegacyReimportPreview>> {
  const ref = isOpaqueId(residueId) ? residueRefOf(residueId) : null;
  if (ref === null) return refuse('not-found', 'no such residue');
  const preserved = await preservedBytesOf(ctx, ref);
  if (preserved === null) return refuse('not-found', 'no preserved bytes for that residue');
  const record = bodyOf(preserved.bytes, ref);
  if (record === null) return refuse('invalid-input', 'the preserved bytes are not that version record');
  const hashed = contentHashOf(record.body, ctx.deps.catalogRoot.digest);
  if (hashed.outcome !== 'hashed') return refuse('invalid-input', 'the preserved body cannot be hashed');
  const manifest = await loadManifest(ctx.deps.catalogRoot.catalog);
  if (manifest.outcome === 'faulted') return refuse('unavailable', 'the legacy manifest is unreadable');
  const entries = manifest.outcome === 'read' ? manifest.manifest.entries : [];
  const named = entries
    .filter((entry) => entry.kind === ref.kind && entry.id === ref.id)
    .flatMap((entry) => entry.versions)
    .find((version) => version.versionId === ref.versionId);
  if (named !== undefined) {
    return named.contentHash === hashed.contentHash
      ? refuse('identity-conflict', 'the catalog already names that version')
      : refuse('content-conflict', 'the catalog names that version with different content');
  }
  const candidate = { ...ref, contentHash: hashed.contentHash, body: record.body };
  const admitted = admission.admits(candidate);
  if (!admitted.ok) return admitted;
  const { basisRevision } = await classify(ctx);
  return ok({ ...ref, residueId, contentHash: hashed.contentHash, source: preserved.source, basisRevision });
}
