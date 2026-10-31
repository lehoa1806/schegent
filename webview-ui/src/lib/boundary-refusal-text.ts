// FR-R4-F05 (FR-014; contract O, O1; data-model §5) — the one text a refused command
// shows when a surface's own map has no sentence for the reason.
//
// WHY ONE MODULE. A rejected acknowledgement carries a `reason`, a code from the host,
// and the webview's surfaces each rendered it their own way: `The host refused: ${reason}`
// in the two family maps, the bare code in a dozen components, and `untrusted-workspace`,
// the router's own gate token, in none of the maps, so a refused action in an untrusted
// workspace read as a raw code. Worse, the old router catch-all put an exception's text in
// that field, and every one of those surfaces would have displayed it.
//
// So there is one table of sentences and one bounded fallback, and every surface asks its
// own map first and this module for anything its map lacks. A known code gets its sentence;
// a code-shaped unknown is named inside a fixed sentence; anything else, which could be
// free text carrying a path, is not shown at all.
//
// This module imports nothing from the host, and posts nothing.

/** The outcome text for a command whose acknowledgement has not arrived (data-model §5). */
export const OUTCOME_NOT_YET_KNOWN_TEXT =
  'The host has not answered yet, so the outcome is not yet known.';

const WORKSPACE_NOT_TRUSTED = 'The workspace is not trusted, so this action is unavailable.';

const BOUNDARY_TEXT: ReadonlyMap<string, string> = new Map([
  [
    'command-dispatch-failed',
    'The action could not be carried out. Check the Schegent log and try again.'
  ],
  [
    'command-result-unrecognized',
    'The host answered in a way this view could not read, and nothing was changed.'
  ],
  ['untrusted-workspace', WORKSPACE_NOT_TRUSTED],
  ['workspace-not-trusted', WORKSPACE_NOT_TRUSTED],
  [
    'secondary-window-readonly',
    'This window is not the primary one, so it cannot make this change.'
  ],
  ['unexpected-error', 'The task could not be restarted. Check the Schegent log.'],
  [
    'queue-state-unavailable',
    'The queue could not be read or saved. Nothing may have changed; check the queue before trying again.'
  ],
  // The ledger's `unknown`, as the adopting helpers report it. Not a refusal: the host may
  // still run the command, so a surface without its own sentence says the outcome is not yet
  // known rather than "The host refused this action (`timeout`)".
  ['timeout', OUTCOME_NOT_YET_KNOWN_TEXT]
]);

/** True when `reason` is a wait that ran out, not an answer from the host. */
export function isOutcomeNotYetKnown(reason: string | undefined): boolean {
  return reason === 'timeout';
}

/** What a reason has to look like to be named in the fallback sentence. */
const CODE_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The sentence for a refusal reason. A code in the table gets its sentence; a code-shaped
 * unknown is named inside a fixed sentence; anything else renders the bare sentence with no
 * part of the reason in it. Total: it never throws and never returns the reason as free text.
 */
export function boundaryRefusalText(reason: string): string {
  const known = BOUNDARY_TEXT.get(reason);
  if (known !== undefined) return known;
  if (CODE_SHAPE.test(reason)) return `The host refused this action (\`${reason}\`).`;
  return 'The host refused this action.';
}

/**
 * A family's own sentence for `reason` when its table holds one, otherwise the boundary
 * text. The lookup is an own-property check, so a reason named like an `Object.prototype`
 * member (`constructor`) cannot return a function from the table.
 */
export function refusalTextFrom(table: Readonly<Record<string, string>>, reason: string): string {
  return Object.hasOwn(table, reason) ? table[reason] : boundaryRefusalText(reason);
}
