// Feature 098 (T055, US4) — what the product says when it has nothing to run.
//
// FR-030a makes the wording a contract between surfaces, not a per-component
// string: "the identical message text, drawn from one shared source rather than
// restated per surface, so the two surfaces cannot drift apart". That is what
// this module is. It lives under `src/contracts/` because that is the only tree
// all four consumers already import from — the host projector, the two webview
// components, and the headless scheduled-start path — and because a contract is
// exactly what a message two independently-rendered surfaces must agree on.
//
// It imports nothing. A webview component value-importing a host module pulls
// that module's whole graph into the bundle, so this one is a leaf on purpose:
// `snapshot.ts` and `phase-projector.ts` reach `vscode`-adjacent code within a
// hop or two, and neither can be the shared source for that reason.
//
// The guidance carries no path the operator has to resolve themselves and no
// absolute location — `examples/` is the directory as it ships inside the
// extension, named so the operator knows what to look for rather than told where
// on their disk to look.

/**
 * The shipped example documents' directory, as an operator would name it.
 *
 * Interpolated into the guidance rather than written into it twice, so the one
 * place this feature makes authoritative — `repo/examples/` — is also the one
 * place a rename has to reach.
 */
export const EXAMPLES_DIRECTORY = 'examples/';

export interface EmptyCatalogGuidance {
  /** The state, in a few words. */
  readonly headline: string;
  /** The remedy: what to do, and where the starting material is (FR-030). */
  readonly body: string;
}

/**
 * The message every empty-catalog surface shows (FR-030, FR-030a).
 *
 * Frozen because it is shared by reference across surfaces that render at
 * different times; a consumer that mutated it would silently change what a
 * surface rendered earlier in the same session.
 */
export const EMPTY_CATALOG_GUIDANCE: EmptyCatalogGuidance = Object.freeze({
  headline: 'No process definitions yet',
  body:
    'Import a process document to get started. The extension ships examples in ' +
    `${EXAMPLES_DIRECTORY} — import one of those, or a YAML document of your own.`
});

/**
 * Feature 102 (T044, US5, FR-030) — the *other* reason a section lists nothing.
 *
 * A workspace can hold a dozen definitions and offer none of them, because Runs
 * offers Active versions and nothing else (FR-003). That produces the identical
 * empty list as an empty catalog and is not the identical situation: the message
 * above sends the operator to import, and importing is exactly the thing that
 * will not help. They can import all afternoon and Runs will still be empty.
 *
 * So this arm names the one action that does help, by the label the Builder puts
 * on the control — "Publish", not a synonym — and names where that control is.
 * FR-004 keeps Runs from offering the action itself, which makes this the one
 * place on the surface where the word appears at all.
 *
 * Kind-agnostic on purpose. The section heading beside it already says whether
 * this is Pipelines or Workflows, and a per-kind pair of strings would be four
 * messages to keep in step where two will do.
 */
export const NONE_ACTIVE_GUIDANCE: EmptyCatalogGuidance = Object.freeze({
  headline: 'Nothing published yet',
  body:
    'Runs offers published definitions only. Open Builder, pick a definition, ' +
    'and choose Publish to make its current version available here.'
});

/**
 * The one rule deciding whether the guidance shows: it shows when there is
 * nothing, and not otherwise (FR-030, FR-032).
 *
 * A function rather than each surface writing `length === 0` itself, because
 * FR-032 is a claim about *both* surfaces and a rule stated twice is a rule that
 * can be changed once. `count` is whatever that surface has nothing of — Phase
 * tiles for the tracker, Pipelines for the launch surface.
 */
export function emptyCatalogGuidance(count: number): EmptyCatalogGuidance | null {
  return count === 0 ? EMPTY_CATALOG_GUIDANCE : null;
}

/**
 * What the host calls the refusal (FR-031, FR-031a).
 *
 * FR-031a requires the scheduled-start path to carry "the same named reason" a
 * manual launch does. Two modules writing the same literal would satisfy that
 * on the day it was written and not after, so the name is declared once here
 * and both the launch gate and the scheduled-start gate read it from this
 * module.
 */
export const CATALOG_EMPTY_REASON = 'catalog-empty';
export type CatalogEmptyReason = typeof CATALOG_EMPTY_REASON;

/**
 * The host's refusal when a launch is attempted against an empty catalog
 * (FR-031, FR-031a).
 *
 * Built from the same body as the guidance so the remedy is worded once: an
 * operator who reads the sidebar and an operator who trips the refusal are told
 * to do the same thing in the same words. What differs is only the first
 * sentence, which names what was refused — guidance explains a state, a refusal
 * explains an outcome.
 */
export const EMPTY_CATALOG_REFUSAL = `Nothing to run: the process catalog is empty. ${EMPTY_CATALOG_GUIDANCE.body}`;
