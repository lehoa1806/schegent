// FR-R3-163 (feature 202) — the derivation behind `sidebar-answer-handling.test.ts`.
//
// This lives outside any `.test.ts` so importing it does not re-register another
// file's suite, which is what lets the gate call it TWICE: once over
// `src/ui/sidebar/commands/` for the real assertion, and once over
// `tests/lint/fixtures/` for the negative control that proves each term still
// matches the shape it was written for (FR-017, plan.md DR-3). The precedent is
// `task-status-writer-derivation.ts`, which exists for the same reason.
//
// ALL FILE ACCESS GOES THROUGH `source-scan.ts` (FR-019, finding F39). Nothing
// here spawns a process, and this module does not import `node:child_process` or
// `node:fs` at all — `filesUnder` and `filesMatching` are the only readers.
// `lint-gates-are-hermetic.test.ts:41-60` forbids an external binary ABSOLUTELY
// rather than by allowlist, so there is no entry to add and nothing to declare.
import { dirname, relative, resolve } from 'node:path';

import { filesMatching, filesUnder } from './source-scan';

/**
 * Shape A — an absent host answer defaulted to a literal asserting success.
 *
 * NOTE ON ESCAPING. `data-model.md` §3 prints this term as `??\s*\{\s*ok\s*:\s*true`.
 * That is the shape in prose, not a usable regular expression: in JavaScript a
 * bare `?` is a quantifier, and `new RegExp('??...')` throws "Nothing to repeat".
 * The two literal question marks must be escaped. The difference is notation
 * only — measured against the uncorrected tree both forms are intended to name
 * the same three routes, and the escaped form is the one that runs.
 *
 * The term is anchored at the literal `true`, not at the `??` operator. A bare
 * nullish-coalescing scan would flag `?? { ok: false, reason: … }`, which is a
 * *pessimistic* default and therefore correct code (rule 67, docs/hard-rules.md:860-862).
 */
export const ABSENT_ANSWER_AS_SUCCESS = String.raw`\?\?\s*\{\s*ok\s*:\s*true`;

/**
 * Shape B — the host's answer asserted into shape at a boundary it does not control.
 *
 * Anchored at `ok\s*:\s*boolean`, not at `as {`. Measured on the uncorrected
 * tree, a bare `as\s*\{` term matches FIVE files: the three defective routes
 * plus `cmd-clear-queue.ts:66` and `cmd-set-queue-failure-policy.ts:25`, both of
 * which assert the shape of the *inbound command payload* rather than of the
 * host's answer. Those two are legitimate and out of this gate's subject
 * (FR-018). The anchor is what excludes them.
 */
export const UNCHECKED_ANSWER_CAST = String.raw`as\s*\{[^}]*\bok\s*:\s*boolean`;

/** True when `text` contains shape A. Exported for the gate's inline controls. */
export function matchesAbsentAsSuccess(text: string): boolean {
  return new RegExp(ABSENT_ANSWER_AS_SUCCESS).test(text);
}

/** True when `text` contains shape B. Exported for the gate's inline controls. */
export function matchesUncheckedCast(text: string): boolean {
  return new RegExp(UNCHECKED_ANSWER_CAST).test(text);
}

/** One route file, and which of the two forbidden shapes it exhibits. */
export interface RouteReading {
  /** Path relative to the scanned root, so a failure names a file a reader can open. */
  readonly file: string;
  readonly absentAsSuccess: boolean;
  readonly uncheckedCast: boolean;
}

/**
 * Every `.ts` file directly under `root`, with both shapes read off each.
 *
 * NON-RECURSIVE by design. `src/ui/sidebar/commands/` is flat today, so recursion
 * would be a no-op there; the scoping matters for the fixture root, where a
 * future subdirectory should not silently enlarge the control's population.
 *
 * A `root` that does not exist yields `[]` — `filesUnder` returns empty for a
 * missing directory by design, and the caller asserts on the population. That is
 * exactly what `MIN_ROUTES` in the gate is for: without it, a mistyped root would
 * make every "no violations" assertion pass vacuously.
 */
export function readRoutes(root: string): readonly RouteReading[] {
  const absoluteRoot = resolve(root);
  const directChild = (file: string): boolean => dirname(file) === absoluteRoot;

  const files = filesUnder(absoluteRoot, { extensions: ['.ts'] }).filter(directChild);
  const absent = new Set(filesMatching(absoluteRoot, ABSENT_ANSWER_AS_SUCCESS).filter(directChild));
  const cast = new Set(filesMatching(absoluteRoot, UNCHECKED_ANSWER_CAST).filter(directChild));

  return files.map((file) => ({
    file: relative(absoluteRoot, file),
    absentAsSuccess: absent.has(file),
    uncheckedCast: cast.has(file)
  }));
}
