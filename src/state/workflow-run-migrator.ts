/**
 * Forward migrator for the `WorkflowRun` schema.
 *
 * Extracted from `WorkspaceStateStore.initialize()` so it can be unit-tested
 * without a VS Code Memento. Down-migration is intentionally not supported
 * (forward-only is the project convention).
 *
 * Version history:
 *   v1 → v2 (feature 011): adds three fields with safe defaults.
 *     - `delayedRetryCount: number` (default 0)
 *     - `pendingRetryAt: number | null` (default null)
 *     - `pendingRetryCause: 'transient_error' | 'rate_limit' | null` (default null)
 *     Invariant: `pendingRetryAt` and `pendingRetryCause` are either both
 *     null or both non-null. A partial pairing is zeroed.
 *
 *   v2 → v3 (feature 017): adds three further fields with safe defaults.
 *     - `phaseOverrides: PhaseOverride[]` (default [])
 *     - `manualPauseAt: number | null` (default null)
 *     - `manualPauseCause: ManualPauseCause | null` (default null)
 *     Invariant: `manualPauseAt` and `manualPauseCause` are either both
 *     null or both non-null. A partial pairing is zeroed.
 *
 *   v3 → v4 (feature 022): extends `phaseOverrides.action` with
 *     `'removed'` and carries optional `priorPhaseState` metadata. Existing
 *     v3 records are already valid and require only sanitization.
 *
 *   v4 → v5 (feature 028): adds two further fields with safe defaults and
 *     extends `manualPauseCause` with `'breakpoint-paused'`.
 *     - `phaseBreakpoints: PhaseBreakpoint[]` (default [])
 *     - `resumeTargetPhaseId: string | null` (default null)
 *     Invariant: `resumeTargetPhaseId !== null` iff
 *     `manualPauseCause === 'breakpoint-paused'`. A mismatched pairing
 *     zeroes the resume-target (the manual-pause pair remains intact via
 *     the existing `manualPausePairInvariant`).
 *
 *     Also adds `pauseSource: 'operator' | 'cascade' | null` to each
 *     `QueueRegistryEntry` (default `'operator'` when
 *     `state === 'manually-paused'`, else `null`). Migrated via
 *     `migrateQueueRegistryV4ToV5()`.
 *
 *   repair (feature 056): removes legacy bugfix phases that were
 *     accidentally persisted into the immutable `speckit-new-feature`
 *     pipeline snapshot. This repair is intentionally code-resident here
 *     instead of activation wiring so persisted `WorkflowRun` rewrites have a
 *     single migration-style home.
 */

import { DELAYED_RETRY_CAP } from '../controller/retry-constants';
import { buildMutationPlan } from '../services/mutation-plan';
import type {
  DelayedRetryCause,
  ManualPauseCause,
  PhaseBreakpoint,
  PhaseOverride,
  PhaseOverrideAction,
  WorkflowRun,
  WorkflowRunStatus
} from './workflow-run';

/**
 * Upper bound for `delayedRetryCount` accepted by the persisted-state
 * invariant in `validateRunInvariants`. Mirrored here so the migrator
 * can normalize legacy records BEFORE `setRun()` runs the invariant
 * check — otherwise a v1 record persisted under the old `retry.maxAttempts`
 * schema (which permitted up to 20) would throw on the next write.
 */
const DELAYED_RETRY_COUNT_PERSISTED_CEILING = 20;

const VALID_PHASE_OVERRIDE_ACTIONS: ReadonlySet<PhaseOverrideAction> = new Set<PhaseOverrideAction>([
  'skipped',
  'disabled',
  'removed'
]);

const VALID_MANUAL_PAUSE_CAUSES: ReadonlySet<ManualPauseCause> = new Set<ManualPauseCause>([
  'operator-paused',
  'queue-paused-mid-run',
  'breakpoint-paused'
]);

const VALID_BREAKPOINT_ACTORS: ReadonlySet<'operator' | 'system'> = new Set<'operator' | 'system'>([
  'operator',
  'system'
]);

export interface WorkflowRunRepairedAuditEvent {
  readonly type: 'workflow-run-repaired';
  readonly runId: string;
  readonly pipelineId: 'speckit-new-feature';
  readonly repair: 'remove-bugfix-phases-from-default-pipeline';
  readonly removedPhaseCount: number;
  readonly removedBreakpointCount: number;
  readonly remainingPhaseCount: number;
}

export interface WorkflowRunRepairResult {
  readonly run: WorkflowRun;
  readonly auditEvent: WorkflowRunRepairedAuditEvent | null;
}

export function migrateLegacyRun(legacy: unknown): WorkflowRun | null {
  if (legacy === null || legacy === undefined) return null;
  if (typeof legacy !== 'object') return null;
  const rec = legacy as Record<string, unknown>;

  // Cap legacy `delayedRetryCount` to the persisted-state ceiling so a
  // record persisted under the old `retry.maxAttempts.maximum = 20`
  // schema cannot trip the invariant check in `validateRunInvariants`
  // on the next save. Values above the ceiling are clamped down, not
  // dropped — preserves the "task hit the wall" signal for telemetry.
  const rawCountValue =
    typeof rec.delayedRetryCount === 'number' && Number.isFinite(rec.delayedRetryCount)
      ? Math.max(0, Math.floor(rec.delayedRetryCount))
      : 0;
  const rawCount = Math.min(rawCountValue, DELAYED_RETRY_COUNT_PERSISTED_CEILING);
  const rawPendingAt =
    typeof rec.pendingRetryAt === 'number' && Number.isFinite(rec.pendingRetryAt)
      ? rec.pendingRetryAt
      : null;
  const rawCause = parsePendingCause(rec.pendingRetryCause);
  const { pendingRetryAt, pendingRetryCause } = retryPairInvariant(rawPendingAt, rawCause);

  // `delayedRetryCount >= DELAYED_RETRY_CAP` (5) implies the run must
  // be `paused` or `failed` (see `validateRunInvariants`). A legacy
  // record with count=5+ AND status='running' would fail invariant.
  // Normalize to `'paused'` — preserves recoverability via operator
  // resume rather than forcing the legacy run to `'failed'`.
  const status: WorkflowRunStatus = normalizeStatus(rec.status, rawCount);

  const rawOverrides = sanitizeOverrides(rec.phaseOverrides);
  const rawManualAt =
    typeof rec.manualPauseAt === 'number' && Number.isFinite(rec.manualPauseAt)
      ? rec.manualPauseAt
      : null;
  const rawManualCause = parseManualPauseCause(rec.manualPauseCause);
  const { manualPauseAt, manualPauseCause } = manualPausePairInvariant(rawManualAt, rawManualCause);

  const rawBreakpoints = sanitizeBreakpoints(rec.phaseBreakpoints, rawOverrides);
  const rawResumeTarget =
    typeof rec.resumeTargetPhaseId === 'string' && rec.resumeTargetPhaseId.length > 0
      ? rec.resumeTargetPhaseId
      : null;
  const resumeTargetPhaseId = resumeTargetInvariant(rawResumeTarget, manualPauseCause);
  const rawTranscriptMode =
    rec.rawTranscriptMode === 'errors-only' || rec.rawTranscriptMode === 'off'
      ? rec.rawTranscriptMode
      : 'always';
  const mutationPlan = rec.mutationPlan && typeof rec.mutationPlan === 'object'
    ? rec.mutationPlan as WorkflowRun['mutationPlan']
    : rec.pipeline && typeof rec.pipeline === 'object'
      ? buildMutationPlan(rec.pipeline as WorkflowRun['pipeline'] as NonNullable<WorkflowRun['pipeline']>)
      : undefined;

  return {
    ...(rec as Omit<
      WorkflowRun,
      | 'delayedRetryCount'
      | 'pendingRetryAt'
      | 'pendingRetryCause'
      | 'phaseOverrides'
      | 'manualPauseAt'
      | 'manualPauseCause'
      | 'phaseBreakpoints'
      | 'resumeTargetPhaseId'
      | 'status'
      | 'rawTranscriptMode'
    >),
    status,
    delayedRetryCount: rawCount,
    pendingRetryAt,
    pendingRetryCause,
    phaseOverrides: rawOverrides,
    manualPauseAt,
    manualPauseCause,
    phaseBreakpoints: rawBreakpoints,
    resumeTargetPhaseId,
    rawTranscriptMode,
    ...(mutationPlan ? { mutationPlan } : {})
  };
}

/** v7 -> v8 forward migration. Idempotent on v8 records. */
export function migrateV7ToV8(legacy: unknown): WorkflowRun | null {
  return migrateLegacyRun(legacy);
}

export function repairLegacyRunSnapshot(run: WorkflowRun): WorkflowRunRepairResult {
  const pipeline = run.pipeline;
  if (!pipeline || pipeline.id !== 'speckit-new-feature') {
    return { run, auditEvent: null };
  }
  const phases = Array.isArray(pipeline.phases) ? pipeline.phases : [];
  const bugfixPhases = phases.filter((phase) => phase.id.startsWith('bugfix-'));
  if (phases.length <= 8 || bugfixPhases.length === 0) {
    return { run, auditEvent: null };
  }

  const fixedPhases = phases.filter((phase) => !phase.id.startsWith('bugfix-'));
  const remainingPhaseIds = new Set(fixedPhases.map((phase) => phase.id));
  const fixedBreakpoints = run.phaseBreakpoints.filter((breakpoint) =>
    remainingPhaseIds.has(breakpoint.phaseId)
  );
  const repaired: WorkflowRun = {
    ...run,
    pipeline: {
      ...pipeline,
      phases: fixedPhases
    },
    phaseBreakpoints: fixedBreakpoints
  };

  return {
    run: repaired,
    auditEvent: {
      type: 'workflow-run-repaired',
      runId: run.id,
      pipelineId: 'speckit-new-feature',
      repair: 'remove-bugfix-phases-from-default-pipeline',
      removedPhaseCount: bugfixPhases.length,
      removedBreakpointCount: run.phaseBreakpoints.length - fixedBreakpoints.length,
      remainingPhaseCount: fixedPhases.length
    }
  };
}

const VALID_WORKFLOW_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set<WorkflowRunStatus>([
  'running',
  'paused',
  'failed',
  'completed',
  'canceled'
]);

/**
 * Resolve the persisted `WorkflowRun.status` to a valid runtime value:
 *   - Validate against the closed enum (drop garbage strings, undefined).
 *   - When `delayedRetryCount` is at-or-above the live cap AND the
 *     legacy record was still `'running'`, normalize to `'paused'` so
 *     the next `validateRunInvariants` write does not throw. The legacy
 *     `retry.maxAttempts` schema permitted up to 20; the live cap is 5.
 *   - Unknown / missing status falls back to `'running'` (the safest
 *     default — the controller's lifecycle will transition it forward).
 */
function normalizeStatus(raw: unknown, delayedRetryCount: number): WorkflowRunStatus {
  const validated =
    typeof raw === 'string' && VALID_WORKFLOW_STATUSES.has(raw as WorkflowRunStatus)
      ? (raw as WorkflowRunStatus)
      : 'running';
  if (delayedRetryCount >= DELAYED_RETRY_CAP && validated === 'running') {
    return 'paused';
  }
  return validated;
}

/**
 * Feature 028 — v4 → v5 forward migration. Idempotent on already-v5 records.
 * Delegates to `migrateLegacyRun()` which has been extended to populate the
 * v5 fields with safe defaults. Exposed as a named alias so the activation
 * code path documents the migration step explicitly.
 */
export function migrateV4ToV5(legacy: unknown): WorkflowRun | null {
  return migrateLegacyRun(legacy);
}

/**
 * Feature 028 — v4 → v5 forward migration for `QueueRegistryEntry` records.
 *
 * Adds `pauseSource: 'operator' | 'cascade' | null` to each entry:
 *   - `state === 'manually-paused'` ⇒ default `'operator'` (preserve any
 *     valid existing value).
 *   - otherwise ⇒ `null`.
 *
 * Idempotent: passes an already-v5 record through unchanged. Returns a
 * shallow-cloned array; non-array input becomes `[]`.
 */
export function migrateQueueRegistryV4ToV5(legacy: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(legacy)) return [];
  const result: Array<Record<string, unknown>> = [];
  for (const item of legacy) {
    if (item === null || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const state = rec.state;
    if (state === 'manually-paused') {
      const existing = rec.pauseSource;
      const pauseSource =
        existing === 'operator' || existing === 'cascade' ? existing : 'operator';
      result.push({ ...rec, pauseSource });
    } else {
      result.push({ ...rec, pauseSource: null });
    }
  }
  return result;
}

function parsePendingCause(value: unknown): DelayedRetryCause | null {
  if (value === 'transient_error' || value === 'rate_limit') return value;
  return null;
}

function parseManualPauseCause(value: unknown): ManualPauseCause | null {
  if (typeof value === 'string' && VALID_MANUAL_PAUSE_CAUSES.has(value as ManualPauseCause)) {
    return value as ManualPauseCause;
  }
  return null;
}

function retryPairInvariant(
  pendingRetryAt: number | null,
  pendingRetryCause: DelayedRetryCause | null
): { pendingRetryAt: number | null; pendingRetryCause: DelayedRetryCause | null } {
  if (pendingRetryAt !== null && pendingRetryCause !== null) {
    return { pendingRetryAt, pendingRetryCause };
  }
  return { pendingRetryAt: null, pendingRetryCause: null };
}

function manualPausePairInvariant(
  manualPauseAt: number | null,
  manualPauseCause: ManualPauseCause | null
): { manualPauseAt: number | null; manualPauseCause: ManualPauseCause | null } {
  if (manualPauseAt !== null && manualPauseCause !== null) {
    return { manualPauseAt, manualPauseCause };
  }
  return { manualPauseAt: null, manualPauseCause: null };
}

function resumeTargetInvariant(
  resumeTargetPhaseId: string | null,
  manualPauseCause: ManualPauseCause | null
): string | null {
  if (manualPauseCause === 'breakpoint-paused' && resumeTargetPhaseId !== null) {
    return resumeTargetPhaseId;
  }
  return null;
}

function sanitizeBreakpoints(
  raw: unknown,
  overrides: ReadonlyArray<PhaseOverride>
): PhaseBreakpoint[] {
  if (!Array.isArray(raw)) return [];
  const overriddenIds = new Set<string>();
  for (const o of overrides) overriddenIds.add(o.phaseId);
  const seen = new Set<string>();
  const result: PhaseBreakpoint[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const phaseId = typeof rec.phaseId === 'string' ? rec.phaseId.trim() : '';
    if (phaseId.length === 0 || seen.has(phaseId) || overriddenIds.has(phaseId)) continue;
    const setAt =
      typeof rec.setAt === 'number' && Number.isFinite(rec.setAt) ? rec.setAt : Date.now();
    const actorRaw = rec.actor;
    const actor: 'operator' | 'system' =
      typeof actorRaw === 'string' && VALID_BREAKPOINT_ACTORS.has(actorRaw as 'operator' | 'system')
        ? (actorRaw as 'operator' | 'system')
        : 'operator';
    seen.add(phaseId);
    result.push({ phaseId, setAt, actor });
  }
  return result;
}

function sanitizeOverrides(raw: unknown): PhaseOverride[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: PhaseOverride[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const phaseId = typeof rec.phaseId === 'string' ? rec.phaseId.trim() : '';
    if (phaseId.length === 0 || seen.has(phaseId)) continue;
    const action = rec.action;
    if (typeof action !== 'string' || !VALID_PHASE_OVERRIDE_ACTIONS.has(action as PhaseOverrideAction)) continue;
    const setAt =
      typeof rec.setAt === 'number' && Number.isFinite(rec.setAt) ? rec.setAt : Date.now();
    const actor =
      typeof rec.actor === 'string' && rec.actor.length > 0 ? rec.actor : 'unknown-operator';
    seen.add(phaseId);
    const priorPhaseState =
      typeof rec.priorPhaseState === 'string' && rec.priorPhaseState.length > 0
        ? rec.priorPhaseState
        : undefined;
    result.push({
      phaseId,
      action: action as PhaseOverrideAction,
      setAt,
      actor,
      ...(priorPhaseState ? { priorPhaseState } : {})
    });
  }
  return result;
}
