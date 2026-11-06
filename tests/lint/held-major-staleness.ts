// FR-R4-F09 (FR-028, FR-029; contract HL1) -- the rule behind `held-major-staleness.test.ts`, in a
// module of its own so it can be tested at its boundary with an injected clock.
//
// FR-R5-F21 (FR-011) moved the rule to `scripts/review-cadence.mjs`, so `npm run review:due` reads
// the same clock the gate does. The gate loads it through `loadReviewCadence` (`review-dates.ts`),
// re-exported here so it keeps its import path: a static import of the ESM module from this
// CommonJS file is TS1479. The parser now reports malformed rows (`readHeldMajors`) instead of
// dropping them, and reads only the `## Held majors` section; `parseHeldRows` is the rows of that
// read.
export { loadReviewCadence } from './review-dates';
export type { ReviewCadence } from './review-dates';
