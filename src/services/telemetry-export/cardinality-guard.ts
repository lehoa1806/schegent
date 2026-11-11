/**
 * FR-R6-F14 (FR-006; research R4) — the attribute-set limit. Each instrument keeps at most
 * `attributeSetsMax` sets: the first 999 distinct ones it sees, then the overflow set, which
 * takes every later new set. A set admitted before the limit keeps its own data point.
 *
 * The guard lives in memory for one exporter lifetime, so the limit holds across batches.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { TELEMETRY_EXPORT_BOUNDS } from '../../contracts/telemetry-export';
import { ATTRIBUTE_KEYS, type InstrumentId } from './mapping-revision';
import type { Attribute } from './metadata-mapper';

export type Admission = 'admitted' | 'overflow';

/** The overflow set of the OpenTelemetry metrics SDK specification: one boolean attribute. */
export const OVERFLOW_ATTRIBUTES: readonly (readonly [string, true])[] = Object.freeze([
  Object.freeze([ATTRIBUTE_KEYS.overflow, true] as const)
]);

/** Keys of lists that cannot change: a list frozen with every entry has its key computed once. */
const KEYS = new WeakMap<readonly Attribute[], string>();

/** One text per attribute set; equal exactly when the sets are equal. */
export function attributeSetKey(attributes: readonly Attribute[]): string {
  const known = KEYS.get(attributes);
  if (known !== undefined) return known;
  const key = JSON.stringify(attributes);
  if (Object.isFrozen(attributes) && attributes.every((attribute) => Object.isFrozen(attribute))) KEYS.set(attributes, key);
  return key;
}

export interface CardinalityGuard {
  /** Whether a data point may carry this set, or must go to the overflow set. */
  admit(instrument: InstrumentId, attributes: readonly Attribute[]): Admission;
  /** The number of ordinary sets the instrument holds. */
  size(instrument: InstrumentId): number;
}

/** `setsMax` counts the overflow set, so `setsMax - 1` ordinary sets are admitted. */
export function createCardinalityGuard(setsMax: number = TELEMETRY_EXPORT_BOUNDS.attributeSetsMax): CardinalityGuard {
  const ordinaryMax = setsMax - 1;
  const seen = new Map<InstrumentId, Set<string>>();

  function setsOf(instrument: InstrumentId): Set<string> {
    const existing = seen.get(instrument);
    if (existing !== undefined) return existing;
    const created = new Set<string>();
    seen.set(instrument, created);
    return created;
  }

  return {
    admit(instrument, attributes) {
      const sets = setsOf(instrument);
      const key = attributeSetKey(attributes);
      if (sets.has(key)) return 'admitted';
      if (sets.size >= ordinaryMax) return 'overflow';
      sets.add(key);
      return 'admitted';
    },
    size(instrument) {
      return seen.get(instrument)?.size ?? 0;
    }
  };
}
