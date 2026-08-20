// Feature 102 (FR-021, FR-022) — which published version a run froze.
//
// One shape, carried on `ExecutionEnvelope` (which is `FrozenRunPlan`) and read
// back by version housekeeping to decide what it may not remove. It is the only
// durable addition the Runs launch surface makes.
//
// Deliberately not in the contracts barrel: `run-request.ts` and
// `catalog-store.ts` are both imported by path for the same reason, and the
// barrel is almost entirely `export *`, which
// `tests/lint/contracts-module-reachability.test.ts` excludes from the corpus
// precisely so a barrel entry cannot stand in for a real consumer.

import type { CatalogKind } from './catalog-store';

/**
 * The published version a run resolved and froze.
 *
 * **Resolved host-side, never accepted from the wire** (FR-023, FR-024). The
 * submission shape has no field for this, and both ingress validators refuse a
 * payload that carries one rather than dropping it — a payload naming its own
 * provenance did not come from this product's surface, and refusing makes the
 * attempt visible instead of silent.
 *
 * **Immutable for the run's life** (FR-025). Structural, like every other
 * envelope member: the plan is frozen once and carried through
 * `guardedRun.scheduleOrEnqueue()` untouched. Publishing a newer version while
 * the run is queued changes what Runs offers next, not what this run executes.
 */
export interface CatalogVersionRef {
  /**
   * Which kind of definition the id names.
   *
   * Part of the identity, not decoration: the store permits a Pipeline and a
   * Workflow to share an id, so `(pipeline, X, v4)` and `(workflow, X, v4)` are
   * two different versions and an exemption earned by one does not cover the
   * other (FR-033).
   */
  readonly kind: CatalogKind;
  /** The definition id, as the catalog holds it. */
  readonly id: string;
  /**
   * The version that was Active at the moment of the freeze.
   *
   * **Never `''`.** Absence of the whole record means "not recorded"; a
   * present-but-blank identity is neither, and no producer may write one
   * (FR-027). `BuilderLifecycle.activeVersionId` already carries this rule for
   * the same reason — an empty string reads as a version downstream and quotes
   * straight back at the host.
   */
  readonly versionId: string;
}
