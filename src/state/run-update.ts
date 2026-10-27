// FR-R4-F01 (spec 239, US2, contract C2) — the vocabulary of a Run field update.
//
// `WorkspaceStateStore.updateRun` applies a patch to the Run a queue holds NOW, inside the
// `KEYS.run` chain. This module holds the part of that contract that is only a shape: the
// closed set of writers that may name themselves, and the update they pass. It sits beside
// the store rather than in it so the store file carries the mechanism and not the lexicon,
// and it is re-exported from there, so `import { RunUpdate } from './workspace-state'` is
// unchanged.

import type { RunPatch, WorkflowRun, WorkflowRunStatus } from './workflow-run';

/**
 * FR-R4-F01 (contract C2) — the closed set of writers `updateRun` accepts a label
 * from. The label names the writer in a refusal message and in the census
 * (`tests/lint/run-write-census.test.ts`), which pins this list: a new writer is
 * a reviewed edit in both places.
 */
export const RUN_UPDATE_LABELS = [
  'pause',
  'resume',
  'restart',
  'skip',
  'disable',
  'enable',
  'set-breakpoint',
  'clear-breakpoint',
  'remove-phase',
  'cancel',
  'liveness',
  'retry-decision',
  'spawn-identity',
  'manual-retry-override',
  'driver-transition',
  // Added by the census (R3a): sites that read a nonterminal Run outside the chain
  // and wrote back a subset of its fields.
  'queue-pause',
  'queue-resume',
  'resume-prompt',
  'resume-admission',
  'spend-pause'
] as const;

export type RunUpdateLabel = (typeof RUN_UPDATE_LABELS)[number];

/**
 * FR-R4-F01 (data-model §2) — a field update for one queue's Run.
 *
 * `patch` receives the Run as it is INSIDE the chain and returns only the fields
 * its writer owns. A writer that needs a precondition on the Run (the retry
 * countdown, the current status) reads `current`, never its own earlier read. A
 * field set to `undefined` in the patch is removed from the Run.
 */
export interface RunUpdate {
  /** The Run the caller observed. Refused `stale-run-id` when the queue holds another. */
  readonly runId: string;
  /** Refused `run-status-precondition` when the current status is outside this set. */
  readonly allowedStatuses: readonly WorkflowRunStatus[];
  readonly patch: (current: WorkflowRun) => RunPatch;
  readonly label: RunUpdateLabel;
}
