// The `display` map of an invalid catalog row, on its way to a webview — once.
//
// WHY THIS MODULE EXISTS. The Phase, Pipeline and Workflow projectors each held a
// `projectDisplay`; the Pipeline's and the Workflow's were byte-identical, comment
// included. All three carried scalars and dropped every list, so the authored lists
// `recognizedAuthoredDisplay` now keeps on `display` — a Phase's `capabilities`, a
// Pipeline's `phases` — stopped at this boundary and never reached the Builder. The
// host-side fix was inert until this one.
//
// WHAT THIS BOUNDARY IS FOR. `display` is built from RAW, UNVALIDATED input: it is
// what a row that failed validation shows the operator, so no parse stands between
// the file on disk and this map. Everything crossing to a webview is therefore
// sanitised and bounded here — per-field for text, and in length for a list, because
// a hand-edited record can hold as many entries as the operator's editor will save.
//
// The scalar predicate is imported rather than restated. Two copies of "what
// `display` can hold" — one deciding, one projecting — is how they come to disagree,
// and a projection that dropped what the validator kept would be this same bug again.

import { isDisplayScalar } from '../../config/authored-display';

export type Sanitize = (value: string) => string;

/**
 * The character bound for one authored field's text, by field name.
 *
 * Supplied per kind: the caps are facts about a Phase or a Pipeline and belong with
 * the projector that knows them, not with this walk.
 */
export type DisplayFieldMax = (field: string) => number;

/**
 * How many entries of one authored list cross to a webview.
 *
 * `capabilities` has six possible values and a Pipeline's phase list is realistically
 * dozens; the bound exists for the record nobody validated, where the list length is
 * whatever was typed. Scaled to `PORTS_PER_RECORD_MAX` next door.
 */
export const ENTRIES_PER_DISPLAY_LIST_MAX = 100;

/**
 * The cap for a `display` field with no cap of its own.
 *
 * The Pipeline and Workflow projectors both name one field (`description`) and bound
 * everything else by this; the Phase projector names five and needs no default of its
 * own.
 */
export const DISPLAY_TEXT_MAX = 512;

/**
 * The projected `display` map: sanitised, bounded, frozen.
 *
 * Scalars, and lists of scalars — the same shapes `recognizedAuthoredDisplay` admits.
 * A non-scalar that reaches here anyway is dropped rather than walked, which keeps
 * this a one-level pass over input that by definition did not parse.
 */
export function projectAuthoredDisplay(
  display: Readonly<Record<string, unknown>>,
  sanitize: Sanitize,
  maxFor: DisplayFieldMax
): Readonly<Record<string, unknown>> {
  const projected: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(display)) {
    if (typeof value === 'string') {
      projected[field] = sanitize(value).slice(0, maxFor(field));
      continue;
    }
    if (isDisplayScalar(value)) {
      projected[field] = value;
      continue;
    }
    if (!Array.isArray(value)) continue;
    const max = maxFor(field);
    projected[field] = Object.freeze(
      (value as readonly unknown[])
        .slice(0, ENTRIES_PER_DISPLAY_LIST_MAX)
        .filter(isDisplayScalar)
        .map((entry) => (typeof entry === 'string' ? sanitize(entry).slice(0, max) : entry))
    );
  }
  return Object.freeze(projected);
}
