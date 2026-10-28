// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT.
// Configuration reads. No I/O, no collaborators constructed, no side effects,
// no timer armed. Sibling of `workspace-settings.ts` and its exact opposite in
// lifetime: that module resolves once at activation, this one resolves nothing.
//
// FR-R3-119 — the settings the controller must NEVER cache, gathered in one
// place. Each is a closure the controller calls at the moment it needs the
// answer, so a setting changed mid-session reaches the next phase, the next
// drain attempt, or the next run — without a window reload.
//
// They belong together because they share one reason rather than one subject:
// `AGENTS.md` carries a separate "never cache the X setting on long-lived
// runner state" rule for each of them, and four spellings of one rule inline in
// the composition root is four chances for the fifth to be written eagerly by
// someone who never met the other three. Reading them side by side is the point.

import * as vscode from 'vscode';

import type { QueueFailurePolicy } from '../contracts/queue-failure-policy';
import type { EffectiveLimit } from '../contracts/snapshot-projections';
import type { RawTranscriptMode } from '../state/workflow-run';
import { originOf } from './workspace-settings';

/** Every accessor re-reads the folder-scoped section; none of them holds it. */
function section(workspaceRoot: string): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('schegent', vscode.Uri.file(workspaceRoot));
}

/**
 * Read per phase invocation, never cached at activation, so flipping the
 * setting mid-run takes effect on the next phase.
 */
export function readForceContinueOnRetryCap(workspaceRoot: string): boolean {
  return readForceContinueOnRetryCapLimit(workspaceRoot).value;
}

/**
 * FR-R4-F02 (contract E2 G6) — the same read with the layer that supplied it. Execution calls the
 * function above, which is this one's `value`, and the per-Run disclosure calls this, so the value
 * the runner acts on and the value the operator is shown come from one read of the setting.
 */
export function readForceContinueOnRetryCapLimit(workspaceRoot: string): EffectiveLimit<boolean> {
  const config = section(workspaceRoot);
  return {
    value: config.get<boolean>('retry.forceContinueOnCap', false) === true,
    origin: originOf(config.inspect<boolean>('retry.forceContinueOnCap'))
  };
}

/**
 * FR-R4-F02 (contract E2 G6) — the spend bounds, each with its origin, read per evaluation and never
 * cached. The watcher acts on the values and the disclosure shows the pairs, from this one read.
 * Unscoped to a folder, exactly as the watcher has always read them: a bound is the workspace's.
 */
export function readSpendLimits(): {
  readonly limitUsd: EffectiveLimit<number | null>;
  readonly limitTokens: EffectiveLimit<number | null>;
} {
  const config = vscode.workspace.getConfiguration('schegent');
  return {
    limitUsd: {
      value: config.get<number | null>('spend.maxUsdPerRun', null),
      origin: originOf(config.inspect<number | null>('spend.maxUsdPerRun'))
    },
    limitTokens: {
      value: config.get<number | null>('spend.maxTokensPerRun', null),
      origin: originOf(config.inspect<number | null>('spend.maxTokensPerRun'))
    }
  };
}

/**
 * Feature 195 (T016, FR-001, FR-018) — the workspace default, read per drain
 * attempt on the same terms as `readForceContinueOnRetryCap` above: never
 * cached at activation, so a mid-session change reaches the next attempt to
 * start work on a queue without a reload.
 */
export function readQueueFailurePolicyDefault(workspaceRoot: string): QueueFailurePolicy {
  return section(workspaceRoot).get<QueueFailurePolicy>(
    'queue.haltOnTaskFailure',
    'halt-on-failure'
  );
}

/**
 * Feature 056 Track 4 (FR-023..FR-026) — the configured retry cap shares the
 * same window as `DELAYED_RETRY_CAP = 5`. Earlier versions advertised [1, 20]
 * but silently saturated; now the package contribution, host validator, and
 * accessor agree on [1, 5] so the operator-facing knob and the persistence
 * invariant are honest.
 */
export function readRetryCap(workspaceRoot: string): number {
  const value = section(workspaceRoot).get<number>('retry.maxAttempts', 5);
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5
    ? value
    : 5;
}

/**
 * Feature 098 (PRIV-02) — both the fallback and the invalid-value landing spot
 * mirror the manifest default, which moved `always` -> `errors-only`. A raw
 * transcript is unredacted prompt, source and model output; an unreadable
 * setting must not resolve to retaining one for every successful run.
 */
export function readRawTranscriptMode(workspaceRoot: string): RawTranscriptMode {
  const value = section(workspaceRoot).get<string>('logging.rawTranscriptMode', 'errors-only');
  return value === 'always' || value === 'off' ? value : 'errors-only';
}
