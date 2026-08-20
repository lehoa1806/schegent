// FR-R3-008 (T383) — the denominator is frozen, so a settings change does not
// move it under a Run in flight.
//
// The anti-pattern the plan names is a best-effort estimate with a moving
// denominator. `loop.maxIterations` is a live workspace setting: derive the total
// on read and an operator who lowers it from 5 to 2 mid-run makes every in-flight
// Run's progress jump, which is worse than no progress reading at all, because it
// looks like measurement. The factory therefore reads the cap **once**, at
// creation, and every later consumer reads the frozen value back off the record.
//
// The test drives the setting through the same seam production uses — a
// `getIterationCap` thunk over a mutable value, which is what `options.iterationCap`
// is on the controller — and changes it after `create()` returns. The Run must not
// notice.

import { describe, expect, it } from 'vitest';
import {
  buildCatalog,
  type PhaseDef,
  type PipelineCatalog,
  type PipelineDef
} from '../../../src/config/pipeline-config';
import { isLoopPhase } from '../../../src/controller/phase';
import { SanitizedLogger } from '../../../src/lib/logger';
import {
  ensureExtendedFeatureRequest,
  type FeatureRequest
} from '../../../src/queue/feature-request';
import {
  computePlannedTotal,
  DEFAULT_ITERATION_CAP,
  MAX_ITERATION_CAP,
  MIN_ITERATION_CAP,
  freezeIterationCap
} from '../../../src/services/run-planned-total';
import { WorkflowRunFactory } from '../../../src/services/workflow-run-factory';

const SPECIFY: PhaseDef = {
  id: 'alpha', name: 'Alpha', version: 1, instruction: 'Alpha prompt.'
};
/**
 * The loop phase, whose weight in `maxPhaseInvocations` is the frozen cap.
 *
 * It loops because it carries a `retryCondition` — the field the controller
 * actually reads — not because of the deprecated `loopable` flag.
 */
const LOOPING: PhaseDef = {
  id: 'beta',
  name: 'Beta',
  version: 1,
  instruction: 'Beta prompt.',
  retryCondition: 'open_questions > 0'
};
const DONE: PhaseDef = {
  id: 'done', name: 'Done', version: 1, instruction: '(no-op)'
};

const AB_FLOW: PipelineDef = {
  id: 'ab-flow', name: 'A then B', phases: ['alpha', 'beta']
};

function catalog(): PipelineCatalog {
  return buildCatalog([SPECIFY, LOOPING, DONE], [AB_FLOW], { claude: [], codex: [], agy: [] }, 'ab-flow');
}

function plainItem(): FeatureRequest {
  return ensureExtendedFeatureRequest({
    id: 'req-1',
    description: 'started the ordinary way',
    enqueuedAt: 1,
    status: 'pending',
    position: 0,
    runId: null
  });
}

/** A factory whose cap thunk reads a value the test can change afterwards. */
function factoryWithLiveCap(initial: number): {
  factory: WorkflowRunFactory;
  setCap: (next: number) => void;
} {
  let cap = initial;
  const factory = new WorkflowRunFactory({
    getCatalog: catalog,
    defaultRunnerKind: 'claude',
    getIterationCap: () => cap,
    logger: new SanitizedLogger()
  });
  return { factory, setCap: (next: number) => { cap = next; } };
}

describe('FR-R3-008 — the progress denominator is frozen at run creation', () => {
  it('keeps the recorded total when loop.maxIterations changes from 5 to 2 mid-run', async () => {
    const { factory, setCap } = factoryWithLiveCap(5);
    const run = await factory.create(plainItem(), 'specs/001-thing', 'ab-flow');

    // The pipeline is alpha + beta(loopable); only beta carries the cap's weight,
    // so 1 + 5 = 6. Feature 098 (T025, FR-022) removed the terminal `done` the
    // resolver used to append, which is where the third phase and the seventh
    // invocation came from.
    expect(run.plannedTotal).toEqual({
      phaseCount: 2,
      iterationCap: 5,
      maxPhaseInvocations: 6
    });

    setCap(2);

    // Nothing re-reads the setting on the Run's behalf: the record is the source.
    expect(run.plannedTotal!.iterationCap, 'the frozen cap, not the live one').toBe(5);
    expect(run.plannedTotal!.maxPhaseInvocations).toBe(6);

    // And a Run created *after* the change gets the new cap, which is what makes
    // the first assertion about freezing rather than about the thunk being unread.
    const later = await factory.create(plainItem(), 'specs/002-thing', 'ab-flow');
    expect(later.plannedTotal).toEqual({
      phaseCount: 2,
      iterationCap: 2,
      maxPhaseInvocations: 3
    });
  });

  it('records a total on every run it creates, so absence means a legacy record', async () => {
    // No `getIterationCap` wired at all — the documented fallback still produces a
    // total, because a projector can only render absence as "unknown" if presence
    // is unconditional for every Run written after the feature.
    const factory = new WorkflowRunFactory({
      getCatalog: catalog,
      defaultRunnerKind: 'claude',
      logger: new SanitizedLogger()
    });
    const run = await factory.create(plainItem(), 'specs/001-thing', 'ab-flow');
    expect(run.plannedTotal!.iterationCap).toBe(DEFAULT_ITERATION_CAP);
    expect(run.plannedTotal!.phaseCount).toBe(2);
  });

  it('freezes a total with no overrides applied, whatever the run start phase', async () => {
    const { factory } = factoryWithLiveCap(5);
    // `featureDir: null` starts at the first phase; a directory starts after
    // `speckit-specify`. Neither changes the plan, so neither changes the total.
    const fresh = await factory.create(plainItem(), null, 'ab-flow');
    const resumed = await factory.create(plainItem(), 'specs/001-thing', 'ab-flow');
    expect(fresh.plannedTotal).toEqual(resumed.plannedTotal);
    expect(fresh.phaseOverrides).toEqual([]);
  });

  it('clamps an out-of-range cap at the freeze rather than at each read', () => {
    // The setting arrives from workspace configuration, so it may be absent,
    // fractional, or out of range. A zero cap would claim a loop phase never runs.
    expect(freezeIterationCap(0)).toBe(MIN_ITERATION_CAP);
    expect(freezeIterationCap(-4)).toBe(MIN_ITERATION_CAP);
    expect(freezeIterationCap(999)).toBe(MAX_ITERATION_CAP);
    expect(freezeIterationCap(3.7)).toBe(3);
    expect(freezeIterationCap(undefined)).toBe(DEFAULT_ITERATION_CAP);
    expect(freezeIterationCap(Number.NaN)).toBe(DEFAULT_ITERATION_CAP);
  });

  it('counts distinct ids for the denominator and positions for the ceiling', () => {
    // A pipeline may list the same phase twice. Both positions produce
    // `PhaseResult` entries under one id, so the numerator can only ever reach one
    // — which is why `phaseCount` is a distinct-id count while
    // `maxPhaseInvocations`, a count of CLI invocations, is positional.
    const total = computePlannedTotal({
      phases: [{ id: 'alpha' }, { id: 'beta', retryCondition: 'x > 0' }, { id: 'alpha' }],
      overrides: [],
      iterationCap: 4
    });
    expect(total.phaseCount).toBe(2);
    expect(total.maxPhaseInvocations).toBe(1 + 4 + 1);
  });

  it('excludes an overridden phase from the total it records', () => {
    const total = computePlannedTotal({
      phases: [{ id: 'alpha' }, { id: 'beta', retryCondition: 'x > 0' }, { id: 'done' }],
      overrides: [{ phaseId: 'beta', action: 'skipped', setAt: 1, actor: 'operator' }],
      iterationCap: 5
    });
    expect(total.phaseCount, 'alpha and done').toBe(2);
    expect(total.maxPhaseInvocations, 'the loop phase contributes nothing once skipped').toBe(2);
  });
});

// The ceiling weights the phases that can actually loop — the same phases the
// controller will actually loop.
//
// `maxPhaseInvocations` weighted `loopable === true`, and the controller has
// never read `loopable`: `transition()` loops a phase when its `retryCondition`
// is non-empty and truthy, and its `loopable` fallback is reachable only when no
// phase definition is passed at all (which the production path always does). The
// manifest says as much — "Deprecated compatibility field... Loop behavior is
// controlled by retryCondition".
//
// So the ceiling was wrong in both directions on any runtime-imported catalog: a
// Phase declaring `retryCondition` and no `loopable` (which is every Phase in
// `examples/`, and the only shape the YAML writer emits) was weighted 1 while it
// could run the cap; a Phase declaring the deprecated `loopable` alone was
// weighted the cap while it could only ever run once.
describe('the ceiling weights what the controller loops (FR-R3-008)', () => {
  const CAP = 4;

  function ceiling(phase: Parameters<typeof computePlannedTotal>[0]['phases']): number {
    return computePlannedTotal({ phases: phase, overrides: [], iterationCap: CAP })
      .maxPhaseInvocations;
  }

  it('weights a phase carrying a retryCondition by the cap', () => {
    expect(ceiling([{ id: 'beta', retryCondition: 'open_questions > 0' }])).toBe(CAP);
  });

  it('does not weight a phase carrying only the deprecated loopable flag', () => {
    expect(ceiling([{ id: 'beta', loopable: true }])).toBe(1);
  });

  it('weights a phase with neither field once', () => {
    expect(ceiling([{ id: 'alpha' }])).toBe(1);
  });

  it('ignores loopable entirely, in both directions', () => {
    // `loopable: false` beside a real condition must not suppress the weight,
    // and `loopable: true` without one must not create it.
    expect(ceiling([{ id: 'beta', retryCondition: 'x > 0', loopable: false }])).toBe(CAP);
    expect(ceiling([{ id: 'beta', loopable: true }])).toBe(1);
  });

  it('treats a blank condition as no condition, as the transition does', () => {
    // `transition()` consults the condition only when it is non-empty after
    // trimming, so a whitespace-only string loops nothing and must weigh 1.
    expect(ceiling([{ id: 'beta', retryCondition: '   ' }])).toBe(1);
  });

  it('agrees with the loop predicate the controller applies, on every shape', () => {
    // The two rules are one rule. Asserted against `isLoopPhase` rather than
    // restated, so a change to the controller's predicate that is not mirrored
    // here fails rather than drifts — the ceiling and the looping are the same
    // claim about the same phase.
    const shapes = [
      { id: 'a' },
      { id: 'b', retryCondition: 'x > 0' },
      { id: 'c', retryCondition: '' },
      { id: 'd', loopable: true },
      { id: 'e', retryCondition: 'x > 0', loopable: false }
    ];
    for (const shape of shapes) {
      const expected = isLoopPhase(shape.id, shape) ? CAP : 1;
      expect(ceiling([shape]), `weight for ${JSON.stringify(shape)}`).toBe(expected);
    }
  });
});
