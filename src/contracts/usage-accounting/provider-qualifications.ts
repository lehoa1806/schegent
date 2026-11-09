/**
 * FR-R6-F06 (FR-020) — what each adapter is qualified to report, kept apart from observed
 * data. An adapter missing from the registry gets `unknown` for every relation, and its cost
 * is never treated as known.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { CacheRelation } from './accounting-types';

export type CostScope = 'session-cumulative' | 'invocation-delta' | 'unknown';
export type QualificationLevel = 'fixture-verified' | 'fixture-only' | 'unqualified';

export interface ProviderQualification {
  readonly backend: string;
  readonly cacheRelation: CacheRelation;
  readonly costScope: CostScope;
  /** True when a session-cumulative cost needs a qualified baseline to become a delta. */
  readonly costNeedsBaseline: boolean;
  readonly qualification: QualificationLevel;
}

export const PROVIDER_QUALIFICATIONS: readonly ProviderQualification[] = Object.freeze([
  Object.freeze({
    backend: 'claude',
    cacheRelation: 'disjoint',
    costScope: 'session-cumulative',
    costNeedsBaseline: true,
    qualification: 'fixture-verified'
  }),
  Object.freeze({
    backend: 'codex',
    cacheRelation: 'subset-of-input',
    costScope: 'invocation-delta',
    costNeedsBaseline: false,
    qualification: 'fixture-verified'
  }),
  Object.freeze({
    backend: 'agy',
    cacheRelation: 'unknown',
    costScope: 'invocation-delta',
    costNeedsBaseline: false,
    qualification: 'fixture-verified'
  }),
  Object.freeze({
    backend: 'acp',
    cacheRelation: 'unknown',
    costScope: 'session-cumulative',
    costNeedsBaseline: true,
    qualification: 'fixture-only'
  })
] as const satisfies readonly ProviderQualification[]);

/** The registry entry for `backend`, or an all-`unknown` entry for an unlisted adapter. */
export function qualificationFor(backend: string): ProviderQualification {
  const found = PROVIDER_QUALIFICATIONS.find((entry) => entry.backend === backend);
  if (found !== undefined) return found;
  return Object.freeze({
    backend,
    cacheRelation: 'unknown',
    costScope: 'unknown',
    costNeedsBaseline: true,
    qualification: 'unqualified'
  });
}
