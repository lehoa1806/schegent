/**
 * Hover text for the Settings page's Queues section, beside the component it describes as
 * Feature 018 asks (FR-012). The `satisfies` below turns a missing or extra entry into a type
 * error. Each queue's behaviour select shares the one `queue-failure-policy` entry.
 *
 * Every body is longer than the inline limit on purpose. The hover action writes a short body
 * into the row and joins it to the control's `aria-describedby`; a longer one opens as a popover
 * and joins only while it is open. The cap's description at rest must stay the shared-tree
 * disclosure alone (`tests/lint/concurrency-isolation-disclosure.test.ts`).
 *
 * FR-013: a control that can be disabled says why it is disabled. These are disabled only in a
 * window that is not the primary one (Feature 092, FR-065).
 */

import type { ControlDescription } from '../hover-text/hover-text-types';

export type QueueDefaultsControlId = 'queue-cap' | 'queue-default' | 'queue-failure-policy';

export const QUEUE_DEFAULTS_DESCRIPTIONS = {
  'queue-cap': {
    title: 'Runs at the same time',
    body:
      'How many Runs may go at once, counted across every queue in this workspace. The host ' +
      'checks the value when you save. A window that is not the primary one shows it without ' +
      'changing it.'
  },
  'queue-default': {
    title: 'Default queue',
    body:
      'The queue a new task joins when it is added without naming one. Saved together with ' +
      'Runs at the same time. A window that is not the primary one shows it without changing it.'
  },
  'queue-failure-policy': {
    title: 'When a task fails',
    body:
      'What this queue does after one of its tasks fails: stop, or go on to the next task. The ' +
      'workspace default is set in the VS Code Settings editor. A window that is not the ' +
      'primary one shows it without changing it.'
  }
} as const satisfies { readonly [K in QueueDefaultsControlId]: ControlDescription };
