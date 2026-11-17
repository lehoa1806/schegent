/**
 * Hover text for the Settings page header's controls, beside the component they describe as
 * Feature 018 asks (FR-012). The `satisfies` below turns a missing or extra entry into a type
 * error.
 *
 * FR-013: a control that can be disabled says why it is disabled and what enables it again.
 */

import type { ControlDescription } from '../hover-text/hover-text-types';

export type SettingsPageHeaderControlId = 'search' | 'revert' | 'save';

export const SETTINGS_PAGE_HEADER_DESCRIPTIONS = {
  // Longer than the inline limit on purpose: a short body would be drawn as a line under the
  // field, inside the header's row of actions.
  search: {
    title: 'Search settings',
    body:
      'Shows only the settings whose name, description or key holds every word you type, from ' +
      'every section. Clear the field or choose a section to see one section again.'
  },
  revert: {
    title: 'Revert',
    body:
      'Discard every unsaved change on this page and show the saved values again. ' +
      'Disabled when nothing has changed.'
  },
  save: {
    title: 'Save',
    body:
      'Write every unsaved change on this page. The settings fields are written together: if ' +
      'one value is refused, none of them is written. The queue cap and default queue are ' +
      'written together on their own, each queue failure policy on its own, and the failure ' +
      'signatures as their own list. Disabled when nothing has changed, while a save is in ' +
      'progress, and when the only changes cannot be saved yet, such as an empty failure ' +
      'signature.'
  }
} as const satisfies { readonly [K in SettingsPageHeaderControlId]: ControlDescription };
