/**
 * FR-R6-F15 (F15-A; FR-012, FR-015, FR-017, NFR-001) — the rules of an edit. An edit writes the
 * next revision of a handoff from replacement sources. It may shorten or reword what a selected
 * source says and drop an optional source or an artifact; it may not add a source or an
 * artifact the base did not carry, change who a source is attributed to, or drop a required
 * source. Everything else of the base (identity, policy digest, approval mode, session rule,
 * cutoff, instructions digest, rendered bound, omissions) is kept as it is.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { HandoffManifest, ManifestSource, PreparedHandoff } from '../../contracts/phase-context/context-manifest';
import { PHASE_CONTEXT_LIMITS, type ArtifactRef, type Refusal } from '../../contracts/phase-context/context-policy';
import { producerKey } from './identity';
import { buildManifest, manifestDigestOf, serializeManifest, sourcesFault } from './manifest';
import { parseManifestSource } from './manifest-parts';
import { listOf, refuse } from './primitives';
import { renderContext } from './renderer';
import { utf8Bytes } from './text-bounds';

export type EditResult = { readonly ok: true; readonly prepared: PreparedHandoff } | Refusal;

const CAPACITY_FAULTS: readonly string[] = ['aggregate-entry-count', 'aggregate-artifact-count'];

interface Replacements {
  readonly ok: true;
  readonly bySource: ReadonlyMap<string, ManifestSource>;
}

/** A manifest with its one text, the digest of that text and its one rendering. */
export function preparedOf(manifest: HandoffManifest): PreparedHandoff {
  const serialized = serializeManifest(manifest);
  return { manifest, serialized, manifestDigest: manifestDigestOf(serialized), rendered: renderContext(manifest) };
}

function sameArtifact(left: ArtifactRef, right: ArtifactRef): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.immutableVersion === right.immutableVersion &&
    left.digestHex === right.digestHex &&
    left.byteSize === right.byteSize &&
    left.kind === right.kind
  );
}

/** What a replacement may not say differently from the source it replaces, or `null`. */
function replacementFault(replacement: ManifestSource, original: ManifestSource): string | null {
  const sameAttribution =
    replacement.acceptedSequence === original.acceptedSequence &&
    replacement.coverage === original.coverage &&
    replacement.required === original.required &&
    replacement.selectedBy.kind === original.selectedBy.kind &&
    replacement.selectedBy.id === original.selectedBy.id;
  if (!sameAttribution) return 'edit-source-attribution';
  const carried = replacement.artifacts.every((artifact) => original.artifacts.some((known) => sameArtifact(artifact, known)));
  return carried ? null : 'edit-unknown-artifact';
}

/** The replacements by producer attempt, each checked against the source it replaces. */
function readReplacements(base: HandoffManifest, items: readonly unknown[]): Replacements | Refusal {
  const originals = new Map(base.sources.map((source) => [producerKey(source.producer), source]));
  const replacements = new Map<string, ManifestSource>();
  for (const item of items) {
    const replacement = parseManifestSource(item, base.cutoffSequence);
    if (typeof replacement === 'string') return refuse('invalid-source', replacement);
    const key = producerKey(replacement.producer);
    const original = originals.get(key);
    if (original === undefined) return refuse('invalid-source', 'edit-unknown-source');
    const fault = replacementFault(replacement, original);
    if (fault !== null) return refuse('invalid-source', fault);
    if (replacements.has(key)) return refuse('invalid-source', 'source-duplicate');
    replacements.set(key, replacement);
  }
  return { ok: true, bySource: replacements };
}

/**
 * FR-015: the revision after `base`, with the replacement sources in the order of the base. The
 * result is marked `edited` even when nothing differs: an edit is a new revision, and a manual
 * handoff waits for a new approval of it (FR-012). No refusal carries text of a source.
 */
export function editRevision(base: HandoffManifest, replacementSources: unknown): EditResult {
  if (!Array.isArray(replacementSources)) return refuse('invalid-source', 'sources');
  const items = listOf(replacementSources, PHASE_CONTEXT_LIMITS.sourceContributionsMax);
  if (items === null) return refuse('capacity-exceeded', 'source-count');
  const replacements = readReplacements(base, items);
  if (!replacements.ok) return replacements;

  const sources: ManifestSource[] = [];
  for (const original of base.sources) {
    const replacement = replacements.bySource.get(producerKey(original.producer));
    if (replacement === undefined && original.required) return refuse('invalid-source', 'edit-required-removed');
    if (replacement !== undefined) sources.push(replacement);
  }
  const fault = sourcesFault(sources, base.identity);
  if (fault !== null) return refuse(CAPACITY_FAULTS.includes(fault) ? 'capacity-exceeded' : 'invalid-source', fault);

  const manifest = buildManifest({
    revision: base.revision + 1,
    previousRevision: base.revision,
    origin: 'edited',
    identity: base.identity,
    policyDigest: base.policyDigest,
    approval: base.approval,
    session: base.session,
    cutoffSequence: base.cutoffSequence,
    targetInstructionsDigest: base.targetInstructionsDigest,
    renderedBytesMax: base.renderedBytesMax,
    sources,
    omissions: base.omissions,
    omissionsUnlisted: base.omissionsUnlisted
  });
  const serialized = serializeManifest(manifest);
  if (utf8Bytes(serialized) > PHASE_CONTEXT_LIMITS.manifestBytesMax) return refuse('capacity-exceeded', 'manifest-bytes');
  const rendered = renderContext(manifest);
  if (rendered.bytes > base.renderedBytesMax) return refuse('capacity-exceeded', 'rendered-bytes');
  return { ok: true, prepared: { manifest, serialized, manifestDigest: manifestDigestOf(serialized), rendered } };
}
