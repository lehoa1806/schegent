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

import { resolveRunLimit, type RunLimitKey } from '../config/tighten-only-limits';
import type { QueueFailurePolicy } from '../contracts/queue-failure-policy';
import type { EffectiveLimit } from '../contracts/snapshot-projections';
import { normalizeMaxUnchangedComparisons } from '../contracts/unchanged-comparison-bound';
import type { TelemetryUserSettingsInput } from '../services/telemetry-host/telemetry-host-service';
import type { RawTranscriptMode } from '../state/workflow-run';

/** Every accessor re-reads the folder-scoped section; none of them holds it. */
function section(workspaceRoot: string): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('schegent', vscode.Uri.file(workspaceRoot));
}

/**
 * Review gap GC-10 — a spend, retry or loop limit as the operator set it, tightened and never
 * loosened by the repository's layers (`config/tighten-only-limits.ts`).
 */
function runLimit<K extends RunLimitKey>(
  config: vscode.WorkspaceConfiguration,
  key: K
): Pick<ReturnType<typeof resolveRunLimit<K>>, 'value' | 'origin'> {
  const { value, origin } = resolveRunLimit(key, config.inspect(key));
  return { value, origin };
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
  const { value, origin } = runLimit(section(workspaceRoot), 'retry.forceContinueOnCap');
  return { value: value === true, origin };
}

/**
 * FR-R4-F17 (contract S5) — the unchanged-comparison bound, read on every call and never cached, so
 * lowering or raising it mid-loop reaches the next retry decision. An invalid value reads as 0, which
 * leaves the bound off (FR-002). Execution calls the function below, which is this one's `value`, and
 * the per-Run limits view calls this, so both read the setting the same way.
 */
export function readMaxUnchangedComparisonsLimit(workspaceRoot: string): EffectiveLimit<number> {
  const { value, origin } = runLimit(section(workspaceRoot), 'loop.maxUnchangedComparisons');
  return { value: normalizeMaxUnchangedComparisons(value), origin };
}

/** The bound alone, for the controller's per-decision reader (S5.2). */
export function readMaxUnchangedComparisons(workspaceRoot: string): number {
  return readMaxUnchangedComparisonsLimit(workspaceRoot).value;
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
    limitUsd: runLimit(config, 'spend.maxUsdPerRun'),
    limitTokens: runLimit(config, 'spend.maxTokensPerRun')
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
  const { value } = runLimit(section(workspaceRoot), 'retry.maxAttempts');
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

/**
 * FR-R4-F04 (FR-001, contract X1) — the transport capture setting, as the user set it, read on every
 * record and never cached, so a switch to `off` or `errors-only` mid-Run reaches the very next line
 * without a window reload (hard rule 24's shape, for a sibling setting).
 *
 * The value is returned RAW. Resolving it is `resolveTransportCaptureMode`'s job and nobody else's: an
 * unknown value reads as `inherit` there, which is the one table `inherit` follows the raw transcript
 * mode through, and a second normalization here would be a second copy of that decision.
 */
export function readTransportCaptureMode(workspaceRoot: string): unknown {
  return section(workspaceRoot).get<unknown>('logging.transportCaptureMode', 'inherit');
}

/**
 * FR-R4-F04 (FR-005) — the session retention age in days, read on every transport check and never
 * cached: record age is bounded by it, and an operator who shortens it means the next append, not the
 * next reload. A value that is not a positive number reads as the manifest default.
 */
export function readSessionRetentionMaxAgeDays(workspaceRoot: string): number {
  const value = section(workspaceRoot).get<number>('logging.sessionRetentionMaxAgeDays', 30);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 30;
}

/**
 * FR-R6-F10 — opt-in isolated per-Run Git worktree execution, read per admission so toggling
 * `schegent.lanes.enabled` takes effect on the next admitted Run without relocating active Runs.
 */
export function readLanesEnabled(workspaceRoot: string): boolean {
  return section(workspaceRoot).get<boolean>('lanes.enabled', false) === true;
}

/** FR-R6-F10 — live isolated lane cap (1..20, default 1). */
export function readLanesLiveCap(workspaceRoot: string): number {
  const value = section(workspaceRoot).get<number>('lanes.liveCap', 1);
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 20 ? value : 1;
}

/** FR-R6-F10 — isolated lane provisioning deadline in milliseconds (1..600s, default 120s). */
export function readLanesProvisioningDeadlineMs(workspaceRoot: string): number {
  const value = section(workspaceRoot).get<number>('lanes.provisioningDeadlineSeconds', 120);
  const secs =
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 600 ? value : 120;
  return secs * 1_000;
}

/**
 * FR-R6-F14 (F14-FR-01, F14-FR-02, F14-FR-09) — reads user/application-scoped OTLP export settings
 * strictly from `inspect()?.globalValue` (falling back to manifest defaults), never from workspace
 * or folder scopes so repository settings cannot enable or redirect telemetry export.
 */
export function readTelemetryExportUserSettings(): TelemetryUserSettingsInput {
  const config = vscode.workspace.getConfiguration('schegent');
  const readGlobal = <T>(key: string, fallback: T): T => {
    const inspected = config.inspect<T>(key);
    return inspected?.globalValue !== undefined ? inspected.globalValue : fallback;
  };
  return {
    enabled: readGlobal<boolean>('telemetry.export.enabled', false) === true,
    endpoint: String(readGlobal<string>('telemetry.export.endpoint', '')),
    protocol: String(readGlobal<string>('telemetry.export.protocol', 'otlp-http-json')),
    allowPlaintextLoopback:
      readGlobal<boolean>('telemetry.export.allowPlaintextLoopback', false) === true,
    credentialSecretKey: String(readGlobal<string>('telemetry.export.credentialSecretKey', '')),
    credentialHeaderName: String(
      readGlobal<string>('telemetry.export.credentialHeaderName', 'Authorization')
    ),
    contentPolicy: String(readGlobal<string>('telemetry.export.contentPolicy', 'metadata-only'))
  };
}
