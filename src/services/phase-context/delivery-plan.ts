/**
 * FR-R6-F15 (F15-A; FR-013, FR-025, FR-026, FR-035) — the delivery plan of a ready revision:
 * ordered prompt blocks, the route of each artifact, the session rule, and the representation
 * a dispatch must still match.
 *
 * The plan sends nothing and copies nothing: it says what would be sent. Context travels as
 * prompt blocks only, never through a command line or an environment variable. Each artifact
 * takes the first route that applies: embedded, a link the host supplied, a protected copy.
 * While a permitted copy does not exist yet the plan lists it and holds no block. The blocks
 * pass F13's prompt builder before they are returned.
 *
 * The representation holds identities, digests and route names, never a location: planning
 * again once a copy exists gives the same record. Sending the blocks, copying files, reusing
 * a session and storing the representation are F15-B.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { ACP_PROTOCOL_VERSION, type AcpPromptBlock, type NegotiatedCapabilities } from '../../contracts/acp-runtime';
import type {
  ArtifactAccess,
  ArtifactRoute,
  ArtifactRouteKind,
  DeliveryPlan,
  DeliveryRepresentation,
  DeliverySession,
  DispatchContext,
  ProfileCapacity,
  SessionRequest
} from '../../contracts/phase-context/context-delivery';
import {
  PHASE_CONTEXT_RENDERER_VERSION,
  type AcceptedRevision,
  type HandoffManifest,
  type RenderedContext
} from '../../contracts/phase-context/context-manifest';
import { IDENTIFIER_PATTERN, PHASE_CONTEXT_LIMITS, type ArtifactRef, type Refusal } from '../../contracts/phase-context/context-policy';
import { buildPromptContent } from '../acp-runtime/prompt-content';
import { parseProducerRef } from './identity';
import { manifestDigestOf, serializeManifest } from './manifest';
import { hasExactKeys, isWholeNumber, matchesPattern, plainRecord, refuse, sha256Hex, taggedDigest } from './primitives';
import { renderContext } from './renderer';
import { textFault, utf8Bytes } from './text-bounds';

export interface DeliveryInput {
  readonly revision: AcceptedRevision;
  readonly manifest: HandoffManifest;
  readonly rendered: RenderedContext;
  readonly targetInstructions: string;
  readonly targetAttemptId: string;
  readonly capabilities: NegotiatedCapabilities;
  readonly profile: ProfileCapacity;
  readonly session: SessionRequest;
  /** The host's answer about one artifact. Asked once per distinct artifact version. */
  accessOf(artifact: ArtifactRef): ArtifactAccess;
}

export type DeliveryResult = { readonly ok: true; readonly plan: DeliveryPlan } | Refusal;
export type DispatchCheck = { readonly ok: true } | Refusal;

const REPRESENTATION_DIGEST_TAG = 'pcd1';
const LINK_URI_BYTES_MAX = 2_048;
const EMBEDDED_MIME_TYPE = 'text/plain';
const CAPABILITY_KEYS = ['protocolVersion', 'loadSession', 'image', 'audio', 'embeddedContext', 'authMethodCount'] as const;
const PROFILE_KEYS = ['profileId', 'profileRevision', 'qualifiedContextBytes'] as const;
const ACCESS_KEYS = ['embeddedText', 'linkUri', 'materializePermitted', 'materializedUri'] as const;
const FRESH_SESSION_KEYS = ['kind'] as const;
const REUSE_SESSION_KEYS = ['kind', 'sessionLineage', 'targetLineage'] as const;

type Checked<T> = ({ readonly ok: true } & T) | Refusal;

interface PlannedArtifact {
  readonly ref: ArtifactRef;
  /** True when any source that carries the artifact is required. */
  required: boolean;
}

interface RoutedArtifact {
  readonly route: ArtifactRoute;
  /** `null` for an omitted artifact and for a copy that does not exist yet. */
  readonly block: AcpPromptBlock | null;
  readonly awaitingCopy: boolean;
  readonly embeddedBytes: number;
}

/** The manifest and its rendering, proven to be the ones the revision records. */
function recordedRendering(input: DeliveryInput): Checked<{ readonly rendered: RenderedContext }> {
  const { revision, manifest } = input;
  let serialized: string;
  let rendered: RenderedContext;
  try {
    serialized = serializeManifest(manifest);
    rendered = renderContext(manifest);
  } catch {
    return refuse('stale-revision', 'manifest-mismatch');
  }
  if (serialized !== revision.serializedManifest || manifestDigestOf(serialized) !== revision.manifestDigest) {
    return refuse('stale-revision', 'manifest-mismatch');
  }
  if (rendered.digestHex !== revision.renderedDigest || rendered.bytes !== revision.renderedBytes) {
    return refuse('stale-revision', 'rendered-mismatch');
  }
  const supplied = plainRecord(input.rendered);
  const same =
    supplied !== null &&
    supplied.text === rendered.text &&
    supplied.digestHex === rendered.digestHex &&
    supplied.bytes === rendered.bytes &&
    supplied.rendererVersion === rendered.rendererVersion;
  return same ? { ok: true, rendered } : refuse('stale-revision', 'rendered-mismatch');
}

function parseCapabilities(value: unknown): NegotiatedCapabilities | null {
  const record = plainRecord(value);
  if (record === null || !hasExactKeys(record, CAPABILITY_KEYS)) return null;
  const { loadSession, image, audio, embeddedContext, authMethodCount } = record;
  if (record.protocolVersion !== ACP_PROTOCOL_VERSION) return null;
  if (typeof loadSession !== 'boolean' || typeof image !== 'boolean') return null;
  if (typeof audio !== 'boolean' || typeof embeddedContext !== 'boolean') return null;
  if (!isWholeNumber(authMethodCount, 0)) return null;
  return { protocolVersion: ACP_PROTOCOL_VERSION, loadSession, image, audio, embeddedContext, authMethodCount };
}

function parseProfile(value: unknown): Checked<{ readonly profileId: string; readonly profileRevision: number; readonly qualifiedBytes: number }> {
  const record = plainRecord(value);
  if (record === null || !hasExactKeys(record, PROFILE_KEYS)) return refuse('invalid-source', 'profile');
  const { profileId, profileRevision, qualifiedContextBytes } = record;
  if (!matchesPattern(IDENTIFIER_PATTERN, profileId) || !isWholeNumber(profileRevision, 0)) return refuse('invalid-source', 'profile');
  if (qualifiedContextBytes === null) return refuse('capacity-exceeded', 'profile-unqualified');
  if (!isWholeNumber(qualifiedContextBytes, 1)) return refuse('invalid-source', 'profile');
  return { ok: true, profileId, profileRevision, qualifiedBytes: qualifiedContextBytes };
}

/**
 * FR-013. A fresh session always works. Reuse needs a policy that permits it, a target lineage
 * that is the attempt being dispatched, and a session of that node and occurrence: a session of
 * another lineage is never forwarded.
 */
function checkSession(value: unknown, manifest: HandoffManifest, targetAttemptId: string): Checked<{ readonly session: DeliverySession }> {
  const record = plainRecord(value);
  if (record === null) return refuse('invalid-source', 'session-shape');
  if (record.kind === 'fresh' && hasExactKeys(record, FRESH_SESSION_KEYS)) return { ok: true, session: 'fresh' };
  if (record.kind !== 'reuse' || !hasExactKeys(record, REUSE_SESSION_KEYS)) return refuse('invalid-source', 'session-shape');
  if (manifest.session === 'fresh') return refuse('invalid-policy', 'session-reuse-not-permitted');
  const sessionLineage = parseProducerRef(record.sessionLineage);
  const targetLineage = parseProducerRef(record.targetLineage);
  if (sessionLineage === null || targetLineage === null) return refuse('invalid-source', 'session-shape');
  const { targetNodePath, targetOccurrenceId } = manifest.identity;
  const isTarget =
    targetLineage.nodePath === targetNodePath && targetLineage.occurrenceId === targetOccurrenceId && targetLineage.attemptId === targetAttemptId;
  if (!isTarget) return refuse('invalid-source', 'session-target');
  if (sessionLineage.nodePath !== targetNodePath || sessionLineage.occurrenceId !== targetOccurrenceId) {
    return refuse('invalid-source', 'session-lineage');
  }
  return { ok: true, session: 'reuse' };
}

/** Each artifact version once, in manifest order, or `null` when two references disagree. */
function distinctArtifacts(manifest: HandoffManifest): readonly PlannedArtifact[] | null {
  const byVersion = new Map<string, PlannedArtifact>();
  for (const source of manifest.sources) {
    for (const ref of source.artifacts) {
      const key = JSON.stringify([ref.artifactId, ref.immutableVersion]);
      const known = byVersion.get(key);
      if (known === undefined) {
        byVersion.set(key, { ref, required: source.required });
        continue;
      }
      if (known.ref.digestHex !== ref.digestHex || known.ref.byteSize !== ref.byteSize || known.ref.kind !== ref.kind) return null;
      known.required = known.required || source.required;
    }
  }
  return [...byVersion.values()];
}

/** A location the host supplied: one line of bounded, well-formed text, or none. */
function isLocationOrNull(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string' || textFault(value, LINK_URI_BYTES_MAX) !== null) return false;
  return !value.includes('\t') && !value.includes('\n');
}

/** The host's answer rebuilt field by field, or `null`. A throw keeps no text of its error. */
function readAccess(accessOf: DeliveryInput['accessOf'], ref: ArtifactRef): ArtifactAccess | null {
  let answer: unknown;
  try {
    answer = accessOf(ref);
  } catch {
    return null;
  }
  const record = plainRecord(answer);
  if (record === null || !hasExactKeys(record, ACCESS_KEYS)) return null;
  const { embeddedText, linkUri, materializePermitted, materializedUri } = record;
  if (embeddedText !== null && typeof embeddedText !== 'string') return null;
  if (!isLocationOrNull(linkUri) || !isLocationOrNull(materializedUri) || typeof materializePermitted !== 'boolean') return null;
  return { embeddedText, linkUri, materializePermitted, materializedUri };
}

function linkBlock(uri: string, ref: ArtifactRef): AcpPromptBlock {
  return { type: 'resource-link', uri, name: ref.artifactId };
}

/**
 * FR-026: the first route that applies. Content offered for embedding is checked against the
 * size and digest of its reference before the bound is, so wrong content is refused even when
 * the artifact would have gone out as a link.
 */
function routeArtifact(artifact: PlannedArtifact, access: ArtifactAccess, embedNegotiated: boolean, embedBytesLeft: number): Checked<RoutedArtifact> {
  const { ref } = artifact;
  const routed = (route: ArtifactRouteKind, block: AcpPromptBlock | null, embeddedBytes = 0): Checked<RoutedArtifact> => ({
    ok: true,
    route: { artifactId: ref.artifactId, immutableVersion: ref.immutableVersion, route },
    block,
    awaitingCopy: route === 'materialized-copy' && block === null,
    embeddedBytes
  });
  const text = access.embeddedText;
  if (embedNegotiated && ref.kind === 'text' && ref.byteSize <= PHASE_CONTEXT_LIMITS.embedBytesMax && text !== null) {
    if (utf8Bytes(text) !== ref.byteSize) return refuse('invalid-source', 'embedded-size');
    if (sha256Hex(text) !== ref.digestHex) return refuse('invalid-source', 'embedded-digest');
    if (ref.byteSize <= embedBytesLeft) {
      const uri = `artifact:${ref.artifactId}@${ref.immutableVersion}`;
      return routed('embedded', { type: 'embedded-resource', uri, text, mimeType: EMBEDDED_MIME_TYPE }, ref.byteSize);
    }
  }
  if (access.linkUri !== null) return routed('resource-link', linkBlock(access.linkUri, ref));
  if (access.materializePermitted) {
    return routed('materialized-copy', access.materializedUri === null ? null : linkBlock(access.materializedUri, ref));
  }
  if (artifact.required) return refuse('required-context-unavailable', 'artifact-unroutable');
  return routed('omitted', null);
}

function routeArtifacts(
  manifest: HandoffManifest,
  accessOf: DeliveryInput['accessOf'],
  embedNegotiated: boolean,
  embedBytesMax: number
): Checked<{ readonly items: readonly RoutedArtifact[] }> {
  const artifacts = distinctArtifacts(manifest);
  if (artifacts === null) return refuse('invalid-source', 'artifact-conflict');
  const items: RoutedArtifact[] = [];
  let embedBytesLeft = embedBytesMax;
  for (const artifact of artifacts) {
    const access = readAccess(accessOf, artifact.ref);
    if (access === null) return refuse('invalid-source', 'artifact-access');
    const routed = routeArtifact(artifact, access, embedNegotiated, embedBytesLeft);
    if (!routed.ok) return routed;
    embedBytesLeft -= routed.embeddedBytes;
    items.push(routed);
  }
  return { ok: true, items };
}

/**
 * The blocks through F13's prompt builder. A link is accepted only when it is a location the
 * host supplied for this plan; the builder refuses any other.
 */
function blocksFault(blocks: readonly AcpPromptBlock[], capabilities: NegotiatedCapabilities): Refusal | null {
  const supplied = new Set<string>();
  for (const block of blocks) {
    if (block.type === 'resource-link') supplied.add(block.uri);
  }
  const result = buildPromptContent(blocks, capabilities, (uri) => supplied.has(uri));
  if (result.ok) return null;
  return result.reason === 'prompt-oversized' ? refuse('capacity-exceeded', 'prompt-bytes') : refuse('invalid-source', 'prompt-content');
}

function representationDigestOf(representation: Omit<DeliveryRepresentation, 'representationDigest'>): string {
  const { capabilities } = representation;
  return taggedDigest([
    REPRESENTATION_DIGEST_TAG,
    representation.handoffId,
    representation.revision,
    representation.targetAttemptId,
    representation.contentDigest,
    representation.rendererVersion,
    representation.renderedDigest,
    CAPABILITY_KEYS.map((key) => capabilities[key]),
    representation.profileId,
    representation.profileRevision,
    representation.session,
    representation.routes.map((route) => [route.artifactId, route.immutableVersion, route.route])
  ]);
}

/** FR-025, FR-026, FR-035: what would be sent for one ready revision, and the record of it. */
export function planDelivery(input: DeliveryInput): DeliveryResult {
  const { revision, manifest } = input;
  if (revision.state !== 'ready') return refuse('stale-revision', 'revision-not-ready');
  if (revision.rendererVersion !== PHASE_CONTEXT_RENDERER_VERSION) return refuse('unsupported-version', 'renderer-version');
  const recorded = recordedRendering(input);
  if (!recorded.ok) return recorded;
  const instructions: unknown = input.targetInstructions;
  if (typeof instructions !== 'string') return refuse('invalid-source', 'target-instructions');
  if (sha256Hex(instructions) !== manifest.targetInstructionsDigest) return refuse('stale-revision', 'instructions-mismatch');
  const targetAttemptId: unknown = input.targetAttemptId;
  if (!matchesPattern(IDENTIFIER_PATTERN, targetAttemptId)) return refuse('invalid-source', 'target-attempt');
  const capabilities = parseCapabilities(input.capabilities);
  if (capabilities === null) return refuse('invalid-source', 'capabilities');
  const profile = parseProfile(input.profile);
  if (!profile.ok) return profile;
  const { rendered } = recorded;
  if (rendered.bytes > profile.qualifiedBytes) return refuse('capacity-exceeded', 'qualified-bound');
  const session = checkSession(input.session, manifest, targetAttemptId);
  if (!session.ok) return session;
  const routed = routeArtifacts(manifest, input.accessOf, capabilities.embeddedContext, profile.qualifiedBytes - rendered.bytes);
  if (!routed.ok) return routed;

  const routes = routed.items.map((item) => item.route);
  const awaitingCopy = routed.items.filter((item) => item.awaitingCopy).map((item) => item.route.artifactId);
  const blocks: AcpPromptBlock[] = [];
  if (awaitingCopy.length === 0) {
    blocks.push({ type: 'text', text: instructions }, { type: 'text', text: rendered.text });
    for (const item of routed.items) {
      if (item.block !== null) blocks.push(item.block);
    }
    const fault = blocksFault(blocks, capabilities);
    if (fault !== null) return fault;
  }
  const recordOf = {
    handoffId: manifest.handoffId,
    revision: revision.revision,
    targetAttemptId,
    contentDigest: revision.manifestDigest,
    rendererVersion: revision.rendererVersion,
    renderedDigest: revision.renderedDigest,
    capabilities,
    profileId: profile.profileId,
    profileRevision: profile.profileRevision,
    session: session.session,
    routes
  };
  const representation: DeliveryRepresentation = { ...recordOf, representationDigest: representationDigestOf(recordOf) };
  return { ok: true, plan: { blocks, awaitingCopy, routes, representation } };
}

function recordedDigest(representation: DeliveryRepresentation): string | null {
  try {
    return representationDigestOf(representation);
  } catch {
    return null;
  }
}

/**
 * FR-035: a dispatch is refused when the record was changed after it was written, or when the
 * capabilities, the profile identity or revision, or the content differ from it.
 */
export function checkDispatch(representation: DeliveryRepresentation, current: DispatchContext): DispatchCheck {
  if (recordedDigest(representation) !== representation.representationDigest) return refuse('stale-revision', 'representation-digest');
  const capabilities = parseCapabilities(current.capabilities);
  const recorded = representation.capabilities;
  if (capabilities === null || CAPABILITY_KEYS.some((key) => capabilities[key] !== recorded[key])) {
    return refuse('stale-revision', 'capabilities-changed');
  }
  const profile = plainRecord(current.profile);
  if (profile === null || profile.profileId !== representation.profileId || profile.profileRevision !== representation.profileRevision) {
    return refuse('stale-revision', 'profile-changed');
  }
  if (current.contentDigest !== representation.contentDigest) return refuse('stale-revision', 'content-changed');
  return { ok: true };
}
