// Shared by the gates that make a dated record fail once its date has passed.
//
// FR-R3-129 introduced the mechanism for the platform decline: *"a dated decline
// is only honest while someone re-reads it"*, so the date lives in the document
// under a machine-readable marker and a gate fails on the day. FR-R3-134 made
// `dated-review-records.test.ts` the single reader, with a registry and a scan of
// `docs/` for markers no entry names.
//
// FR-R5-F21 (FR-008, FR-011) moved the predicates and the registry to
// `scripts/review-cadence.mjs`, so `npm run review:due` answers "what is due, and
// when" with the gate's own rules. A marker whose date is not a real calendar day
// now reads as malformed (`readReviewMarker`), not as absent.
//
// The gates load the module through this function, not a static import: they are
// CommonJS and the module is ESM, so a static import or re-export of it is TS1479,
// while a literal `import()` type-checks and stays typed by `review-cadence.d.mts`.

/** The review-date rules and the dated-review registry, from `scripts/review-cadence.mjs`. */
export async function loadReviewCadence() {
  return import('../../scripts/review-cadence.mjs');
}

/** What `loadReviewCadence` resolves to. */
export type ReviewCadence = Awaited<ReturnType<typeof loadReviewCadence>>;
