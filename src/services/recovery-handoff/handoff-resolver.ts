/**
 * FR-R6-F08 (research R6) — resolves each reference of a handoff revision to `available` or to
 * one of the six reasons a reference cannot be used: missing, expired, deleted, unreadable,
 * changed, unsupported.
 *
 * The record comes from F05 `getArtifact`; the bytes are checked through the F05 probe only
 * when a digest is expected and the record is present and of an accepted store kind. The
 * locator stays host-internal: it is read here and handed to the probe, never returned.
 *
 * Every result is written to `last_resolution` on its reference row, so an explanation can
 * report it without probing again.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import type { ArtifactRecord, LifecycleResult } from '../../contracts/artifact-lifecycle/lifecycle-types';
import {
  HANDOFF_ACCEPTED_STORE_KINDS,
  type HandoffReferenceRole,
  type HandoffResolution
} from '../../contracts/recovery-handoff/handoff-types';
import type { ArtifactLifecycleService } from '../artifact-lifecycle';
import type { ArtifactByteProbe, ArtifactLocator } from '../artifact-lifecycle/artifact-records';
import { envelopeDigestOf, type RecoveryEnvelopePort } from './handoff-envelopes';
import type { ReferenceRow } from './handoff-store-rows';
import type { SqliteHandoffStore } from './handoff-store';

export interface ResolverDeps {
  readonly store: SqliteHandoffStore;
  readonly lifecycle: Pick<ArtifactLifecycleService, 'getArtifact'>;
  /** Host-internal F05 locator read (`ArtifactRecordStore.locatorOf`). */
  readonly locatorOf: (artifactId: string) => ArtifactLocator | null;
  readonly probe: Pick<ArtifactByteProbe, 'digestSha256'> & Partial<Pick<ArtifactByteProbe, 'observe'>>;
  /** Optional envelope port so checkpoint-stored envelopes are digest-verified at use (`16-12`). */
  readonly envelopes?: Pick<RecoveryEnvelopePort, 'readRecoveryEnvelope'>;
  readonly nowMs: () => number;
}

export interface EnvelopeVerificationLocation {
  readonly runId: string;
  readonly handoverId: string;
}

export interface ResolveRevisionOptions {
  readonly envelopeLocation?: EnvelopeVerificationLocation;
  readonly requireEnvelope?: boolean;
}

export interface ResolvedReference {
  readonly artifactId: string;
  readonly role: HandoffReferenceRole;
  readonly required: boolean;
  readonly resolution: HandoffResolution;
}

export interface OmittedReference {
  readonly artifactId: string;
  readonly role: HandoffReferenceRole;
  readonly resolution: HandoffResolution;
}

export type RevisionUsability = 'usable' | 'blocked';

export interface RevisionResolution {
  readonly status: RevisionUsability;
  readonly references: readonly ResolvedReference[];
  /** Optional references that are not `available`; they do not block the revision. */
  readonly omitted: readonly OmittedReference[];
  /** Present when the revision manifest names an envelope that was verified at use (`16-12`). */
  readonly envelopeResolution?: HandoffResolution;
}

const REFUSAL_RESOLUTIONS: Readonly<Record<string, HandoffResolution>> = Object.freeze({
  'not-found': 'missing',
  'unknown-version': 'unsupported'
});

const AVAILABILITY_RESOLUTIONS: Readonly<Record<string, HandoffResolution>> = Object.freeze({
  missing: 'missing',
  expired: 'expired',
  deleted: 'deleted',
  corrupt: 'unreadable',
  unverified: 'unreadable',
  pending: 'unreadable'
});

function expectedDigestOf(record: ArtifactRecord, expectedDigest: string | null): string | null {
  return expectedDigest ?? record.digest?.value ?? null;
}

/**
 * R6, pure. `probeDigest` is what the F05 probe observed (null when it could not read the
 * bytes); `expectedDigest` is the reference's own digest, else the record's is used.
 */
export function classifyResolution(
  found: LifecycleResult<ArtifactRecord>,
  probeDigest: string | null,
  expectedDigest: string | null
): HandoffResolution {
  if (!found.ok) return REFUSAL_RESOLUTIONS[found.refusal.code] ?? 'unreadable';
  const record = found.value;
  if (!HANDOFF_ACCEPTED_STORE_KINDS.has(record.storeKind)) return 'unsupported';
  if (record.availability !== 'present') return AVAILABILITY_RESOLUTIONS[record.availability] ?? 'unreadable';
  const expected = expectedDigestOf(record, expectedDigest);
  if (expected === null) return 'available';
  if (probeDigest === null) return 'unreadable';
  return probeDigest === expected ? 'available' : 'changed';
}

const NEWER_ENVELOPE_CODE = 'unsupported-recovery-envelope-version';

async function verifyArtifactBytes(
  deps: ResolverDeps,
  artifactId: string,
  found: LifecycleResult<ArtifactRecord>,
  expectedDigest: string | null
): Promise<HandoffResolution> {
  if (!found.ok || !HANDOFF_ACCEPTED_STORE_KINDS.has(found.value.storeKind) || found.value.availability !== 'present') {
    return classifyResolution(found, null, expectedDigest);
  }
  const expected = expectedDigestOf(found.value, expectedDigest);
  if (expected === null) {
    if (deps.probe.observe === undefined) return 'available';
    const locator = deps.locatorOf(artifactId);
    if (locator === null) return 'unreadable';
    try {
      const observed = await deps.probe.observe(locator);
      return observed.exists ? 'available' : 'missing';
    } catch {
      return 'unreadable';
    }
  }
  const locator = deps.locatorOf(artifactId);
  if (locator === null) return 'unreadable';
  if (deps.probe.observe !== undefined) {
    try {
      const observed = await deps.probe.observe(locator);
      if (!observed.exists) return 'missing';
    } catch {
      return 'unreadable';
    }
  }
  const probeDigest = await deps.probe.digestSha256(locator).catch(() => null);
  return classifyResolution(found, probeDigest, expectedDigest);
}

async function resolveOne(deps: ResolverDeps, row: ReferenceRow): Promise<HandoffResolution> {
  const found = deps.lifecycle.getArtifact(row.artifactId);
  return verifyArtifactBytes(deps, row.artifactId, found, row.expectedDigest);
}

function parseManifestEnvelope(
  manifestJson: string
): { readonly artifactId: string; readonly digest: string } | 'invalid' | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson);
  } catch {
    return 'invalid';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'invalid';
  const envelope = (parsed as { readonly envelope?: unknown }).envelope;
  if (envelope === null || envelope === undefined) return null;
  if (typeof envelope !== 'object' || Array.isArray(envelope)) return 'invalid';
  const artifactId = (envelope as { readonly artifactId?: unknown }).artifactId;
  const digest = (envelope as { readonly digest?: unknown }).digest;
  if (typeof artifactId !== 'string' || typeof digest !== 'string') return 'invalid';
  return { artifactId, digest };
}

async function verifyCheckpointEnvelope(
  envelopes: Pick<RecoveryEnvelopePort, 'readRecoveryEnvelope'>,
  runId: string,
  handoverId: string,
  expectedDigest: string
): Promise<HandoffResolution | null> {
  const read = await envelopes.readRecoveryEnvelope(runId, handoverId).catch(() => 'error' as const);
  if (read === 'error') return 'unreadable';
  if (read === null) return null;
  if (!read.ok) {
    const newer = read.diagnostics.some((diagnostic) => diagnostic.code === NEWER_ENVELOPE_CODE);
    return newer ? 'unsupported' : 'unreadable';
  }
  return envelopeDigestOf(read.value) === expectedDigest ? 'available' : 'changed';
}

async function resolveEnvelope(
  deps: ResolverDeps,
  handoffId: string,
  revisionNo: number,
  options?: ResolveRevisionOptions
): Promise<HandoffResolution | undefined> {
  const revision = deps.store.getRevision(handoffId, revisionNo);
  if (revision === undefined) return undefined;
  const envelope = parseManifestEnvelope(revision.manifestJson);
  if (envelope === null) return undefined;
  if (envelope === 'invalid') return 'unreadable';

  const envelopeLocation = options?.envelopeLocation;
  if (envelopeLocation !== undefined) {
    if (deps.envelopes === undefined) return 'unreadable';
    const verified = await verifyCheckpointEnvelope(
      deps.envelopes,
      envelopeLocation.runId,
      envelopeLocation.handoverId,
      envelope.digest
    );
    return verified ?? 'missing';
  }

  const found = deps.lifecycle.getArtifact(envelope.artifactId);
  if (found.ok) {
    return verifyArtifactBytes(deps, envelope.artifactId, found, envelope.digest);
  }
  if (found.refusal.code !== 'not-found') {
    return REFUSAL_RESOLUTIONS[found.refusal.code] ?? 'unreadable';
  }

  if (deps.envelopes !== undefined) {
    const handoff = deps.store.getHandoff(handoffId);
    if (handoff === undefined) return 'missing';
    const verified = await verifyCheckpointEnvelope(
      deps.envelopes,
      handoff.rootExecutionId,
      envelope.artifactId,
      envelope.digest
    );
    return verified ?? 'missing';
  }

  return options?.requireEnvelope === true ? 'missing' : undefined;
}

/**
 * Resolves every reference of one revision (and verifies `manifest.envelope` when registered or
 * stored under the checkpoint envelope port) by freshly probing bytes/digests at use (`16-12`),
 * recording each reference result on its row.
 */
export async function resolveRevision(
  deps: ResolverDeps,
  handoffId: string,
  revisionNo: number,
  options?: ResolveRevisionOptions
): Promise<RevisionResolution> {
  const references: ResolvedReference[] = [];
  for (const row of deps.store.listReferences(handoffId, revisionNo)) {
    const resolution = await resolveOne(deps, row);
    deps.store.setResolution(handoffId, revisionNo, row.artifactId, resolution, deps.nowMs());
    references.push({ artifactId: row.artifactId, role: row.role, required: row.required, resolution });
  }
  const envelopeResolution = await resolveEnvelope(deps, handoffId, revisionNo, options);
  const blocked =
    references.some((ref) => ref.required && ref.resolution !== 'available') ||
    (envelopeResolution !== undefined && envelopeResolution !== 'available');
  const omitted = references
    .filter((ref) => !ref.required && ref.resolution !== 'available')
    .map((ref) => ({ artifactId: ref.artifactId, role: ref.role, resolution: ref.resolution }));
  return {
    status: blocked ? 'blocked' : 'usable',
    references,
    omitted,
    ...(envelopeResolution !== undefined ? { envelopeResolution } : {})
  };
}
