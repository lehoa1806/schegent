// The vacuity detector, extracted so it has ONE definition.
//
// `scanning-gates-prove-they-scanned.test.ts` owned these three patterns
// inline. FR-R3-088 requires measuring the detector's false-negative rate, and a
// census that re-declared the patterns would be measuring a copy — the
// duplicate-authority shape FR-R3-066 exists to remove, reproduced inside the
// very measurement meant to expose it. So the gate and the census import the
// same predicate from here.
//
// WHAT THE DETECTOR CAN AND CANNOT DO, restated because the whole census is
// about the second half:
//
//   It reads source TEXT for scanning calls, for `toEqual([])`, and for the
//   shapes a vacuity control takes. **It cannot prove a gate is vacuous, and it
//   cannot prove one is sound.** A control that constrains nothing still passes.
//
// Its detection erred in one direction three times during development —
// `toContain(HELPER)` matched, `toContain('path.ts')` and
// `toContain(DISPATCH_MODULE)` did not: the same idea spelled three ways. Those
// were caught because they reported a CONTROLLED gate as UNCONTROLLED, which is
// loud. The symmetric error — an UNCONTROLLED gate reported as CONTROLLED — is
// silent, and `vacuity-false-negative-census.test.ts` is what puts a number on
// how often it happens.

/** Walks a tree, or resolves a file set from one. */
// FR-R3-121 follow-up (2026-08-27) — `matchingRelativePaths` added. Ten
// inline-IPC gates moved to it when their private `listMatchingFiles` copies
// were removed, and without this name they stopped matching here: the
// classifiable-gate count fell 89 -> 79 and ten gates silently left the vacuity
// census. The census caught it, which is the census working; the lesson is that
// a shared idiom is load-bearing for the meta-gates that read it, and changing
// one means updating them in the same commit.
export const SCANS =
  /filesMatching|matchingRelativePaths|filesUnder|linesMatching|readdirSync|collect\w*Files|walk\(/;

/** Asserts that a collected set of offenders is empty. */
export const ASSERTS_EMPTY = /\.toEqual\(\s*\[\s*\]\s*\)/;

/**
 * Shapes a vacuity control takes here. Deliberately broad — the question is
 * whether the author thought about it, not whether they picked a house form.
 *
 * `toContain(HELPER)` and `toContain('webview-ui/src/lib/reorder-task.ts')` are
 * the same control spelled two ways. An earlier version of this detector
 * recognised only the first and reported four gates as uncontrolled that were
 * not — a detector with a false negative is the same defect it exists to find,
 * one level up.
 *
 * An ALL_CAPS module constant passed to `toContain` is this suite's idiom for
 * "the scan must find this anchor": HELPER, ANCHOR, DISPATCH_MODULE. The
 * detector has now missed this spelling twice — first the path literal, then the
 * named constant — which is worth stating plainly: each miss reported a
 * controlled gate as uncontrolled, and each was caught by the staleness check
 * rather than by reading the files.
 */
export const PROVES_NON_EMPTY = new RegExp(
  [
    'toBeGreaterThan',
    'toBeGreaterThanOrEqual',
    'toContain\\(\\s*[A-Z][A-Z0-9_]{2,}',
    "toContain\\(\\s*['\"`][\\w./-]+\\.(ts|svelte|md|json)",
    'ANCHORS',
    'MIN_SITES',
    'MIN_\\w+',
    'vacuous',
    'toHaveLength\\(\\s*[1-9]',
    'expect\\.fail'
  ].join('|')
);

/** Does this source look like a gate that walks a tree and asserts emptiness? */
export function isScanningGate(source: string): boolean {
  return SCANS.test(source) && ASSERTS_EMPTY.test(source);
}

/** Does this source carry something the detector recognises as a vacuity control? */
export function looksControlled(source: string): boolean {
  return PROVES_NON_EMPTY.test(source);
}
