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
import type { ReferenceRow } from './handoff-store-rows';
import type { SqliteHandoffStore } from './handoff-store';

export interface ResolverDeps {
  readonly store: SqliteHandoffStore;
  readonly lifecycle: Pick<ArtifactLifecycleService, 'getArtifact'>;
  /** Host-internal F05 locator read (`ArtifactRecordStore.locatorOf`). */
  readonly locatorOf: (artifactId: string) => ArtifactLocator | null;
  readonly probe: Pick<ArtifactByteProbe, 'digestSha256'>;
  readonly nowMs: () => number;
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

function needsProbe(found: LifecycleResult<ArtifactRecord>, expectedDigest: string | null): boolean {
  if (!found.ok) return false;
  const record = found.value;
  if (!HANDOFF_ACCEPTED_STORE_KINDS.has(record.storeKind) || record.availability !== 'present') return false;
  return expectedDigestOf(record, expectedDigest) !== null;
}

async function observeDigest(deps: ResolverDeps, artifactId: string): Promise<string | null> {
  const locator = deps.locatorOf(artifactId);
  if (locator === null) return null;
  return deps.probe.digestSha256(locator).catch(() => null);
}

async function resolveOne(deps: ResolverDeps, row: ReferenceRow): Promise<HandoffResolution> {
  const found = deps.lifecycle.getArtifact(row.artifactId);
  const probeDigest = needsProbe(found, row.expectedDigest) ? await observeDigest(deps, row.artifactId) : null;
  return classifyResolution(found, probeDigest, row.expectedDigest);
}

/** Resolves every reference of one revision and records each result on its row. */
export async function resolveRevision(
  deps: ResolverDeps,
  handoffId: string,
  revisionNo: number
): Promise<RevisionResolution> {
  const references: ResolvedReference[] = [];
  for (const row of deps.store.listReferences(handoffId, revisionNo)) {
    const resolution = await resolveOne(deps, row);
    deps.store.setResolution(handoffId, revisionNo, row.artifactId, resolution, deps.nowMs());
    references.push({ artifactId: row.artifactId, role: row.role, required: row.required, resolution });
  }
  const blocked = references.some((ref) => ref.required && ref.resolution !== 'available');
  const omitted = references
    .filter((ref) => !ref.required && ref.resolution !== 'available')
    .map((ref) => ({ artifactId: ref.artifactId, role: ref.role, resolution: ref.resolution }));
  return { status: blocked ? 'blocked' : 'usable', references, omitted };
}
