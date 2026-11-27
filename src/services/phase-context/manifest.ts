/**
 * FR-R6-F15 (F15-A; FR-007, FR-015, FR-020, NFR-001) — the manifest of one handoff revision:
 * built from checked parts, written as one text whatever the key order of its input, named by
 * the digest of that text, and read back from an untrusted value with every bound checked
 * again, the aggregate ones included.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import {
  MANIFEST_ORIGINS,
  PHASE_CONTEXT_MANIFEST_VERSION,
  type HandoffManifest,
  type ManifestOrigin,
  type ManifestSource,
  type Omission,
  type RequestRef
} from '../../contracts/phase-context/context-manifest';
import {
  APPROVAL_MODES,
  DIGEST_PATTERN,
  PHASE_CONTEXT_LIMITS,
  SESSION_POLICIES,
  type ApprovalMode,
  type ArtifactRef,
  type HandoffIdentity,
  type ProducerRef,
  type SessionPolicy
} from '../../contracts/phase-context/context-policy';
import { compareProducers, handoffIdOf, parseHandoffIdentity, producerKey } from './identity';
import { parseManifestSource, parseOmission } from './manifest-parts';
import { hasExactKeys, isOneOf, isWholeNumber, listOf, matchesPattern, plainRecord, sha256Hex } from './primitives';
import { utf8Bytes } from './text-bounds';

/** The checked parts of one revision. The handoff identity is derived, not given. */
export interface ManifestInput {
  readonly revision: number;
  readonly previousRevision: number | null;
  readonly origin: ManifestOrigin;
  readonly identity: HandoffIdentity;
  readonly policyDigest: string;
  readonly approval: ApprovalMode;
  readonly session: SessionPolicy;
  readonly cutoffSequence: number;
  readonly targetInstructionsDigest: string;
  readonly renderedBytesMax: number;
  readonly sources: readonly ManifestSource[];
  readonly omissions: readonly Omission[];
  readonly omissionsUnlisted: number;
}

export type ManifestParse =
  | { readonly kind: 'valid'; readonly manifest: HandoffManifest }
  | { readonly kind: 'unsupported-version'; readonly preserved: unknown }
  | { readonly kind: 'invalid'; readonly detail: string };

const MANIFEST_KEYS = [
  'manifestVersion',
  'handoffId',
  'revision',
  'previousRevision',
  'origin',
  'identity',
  'policyDigest',
  'approval',
  'session',
  'cutoffSequence',
  'targetInstructionsDigest',
  'renderedBytesMax',
  'sources',
  'omissions',
  'omissionsUnlisted'
] as const;
const SEPARATOR_BYTES = 1;

function orderedProducer(producer: ProducerRef): ProducerRef {
  return { nodePath: producer.nodePath, occurrenceId: producer.occurrenceId, attemptId: producer.attemptId };
}

function orderedRequest(request: RequestRef): RequestRef {
  return { kind: request.kind, id: request.id };
}

function orderedArtifact(artifact: ArtifactRef): ArtifactRef {
  return {
    artifactId: artifact.artifactId,
    immutableVersion: artifact.immutableVersion,
    digestHex: artifact.digestHex,
    byteSize: artifact.byteSize,
    kind: artifact.kind
  };
}

function orderedSource(source: ManifestSource): ManifestSource {
  return {
    producer: orderedProducer(source.producer),
    acceptedSequence: source.acceptedSequence,
    coverage: source.coverage,
    required: source.required,
    selectedBy: orderedRequest(source.selectedBy),
    outcomes: [...source.outcomes],
    decisions: [...source.decisions],
    constraints: [...source.constraints],
    unresolvedIssues: [...source.unresolvedIssues],
    summary: source.summary,
    artifacts: source.artifacts.map(orderedArtifact)
  };
}

function orderedOmission(omission: Omission): Omission {
  return {
    producer: orderedProducer(omission.producer),
    request: omission.request === null ? null : orderedRequest(omission.request),
    reason: omission.reason
  };
}

function orderedIdentity(identity: HandoffIdentity): HandoffIdentity {
  return {
    workspaceId: identity.workspaceId,
    rootExecutionId: identity.rootExecutionId,
    sourceInvocationId: identity.sourceInvocationId,
    targetNodePath: identity.targetNodePath,
    targetOccurrenceId: identity.targetOccurrenceId,
    inputEnvelopeRevision: identity.inputEnvelopeRevision,
    sourceAttempts: [...identity.sourceAttempts].sort(compareProducers).map(orderedProducer)
  };
}

/**
 * The manifest of the given parts, every object in the one key order the text is written in.
 * The source attempts of the identity are sorted; the sources and omissions keep their order,
 * which is part of what the manifest says.
 */
export function buildManifest(input: ManifestInput): HandoffManifest {
  const identity = orderedIdentity(input.identity);
  return {
    manifestVersion: PHASE_CONTEXT_MANIFEST_VERSION,
    handoffId: handoffIdOf(identity),
    revision: input.revision,
    previousRevision: input.previousRevision,
    origin: input.origin,
    identity,
    policyDigest: input.policyDigest,
    approval: input.approval,
    session: input.session,
    cutoffSequence: input.cutoffSequence,
    targetInstructionsDigest: input.targetInstructionsDigest,
    renderedBytesMax: input.renderedBytesMax,
    sources: input.sources.map(orderedSource),
    omissions: input.omissions.map(orderedOmission),
    omissionsUnlisted: input.omissionsUnlisted
  };
}

/** FR-007: one text per manifest. Equal manifests give equal text. */
export function serializeManifest(manifest: HandoffManifest): string {
  return JSON.stringify({
    manifestVersion: manifest.manifestVersion,
    handoffId: manifest.handoffId,
    revision: manifest.revision,
    previousRevision: manifest.previousRevision,
    origin: manifest.origin,
    identity: orderedIdentity(manifest.identity),
    policyDigest: manifest.policyDigest,
    approval: manifest.approval,
    session: manifest.session,
    cutoffSequence: manifest.cutoffSequence,
    targetInstructionsDigest: manifest.targetInstructionsDigest,
    renderedBytesMax: manifest.renderedBytesMax,
    sources: manifest.sources.map(orderedSource),
    omissions: manifest.omissions.map(orderedOmission),
    omissionsUnlisted: manifest.omissionsUnlisted
  });
}

export function manifestDigestOf(serialized: string): string {
  return sha256Hex(serialized);
}

/**
 * The bytes one source adds to the serialized manifest, its separator included. A manifest of
 * n sources is the manifest of none, plus the sum of these, less one separator.
 */
export function manifestEntryBytes(source: ManifestSource): number {
  return utf8Bytes(JSON.stringify(orderedSource(source))) + SEPARATOR_BYTES;
}

/** The bytes one listed omission adds to the serialized manifest, counted as a source is. */
export function manifestOmissionBytes(omission: Omission): number {
  return utf8Bytes(JSON.stringify(orderedOmission(omission))) + SEPARATOR_BYTES;
}

function invalid(detail: string): ManifestParse {
  return { kind: 'invalid', detail };
}

function parseSources(value: unknown, cutoffSequence: number): readonly ManifestSource[] | string {
  const items = listOf(value, PHASE_CONTEXT_LIMITS.sourceContributionsMax);
  if (items === null) return 'source-count';
  const sources: ManifestSource[] = [];
  for (const item of items) {
    const source = parseManifestSource(item, cutoffSequence);
    if (typeof source === 'string') return source;
    sources.push(source);
  }
  return sources;
}

function parseOmissions(value: unknown): readonly Omission[] | string {
  const items = listOf(value, PHASE_CONTEXT_LIMITS.sourceContributionsMax);
  if (items === null) return 'omission-count';
  const omissions: Omission[] = [];
  for (const item of items) {
    const omission = parseOmission(item);
    if (omission === null) return 'omission';
    omissions.push(omission);
  }
  return omissions;
}

/**
 * What is wrong with the sources taken together, or `null`: one producer attempt twice, an
 * attempt the identity does not name (FR-002), or a collection over its aggregate bound.
 */
export function sourcesFault(sources: readonly ManifestSource[], identity: HandoffIdentity): string | null {
  const named = new Set(identity.sourceAttempts.map(producerKey));
  const seen = new Set<string>();
  let outcomes = 0;
  let decisions = 0;
  let constraints = 0;
  let unresolvedIssues = 0;
  let artifacts = 0;
  for (const source of sources) {
    const key = producerKey(source.producer);
    if (seen.has(key)) return 'source-duplicate';
    seen.add(key);
    if (!named.has(key)) return 'source-not-in-identity';
    outcomes += source.outcomes.length;
    decisions += source.decisions.length;
    constraints += source.constraints.length;
    unresolvedIssues += source.unresolvedIssues.length;
    artifacts += source.artifacts.length;
  }
  if (Math.max(outcomes, decisions, constraints, unresolvedIssues) > PHASE_CONTEXT_LIMITS.collectionEntriesMax) {
    return 'aggregate-entry-count';
  }
  return artifacts > PHASE_CONTEXT_LIMITS.artifactReferencesMax ? 'aggregate-artifact-count' : null;
}

/** The detail code of the first scalar field that is wrong, or `null`. */
function scalarFault(record: Readonly<Record<string, unknown>>): string | null {
  const { handoffId, revision, previousRevision, origin, policyDigest, approval, session } = record;
  if (!matchesPattern(DIGEST_PATTERN, handoffId)) return 'handoff-id';
  if (!isWholeNumber(revision, 1)) return 'revision';
  const expectedPrevious = revision === 1 ? null : revision - 1;
  if (previousRevision !== expectedPrevious) return 'previous-revision';
  if (!isOneOf(MANIFEST_ORIGINS, origin)) return 'origin';
  if (!matchesPattern(DIGEST_PATTERN, policyDigest)) return 'policy-digest';
  if (!isOneOf(APPROVAL_MODES, approval)) return 'approval';
  if (!isOneOf(SESSION_POLICIES, session)) return 'session';
  if (!isWholeNumber(record.cutoffSequence, 0)) return 'cutoff';
  if (!matchesPattern(DIGEST_PATTERN, record.targetInstructionsDigest)) return 'instructions-digest';
  if (!isWholeNumber(record.renderedBytesMax, 1, PHASE_CONTEXT_LIMITS.renderedContextBytesMax)) return 'rendered-bound';
  // Every omission is a candidate left out, so the count cannot pass what one preparation reads.
  return isWholeNumber(record.omissionsUnlisted, 0, PHASE_CONTEXT_LIMITS.candidatesMax) ? null : 'omissions-unlisted';
}

/**
 * FR-020: a manifest of a newer version is handed back as received and refused. Anything else
 * is rebuilt field by field; a key the contract does not name, a bound passed or a handoff
 * identity that is not the digest of the lineage refuses the whole value.
 */
export function parseManifest(value: unknown): ManifestParse {
  const record = plainRecord(value);
  if (record === null) return invalid('manifest-shape');
  const { manifestVersion } = record;
  if (isWholeNumber(manifestVersion, PHASE_CONTEXT_MANIFEST_VERSION + 1)) return { kind: 'unsupported-version', preserved: value };
  if (manifestVersion !== PHASE_CONTEXT_MANIFEST_VERSION) return invalid('manifest-version');
  if (!hasExactKeys(record, MANIFEST_KEYS)) return invalid('manifest-shape');
  const fault = scalarFault(record);
  if (fault !== null) return invalid(fault);

  const identity = parseHandoffIdentity(record.identity);
  if (!identity.ok) return invalid(identity.detail);
  if (identity.handoffId !== record.handoffId) return invalid('handoff-id');
  const cutoffSequence = record.cutoffSequence as number;
  const sources = parseSources(record.sources, cutoffSequence);
  if (typeof sources === 'string') return invalid(sources);
  const together = sourcesFault(sources, identity.identity);
  if (together !== null) return invalid(together);
  const omissions = parseOmissions(record.omissions);
  if (typeof omissions === 'string') return invalid(omissions);

  const manifest = buildManifest({
    revision: record.revision as number,
    previousRevision: record.previousRevision as number | null,
    origin: record.origin as ManifestOrigin,
    identity: identity.identity,
    policyDigest: record.policyDigest as string,
    approval: record.approval as ApprovalMode,
    session: record.session as SessionPolicy,
    cutoffSequence,
    targetInstructionsDigest: record.targetInstructionsDigest as string,
    renderedBytesMax: record.renderedBytesMax as number,
    sources,
    omissions,
    omissionsUnlisted: record.omissionsUnlisted as number
  });
  if (utf8Bytes(serializeManifest(manifest)) > PHASE_CONTEXT_LIMITS.manifestBytesMax) return invalid('manifest-bytes');
  return { kind: 'valid', manifest };
}
