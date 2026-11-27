// FR-R3-085 — what a Run id is, in one place.
//
// WHY THIS MODULE EXISTS. The evidence export and the evidence delete both
// select a Run's artifacts with `relative.includes(runId)`, so both must reject a
// degenerate id — `.`, `''`, `log` — which is a substring of nearly every
// evidence path and turns a scoped operation into an unscoped one.
//
// Both were given the same check, and that was the mistake: two copies of one
// rule is a second authority on it, and the way that goes wrong is specific and
// bad — one is tightened, the other is not, and a delete accepts an id the
// export refuses. This feature's own FR-082 forbids exactly that shape, and the
// security fix that introduced it was caught by re-reading the fix rather than
// by any gate.
//
// So it lives here, a leaf module importing nothing, on the same reasoning
// `contracts/backend-kinds.ts` was extracted for in this same change: identity
// belongs in contracts, and a rule two callers share has one home.

/** Run ids are `randomUUID()`. Nothing else is a Run id. */
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `value` is a Run id.
 *
 * Validated at the boundary rather than trusted from the caller. The callers
 * pass a real id today; that is an argument for the check being cheap, not for
 * omitting it.
 */
export function isRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value);
}
