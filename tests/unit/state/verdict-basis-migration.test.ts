// FR-R4-F01 (spec 239, US4, T055, FR-016 to FR-019, contract V1, data-model §4) — the verdict
// basis of a frozen Run is migrated by the SHAPE of each Phase snapshot.
//
// `migrateV13ToV14` was pure and correct per snapshot, and called by nothing in `src/`: it expects
// a `record.plans` array and no persisted key has that shape. The snapshots execution actually
// reads are `WorkflowRun.pipeline.phases` and `WorkflowRun.envelope.pipeline.phases`. What dates
// a frozen Phase is the pair of fields it carries, because the commit that stamped schema v14 also
// introduced `hostVerificationDeclaredAt`, and every production freeze writes both:
//
//   hostVerification  declaredAt   class             write
//   present           present      current           none
//   present           absent       legacy-authored   declaredAt 'phase-definition'
//   absent            absent       legacy-default    'model-token', declaredAt 'default'
//   absent            present      unknown           resolveHostVerification(...), declaredAt kept

import { describe, expect, it } from 'vitest';
import { resolveHostVerification } from '../../../src/config/phase-runner-policy';
import { migrateRunVerdictBasis } from '../../../src/state/host-verification-migrator';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import { buildWorkflowRun } from '../../fixtures/state/queue-fixtures';

interface PhaseShape {
  readonly id: string;
  readonly name: string;
  readonly instruction: string;
  readonly sideEffects?: string;
  readonly hostVerification?: string;
  readonly hostVerificationDeclaredAt?: string;
}

const phase = (id: string, extra: Partial<PhaseShape> = {}): PhaseShape => ({
  id,
  name: id,
  instruction: `/${id}`,
  sideEffects: 'workspace',
  ...extra
});

const LEGACY_DEFAULT = phase('legacy-default');
const LEGACY_AUTHORED = phase('legacy-authored', { hostVerification: 'exit-code' });
const CURRENT = phase('current', {
  hostVerification: 'exit-code',
  hostVerificationDeclaredAt: 'phase-definition'
});
const UNKNOWN_LOAD_BEARING = phase('unknown-effects', { hostVerificationDeclaredAt: 'default' });
const UNKNOWN_INERT = phase('unknown-inert', {
  sideEffects: 'none',
  hostVerificationDeclaredAt: 'default'
});

/** A Run whose pipeline snapshot and envelope snapshot are the given Phase lists. */
function runWith(
  pipeline: readonly PhaseShape[] | undefined,
  envelope?: readonly PhaseShape[]
): WorkflowRun {
  const base = buildWorkflowRun({ id: 'run-v13', featureId: 'task-v13' });
  const withoutPipeline: Record<string, unknown> = { ...base };
  delete withoutPipeline.pipeline;
  return {
    ...withoutPipeline,
    ...(pipeline === undefined
      ? {}
      : { pipeline: { id: 'p', name: 'p', phases: pipeline } }),
    ...(envelope === undefined ? {} : { envelope: { pipeline: { id: 'p', name: 'p', phases: envelope } } })
  } as unknown as WorkflowRun;
}

const phasesOf = (run: WorkflowRun): readonly PhaseShape[] =>
  (run.pipeline as unknown as { phases: readonly PhaseShape[] }).phases;
const envelopePhasesOf = (run: WorkflowRun): readonly PhaseShape[] =>
  (run.envelope as unknown as { pipeline: { phases: readonly PhaseShape[] } }).pipeline.phases;
const byId = (phases: readonly PhaseShape[], id: string): PhaseShape =>
  phases.find((candidate) => candidate.id === id)!;

describe('each class of data-model §4 gets its write', () => {
  it('current: nothing is written, and the Run is the input object', () => {
    const run = runWith([CURRENT]);

    const result = migrateRunVerdictBasis(run);

    expect(result.changed).toBe(false);
    expect(result.run).toBe(run);
    expect(result.counts).toEqual({ current: 1, 'legacy-authored': 0, 'legacy-default': 0, unknown: 0 });
  });

  it('legacy-authored: the authored value is kept and its provenance recorded', () => {
    const result = migrateRunVerdictBasis(runWith([LEGACY_AUTHORED]));

    expect(byId(phasesOf(result.run), 'legacy-authored')).toMatchObject({
      hostVerification: 'exit-code',
      hostVerificationDeclaredAt: 'phase-definition'
    });
    expect(result.counts['legacy-authored']).toBe(1);
  });

  it("legacy-default: the OLD meaning is preserved, 'model-token' with provenance default", () => {
    const result = migrateRunVerdictBasis(runWith([LEGACY_DEFAULT]));

    expect(byId(phasesOf(result.run), 'legacy-default')).toMatchObject({
      hostVerification: 'model-token',
      hostVerificationDeclaredAt: 'default'
    });
    expect(result.changed).toBe(true);
    expect(result.counts['legacy-default']).toBe(1);
  });

  it('unknown: the value the runtime already applies is written, and the provenance is kept (G3)', () => {
    const result = migrateRunVerdictBasis(runWith([UNKNOWN_LOAD_BEARING, UNKNOWN_INERT]));

    const loadBearing = byId(phasesOf(result.run), 'unknown-effects');
    const inert = byId(phasesOf(result.run), 'unknown-inert');
    // The same call phase-runner.ts makes at runtime, so the applied policy does not change.
    expect(loadBearing.hostVerification).toBe(resolveHostVerification(undefined, 'workspace'));
    expect(loadBearing.hostVerification).toBe('exit-code');
    expect(inert.hostVerification).toBe(resolveHostVerification(undefined, 'none'));
    expect(loadBearing.hostVerificationDeclaredAt).toBe('default');
    expect(inert.hostVerificationDeclaredAt).toBe('default');
    expect(result.counts.unknown).toBe(2);
  });

  it("never writes 'model-token' into a Phase that carries a provenance (G4)", () => {
    const result = migrateRunVerdictBasis(runWith([UNKNOWN_LOAD_BEARING, CURRENT, LEGACY_DEFAULT]));

    for (const migrated of phasesOf(result.run)) {
      if (migrated.id === 'legacy-default') continue;
      expect(
        migrated.hostVerification === 'model-token' && migrated.sideEffects !== 'none',
        `${migrated.id} was given the weaker legacy default`
      ).toBe(false);
    }
  });
});

describe('the two snapshots are classified independently (G1)', () => {
  it('migrates the pipeline snapshot and leaves a current envelope snapshot as it is', () => {
    const run = runWith([LEGACY_DEFAULT], [CURRENT]);

    const result = migrateRunVerdictBasis(run);

    expect(byId(phasesOf(result.run), 'legacy-default').hostVerification).toBe('model-token');
    expect(envelopePhasesOf(result.run)).toBe(envelopePhasesOf(run));
  });

  it('migrates the envelope snapshot when only it is legacy', () => {
    const result = migrateRunVerdictBasis(runWith([CURRENT], [LEGACY_DEFAULT]));

    expect(byId(envelopePhasesOf(result.run), 'legacy-default').hostVerification).toBe('model-token');
  });

  it('counts a Phase once when the same snapshot is serialized in both places', () => {
    const result = migrateRunVerdictBasis(runWith([LEGACY_DEFAULT, CURRENT], [LEGACY_DEFAULT, CURRENT]));

    expect(result.counts).toEqual({ current: 1, 'legacy-authored': 0, 'legacy-default': 1, unknown: 0 });
  });

  it('leaves a Run with neither snapshot unchanged, as the same object', () => {
    const run = runWith(undefined);

    const result = migrateRunVerdictBasis(run);

    expect(result.changed).toBe(false);
    expect(result.run).toBe(run);
    expect(result.counts).toEqual({ current: 0, 'legacy-authored': 0, 'legacy-default': 0, unknown: 0 });
  });

  it('passes every other field through untouched', () => {
    const run = runWith([LEGACY_DEFAULT]);

    const { run: migrated } = migrateRunVerdictBasis(run);

    const { pipeline: _before, ...restBefore } = run;
    const { pipeline: _after, ...restAfter } = migrated;
    expect(restAfter).toEqual(restBefore);
  });
});

describe('idempotence and purity (G2)', () => {
  it('a second application changes nothing and counts only current', () => {
    const first = migrateRunVerdictBasis(
      runWith(
        [LEGACY_DEFAULT, LEGACY_AUTHORED, UNKNOWN_LOAD_BEARING, CURRENT],
        [LEGACY_DEFAULT, LEGACY_AUTHORED, UNKNOWN_LOAD_BEARING, CURRENT]
      )
    );

    const second = migrateRunVerdictBasis(first.run);

    expect(second.changed).toBe(false);
    expect(second.run).toBe(first.run);
    expect(second.counts).toEqual({ current: 4, 'legacy-authored': 0, 'legacy-default': 0, unknown: 0 });
  });

  it('does not mutate the Run it is handed', () => {
    const run = runWith([LEGACY_DEFAULT]);
    const before = JSON.stringify(run);

    migrateRunVerdictBasis(run);

    expect(JSON.stringify(run)).toBe(before);
  });
});
