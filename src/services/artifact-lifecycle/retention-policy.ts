/**
 * FR-R6-F05 (US4) — retention-policy eligibility, adoption preview and
 * adoption (FR-008, FR-018, AC-03).
 *
 * Existing class policies stay in force: an adopted policy ages only the
 * classes whose F02 inventory entry applies after activation, and only from
 * terminal settlement. Audit and provider-session stores are never eligible,
 * and unclassified bytes are never collected. Revision 0 is implicit; the
 * partial unique index on `retention_policy_revisions` keeps at most one
 * revision adopted.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { createHash } from 'node:crypto';
import {
  NEVER_ELIGIBLE_STORE_KINDS,
  type ArtifactRecord,
  type LifecycleResult,
  type RetentionClassId,
  type RetentionDecision,
  type RetentionDecisionAction,
  type RetentionPolicy,
  type RetentionPreview,
  type RetentionPreviewClassLine,
  type RetentionPreviewSummary
} from '../../contracts/artifact-lifecycle/lifecycle-types';
import type {
  AdoptedRetentionPolicy,
  PolicyAdoptionRequest,
  PolicyAdoptionResult
} from '../../contracts/artifact-lifecycle/retention-policy-types';
import {
  RETENTION_CLASS_IDS,
  RETENTION_POLICY_INVENTORY
} from '../../contracts/shared-memory-storage/consumer-and-retention-inventories';
import type { NodeSqliteConnection } from '../sqlite-store';
import {
  adoptedPolicyRevision,
  forEachManagedRecord,
  isLiveWriter,
  pinnedRunsOf,
  standingOf,
  type LifecycleContext
} from './lifecycle-context';
import { inImmediateTransaction, isNonNegativeInteger, ok, refuse } from './lifecycle-results';
import { runAuthorizedMutation } from './mutation-authority';

/** The most protected exceptions an adoption preview names; the rest are counted only. */
export const POLICY_PREVIEW_MAX_EXCEPTIONS = 100;

const POLICY_KEYS: readonly string[] = ['schemaVersion', 'terminalDetailMaxAgeMs', 'archivalHotListBound', 'archivalMaxAgeMs'];

/** Classes an adopted policy may age: the F02 entries that apply only after activation. */
const ACTIVATED_CLASSES: ReadonlySet<RetentionClassId> = new Set(
  RETENTION_POLICY_INVENTORY.filter((entry) => entry.appliesOnlyAfterActivation).map((entry) => entry.retentionClass)
);

/** Classes no policy ages, whatever their store kind says: the vendor's own stores (FR-008). */
const NEVER_ELIGIBLE_CLASSES: ReadonlySet<RetentionClassId> = new Set(
  RETENTION_POLICY_INVENTORY.filter((entry) => entry.governingPolicy === 'external-provider-boundary').map(
    (entry) => entry.retentionClass
  )
);

/** Whether `value` is a well-formed policy this service can adopt; unknown keys are refused. */
export function isRetentionPolicy(value: unknown): value is RetentionPolicy {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !POLICY_KEYS.includes(key))) return false;
  return (
    candidate['schemaVersion'] === 1 &&
    isNonNegativeInteger(candidate['terminalDetailMaxAgeMs']) &&
    isNonNegativeInteger(candidate['archivalHotListBound']) &&
    (candidate['archivalHotListBound'] as number) >= 1 &&
    isNonNegativeInteger(candidate['archivalMaxAgeMs'])
  );
}

function normalizedPolicy(policy: RetentionPolicy): RetentionPolicy {
  return {
    schemaVersion: policy.schemaVersion,
    terminalDetailMaxAgeMs: policy.terminalDetailMaxAgeMs,
    archivalHotListBound: policy.archivalHotListBound,
    archivalMaxAgeMs: policy.archivalMaxAgeMs
  };
}

/** The adopted policy, or `null` for the implicit revision 0. An unreadable stored policy fails closed to `null`. */
export function readAdoptedPolicy(conn: NodeSqliteConnection): AdoptedRetentionPolicy | null {
  const row = conn.get<{ policy_revision: number; policy_json: string }>(
    `SELECT policy_revision, policy_json FROM retention_policy_revisions WHERE state = 'adopted'`
  );
  if (row === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.policy_json);
  } catch {
    return null;
  }
  if (!isRetentionPolicy(parsed)) return null;
  return { policyRevision: row.policy_revision, policy: normalizedPolicy(parsed) };
}

function decision(record: ArtifactRecord, action: RetentionDecisionAction): RetentionDecision {
  return { artifactId: record.artifactId, action, retentionClass: record.retentionClass, byteSize: record.byteSize };
}

/**
 * One artifact's decision under `policy` (`null` is revision 0). Never-eligible and unclassified
 * artifacts are preserved under every policy; any class outside the activated set keeps its
 * existing policy; protection outranks age.
 */
export function evaluateEligibility(
  record: ArtifactRecord,
  policy: RetentionPolicy | null,
  isProtected: (record: ArtifactRecord) => boolean,
  nowMs: number
): RetentionDecision {
  if (record.storeKind === 'unclassified') return decision(record, 'preserve-unclassified');
  if (NEVER_ELIGIBLE_STORE_KINDS.includes(record.storeKind) || NEVER_ELIGIBLE_CLASSES.has(record.retentionClass)) {
    return decision(record, 'preserve-never-eligible');
  }
  if (policy === null || !ACTIVATED_CLASSES.has(record.retentionClass)) return decision(record, 'preserve-ineligible');
  if (isProtected(record)) return decision(record, 'preserve-protected');
  const settledAt = record.terminalSettledAtMs;
  if (settledAt === null || isLiveWriter(record)) return decision(record, 'preserve-ineligible');
  return decision(record, nowMs - settledAt >= policy.terminalDetailMaxAgeMs ? 'collect' : 'preserve-ineligible');
}

function decideAll(ctx: LifecycleContext, policy: RetentionPolicy | null): RetentionDecision[] {
  const pinnedRuns = pinnedRunsOf(ctx);
  const nowMs = ctx.deps.nowMs();
  const decisions: RetentionDecision[] = [];
  forEachManagedRecord(ctx, (record) => {
    const standing = standingOf(ctx, record, pinnedRuns);
    if (standing.gone) return;
    decisions.push(evaluateEligibility(record, policy, () => standing.protected, nowMs));
  });
  return decisions;
}

/** Every present managed artifact's decision under the adopted policy (revision 0 when none is). */
export function currentRetentionDecisions(ctx: LifecycleContext): RetentionDecision[] {
  return decideAll(ctx, readAdoptedPolicy(ctx.deps.conn)?.policy ?? null);
}

type Tally = { affectedCount: number; affectedBytes: number; protectedCount: number; protectedBytes: number };

function summarize(decisions: readonly RetentionDecision[]): RetentionPreviewSummary {
  const perClass = new Map<RetentionClassId, Tally>(
    RETENTION_CLASS_IDS.map((id) => [id, { affectedCount: 0, affectedBytes: 0, protectedCount: 0, protectedBytes: 0 }])
  );
  const exceptions: { artifactId: string; reason: RetentionDecisionAction }[] = [];
  let exceptionCount = 0;
  let unclassifiedCount = 0;
  let unclassifiedBytes = 0;
  for (const item of decisions) {
    const tally = perClass.get(item.retentionClass);
    if (item.action === 'preserve-unclassified') {
      unclassifiedCount += 1;
      unclassifiedBytes += item.byteSize;
    } else if (tally !== undefined && item.action === 'collect') {
      tally.affectedCount += 1;
      tally.affectedBytes += item.byteSize;
    } else if (tally !== undefined && item.action === 'preserve-protected') {
      tally.protectedCount += 1;
      tally.protectedBytes += item.byteSize;
    }
    if (item.action !== 'preserve-protected' && item.action !== 'preserve-never-eligible') continue;
    exceptionCount += 1;
    if (exceptions.length < POLICY_PREVIEW_MAX_EXCEPTIONS) exceptions.push({ artifactId: item.artifactId, reason: item.action });
  }
  const lines: RetentionPreviewClassLine[] = [...perClass.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([retentionClass, tally]) => ({ retentionClass, ...tally }));
  const sum = (pick: (line: RetentionPreviewClassLine) => number): number => lines.reduce((total, line) => total + pick(line), 0);
  const truncated = exceptionCount - exceptions.length;
  return {
    affectedCount: sum((line) => line.affectedCount),
    affectedBytes: sum((line) => line.affectedBytes),
    protectedCount: sum((line) => line.protectedCount),
    protectedBytes: sum((line) => line.protectedBytes),
    unclassifiedCount,
    unclassifiedBytes,
    perClass: lines,
    protectedExceptions: exceptions,
    coverage: 'complete',
    notes: [...coverageNotes(), ...(truncated > 0 ? [`${truncated} further preserved artifacts are counted but not listed`] : [])]
  };
}

/** The reporting and recovery coverage an adoption keeps: what stays on its existing policy, and why. */
function coverageNotes(): string[] {
  const kept = RETENTION_POLICY_INVENTORY.filter((entry) => !entry.appliesOnlyAfterActivation).map(
    (entry) => `${entry.retentionClass} keeps its existing policy (${entry.governingPolicy})`
  );
  return [
    ...kept,
    'audit and provider-session stores are never eligible; unclassified bytes are never collected',
    'protected artifacts and artifacts of runs pinned for recovery stay recoverable',
    'adoption changes eligibility only; collection runs through a separate previewed deletion'
  ];
}

interface AdoptionPlan {
  readonly basis: string;
  readonly summary: RetentionPreviewSummary;
}

function planAdoption(ctx: LifecycleContext, policy: RetentionPolicy): AdoptionPlan {
  const decisions = decideAll(ctx, policy);
  const considered = decisions.map((item) => [item.artifactId, item.action, item.byteSize] as const);
  const basis = createHash('sha256')
    .update(
      JSON.stringify({
        kind: 'policy-adoption',
        adoptedRevision: adoptedPolicyRevision(ctx.deps.conn),
        policy: normalizedPolicy(policy),
        considered
      })
    )
    .digest('hex');
  return { basis, summary: summarize(decisions) };
}

/** Persists and returns a `policy-adoption` preview for `policy` (FR-018). */
export function previewPolicyAdoption(ctx: LifecycleContext, policy: RetentionPolicy): LifecycleResult<RetentionPreview> {
  if (!isRetentionPolicy(policy)) return refuse('invalid-input', 'retention policy is malformed');
  const plan = planAdoption(ctx, policy);
  return ok(ctx.previews.create('policy-adoption', plan.basis, plan.summary));
}

function nextRevision(conn: NodeSqliteConnection): number {
  return (conn.scalar<number>('SELECT MAX(policy_revision) FROM retention_policy_revisions') ?? 0) + 1;
}

/**
 * Adopts the previewed policy as the next revision and supersedes the one in force, in one
 * transaction. The fixed gate runs first; one metadata-only audit record follows.
 */
export function adoptPolicy(ctx: LifecycleContext, request: PolicyAdoptionRequest): LifecycleResult<PolicyAdoptionResult> {
  if (!isRetentionPolicy(request.policy)) return refuse('invalid-input', 'retention policy is malformed');
  const policy = normalizedPolicy(request.policy);
  const plan = planAdoption(ctx, policy);
  const deps = { previews: ctx.previews, audit: ctx.deps.audit };
  return runAuthorizedMutation(deps, request, 'policy-adoption', plan.basis, (preview) => {
    const nowMs = ctx.deps.nowMs();
    const policyRevision = inImmediateTransaction(ctx.deps.conn, () => {
      const revision = nextRevision(ctx.deps.conn);
      ctx.deps.conn.run(`UPDATE retention_policy_revisions SET state = 'superseded' WHERE state = 'adopted'`);
      ctx.deps.conn.run(
        `INSERT INTO retention_policy_revisions (policy_revision, state, policy_json, preview_id, created_at_ms, adopted_at_ms)
         VALUES (?, 'adopted', ?, ?, ?, ?)`,
        revision,
        JSON.stringify(policy),
        preview.previewId,
        nowMs,
        nowMs
      );
      return revision;
    });
    return {
      operationId: ctx.newId(),
      counts: { policyRevision, affectedCount: plan.summary.affectedCount },
      result: 'completed',
      value: { policyRevision }
    };
  });
}
