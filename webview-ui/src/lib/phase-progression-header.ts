/**
 * The Phase Progression panel's header line, as one pure function of the two
 * facts it reads.
 *
 * Extracted from `PhaseProgression.svelte` (Feature 201, T022) because that
 * component measured exactly 500 lines against the inclusive flat 500 that
 * `tests/lint/svelte-component-loc-budget.test.ts` enforces — zero headroom,
 * so threading one new attribute through would have landed it at 501. FR-042
 * makes freeing a line a *precondition* of adding one, not a follow-up: the
 * ceiling must not be exceeded even transiently.
 *
 * The line freed is incidental; the seam is not. Composing a display string
 * from an optional Task id and an optional Pipeline name is a question about
 * text, and the component's remaining work is a question about tiles and
 * events. Nothing changed in the move — the two branches, the `'standard'`
 * exclusion and the em-dash separator are the originals, and
 * `__tests__/phase-progression-header.test.ts` now pins them directly rather
 * than through a rendered heading.
 */

/** The Pipeline fields the header reads, narrowed from `ActivePipelineSummary`. */
export interface HeaderPipeline {
  readonly id: string;
  readonly name: string;
}

/**
 * `Phase Progression`, optionally naming the in-flight Task and the Pipeline.
 *
 * The Pipeline suffix is suppressed for the id `'standard'`: that is the
 * default every Run gets when none was chosen, so naming it would tell the
 * operator about a choice nobody made. Any other Pipeline is named, including
 * one whose *display name* happens to be "Standard" — the exclusion is by id,
 * because the id is what says "no choice was made" and the name does not.
 */
export function phaseProgressionHeader(
  activeTaskId: string | null,
  activePipeline: HeaderPipeline | null
): string {
  const pipelineSuffix =
    activePipeline && activePipeline.id !== 'standard' ? ` — Pipeline: ${activePipeline.name}` : '';
  const base = activeTaskId ? `Phase Progression (Active: ${activeTaskId})` : 'Phase Progression';
  return `${base}${pipelineSuffix}`;
}
