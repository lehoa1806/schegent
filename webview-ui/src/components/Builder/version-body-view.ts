// Feature 101 (US4, T056, FR-012b) — the three states a version body can be in.
//
// Three, and there is no fourth. The fourth that keeps trying to exist is "the
// read failed, so show an empty body", and it is the one state this surface must
// never reach: an empty body renders identically to a definition with no
// content, so a failed read would look to the operator like a version they had
// successfully read and found blank. They cannot tell those apart, and they
// would act on the wrong one.
//
// Modelling it as a discriminated union rather than `{ body, error, loading }`
// makes that structural: there is no value of this type that carries both a
// failure and a body, so the fallback cannot be written by accident.

import type { ReadDefinitionVersionResult } from '../../lib/catalog-history-ipc';

export type VersionBodyView =
  /** The read is in flight. Explicit, so "nothing yet" never reads as "nothing there". */
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly body: Readonly<Record<string, unknown>> }
  | { readonly status: 'error'; readonly reason: string };

/**
 * What the operator reads instead of the wire token.
 *
 * The host's four rejections (`contracts/builder-projection.md` §B.4) plus the
 * two the helper produces on its own. A reason with no entry falls back to the
 * token in parentheses — a token is poor prose but it is still information, and
 * silently dropping it would leave an error state with nothing in it.
 */
const REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'catalog-unavailable': 'The catalog is not available in this workspace.',
  'unknown-version': 'This version is no longer in the catalog. Reload to refresh the list.',
  'record-missing': 'The catalog lists this version but its contents are missing.',
  'read-failed': 'This version could not be read.',
  timeout: 'The extension host did not answer. Nothing was read.',
  'internal-error': 'This version could not be read.'
});

/** The last resort, so an error state always has words in it. */
const UNEXPLAINED = 'This version could not be read.';

export function describeReason(reason: string): string {
  if (reason.length === 0) return UNEXPLAINED;
  return REASON_TEXT[reason] ?? `${UNEXPLAINED} (${reason})`;
}

/**
 * Project a completed read into what the panel shows.
 *
 * A failure never produces a `ready`, whatever it carries — that is the whole
 * job, and it is one line because the union above already made the alternative
 * unrepresentable.
 */
export function viewOfReadResult(result: ReadDefinitionVersionResult): VersionBodyView {
  if (result.outcome === 'success') {
    return { status: 'ready', body: result.body };
  }
  return { status: 'error', reason: result.reason };
}

/**
 * One definition body as text.
 *
 * The body is operator-authored JSON of no fixed shape, so it is shown as the
 * document it is rather than projected into fields this panel would have to
 * keep in step with three catalog schemas. `JSON.stringify` can throw on a
 * cyclic value; a body that crossed IPC cannot be cyclic, but a body that
 * cannot be rendered is a read that failed, not a body that is empty.
 */
export function formatVersionBody(body: Readonly<Record<string, unknown>>): string | null {
  try {
    return JSON.stringify(body, null, 2) ?? null;
  } catch {
    return null;
  }
}
