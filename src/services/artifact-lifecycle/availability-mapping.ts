/**
 * FR-R6-F05 (clarification 2) — the fixed, read-only mapping from the F04
 * `artifact_availability.state` vocabulary to the F02 availability states.
 *
 * F04 rows are never rewritten. When an `artifact_lifecycle` row exists, its
 * availability is authoritative. A value outside the known set is preserved as
 * `unverified`, never coerced to `present`.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import type {
  ArtifactAvailabilityState,
  ArtifactStoreKind
} from '../../contracts/artifact-lifecycle/lifecycle-types';
import { ARTIFACT_AVAILABILITY_STATES } from '../../contracts/shared-memory-storage/identity-and-observations';

export interface ResolvedAvailability {
  readonly availability: ArtifactAvailabilityState;
  /** `quarantine` when F04 says `quarantined`; the record's class is then forced to quarantine. */
  readonly forcedStoreKind: ArtifactStoreKind | null;
}

const F04_TO_F05: ReadonlyMap<string, ResolvedAvailability> = new Map([
  ['available', { availability: 'present', forcedStoreKind: null }],
  ['evicted', { availability: 'expired', forcedStoreKind: null }],
  ['missing', { availability: 'missing', forcedStoreKind: null }],
  ['quarantined', { availability: 'present', forcedStoreKind: 'quarantine' }]
]);

const UNVERIFIED: ResolvedAvailability = { availability: 'unverified', forcedStoreKind: null };
const NO_ROW: ResolvedAvailability = { availability: 'missing', forcedStoreKind: null };

export function isArtifactAvailabilityState(value: string): value is ArtifactAvailabilityState {
  return (ARTIFACT_AVAILABILITY_STATES as readonly string[]).includes(value);
}

export function mapF04Availability(value: string): ResolvedAvailability {
  return F04_TO_F05.get(value) ?? UNVERIFIED;
}

export function resolveAvailability(
  lifecycleRow: { readonly availability: string } | undefined,
  f04Row: { readonly state: string } | undefined
): ResolvedAvailability {
  if (lifecycleRow !== undefined) {
    return isArtifactAvailabilityState(lifecycleRow.availability)
      ? { availability: lifecycleRow.availability, forcedStoreKind: null }
      : UNVERIFIED;
  }
  if (f04Row !== undefined) return mapF04Availability(f04Row.state);
  return NO_ROW;
}
