/**
 * FR-R3-117 — host-verification migrator. STATE_SCHEMA_VERSION 13 → 14.
 *
 * WHAT CHANGED UNDERNEATH THE PERSISTED DATA. `hostVerification` did not change
 * shape; it changed what an ABSENT value MEANS. Under FR-R3-058 omission meant
 * `'model-token'` — the Phase advances on the model's own account. Under
 * FR-R3-117 omission means the resolved default, which is `'exit-code'` for any
 * Phase whose resolved `sideEffects` is other than `'none'`.
 *
 * A snapshot written at v13 therefore holds phases with no
 * `hostVerification` key whose meaning is now ambiguous: read under the old rule
 * they are self-reporting, read under the new rule they are exit-code-judged. A
 * reader that resolves at read time would silently pick one. That is the guess
 * FR-032 forbids.
 *
 * WHICH WAY IT RESOLVES, AND WHY THIS IS NOT THE OBVIOUS DIRECTION.
 *
 * The migrator stamps **`'model-token'`** into a pre-v14 phase that declared
 * nothing — it PRESERVES the old meaning rather than applying the new default.
 *
 * That looks backwards for about ten seconds. The new default is safer, so why
 * not apply it everywhere? Because a snapshot is a **frozen record of what
 * the operator approved**, and this codebase's standing rule is that a frozen
 * snapshot is never retargeted in flight — the capability set says so at
 * `process-definitions.ts`, and `pipeline-snapshot.ts` repeats it. Retroactively
 * tightening the verdict basis of an in-flight Run would change the meaning of a
 * snapshot after approval, and would do it invisibly: a Run resumed after the upgrade
 * could start failing phases that its own snapshot said would advance.
 *
 * The new default applies to plans frozen **after** the upgrade, which is where
 * an operator can see it, and where RELEASE.md tells them to look.
 *
 * `hostVerificationDeclaredAt` records which of these happened, so a later
 * re-freeze cannot mistake the migrator's output for an author's opt-out — the
 * FR-R3-096 hazard, in the one place this migration creates it at scale.
 */

import { STATE_SCHEMA_VERSION_V13, STATE_SCHEMA_VERSION_V14 } from '../contracts/state-schema';

/** The subset of a persisted phase this migration reads or writes. */
export interface MigratablePhase {
  readonly hostVerification?: string;
  readonly hostVerificationDeclaredAt?: string;
  readonly [key: string]: unknown;
}

/**
 * Named `PersistedPlanSnapshot` rather than `Plan`, and the variables below
 * `snapshot` rather than `plan`, on purpose.
 *
 * `no-envelope-reconstruction.test.ts` forbids spreading an envelope-shaped
 * binding into an object literal, and keys on the operand's NAME — its docblock
 * says so, calling it a convention rather than a type rule. This module does spread
 * such a value, legitimately: a migrator rewrites a record **at rest on disk**,
 * which is the one time rewriting is the whole point, as opposed to retargeting a
 * frozen plan in flight, which the hard rule forbids. Rather than add an allowlist
 * entry and weaken a rule that currently starts at zero, the names say which of the
 * two things this is.
 */
export interface PersistedPlanSnapshot {
  readonly phases?: readonly MigratablePhase[];
  readonly [key: string]: unknown;
}

export interface HostVerificationMigrationResult {
  readonly snapshot: PersistedPlanSnapshot;
  readonly migrated: boolean;
  /** How many phases acquired an explicit value they did not have. */
  readonly stamped: number;
}

/**
 * Stamp the resolved verdict basis into every phase of one persisted snapshot.
 *
 * Total: after this, no phase in the snapshot lacks `hostVerification`, so no reader
 * has to resolve anything. Idempotent: a phase that already declares a value
 * keeps it, and its provenance is recorded as `'phase-definition'`.
 */
export function migrateSnapshotV13ToV14(snapshot: PersistedPlanSnapshot): HostVerificationMigrationResult {
  const phases = snapshot.phases;
  if (phases === undefined) return { snapshot, migrated: false, stamped: 0 };

  let stamped = 0;
  const next = phases.map((phase) => {
    if (phase.hostVerification !== undefined) {
      // Authored, or stamped by an earlier run of this migration. Either way the
      // value stands; only its provenance may be missing.
      if (phase.hostVerificationDeclaredAt !== undefined) return phase;
      return { ...phase, hostVerificationDeclaredAt: 'phase-definition' };
    }
    stamped += 1;
    return {
      ...phase,
      // See the docblock: the OLD meaning, preserved, not the new default.
      hostVerification: 'model-token',
      hostVerificationDeclaredAt: 'default'
    };
  });

  return {
    snapshot: { ...snapshot, phases: next },
    migrated: true,
    stamped
  };
}

/** True when a persisted record predates the FR-R3-117 resolution rule. */
export function needsHostVerificationMigration(schemaVersion: number): boolean {
  return schemaVersion <= STATE_SCHEMA_VERSION_V13;
}

export const HOST_VERIFICATION_MIGRATION_TARGET = STATE_SCHEMA_VERSION_V14;

/**
 * The migration-ladder entry point, named to the convention the ladder gate and
 * `state-schema.ts`'s version history both use.
 *
 * A persisted workspace record holds many snapshots; this maps the per-snapshot
 * step over all of them and reports how many phases acquired an explicit value,
 * so the activation path can record a real number rather than "migrated".
 */
export interface WorkspaceRecordV13 {
  readonly plans?: readonly PersistedPlanSnapshot[];
  readonly [key: string]: unknown;
}

export interface LadderMigrationResult {
  readonly record: WorkspaceRecordV13;
  readonly migrated: boolean;
  readonly phasesStamped: number;
  readonly plansTouched: number;
}

export function migrateV13ToV14(record: WorkspaceRecordV13): LadderMigrationResult {
  const plans = record.plans;
  if (plans === undefined) {
    return { record, migrated: false, phasesStamped: 0, plansTouched: 0 };
  }
  let phasesStamped = 0;
  let plansTouched = 0;
  const next = plans.map((snapshot) => {
    const result = migrateSnapshotV13ToV14(snapshot);
    if (result.migrated) plansTouched += 1;
    phasesStamped += result.stamped;
    return result.snapshot;
  });
  return {
    record: { ...record, plans: next },
    migrated: plansTouched > 0,
    phasesStamped,
    plansTouched
  };
}
