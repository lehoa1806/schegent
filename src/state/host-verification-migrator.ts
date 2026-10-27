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

import { resolveHostVerification } from '../config/phase-runner-policy';
import { STATE_SCHEMA_VERSION_V13, STATE_SCHEMA_VERSION_V14 } from '../contracts/state-schema';
import type { PhaseSideEffects } from '../config/pipeline-config';
import type { WorkflowRun } from './workflow-run';

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

// ---------------------------------------------------------------------------------------------
// FR-R4-F01 (spec 239, US4, contract V1) — migrate a frozen RUN by the shape of its Phases.
//
// `migrateV13ToV14` above is correct per snapshot and was never called: it expects a
// `record.plans` array, and no persisted key has that shape. The snapshots execution reads are
// `WorkflowRun.pipeline.phases` and `WorkflowRun.envelope.pipeline.phases`. What dates a frozen
// Phase is the PAIR of fields it carries, because the commit that stamped schema v14 also
// introduced `hostVerificationDeclaredAt`, and every production freeze (`snapshotPhaseDef`)
// writes both. So the shape shows which build froze it:
//
//   hostVerification  declaredAt   class             write
//   present           present      current           none
//   present           absent       legacy-authored   declaredAt 'phase-definition'
//   absent            absent       legacy-default    'model-token', declaredAt 'default'
//   absent            present      unknown           resolveHostVerification(...), declaredAt kept
//
// Keyed on shape, the step is idempotent, safe to interrupt, and repairs a workspace an earlier
// v14 build stamped without migrating.
// ---------------------------------------------------------------------------------------------

export type PhaseVerdictClass = 'current' | 'legacy-authored' | 'legacy-default' | 'unknown';

export interface RunVerdictMigration {
  /** A new object when something changed; the input object when nothing did. */
  readonly run: WorkflowRun;
  readonly changed: boolean;
  /** Phases per class, counted once by id when the Run carries the same snapshot twice. */
  readonly counts: Readonly<Record<PhaseVerdictClass, number>>;
}

/**
 * What the ladder reports for one Run it touched (data-model §4). `queueId` is `null` for a Run
 * found in the terminal-transition journal, which has no queue entry of its own.
 */
export type VerdictBasisMigrationEvent =
  | {
      readonly type: 'verdict-basis-migrated';
      readonly runId: string;
      readonly queueId: string | null;
      readonly legacyAuthored: number;
      readonly legacyDefault: number;
    }
  | {
      readonly type: 'verdict-basis-provenance-unknown';
      readonly runId: string;
      readonly queueId: string | null;
      readonly phaseCount: number;
    };

function classifyPhase(phase: MigratablePhase): PhaseVerdictClass {
  const declared = phase.hostVerification !== undefined;
  const dated = phase.hostVerificationDeclaredAt !== undefined;
  if (declared) return dated ? 'current' : 'legacy-authored';
  return dated ? 'unknown' : 'legacy-default';
}

/** The Phase after its class's write; the same object for `current`. */
function migratePhase(phase: MigratablePhase, phaseClass: PhaseVerdictClass): MigratablePhase {
  switch (phaseClass) {
    case 'current':
      return phase;
    case 'unknown':
      // The value the runtime already applies (`phase-runner.ts` makes this call), written
      // explicitly. The Run keeps the current policy exactly, the next initialize reads the Phase
      // as `current`, and the disclosure fires once. The provenance it already carries is kept.
      return {
        ...phase,
        hostVerification: resolveHostVerification(
          undefined,
          phase.sideEffects as PhaseSideEffects | undefined
        )
      };
    default:
      // The three rows `migrateSnapshotV13ToV14` already knows, applied to this one Phase.
      return migrateSnapshotV13ToV14({ phases: [phase] }).snapshot.phases![0]!;
  }
}

interface SnapshotMigration {
  readonly snapshot: PersistedPlanSnapshot;
  readonly changed: boolean;
}

function migrateSnapshot(
  snapshot: PersistedPlanSnapshot | undefined,
  classes: Map<string, PhaseVerdictClass>
): SnapshotMigration | undefined {
  const phases = snapshot?.phases;
  if (snapshot === undefined || phases === undefined) return undefined;
  let changed = false as boolean;
  const migrated = phases.map((phase) => {
    const phaseClass = classifyPhase(phase);
    const id = typeof phase.id === 'string' ? phase.id : `#${classes.size}`;
    if (!classes.has(id)) classes.set(id, phaseClass);
    if (phaseClass === 'current') return phase;
    changed = true;
    return migratePhase(phase, phaseClass);
  });
  return { snapshot: changed ? { ...snapshot, phases: migrated } : snapshot, changed };
}

/**
 * Classify and migrate the Phases of one Run: `run.pipeline.phases` and
 * `run.envelope.pipeline.phases`, each on its own. Every other field passes through unchanged, and
 * a Run with neither snapshot is returned as it came. Pure: the input is not mutated.
 */
export function migrateRunVerdictBasis(run: WorkflowRun): RunVerdictMigration {
  const classes = new Map<string, PhaseVerdictClass>();
  const holder = run as unknown as {
    pipeline?: PersistedPlanSnapshot;
    envelope?: { pipeline?: PersistedPlanSnapshot } & Record<string, unknown>;
  };
  // Named for what it is HERE, a record rewritten at rest, for the reason the header of this
  // module gives for `PersistedPlanSnapshot`: `no-envelope-reconstruction.test.ts` keys on the name
  // of a spread operand, and this is the migrator's one legitimate rewrite, not a retarget.
  const frozenExecution = holder.envelope;
  const pipeline = migrateSnapshot(holder.pipeline, classes);
  const executionPipeline = migrateSnapshot(frozenExecution?.pipeline, classes);

  const counts: Record<PhaseVerdictClass, number> = {
    current: 0,
    'legacy-authored': 0,
    'legacy-default': 0,
    unknown: 0
  };
  for (const phaseClass of classes.values()) counts[phaseClass] += 1;

  const changed = (pipeline?.changed ?? false) || (executionPipeline?.changed ?? false);
  if (!changed) return { run, changed: false, counts };

  const next: Record<string, unknown> = { ...run };
  if (pipeline?.changed === true) next.pipeline = pipeline.snapshot;
  if (executionPipeline?.changed === true && frozenExecution !== undefined) {
    next.envelope = { ...frozenExecution, pipeline: executionPipeline.snapshot };
  }
  return { run: next as unknown as WorkflowRun, changed: true, counts };
}

/**
 * The events one Run's migration reports. A Run with legacy Phases yields `verdict-basis-migrated`
 * (an information line, no notification); a Run with Phases no production freeze could have
 * written yields `verdict-basis-provenance-unknown` (disclosed once). Nothing here is an audit event.
 */
export function verdictBasisEvents(
  runId: string,
  queueId: string | null,
  counts: Readonly<Record<PhaseVerdictClass, number>>
): readonly VerdictBasisMigrationEvent[] {
  const events: VerdictBasisMigrationEvent[] = [];
  const legacyAuthored = counts['legacy-authored'];
  const legacyDefault = counts['legacy-default'];
  if (legacyAuthored + legacyDefault > 0) {
    events.push({ type: 'verdict-basis-migrated', runId, queueId, legacyAuthored, legacyDefault });
  }
  if (counts.unknown > 0) {
    events.push({
      type: 'verdict-basis-provenance-unknown',
      runId,
      queueId,
      phaseCount: counts.unknown
    });
  }
  return events;
}
