/**
 * FR-R6-F05 US3 (FR-013, research R8) — read-only classification of a legacy
 * `.schegent/catalog/`.
 *
 * The manifest and the version records are read through the catalog's own
 * readers (`loadManifest`, `scanCatalog`), so residue means exactly what the
 * catalog calls collectable: a record on disk the manifest does not name. The
 * residue bytes are hashed through the byte port so a later move can verify
 * the copy against the same digest.
 *
 * A version the manifest names is `published`; residue a pointer or a consumer
 * references is `protected`; the rest is `unresolved`. Nothing is disposable,
 * and nothing here writes.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { createHash } from 'node:crypto';

import { directoryForKind, MANIFEST_SEGMENTS, versionSegments } from '../../catalog/catalog-paths';
import { emptyManifest, loadManifest } from '../../catalog/catalog-manifest';
import { scanCatalog } from '../../catalog/catalog-integrity';
import type { CatalogFsPort, Digest } from '../../catalog/ports';
import { CATALOG_KINDS, type CatalogKind, type CatalogManifest } from '../../contracts/catalog-store';
import type {
  LegacyCatalogClassification,
  LegacyCatalogConsumerPort,
  LegacyCatalogPointer,
  LegacyCatalogResidue,
  LegacyCatalogVersionClassification,
  LegacyCatalogVersionRef
} from '../../contracts/artifact-lifecycle/legacy-preservation-types';
import type { LegacyPreservationFs } from './legacy-preservation-fs';

/** The legacy catalog: the catalog's reader port rooted at it, and where it sits in the workspace. */
export interface LegacyCatalogRoot {
  readonly catalog: CatalogFsPort;
  readonly digest: Digest;
  /** Workspace-relative segments of the catalog directory, e.g. `['.schegent', 'catalog']`. */
  readonly segments: readonly string[];
}

const RESIDUE_PREFIX = 'residue';
const SCAN_KINDS: readonly CatalogKind[] = [...CATALOG_KINDS, 'pipeline'];

/** `sha256:<hex>` over raw bytes. */
export function digestOfBytes(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function residueIdOf(ref: LegacyCatalogVersionRef): string {
  return `${RESIDUE_PREFIX}:${ref.kind}:${ref.id}:${ref.versionId}`;
}

/** The identity a residue id names, or null when it is not one this module issued. */
export function residueRefOf(residueId: string): LegacyCatalogVersionRef | null {
  const parts = residueId.split(':');
  if (parts.length !== 4 || parts.at(0) !== RESIDUE_PREFIX) return null;
  const kind = SCAN_KINDS.find((candidate) => candidate === parts.at(1));
  const id = parts.at(2);
  const versionId = parts.at(3);
  if (kind === undefined || id === undefined || versionId === undefined) return null;
  return { kind, id, versionId };
}

/** Workspace-relative segments of a version record under the catalog root. */
export function recordSegments(root: LegacyCatalogRoot, ref: LegacyCatalogVersionRef): readonly string[] {
  return [...root.segments, ...versionSegments(ref.kind, ref.id, ref.versionId)];
}

/** The identity a persisted source key names, or null when it is not a record under the catalog. */
export function refOfSourceKey(root: LegacyCatalogRoot, sourceKey: string): LegacyCatalogVersionRef | null {
  const parts = sourceKey.split('/');
  const prefix = parts.slice(0, root.segments.length);
  if (prefix.join('/') !== root.segments.join('/') || parts.length !== root.segments.length + 3) return null;
  const tail = parts.slice(root.segments.length);
  const [directory, id, file] = [tail.at(0), tail.at(1), tail.at(2)];
  const kind = SCAN_KINDS.find((candidate) => directoryForKind(candidate) === directory);
  if (kind === undefined || id === undefined || file === undefined || !file.endsWith('.json')) return null;
  return { kind, id, versionId: file.slice(0, -'.json'.length) };
}

function pointersOf(manifest: CatalogManifest, ref: LegacyCatalogVersionRef): readonly LegacyCatalogPointer[] {
  const entry = manifest.entries.find((candidate) => candidate.kind === ref.kind && candidate.id === ref.id);
  if (entry === undefined) return [];
  const pointers: LegacyCatalogPointer[] = [];
  if (entry.activeVersionId === ref.versionId) pointers.push('active');
  if (entry.draftVersionId === ref.versionId) pointers.push('draft');
  return pointers;
}

function publishedVersions(
  manifest: CatalogManifest,
  consumers: LegacyCatalogConsumerPort
): readonly LegacyCatalogVersionClassification[] {
  return manifest.entries.flatMap((entry) =>
    entry.versions.map((version) => {
      const ref = { kind: entry.kind, id: entry.id, versionId: version.versionId };
      return {
        ...ref,
        contentHash: version.contentHash,
        pointers: pointersOf(manifest, ref),
        consumers: [...consumers.consumersOf(ref)],
        disposition: 'published' as const
      };
    })
  );
}

async function residueOf(
  root: LegacyCatalogRoot,
  files: LegacyPreservationFs,
  consumers: LegacyCatalogConsumerPort,
  manifest: CatalogManifest,
  ref: LegacyCatalogVersionRef
): Promise<LegacyCatalogResidue> {
  const read = await files.readBytes(recordSegments(root, ref));
  const bytes = read.outcome === 'read' ? read.bytes : null;
  const pointers = pointersOf(manifest, ref);
  const readers = [...consumers.consumersOf(ref)];
  return {
    kind: ref.kind,
    id: ref.id,
    versionId: ref.versionId,
    residueId: residueIdOf(ref),
    digest: bytes === null ? null : digestOfBytes(bytes),
    sizeBytes: bytes === null ? null : bytes.length,
    pointers,
    consumers: readers,
    disposition: pointers.length > 0 || readers.length > 0 ? 'protected' : 'unresolved',
    outcome: 'preserved-in-place'
  };
}

function basisOf(
  manifestState: LegacyCatalogClassification['manifestState'],
  manifestGeneration: string | null,
  residue: readonly LegacyCatalogResidue[]
): string {
  const lines = residue.map((entry) => [entry.residueId, entry.digest, entry.disposition]);
  const text = JSON.stringify([manifestState, manifestGeneration, lines]);
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Classify the legacy catalog (FR-013). Reads only: no catalog writer is
 * called, no pointer is synthesized, and no byte moves.
 */
export async function classifyLegacyCatalogResidue(
  catalogRoot: LegacyCatalogRoot,
  files: LegacyPreservationFs,
  consumers: LegacyCatalogConsumerPort
): Promise<LegacyCatalogClassification> {
  const raw = await files.readBytes([...catalogRoot.segments, ...MANIFEST_SEGMENTS]);
  const loaded = await loadManifest(catalogRoot.catalog);
  const manifestState = loaded.outcome;
  const manifest = loaded.outcome === 'read' ? loaded.manifest : emptyManifest();
  const manifestGeneration = loaded.outcome !== 'absent' && raw.outcome === 'read' ? digestOfBytes(raw.bytes) : null;
  const scan = await scanCatalog(catalogRoot.catalog, catalogRoot.digest, manifest);
  const residue: LegacyCatalogResidue[] = [];
  for (const ref of scan.collectable) {
    residue.push(await residueOf(catalogRoot, files, consumers, manifest, ref));
  }
  residue.sort((left, right) => left.residueId.localeCompare(right.residueId));
  return {
    manifestState,
    manifestGeneration,
    versions: publishedVersions(manifest, consumers),
    residue,
    unresolvedReferenceCount: scan.faults.length,
    basisRevision: basisOf(manifestState, manifestGeneration, residue)
  };
}
