// FR-R6-F05 (T037, US4) — retention-policy adoption (AC-03, FR-008, FR-018).
//
// Revision 0 is implicit: every artifact stays on its existing class policy. Only the class whose
// F02 inventory entry applies after activation is aged by an adopted policy; the audit log, vendor
// session stores and unclassified bytes are never eligible under any policy. Adoption names a live
// preview taken for the same policy on the same state, and at most one revision is ever adopted.

import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ArtifactRecord,
  MutationAuthority,
  RetentionPolicy
} from '../../../src/contracts/artifact-lifecycle/lifecycle-types';
import { DEFAULT_RETENTION_POLICY } from '../../../src/contracts/artifact-lifecycle/retention-policy-types';
import { RETENTION_CLASS_IDS } from '../../../src/contracts/shared-memory-storage/consumer-and-retention-inventories';
import {
  ArtifactRecordStore,
  DENY_ALL_ACCESS_POLICY,
  PreviewStore,
  ReferenceStore,
  type LifecycleContext,
  type RegisterArtifactInput
} from '../../../src/services/artifact-lifecycle';
import { adoptedPolicyRevision } from '../../../src/services/artifact-lifecycle/lifecycle-context';
import {
  adoptPolicy,
  currentRetentionDecisions,
  evaluateEligibility,
  previewPolicyAdoption,
  readAdoptedPolicy
} from '../../../src/services/artifact-lifecycle/retention-policy';
import { checkpointArtifact, FULL, lifecycleFixture, NOW, type LifecycleFixture } from './lifecycle-fixture';

const DAY_MS = 24 * 60 * 60 * 1000;
const DETAIL_CLASS = 'new-terminal-execution-usage-detail' as const;
const PINNED_RUN = 'run-pinned';

function contextAt(fx: LifecycleFixture, nowMs: number): LifecycleContext {
  let next = 0;
  const newId = (): string => `rp-${nowMs}-${(next += 1)}`;
  const now = (): number => nowMs;
  return {
    deps: {
      conn: fx.conn,
      nowMs: now,
      fs: fx.fs,
      probe: {
        observe: () => Promise.resolve({ exists: true, sizeBytes: 40, producerIdentity: 'writer', generation: null }),
        digestSha256: () => Promise.resolve(null)
      },
      audit: { recordLifecycleMutation: (record) => fx.audits.push(record) },
      scanRoots: [],
      accessPolicy: DENY_ALL_ACCESS_POLICY,
      resolveOwner: () => 'live',
      newId,
      pinnedRunIds: () => new Set([PINNED_RUN])
    },
    records: new ArtifactRecordStore(fx.conn, now),
    previews: new PreviewStore(fx.conn, now, newId),
    references: new ReferenceStore(fx.conn, now),
    newId
  };
}

function seed(fx: LifecycleFixture, id: string, settledAgoMs: number | null, overrides: Partial<RegisterArtifactInput>): void {
  const registered = fx.build().registerArtifact(
    checkpointArtifact(id, { retentionClass: DETAIL_CLASS, storeKind: 'report', ...overrides })
  );
  if (!registered.ok) throw new Error(`seed failed: ${registered.refusal.code}`);
  if (settledAgoMs === null) return;
  fx.conn.run('UPDATE artifact_lifecycle SET terminal_settled_at_ms = ? WHERE artifact_id = ?', NOW - settledAgoMs, id);
}

/** One artifact per standing the policy must tell apart. */
function seedStandings(fx: LifecycleFixture): void {
  seed(fx, 'detail-old', 100 * DAY_MS, { byteSize: 1000 });
  seed(fx, 'detail-young', 10 * DAY_MS, { byteSize: 70 });
  seed(fx, 'detail-unsettled', null, { byteSize: 30 });
  seed(fx, 'detail-pinned', 100 * DAY_MS, { byteSize: 500, ownerRunId: PINNED_RUN });
  seed(fx, 'audit-old', 100 * DAY_MS, { storeKind: 'audit', byteSize: 11 });
  seed(fx, 'session-old', 100 * DAY_MS, {
    storeKind: 'provider-session',
    retentionClass: 'provider-owned-session-stores',
    byteSize: 13
  });
  seed(fx, 'checkpoint-old', 100 * DAY_MS, { storeKind: 'checkpoint', retentionClass: 'transcripts-diagnostics-checkpoints-audit-catalog' });
  seed(fx, 'unclassified-old', 100 * DAY_MS, { storeKind: 'unclassified', byteSize: 17 });
}

function record(ctx: LifecycleContext, id: string): ArtifactRecord {
  const found = ctx.records.get(id);
  if (!found.ok) throw new Error(`missing record ${id}`);
  return found.value;
}

const notProtected = (): boolean => false;

function actionsOf(ctx: LifecycleContext): Map<string, string> {
  return new Map(currentRetentionDecisions(ctx).map((decision) => [decision.artifactId, decision.action]));
}

function adoptedRowCount(fx: LifecycleFixture): number | undefined {
  return fx.conn.scalar<number>(`SELECT COUNT(*) FROM retention_policy_revisions WHERE state = 'adopted'`);
}

function adopt(ctx: LifecycleContext, policy: RetentionPolicy = DEFAULT_RETENTION_POLICY, authority: MutationAuthority = FULL) {
  const preview = previewPolicyAdoption(ctx, policy);
  if (!preview.ok) throw new Error(`preview failed: ${preview.refusal.code}`);
  return adoptPolicy(ctx, { previewId: preview.value.previewId, confirmation: 'confirmed', authority, policy });
}

describe('evaluateEligibility', () => {
  let fx: LifecycleFixture;
  let ctx: LifecycleContext;

  beforeEach(() => {
    fx = lifecycleFixture();
    ctx = contextAt(fx, NOW);
    seedStandings(fx);
  });

  it('keeps every artifact on its existing class policy under the implicit revision 0', () => {
    for (const id of ['detail-old', 'detail-young', 'checkpoint-old']) {
      expect(evaluateEligibility(record(ctx, id), null, notProtected, NOW).action).toBe('preserve-ineligible');
    }
    expect(readAdoptedPolicy(fx.conn)).toBeNull();
    expect([...actionsOf(ctx).values()]).not.toContain('collect');
  });

  it('collects only settled new-metadata detail older than the policy age', () => {
    const decide = (id: string) => evaluateEligibility(record(ctx, id), DEFAULT_RETENTION_POLICY, notProtected, NOW);
    expect(decide('detail-old')).toEqual({
      artifactId: 'detail-old',
      action: 'collect',
      retentionClass: DETAIL_CLASS,
      byteSize: 1000
    });
    expect(decide('detail-young').action).toBe('preserve-ineligible');
    expect(decide('detail-unsettled').action).toBe('preserve-ineligible');
    expect(decide('checkpoint-old').action).toBe('preserve-ineligible');
  });

  it('preserves a protected artifact the policy would otherwise collect', () => {
    const decision = evaluateEligibility(record(ctx, 'detail-old'), DEFAULT_RETENTION_POLICY, () => true, NOW);
    expect(decision.action).toBe('preserve-protected');
  });

  const policies: readonly RetentionPolicy[] = [
    DEFAULT_RETENTION_POLICY,
    { ...DEFAULT_RETENTION_POLICY, terminalDetailMaxAgeMs: 0 }
  ];

  it.each(policies.map((policy) => [policy.terminalDetailMaxAgeMs, policy] as const))(
    'never makes audit or provider-session stores eligible (max age %d ms)',
    (_age, policy) => {
      expect(evaluateEligibility(record(ctx, 'audit-old'), policy, notProtected, NOW).action).toBe('preserve-never-eligible');
      expect(evaluateEligibility(record(ctx, 'session-old'), policy, notProtected, NOW).action).toBe('preserve-never-eligible');
    }
  );

  it.each(policies.map((policy) => [policy.terminalDetailMaxAgeMs, policy] as const))(
    'never makes unclassified bytes eligible (max age %d ms)',
    (_age, policy) => {
      expect(evaluateEligibility(record(ctx, 'unclassified-old'), policy, notProtected, NOW).action).toBe('preserve-unclassified');
    }
  );
});

describe('previewPolicyAdoption', () => {
  let fx: LifecycleFixture;
  let ctx: LifecycleContext;

  beforeEach(() => {
    fx = lifecycleFixture();
    ctx = contextAt(fx, NOW);
    seedStandings(fx);
  });

  it('reports data classes, affected counts and bytes, protected exceptions and coverage', () => {
    const preview = previewPolicyAdoption(ctx, DEFAULT_RETENTION_POLICY);
    if (!preview.ok) throw new Error(preview.refusal.code);
    const { summary } = preview.value;
    expect(preview.value.kind).toBe('policy-adoption');
    expect(summary.perClass.map((line) => line.retentionClass)).toEqual([...RETENTION_CLASS_IDS].sort());
    expect(summary.perClass.find((line) => line.retentionClass === DETAIL_CLASS)).toEqual({
      retentionClass: DETAIL_CLASS,
      affectedCount: 1,
      affectedBytes: 1000,
      protectedCount: 1,
      protectedBytes: 500
    });
    expect(summary.affectedCount).toBe(1);
    expect(summary.affectedBytes).toBe(1000);
    expect(summary.unclassifiedCount).toBe(1);
    expect(summary.unclassifiedBytes).toBe(17);
    expect(summary.protectedExceptions).toEqual(
      expect.arrayContaining([
        { artifactId: 'detail-pinned', reason: 'preserve-protected' },
        { artifactId: 'audit-old', reason: 'preserve-never-eligible' },
        { artifactId: 'session-old', reason: 'preserve-never-eligible' }
      ])
    );
    expect(summary.coverage).toBe('complete');
    expect(summary.notes.some((note) => note.includes('transcripts-diagnostics-checkpoints-audit-catalog'))).toBe(true);
  });

  it('persists the preview it returns', () => {
    const preview = previewPolicyAdoption(ctx, DEFAULT_RETENTION_POLICY);
    if (!preview.ok) throw new Error(preview.refusal.code);
    expect(ctx.previews.get(preview.value.previewId)).toEqual({ ok: true, value: preview.value });
  });

  it.each([
    ['a schema version other than 1', { ...DEFAULT_RETENTION_POLICY, schemaVersion: 2 }],
    ['a negative age', { ...DEFAULT_RETENTION_POLICY, terminalDetailMaxAgeMs: -1 }],
    ['a fractional hot-list bound', { ...DEFAULT_RETENTION_POLICY, archivalHotListBound: 1.5 }],
    ['a zero hot-list bound', { ...DEFAULT_RETENTION_POLICY, archivalHotListBound: 0 }],
    ['an unknown key', { ...DEFAULT_RETENTION_POLICY, purgeAll: true }]
  ])('refuses %s as invalid-input', (_label, policy) => {
    const preview = previewPolicyAdoption(ctx, policy as unknown as RetentionPolicy);
    expect(preview.ok ? undefined : preview.refusal.code).toBe('invalid-input');
  });
});

describe('adoptPolicy', () => {
  let fx: LifecycleFixture;
  let ctx: LifecycleContext;

  beforeEach(() => {
    fx = lifecycleFixture();
    ctx = contextAt(fx, NOW);
    seedStandings(fx);
  });

  it('adopts revision 1 and emits one metadata-only audit record', () => {
    expect(adopt(ctx)).toEqual({ ok: true, value: { policyRevision: 1 } });
    expect(adoptedPolicyRevision(fx.conn)).toBe(1);
    expect(readAdoptedPolicy(fx.conn)).toEqual({ policyRevision: 1, policy: DEFAULT_RETENTION_POLICY });
    expect(fx.audits).toHaveLength(1);
    expect(fx.audits.at(0)).toMatchObject({ operationKind: 'policy-adoption', result: 'completed' });
  });

  it('refuses a preview whose state changed since it was taken', () => {
    const preview = previewPolicyAdoption(ctx, DEFAULT_RETENTION_POLICY);
    if (!preview.ok) throw new Error(preview.refusal.code);
    seed(fx, 'detail-later', 200 * DAY_MS, {});
    const adopted = adoptPolicy(ctx, {
      previewId: preview.value.previewId,
      confirmation: 'confirmed',
      authority: FULL,
      policy: DEFAULT_RETENTION_POLICY
    });
    expect(adopted.ok ? undefined : adopted.refusal.code).toBe('preview-stale');
    expect(adoptedPolicyRevision(fx.conn)).toBe(0);
    expect(fx.audits).toHaveLength(0);
  });

  it('refuses a policy other than the one previewed', () => {
    const preview = previewPolicyAdoption(ctx, DEFAULT_RETENTION_POLICY);
    if (!preview.ok) throw new Error(preview.refusal.code);
    const adopted = adoptPolicy(ctx, {
      previewId: preview.value.previewId,
      confirmation: 'confirmed',
      authority: FULL,
      policy: { ...DEFAULT_RETENTION_POLICY, terminalDetailMaxAgeMs: DAY_MS }
    });
    expect(adopted.ok ? undefined : adopted.refusal.code).toBe('preview-stale');
  });

  it('refuses in the fixed gate order before reading the preview', () => {
    const adopted = adopt(ctx, DEFAULT_RETENTION_POLICY, { ...FULL, trusted: false });
    expect(adopted.ok ? undefined : adopted.refusal.code).toBe('untrusted-workspace');
    const preview = previewPolicyAdoption(ctx, DEFAULT_RETENTION_POLICY);
    if (!preview.ok) throw new Error(preview.refusal.code);
    const unconfirmed = adoptPolicy(ctx, {
      previewId: preview.value.previewId,
      confirmation: undefined,
      authority: FULL,
      policy: DEFAULT_RETENTION_POLICY
    });
    expect(unconfirmed.ok ? undefined : unconfirmed.refusal.code).toBe('confirmation-required');
    expect(adoptedPolicyRevision(fx.conn)).toBe(0);
  });

  it('changes only the previewed eligible set', () => {
    const before = actionsOf(ctx);
    const preview = previewPolicyAdoption(ctx, DEFAULT_RETENTION_POLICY);
    if (!preview.ok) throw new Error(preview.refusal.code);
    const adopted = adoptPolicy(ctx, {
      previewId: preview.value.previewId,
      confirmation: 'confirmed',
      authority: FULL,
      policy: DEFAULT_RETENTION_POLICY
    });
    expect(adopted.ok).toBe(true);
    const after = actionsOf(ctx);
    const collectable = (actions: Map<string, string>): string[] =>
      [...actions].filter(([, action]) => action === 'collect').map(([id]) => id);
    expect(collectable(before)).toEqual([]);
    expect(collectable(after)).toEqual(['detail-old']);
    expect(collectable(after)).toHaveLength(preview.value.summary.affectedCount);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  });

  it('keeps at most one adopted revision', () => {
    expect(adopt(ctx)).toEqual({ ok: true, value: { policyRevision: 1 } });
    const later = contextAt(fx, NOW + 1);
    expect(adopt(later, { ...DEFAULT_RETENTION_POLICY, terminalDetailMaxAgeMs: 5 * DAY_MS })).toEqual({
      ok: true,
      value: { policyRevision: 2 }
    });
    expect(adoptedRowCount(fx)).toBe(1);
    expect(fx.conn.scalar<string>('SELECT state FROM retention_policy_revisions WHERE policy_revision = 1')).toBe('superseded');
    expect(adoptedPolicyRevision(fx.conn)).toBe(2);
    expect(() =>
      fx.conn.run(
        `INSERT INTO retention_policy_revisions (policy_revision, state, policy_json, created_at_ms) VALUES (3, 'adopted', '{}', ?)`,
        NOW
      )
    ).toThrow();
  });
});
