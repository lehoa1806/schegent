// Feature 087 (T030) — prior-output references.
//
// A reference is `{ sourceRunId, outputName }` and is compared field-wise
// against what the source Run recorded (FR-028a). It has no string form, so
// there is no grammar to define and no parser to write — the same answer the
// project gave for Workflow conditions, for the same reason: a string form
// turns operator-authored content into something the host has to interpret.
//
// A consequence worth naming: a Run identifier or output name may contain any
// character at all, including the separators a string form would have needed to
// reserve. Nothing here splits, trims, or case-folds.
//
// Resolution happens at validation time (FR-027) and its result is frozen
// (FR-028), so a later change to the source Run cannot retarget a Run already
// created against it.

import type { PriorOutputReference } from '../../contracts/run-request';
import type { RunOutputRecord } from '../../contracts/run-results';

/** Reads the outputs a completed Run recorded. `null` when there is no such Run. */
export interface PriorRunOutputSource {
  outputsFor(runId: string): readonly RunOutputRecord[] | null;
}

export type PriorOutputResolution =
  | { readonly ok: true; readonly reference: string }
  | { readonly ok: false; readonly code: 'prior-run-not-found' | 'prior-output-not-found' };

export function resolvePriorOutput(
  source: PriorRunOutputSource,
  reference: PriorOutputReference
): PriorOutputResolution {
  const outputs = source.outputsFor(reference.sourceRunId);
  if (outputs === null) return { ok: false, code: 'prior-run-not-found' };

  const match = outputs.find((output) => output.name === reference.outputName);
  // An output recorded as `unresolved` has a name and no location. There is
  // nothing to feed forward, so it refuses like a name that was never there —
  // freezing an absent location would defer the failure to run time.
  if (match === undefined || match.status !== 'resolved' || match.reference === undefined) {
    return { ok: false, code: 'prior-output-not-found' };
  }

  return { ok: true, reference: match.reference };
}
