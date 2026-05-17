/**
 * Feature 018 — Per-tab description map for WakeUpTab.
 *
 * Wake up pre-warms Claude's 5-hour rolling allocation window with a
 * tiny, sandboxed CLI invocation on a schedule. The runner spawns in a
 * temporary directory with no workspace files in scope — a defense-in-
 * depth boundary documented in `docs/security/threat-model.md` T17.
 *
 * FR-013 coverage:
 *   - Scheduler-type, chronological-time, and periodic-interval inputs
 *     are disabled when the master Enable Wake up toggle is off. The
 *     reason and how to re-enable is stated in each body.
 *   - Save is disabled while a save is in flight, or when the active
 *     field is invalid AND Wake up is enabled.
 */

import type { ControlDescription } from '../hover-text/hover-text-types';

export type WakeUpControlId =
  | 'tab-header'
  | 'enabled'
  | 'scheduler-type'
  | 'chronological-time'
  | 'periodic-interval'
  | 'now'
  | 'save'
  | 'model'
  | 'model-save'
  | 'session-log-reveal';

export const WAKEUP_DESCRIPTIONS = {
  'tab-header': {
    title: 'Wake up',
    body:
      "Pre-warm Claude's 5-hour rolling allocation window with a tiny CLI " +
      'invocation on a schedule. The wake-up runs detached from VS Code in ' +
      'a temporary directory — no workspace files are in scope.'
  },

  enabled: {
    title: 'Enable Wake up',
    body:
      'When on, an OS-native scheduled task is installed and fires according ' +
      'to the schedule below. When off, the scheduled task is uninstalled. ' +
      'Turning this off disables the schedule inputs below.'
  },

  'scheduler-type': {
    title: 'Scheduler type',
    body:
      'Chronological fires at a fixed daily wall-clock time. Periodic fires ' +
      "on a fixed interval (e.g. `Every 4h`). Disabled when Wake up is off — " +
      'turn on Enable Wake up to edit.'
  },

  'chronological-time': {
    title: 'Daily time (HH:MM, 24-hour)',
    body:
      "Wall-clock time interpreted in the machine's local time zone. Format " +
      '`HH:MM` 24-hour (e.g. `04:00`). Disabled when Wake up is off — turn ' +
      'on Enable Wake up to edit.'
  },

  'periodic-interval': {
    title: 'Periodic interval',
    body:
      'Format `Every Nm` or `Every Nh` (e.g. `Every 15m`, `Every 4h`); ' +
      "minimum is 1 minute. Intervals shorter than Claude's 5-hour rolling " +
      'window are allowed but may waste tokens. Disabled when Wake up is off.'
  },

  save: {
    title: 'Save Wake up settings',
    body:
      'Persist Wake up configuration; installing or uninstalling the OS-native ' +
      'scheduled task as a side effect. Disabled while saving or when the ' +
      'active schedule field is invalid (and Wake up is enabled).'
  },

  now: {
    title: 'Wake up now',
    body:
      'Run one isolated wake-up attempt immediately without changing the ' +
      'saved schedule or OS-native scheduled task.'
  },

  model: {
    title: 'Claude model',
    body:
      'Which Claude model the wake-up runner invokes. "Default (runner-chosen)" ' +
      'omits the --model flag and lets the CLI pick its own default. Picking a ' +
      'specific model passes it to the CLI on every fire (scheduled and manual).'
  },

  'model-save': {
    title: 'Save model selection',
    body:
      'Persist the wake-up model selection. The schedule fields are saved by ' +
      'their own Save button — this button only updates the model field.'
  },

  'session-log-reveal': {
    title: 'Reveal session log in OS file manager',
    body:
      "Opens the operator's OS file manager at the on-disk wake-up `session.log`. " +
      'The host owns the absolute path; the webview never supplies one. Disabled ' +
      'when the path has not been provisioned yet (host has not created the wake-up ' +
      'storage dir).'
  }
} as const satisfies { readonly [K in WakeUpControlId]: ControlDescription };
