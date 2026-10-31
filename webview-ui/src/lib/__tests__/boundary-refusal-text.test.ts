// FR-R4-F05 (T11; contract O, O1; data-model §5; FR-014) — the one text a refused
// command shows when a surface's own map has no sentence for the reason.
//
// WHY A SHARED, BOUNDED FALLBACK. The refusal reason on a rejected acknowledgement is a
// code from the host, and for years each webview surface rendered it however it liked:
// `The host refused: ${reason}` in two families, the bare code in a dozen components, and
// `untrusted-workspace` (the router's own gate token) in none of the maps, so a refused
// action in an untrusted workspace read as a raw code. This module is the table and the
// fallback: a known code gets its sentence, a code-shaped unknown is named inside a fixed
// sentence, and anything else, which could be host free text that carries a path, is not
// shown at all.

import { describe, expect, it } from 'vitest';

import {
  OUTCOME_NOT_YET_KNOWN_TEXT,
  boundaryRefusalText,
  isOutcomeNotYetKnown
} from '../boundary-refusal-text';

const TABLE: ReadonlyArray<readonly [string, string]> = [
  [
    'command-dispatch-failed',
    'The action could not be carried out. Check the Schegent log and try again.'
  ],
  [
    'command-result-unrecognized',
    'The host answered in a way this view could not read, and nothing was changed.'
  ],
  ['untrusted-workspace', 'The workspace is not trusted, so this action is unavailable.'],
  ['workspace-not-trusted', 'The workspace is not trusted, so this action is unavailable.'],
  [
    'secondary-window-readonly',
    'This window is not the primary one, so it cannot make this change.'
  ],
  ['unexpected-error', 'The task could not be restarted. Check the Schegent log.'],
  [
    'queue-state-unavailable',
    'The queue could not be read or saved. Nothing may have changed; check the queue before trying again.'
  ]
];

describe('boundaryRefusalText (T11)', () => {
  it.each(TABLE)('renders %s as its table sentence, verbatim', (code, text) => {
    expect(boundaryRefusalText(code)).toBe(text);
  });

  // FR-R4-F05 code review (I5) — the helpers report the ledger's `unknown` as `timeout`. A
  // surface that falls back here showed "The host refused this action (`timeout`)".
  it('words the helpers\' timeout as not yet known, never as a refusal', () => {
    expect(boundaryRefusalText('timeout')).toBe(OUTCOME_NOT_YET_KNOWN_TEXT);
    expect(isOutcomeNotYetKnown('timeout')).toBe(true);
    expect(isOutcomeNotYetKnown('stale-catalog')).toBe(false);
    expect(isOutcomeNotYetKnown(undefined)).toBe(false);
  });

  it('words the unknown outcome as not yet known', () => {
    expect(OUTCOME_NOT_YET_KNOWN_TEXT).toBe(
      'The host has not answered yet, so the outcome is not yet known.'
    );
  });

  it('names a code-shaped unknown reason inside a fixed sentence', () => {
    expect(boundaryRefusalText('some-new-host-refusal')).toBe(
      'The host refused this action (`some-new-host-refusal`).'
    );
    expect(boundaryRefusalText('0-leading-digit')).toBe(
      'The host refused this action (`0-leading-digit`).'
    );
  });

  it('accepts a code of exactly 64 characters', () => {
    const code = 'a'.repeat(64);

    expect(boundaryRefusalText(code)).toBe(`The host refused this action (\`${code}\`).`);
  });

  it.each([
    ['a space', 'write failed'],
    ['a slash', 'write-failed/synthetic'],
    ['an uppercase letter', 'Write-failed'],
    ['65 characters', 'a'.repeat(65)],
    ['a leading hyphen', '-leading-hyphen'],
    ['a path', '/synthetic/home/user-252/secret.txt'],
    ['an empty string', '']
  ])('shows the bare sentence, with no part of the reason, for %s', (_label, reason) => {
    const text = boundaryRefusalText(reason);

    expect(text).toBe('The host refused this action.');
    if (reason.length > 0) expect(text).not.toContain(reason);
  });
});
