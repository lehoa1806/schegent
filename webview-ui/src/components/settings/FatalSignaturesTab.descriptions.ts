/**
 * Feature 018 — Per-tab description map for FatalSignaturesTab.
 *
 * Two-section design (per spec acceptance scenario 3 of US1), in the
 * redesign's words and order:
 *   1. Your additions — entries persisted in `schegent.fatalSignatures`
 *      (workspace). They extend the built-in list; they NEVER remove,
 *      modify, or re-order a built-in entry.
 *   2. Built in — read-only, mirrors the code-resident floor from
 *      `src/lib/fatal-signature-registry.ts`. Entries can only be
 *      changed via PR review.
 *
 * WHERE EACH BODY IS READ. `tab-header` is the section's one visible line
 * (FR-016). The redesign draws no line under a heading, so the two
 * section-header bodies are their sections' accessible descriptions, out
 * of sight, and `operator-input` carries the three facts scenario 3 asks
 * the list to state: additions add to the built-in list, a built-in entry
 * cannot be removed, and the audit log tells the two apart.
 *
 * The HoverText primitive uses each control's `controlId` only for DOM
 * id generation. Dynamic per-row hover text (operator-input-<i>,
 * operator-remove-<i>) re-uses the template descriptions below with
 * different controlIds — that is why this map only enumerates the
 * static template keys. A body of 80 characters or fewer is drawn as a
 * line beside its control, so each of the three stays longer than that.
 *
 * FR-013 coverage:
 *   - The list has no Save or Reset of its own. The page header's Save
 *     and Revert write and discard it with every other change, and their
 *     descriptions (`SettingsPageHeader.descriptions.ts`) state when each
 *     is disabled, an empty row included.
 */

import type { ControlDescription } from '../hover-text/hover-text-types';

export type FatalSignaturesControlId =
  | 'tab-header'
  | 'operator-section-header'
  | 'built-in-section-header'
  | 'operator-add'
  | 'operator-input'
  | 'operator-remove';

export const FATAL_SIGNATURES_DESCRIPTIONS = {
  'tab-header': {
    title: 'Failure signatures',
    body: 'Text that marks a failure as fatal, so Schegent stops retrying.'
  },

  'operator-section-header': {
    title: 'Your additions',
    body:
      'Text this workspace adds to the built-in list. An addition is checked ' +
      'after the built-in entries and cannot remove, change or reorder them.'
  },

  'built-in-section-header': {
    title: 'Built in',
    body:
      'Entries that ship with Schegent. They are read-only: this page cannot ' +
      'change or remove them.'
  },

  'operator-add': {
    title: 'Add text',
    body:
      'Adds an empty row to your additions. Type the text to match, then ' +
      'choose Save at the top of the page to keep it.'
  },

  'operator-input': {
    title: 'Text to match',
    body:
      'Matched exactly, case included, anywhere in a line of the backend ' +
      'output. Your additions add to the built-in list, and a built-in entry ' +
      'cannot be removed or changed here. A row that repeats a built-in entry ' +
      'is flagged and counts as built in. The audit log records which list a ' +
      'match came from. An empty row cannot be saved.'
  },

  'operator-remove': {
    title: 'Remove text',
    body:
      'Removes this row from your additions. Nothing is written until you ' +
      'choose Save at the top of the page. Warning: once saved, this ' +
      'workspace no longer treats the text as fatal. Built-in entries are ' +
      'not affected.'
  }
} as const satisfies { readonly [K in FatalSignaturesControlId]: ControlDescription };
