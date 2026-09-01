// The `display` map an invalid catalog row shows the operator — one declaration.
//
// WHY THIS MODULE EXISTS. The Phase, Pipeline and Workflow validators each held a
// byte-identical `recognizedDisplay`, differing only in which authored set they
// walked. All three admitted `string | number | boolean | null` and dropped
// everything else, and every authored set contains fields that are lists — so three
// separate sites that read a list back out of `display` were dead code:
// `authoredPhaseIds()` (an invalid Pipeline blocked no Phase deletion),
// `sourceRecordToMutablePipeline()` (an invalid Pipeline opened with an empty phase
// list, discarding what the operator typed), and a Phase's `capabilities` (repairing
// an invalid Phase widened its authority back to every capability).
//
// Fixing the predicate in three places is how it came to be wrong in three places.
// It is declared once, here, and the three validators call it.
//
// WHAT `display` IS FOR. A row that FAILED validation has no parsed definition, so
// `display` is the operator's only view of what they wrote. It is therefore built
// from RAW, UNVALIDATED input and is projected state only: never persisted, never
// executed, never read as a definition. Callers bound and sanitise it on the way to
// a webview.

/**
 * A value `display` carries as-is: no nesting, nothing to walk.
 *
 * Exported because the sidebar projector bounds this same map on its way to a
 * webview, and a projector that dropped what this file kept would re-create the bug
 * this module exists to fix.
 */
export function isDisplayScalar(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  );
}

/**
 * The authored fields of `raw` that `display` can carry, frozen.
 *
 * Scalars, and lists of scalars. **Not** lists of objects (`inputs`, `outputs`,
 * `bindings`, `nodes`, `connections`) or objects (`executionDefaults`): admitting
 * those means sanitising to unbounded depth on the one path whose input is by
 * definition malformed, and no site reads them from `display`. A non-scalar element
 * inside an admitted list is dropped rather than costing the operator the entries
 * beside it — a malformed row is all this path ever sees.
 */
export function recognizedAuthoredDisplay(
  raw: Record<string, unknown>,
  authoredFields: ReadonlySet<string>
): Readonly<Record<string, unknown>> {
  const display: Record<string, unknown> = {};
  for (const field of authoredFields) {
    const value = raw[field];
    if (isDisplayScalar(value)) {
      display[field] = value;
      continue;
    }
    if (!Array.isArray(value)) continue;
    const entries = (value as readonly unknown[]).filter(isDisplayScalar);
    // A list that loses EVERY entry is not an empty list — it is a list this map
    // cannot represent, and saying `[]` would report an authored `inputs` of two
    // ports as a declaration of none. An absent key says "unknown", which is the
    // truth. An authored empty list is still carried as empty, because that is a
    // real declaration.
    if (entries.length === 0 && value.length > 0) continue;
    display[field] = Object.freeze(entries);
  }
  return Object.freeze(display);
}
