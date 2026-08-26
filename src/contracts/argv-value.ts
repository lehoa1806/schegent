// FR-R3-105 (FR-060, FR-063) — what a safe argv value is, in one place, read by both
// halves of the check.
//
// TWO HALVES, ONE RULE. The freeze site
// (`src/config/process-definition-validator.ts`) refuses a hostile `model` when a
// document is validated. That closes the ingress. It does **not** close plans that were
// already frozen: a `FrozenRunPlan` persisted before this rule existed carries whatever
// its document said, and re-resolving it at drain time is forbidden — the freeze is the
// whole point of the freeze. So dispatch re-checks, which is the same defensive shape
// `resolveRunOutputs` applies to a frozen plan's declared outputs.
//
// The rule lives here, in `contracts/`, rather than in either caller, because two copies
// of "what does a safe value look like" is how a validator and a dispatcher come to
// disagree — and the disagreement would present as a run that executed rather than a
// refusal.
//
// This module imports nothing, on purpose. It is a leaf.

/**
 * The charset a free-form authored value may use before it becomes an argv token.
 *
 * A leading hyphen is excluded by the pattern's first character class rather than by a
 * separate check, because a value beginning `-` IS a flag to the child's argument parser
 * whatever else it contains. Spawns are `shell: false` throughout, so the hazard is flag
 * injection, not shell injection; the rest of the charset is narrow because every real
 * model identifier across the three backends is vendor-shaped.
 */
export const ARGV_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

/** The longest such value. Vendor identifiers are far shorter; this is a bound, not a target. */
export const ARGV_VALUE_MAX_LEN = 128;

/**
 * Whether a value may be handed to a backend as its own argv token.
 *
 * Returns a verdict rather than throwing, because the two callers need different
 * responses: the validator collects a field error an operator reads, and dispatch drops
 * the field and records why. Neither may REWRITE the value — a laundered value that looks
 * legitimate is worse than a declined one, which is the `catalogVersion` rule's
 * reasoning.
 */
export function isSafeArgvValue(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > ARGV_VALUE_MAX_LEN) return false;
  return ARGV_VALUE_PATTERN.test(value);
}
