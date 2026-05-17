/**
 * Feature 018 — Per-tab description map for FatalSignaturesTab.
 *
 * Two-section design (per spec acceptance scenario 3 of US1):
 *   1. Built-in section — read-only, mirrors the code-resident floor
 *      from `src/lib/fatal-signature-registry.ts`. Entries can only be
 *      changed via PR review.
 *   2. Operator section — additive entries persisted in
 *      `schegent.fatalSignatures` (workspace). Operator entries extend
 *      the built-in registry; they NEVER remove, modify, or re-order
 *      built-ins.
 *
 * The HoverText primitive uses each control's `controlId` only for DOM
 * id generation. Dynamic per-row hover text (operator-input-<i>,
 * operator-remove-<i>) re-uses the template descriptions below with
 * different controlIds — that is why this map only enumerates the
 * static template keys.
 *
 * FR-013 coverage:
 *   - Save and Reset disable when there are no unsaved changes (Reset)
 *     or when an unsaved row is empty (Save) — both reasons are in the
 *     body text below.
 */

import type { ControlDescription } from '../hover-text/hover-text-types';

export type FatalSignaturesControlId =
  | 'tab-header'
  | 'built-in-section-header'
  | 'operator-section-header'
  | 'operator-add'
  | 'operator-save'
  | 'operator-reset'
  | 'operator-input'
  | 'operator-remove';

export const FATAL_SIGNATURES_DESCRIPTIONS = {
  'tab-header': {
    title: 'Fatal Signatures',
    body:
      'Verbatim substrings that, when matched in CLI stdout or stderr, ' +
      'terminate the active phase immediately (skipping the delayed-retry ' +
      'loop). The built-in floor is code-resident; operator entries are ' +
      'additive workspace overrides.'
  },

  'built-in-section-header': {
    title: 'Built-in registry',
    body:
      'Read-only entries baked into the extension binary at ' +
      '`src/lib/fatal-signature-registry.ts`. To add or remove a built-in, ' +
      'open a PR — they cannot be edited from this UI.'
  },

  'operator-section-header': {
    title: 'Operator additions',
    body:
      'Workspace-scoped entries that extend the built-in registry on every ' +
      'CLI invocation. Operator entries are additive only — they cannot ' +
      'remove, modify, or re-order built-ins.'
  },

  'operator-add': {
    title: 'Add signature',
    body:
      'Append a new empty operator row to the list. Type a verbatim ' +
      'substring then click Save to persist.'
  },

  'operator-save': {
    title: 'Save operator signatures',
    body:
      'Persist the operator additions to `schegent.fatalSignatures`. ' +
      'Disabled when there are no unsaved changes OR when at least one row ' +
      'is empty — fill or remove blank rows first.'
  },

  'operator-reset': {
    title: 'Reset operator signatures',
    body:
      'Discard every unsaved edit and restore the projected operator list. ' +
      'Disabled when there are no unsaved changes.'
  },

  'operator-input': {
    title: 'Operator signature',
    body:
      'Type a verbatim substring (case-sensitive). Whitespace-only rows are ' +
      'rejected. Duplicates with built-in entries are flagged inline; the ' +
      'host de-dupes them and keeps the built-in attribution.'
  },

  'operator-remove': {
    title: 'Remove signature',
    body:
      'Remove this operator row from the local draft. The removal is not ' +
      'persisted until you click Save. Warning: removing a row deletes the ' +
      'workspace addition; built-ins remain unaffected.'
  }
} as const satisfies { readonly [K in FatalSignaturesControlId]: ControlDescription };
