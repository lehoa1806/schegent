import { describe, it, expect } from 'vitest';
import {
  transition,
  isLoopPhase,
  nextSuccessor,
  DEGRADED_CONTINUE_NOTIFY_TAG,
  FORCE_CONTINUE_NOTIFY_TAG,
  INCOMPLETE_TURN_UNRESOLVED_CAUSE,
  LAST_PHASE_ISSUES_REMAIN_CAUSE,
  type PhaseDefLike,
  type TransitionInput
} from '../../../src/controller/phase';
import { resolveRetryCapOutcome } from '../../../src/contracts/retry-cap-outcome';
import {
  FIXTURE_PHASES,
  FIXTURE_PHASE_FIRST,
  FIXTURE_PHASE_SECOND
} from '../../fixtures/process-catalog-fixture';

// Feature 098 (T080) — `lists the nine invocable phases` stood at the head of this
// describe. It asserted the contents of `INVOCABLE_PHASES`, which T038 deleted:
// there is no fixed set of Phase ids the host can invoke, because an operator's
// Phase id is data. The hardcoded successor chain below is the module's own
// no-pipeline fallback and is asserted as such, not as a vocabulary.
describe('Phase enum and transitions', () => {
  it('marks clarify, analyze, implement, and review as loop phases', () => {
    expect(isLoopPhase('speckit-clarify')).toBe(true);
    expect(isLoopPhase('speckit-analyze')).toBe(true);
    expect(isLoopPhase('speckit-implement')).toBe(true);
    expect(isLoopPhase('speckit-review')).toBe(true);
    expect(isLoopPhase('speckit-plan')).toBe(false);
    expect(isLoopPhase('speckit-checklist')).toBe(false);
  });

  it('walks the linear successor chain', () => {
    expect(nextSuccessor('speckit-specify')).toBe('speckit-clarify');
    expect(nextSuccessor('speckit-clarify')).toBe('speckit-plan');
    expect(nextSuccessor('speckit-plan')).toBe('speckit-tasks');
    expect(nextSuccessor('speckit-tasks')).toBe('speckit-checklist');
    expect(nextSuccessor('speckit-checklist')).toBe('speckit-analyze');
    expect(nextSuccessor('speckit-analyze')).toBe('speckit-implement');
    expect(nextSuccessor('speckit-implement')).toBe('speckit-review');
    expect(nextSuccessor('speckit-review')).toBe('finalize');
    expect(nextSuccessor('finalize')).toBe('done');
    expect(nextSuccessor('done')).toBe('done');
  });

  it('advances on clean outcome', () => {
    const result = transition({ phase: 'speckit-specify', outcome: 'clean', iteration: 1, iterationCap: 10 });
    expect(result.kind).toBe('advance');
    if (result.kind === 'advance') {
      expect(result.nextPhase).toBe('speckit-clarify');
      expect(result.nextIteration).toBe(1);
    }
  });

  it('loops clarify when issues remain and iteration < cap', () => {
    const result = transition({ phase: 'speckit-clarify', outcome: 'issues_remain', iteration: 2, iterationCap: 10 });
    expect(result.kind).toBe('loop');
    if (result.kind === 'loop') {
      expect(result.nextIteration).toBe(3);
    }
  });

  it('force-advances clarify at iteration cap with warning', () => {
    const result = transition({
      phase: 'speckit-clarify',
      outcome: 'issues_remain',
      iteration: 10,
      iterationCap: 10
    });
    expect(result.kind).toBe('advance');
    if (result.kind === 'advance') {
      expect(result.nextPhase).toBe('speckit-plan');
    }
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('halts with paused on rate_limited', () => {
    const result = transition({ phase: 'speckit-specify', outcome: 'rate_limited', iteration: 1, iterationCap: 10 });
    expect(result.kind).toBe('halt');
    if (result.kind === 'halt') {
      expect(result.status).toBe('paused');
    }
  });

  it('halts with failed on failed and timeout', () => {
    const failed = transition({ phase: 'speckit-plan', outcome: 'failed', iteration: 1, iterationCap: 10 });
    expect(failed.kind).toBe('halt');
    if (failed.kind === 'halt') expect(failed.status).toBe('failed');

    const timeout = transition({ phase: 'speckit-plan', outcome: 'timeout', iteration: 1, iterationCap: 10 });
    expect(timeout.kind).toBe('halt');
    if (timeout.kind === 'halt') expect(timeout.status).toBe('failed');
  });

  it.each(['failed', 'timeout'] as const)(
    'advances after a terminal %s outcome when the phase is explicitly optional',
    (outcome) => {
      const result = transition({
        phase: 'speckit-plan',
        outcome,
        iteration: 2,
        iterationCap: 10,
        phaseDef: { id: 'speckit-plan', isRequired: false }
      });

      expect(result.kind).toBe('advance');
      if (result.kind === 'advance') {
        expect(result.nextPhase).toBe('speckit-tasks');
      }
      expect(result.warnings).toEqual([
        `optional phase speckit-plan ${outcome}; continuing`
      ]);
    }
  );

  it.each([undefined, true] as const)(
    'keeps failed outcomes fail-stop when isRequired is %s',
    (isRequired) => {
      const result = transition({
        phase: 'speckit-plan',
        outcome: 'failed',
        iteration: 1,
        iterationCap: 10,
        phaseDef: {
          id: 'speckit-plan',
          ...(isRequired === undefined ? {} : { isRequired })
        }
      });

      expect(result.kind).toBe('halt');
      if (result.kind === 'halt') expect(result.status).toBe('failed');
    }
  );

  it.each(['rate_limited', 'transient_error'] as const)(
    'does not bypass retry policy for optional %s outcomes',
    (outcome) => {
      const result = transition({
        phase: 'speckit-plan',
        outcome,
        iteration: 1,
        iterationCap: 10,
        phaseDef: { id: 'speckit-plan', isRequired: false }
      });

      expect(result.kind).toBe('halt');
      if (result.kind === 'halt') expect(result.status).toBe('paused');
    }
  );

  it('advances skipped phases without treating them as failed', () => {
    const result = transition({
      phase: 'speckit-plan',
      outcome: 'skipped',
      iteration: 1,
      iterationCap: 10
    });

    expect(result.kind).toBe('advance');
    if (result.kind === 'advance') {
      expect(result.nextPhase).toBe('speckit-tasks');
    }
  });

  it('issues_remain on a non-loop phase advances normally', () => {
    const result = transition({ phase: 'speckit-plan', outcome: 'issues_remain', iteration: 1, iterationCap: 10 });
    expect(result.kind).toBe('advance');
  });

  describe('catalog-driven dispatch', () => {
    // Feature 098 (T080) — the pipeline under test was assembled from
    // `BUILT_IN_PIPELINE.phases` resolved against `BUILT_IN_PHASES`, so the
    // successor assertions read as facts about the speckit sequence when what
    // they establish is that `nextSuccessor` walks whatever sequence it is
    // handed. The fixture rows carry ids the product does not recognise, which is
    // the point: the walk cannot be coming from anywhere but the argument.
    const pipeline = { phases: FIXTURE_PHASES };
    const [first, second, third] = FIXTURE_PHASES;
    const last = FIXTURE_PHASES[FIXTURE_PHASES.length - 1];

    it('nextSuccessor walks the pipeline it is given', () => {
      expect(nextSuccessor(first.id, pipeline)).toBe(second.id);
      expect(nextSuccessor(second.id, pipeline)).toBe(third.id);
      expect(nextSuccessor(last.id, pipeline)).toBe('done');
      expect(nextSuccessor('done', pipeline)).toBe('done');
      // The hardcoded fallback chain does not leak in: `speckit-specify` is not a
      // member of this pipeline, so it terminates rather than advancing to
      // `speckit-clarify`.
      expect(nextSuccessor('speckit-specify', pipeline)).toBe('done');
    });

    it('nextSuccessor returns done for unknown phase id within a pipeline', () => {
      expect(nextSuccessor('not-a-phase', pipeline)).toBe('done');
    });

    it('isLoopPhase consults the PhaseDef.retryCondition when supplied', () => {
      expect(isLoopPhase('foo', { id: 'foo', retryCondition: 'open_questions > 0' })).toBe(true);
      expect(isLoopPhase('foo', { id: 'foo', retryCondition: undefined })).toBe(false);
      // Blank is not a condition. `transition()` consults the condition only
      // when it is non-empty after trimming, so a whitespace-only string must
      // not make the phase a loop phase to this predicate either — otherwise it
      // loops on `issues_remain` through the legacy branch with nothing to
      // evaluate and nothing to end it.
      expect(isLoopPhase('foo', { id: 'foo', retryCondition: '   ' })).toBe(false);
      expect(isLoopPhase('foo', { id: 'foo', retryCondition: '' })).toBe(false);
    });

    // The successor's starting iteration is read off the successor's own
    // definition, not off its id.
    //
    // `transition()` returned `nextIteration: isLoopPhase(next) ? 1 : 0` with no
    // definition at six sites, so the answer came from `LOOP_PHASES` — four
    // hardcoded speckit ids. On an imported catalog that is an off-by-one on the
    // operator's own bound: a loop phase entered at iteration 0 runs at 0,1,…,cap
    // before `iteration >= iterationCap` bites, which is cap+1 invocations of a
    // phase the frozen `maxPhaseInvocations` weighted at cap.
    describe('the successor enters at the iteration its own definition implies', () => {
      const advance = (from: string) =>
        transition({
          phase: from,
          outcome: 'clean',
          iteration: 1,
          iterationCap: 5,
          pipeline,
          phaseDef: FIXTURE_PHASES.find((phase) => phase.id === from)
        });

      it('enters a looping successor at 1, though its id is in no hardcoded set', () => {
        const result = advance(first.id);
        expect(result.kind).toBe('advance');
        if (result.kind !== 'advance') return;
        expect(result.nextPhase, 'the looping fixture phase').toBe(second.id);
        expect(result.nextIteration).toBe(1);
      });

      it('enters a non-looping successor at 0', () => {
        const result = advance(second.id);
        expect(result.kind).toBe('advance');
        if (result.kind !== 'advance') return;
        expect(result.nextPhase).toBe(third.id);
        expect(result.nextIteration).toBe(0);
      });

      it('does not read the successor id against the legacy loop set', () => {
        // A pipeline whose successor is *named* `speckit-clarify` but declares no
        // condition. The id is in `LOOP_PHASES`; the phase does not loop, so it
        // must enter at 0. The legacy set may only answer when there is no
        // pipeline to ask.
        const named = {
          phases: [{ id: 'lead' }, { id: 'speckit-clarify' }]
        };
        const result = transition({
          phase: 'lead', outcome: 'clean', iteration: 1, iterationCap: 5, pipeline: named
        });
        expect(result.kind).toBe('advance');
        if (result.kind !== 'advance') return;
        expect(result.nextPhase).toBe('speckit-clarify');
        expect(result.nextIteration).toBe(0);
      });

      it('still answers from the legacy set when no pipeline is supplied', () => {
        // The no-pipeline fallback is unchanged: a caller with no plan to consult
        // gets the hardcoded chain and the hardcoded loop set, together.
        const result = transition({
          phase: 'speckit-specify', outcome: 'clean', iteration: 1, iterationCap: 5
        });
        expect(result.kind).toBe('advance');
        if (result.kind !== 'advance') return;
        expect(result.nextPhase).toBe('speckit-clarify');
        expect(result.nextIteration).toBe(1);
      });

      it('enters the looping successor at 1 on every path that advances', () => {
        // All six sites, not just the clean one: skipped, optional-failure,
        // condition-falsy, forced-continue-at-cap, legacy-cap force-advance, and
        // the final fall-through. Each returns the successor's own entry
        // iteration or none of them can be trusted.
        const toSecond = { phase: first.id, iterationCap: 5, pipeline };
        const def = FIXTURE_PHASE_FIRST;
        const paths: ReadonlyArray<readonly [string, TransitionInput]> = [
          ['skipped', { ...toSecond, outcome: 'skipped', iteration: 1 }],
          ['optional failure', {
            ...toSecond, outcome: 'failed', iteration: 1,
            phaseDef: { ...def, isRequired: false }
          }],
          ['condition falsy', {
            ...toSecond, outcome: 'clean', iteration: 1,
            phaseDef: { ...def, retryCondition: 'pending_tasks > 0' }, metrics: { pending_tasks: 0 }
          }],
          ['forced continue at cap', {
            ...toSecond, outcome: 'issues_remain', iteration: 5,
            phaseDef: { ...def, retryCondition: 'pending_tasks > 0' },
            capOutcome: 'continue',
            metrics: { pending_tasks: 2 }
          }],
          // The legacy branch: no `phaseDef`, so `speckit-clarify` loops from
          // `LOOP_PHASES`, hits the cap, and force-advances into the fixture
          // phase that does declare a condition.
          ['legacy cap force-advance', {
            phase: 'speckit-clarify', outcome: 'issues_remain', iteration: 5, iterationCap: 5,
            pipeline: { phases: [{ id: 'speckit-clarify' }, FIXTURE_PHASE_SECOND] }
          }],
          ['fall-through', { ...toSecond, outcome: 'issues_remain', iteration: 1 }]
        ];

        for (const [name, input] of paths) {
          const result = transition(input);
          expect(result.kind, `${name} advances`).toBe('advance');
          if (result.kind !== 'advance') continue;
          expect(result.nextPhase, `${name} reaches the looping phase`).toBe(second.id);
          expect(result.nextIteration, `${name} enters at 1`).toBe(1);
        }
      });
    });
  });

  // FR-R3-199 — a last phase that reported issues outstanding advanced to `done`
  // like a clean one, and the driver marked the Run `completed`: the queue started
  // its next task and `errors-only` retention deleted the transcript. A required
  // last phase now halts the Run `failed`, on that phase, so a resume re-runs it.
  describe('a last phase that ends with issues outstanding (FR-R3-199)', () => {
    // No phase declares a retryCondition: the rule is about position alone.
    const middle: PhaseDefLike = { id: 'middle' };
    const final: PhaseDefLike = { id: 'final' };
    const pipeline = { phases: [{ id: 'lead' }, middle, final] };
    const atFinal = (outcome: TransitionInput['outcome'], phaseDef: PhaseDefLike = final) =>
      transition({ phase: final.id, outcome, iteration: 1, iterationCap: 5, pipeline, phaseDef });

    it('halts failed when the phase is required', () => {
      const result = atFinal('issues_remain');
      expect(result).toMatchObject({
        kind: 'halt',
        status: 'failed',
        cause: LAST_PHASE_ISSUES_REMAIN_CAUSE
      });
      expect(result.warnings.some((w) => w.includes(final.id))).toBe(true);
    });

    it('advances to done when the phase is optional', () => {
      const result = atFinal('issues_remain', { ...final, isRequired: false });
      expect(result).toMatchObject({ kind: 'advance', nextPhase: 'done' });
    });

    it('advances from a middle phase', () => {
      const result = transition({
        phase: middle.id, outcome: 'issues_remain', iteration: 1, iterationCap: 5,
        pipeline, phaseDef: middle
      });
      expect(result).toMatchObject({ kind: 'advance', nextPhase: final.id });
    });

    it('advances to done when the last phase is clean', () => {
      expect(atFinal('clean')).toMatchObject({ kind: 'advance', nextPhase: 'done' });
    });

    it("leaves a falsy retryCondition's answer alone", () => {
      // The condition is the operator's own answer to whether the phase is done,
      // so the rule stays out of that arm.
      const result = transition({
        phase: final.id, outcome: 'issues_remain', iteration: 1, iterationCap: 5, pipeline,
        phaseDef: { ...final, retryCondition: 'pending_tasks > 0' }, metrics: { pending_tasks: 0 }
      });
      expect(result).toMatchObject({ kind: 'advance', nextPhase: 'done' });
    });
  });

  // FR-R3-198 — a phase still unfinished after the dispatch's immediate resumes
  // never reported anything, so it halts the Run `failed` on that phase. An
  // optional phase that `failed` advances; this one does not, wherever it sits.
  describe('a phase that ended its turn unfinished (FR-R3-198, T1877)', () => {
    const middle: PhaseDefLike = { id: 'middle' };
    const final: PhaseDefLike = { id: 'final' };
    const pipeline = { phases: [{ id: 'lead' }, middle, final] };

    it('names its cause incomplete_turn_unresolved', () => {
      expect(INCOMPLETE_TURN_UNRESOLVED_CAUSE).toBe('incomplete_turn_unresolved');
    });

    for (const phaseDef of [middle, final]) {
      for (const isRequired of [true, false]) {
        it(`halts failed from the ${phaseDef.id} phase with isRequired ${isRequired}`, () => {
          const result = transition({
            phase: phaseDef.id, outcome: 'incomplete_turn', iteration: 1, iterationCap: 5,
            pipeline, phaseDef: { ...phaseDef, isRequired }
          });
          expect(result).toMatchObject({
            kind: 'halt',
            status: 'failed',
            cause: 'incomplete_turn_unresolved'
          });
        });
      }
    }
  });

  describe('retryCondition truth table (010, T023, US2)', () => {
    const PHASE_DEF = {
      id: 'security-audit',
      retryCondition: 'open_questions > 0'
    };

    it('clean + truthy expression loops (overrides CLEAR) — FR-010', () => {
      const result = transition({
        phase: 'security-audit',
        outcome: 'clean',
        iteration: 1,
        iterationCap: 5,
        phaseDef: PHASE_DEF,
        metrics: { open_questions: 2 }
      });
      expect(result.kind).toBe('loop');
      if (result.kind === 'loop') {
        expect(result.nextIteration).toBe(2);
      }
    });

    it('open_questions + falsy expression advances — FR-010', () => {
      const result = transition({
        phase: 'security-audit',
        outcome: 'issues_remain',
        iteration: 1,
        iterationCap: 5,
        phaseDef: PHASE_DEF,
        metrics: { open_questions: 0 }
      });
      expect(result.kind).toBe('advance');
    });

    it('cap reached + truthy expression halts failed with cause cap_exhausted — FR-010, SC-009', () => {
      const result = transition({
        phase: 'security-audit',
        outcome: 'clean',
        iteration: 5,
        iterationCap: 5,
        phaseDef: PHASE_DEF,
        metrics: { open_questions: 3 }
      });
      expect(result.kind).toBe('halt');
      if (result.kind === 'halt') {
        expect(result.status).toBe('failed');
        expect(result.cause).toBe('cap_exhausted');
      }
    });

    describe('forceContinueOnRetryCap', () => {
      // The escape hatch is scoped to cap exhaustion and nothing else: a phase
      // whose retryCondition never went falsy advances instead of halting, and
      // says so under a notification tag. It is NOT a way past a `failed` or
      // `timeout` outcome — those are terminal before the cap is ever read.
      //
      // FR-R3-157 (decision D-I1) — `transition()` no longer takes the boolean or
      // the workspace default; it takes the outcome those two resolve to. Each
      // test below keeps every assertion it had and changes only how `capOutcome`
      // is BUILT: through `resolveRetryCapOutcome`, the real production resolver,
      // fed the same two inputs the test used to pass to `transition()` directly.
      // The precedence claim is therefore still made end to end, through the same
      // two collaborators the production path uses — rewriting these to pass a
      // literal `capOutcome` instead is what would have weakened them, because
      // three of the four would then assert the same tautology.
      const CAP_EXHAUSTED = {
        phase: 'security-audit',
        outcome: 'clean',
        iteration: 5,
        iterationCap: 5,
        metrics: { open_questions: 3 }
      } as const;

      it('advances past the cap and tags the warning when the phase opts in', () => {
        const result = transition({
          ...CAP_EXHAUSTED,
          phaseDef: PHASE_DEF,
          capOutcome: resolveRetryCapOutcome(
            { ...PHASE_DEF, forceContinueOnRetryCap: true },
            undefined
          )
        });

        expect(result.kind).toBe('advance');
        if (result.kind !== 'advance') return;
        expect(result.nextPhase).toBe(nextSuccessor('security-audit', undefined));
        expect(result.warnings.some((w) => w.startsWith(FORCE_CONTINUE_NOTIFY_TAG))).toBe(true);
        expect(result.warnings.join(' ')).toContain('UNVERIFIED');
      });

      it('advances when only the workspace default opts in', () => {
        const result = transition({
          ...CAP_EXHAUSTED,
          phaseDef: PHASE_DEF,
          // `{}` rather than `PHASE_DEF`: the compiler REFUSES `PHASE_DEF` here
          // (TS2559, no properties in common with `RetryCapDefLike`) because it
          // states neither cap field, which is the precondition this test is
          // about. The refusal is the proof; `{}` is what PHASE_DEF contributes.
          capOutcome: resolveRetryCapOutcome({}, true)
        });

        expect(result.kind).toBe('advance');
      });

      it('lets an explicit phase `false` override a workspace default of true', () => {
        const result = transition({
          ...CAP_EXHAUSTED,
          phaseDef: PHASE_DEF,
          capOutcome: resolveRetryCapOutcome(
            { ...PHASE_DEF, forceContinueOnRetryCap: false },
            true
          )
        });

        expect(result.kind).toBe('halt');
        if (result.kind === 'halt') expect(result.cause).toBe('cap_exhausted');
      });

      it('still halts a terminal outcome — the hatch never reaches the cap branch', () => {
        const result = transition({
          ...CAP_EXHAUSTED,
          outcome: 'failed',
          phaseDef: PHASE_DEF,
          capOutcome: resolveRetryCapOutcome({ ...PHASE_DEF, forceContinueOnRetryCap: true }, true)
        });

        expect(result.kind).toBe('halt');
        if (result.kind !== 'halt') return;
        expect(result.status).toBe('failed');
        expect(result.warnings.some((w) => w.startsWith(FORCE_CONTINUE_NOTIFY_TAG))).toBe(false);
      });

      it('defaults off — an unset field with no default keeps the halt', () => {
        const result = transition({
          ...CAP_EXHAUSTED,
          phaseDef: PHASE_DEF,
          // `{}` for the same reason as above — a phase stating neither field.
          capOutcome: resolveRetryCapOutcome({}, undefined)
        });

        expect(result.kind).toBe('halt');
        if (result.kind === 'halt') expect(result.cause).toBe('cap_exhausted');
      });
    });

    // FR-R3-157 (contract C2) — `transition()` no longer resolves anything at the
    // cap. It receives an outcome already resolved by
    // `contracts/retry-cap-outcome.ts` and switches on it. The block above still
    // asserts the resolution PRECEDENCE end to end, composed through that same
    // function; this block asserts the switch itself, one arm at a time.
    describe('capOutcome — the resolved outcome at the cap (FR-R3-157)', () => {
      const CAP_EXHAUSTED = {
        phase: 'security-audit',
        outcome: 'clean',
        iteration: 5,
        iterationCap: 5,
        phaseDef: PHASE_DEF,
        metrics: { open_questions: 3 }
      } as const;

      it("'fail' halts with the cap-exhausted cause (C2.1, FR-002)", () => {
        const result = transition({ ...CAP_EXHAUSTED, capOutcome: 'fail' });

        expect(result.kind).toBe('halt');
        if (result.kind !== 'halt') return;
        expect(result.status).toBe('failed');
        expect(result.cause).toBe('cap_exhausted');
        expect(result.warnings.some((w) => w.startsWith(FORCE_CONTINUE_NOTIFY_TAG))).toBe(false);
      });

      it("'continue' advances under the forced-continue tag (C2.2, FR-003)", () => {
        const result = transition({ ...CAP_EXHAUSTED, capOutcome: 'continue' });

        expect(result.kind).toBe('advance');
        if (result.kind !== 'advance') return;
        expect(result.nextPhase).toBe(nextSuccessor('security-audit', undefined));
        expect(result.warnings.some((w) => w.startsWith(FORCE_CONTINUE_NOTIFY_TAG))).toBe(true);
      });

      // C2.7 — the two call sites that pass no phase definition also pass no
      // outcome, and neither can reach this branch. Absent must nonetheless be
      // the safe answer rather than an unhandled case.
      it('an absent capOutcome behaves as `fail` (C2.7)', () => {
        const result = transition({ ...CAP_EXHAUSTED });

        expect(result.kind).toBe('halt');
        if (result.kind !== 'halt') return;
        expect(result.status).toBe('failed');
        expect(result.cause).toBe('cap_exhausted');
      });

      // --- FR-R3-157 US2 — the third outcome (contract C2.3-C2.6) -----------
      //
      // `continue-degraded` is `continue` that admits what it did. It has to
      // advance identically — same successor, same iteration — because an
      // outcome that also changed WHERE the run went would be two decisions
      // wearing one name, and the operator choosing it is choosing to proceed,
      // not to reroute. What it adds is the record: a named entry, and a warning
      // that says a durable record exists so a log reader knows to go looking.
      describe("'continue-degraded' (C2.3-C2.6)", () => {
        it('advances to exactly where `continue` would (C2.3, FR-004)', () => {
          // Asserted against `continue`'s OWN result rather than against a
          // literal successor: the claim is that the two agree, and a literal
          // would keep passing if both drifted together.
          const plain = transition({ ...CAP_EXHAUSTED, capOutcome: 'continue' });
          const degraded = transition({ ...CAP_EXHAUSTED, capOutcome: 'continue-degraded' });

          expect(plain.kind).toBe('advance');
          expect(degraded.kind).toBe('advance');
          if (plain.kind !== 'advance' || degraded.kind !== 'advance') return;
          expect(degraded.nextPhase).toBe(plain.nextPhase);
          expect(degraded.nextIteration).toBe(plain.nextIteration);
        });

        it('names the phase and the authored condition on the mark (C2.3, FR-009)', () => {
          const result = transition({ ...CAP_EXHAUSTED, capOutcome: 'continue-degraded' });

          expect(result.kind).toBe('advance');
          if (result.kind !== 'advance') return;
          // The condition is carried AS AUTHORED — not normalized, not the
          // evaluated value. FR-009 is explicit that a mark saying only
          // "degraded" does not satisfy it: the operator has to be able to see
          // which gate went unverified without opening the pipeline file.
          expect(result.degraded).toEqual({
            phaseId: 'security-audit',
            condition: PHASE_DEF.retryCondition
          });
        });

        it('warns under a tag of its own, not the forced-continue one (C2.3, C2.4)', () => {
          const result = transition({ ...CAP_EXHAUSTED, capOutcome: 'continue-degraded' });

          expect(result.kind).toBe('advance');
          if (result.kind !== 'advance') return;
          expect(DEGRADED_CONTINUE_NOTIFY_TAG).not.toBe(FORCE_CONTINUE_NOTIFY_TAG);
          const tagged = result.warnings.filter((w) =>
            w.startsWith(DEGRADED_CONTINUE_NOTIFY_TAG)
          );
          expect(tagged, 'exactly one degraded warning, not zero and not two').toHaveLength(1);
          // A reader who greps the forced-continue tag must not also collect
          // these: the two outcomes differ precisely in whether a durable record
          // was written, and a shared tag would erase that difference in the log.
          expect(result.warnings.some((w) => w.startsWith(FORCE_CONTINUE_NOTIFY_TAG))).toBe(false);
          // Both halves, per C2.3: what went wrong, and that it was recorded.
          // Capitalized to match `UNVERIFIED`, which is this module's existing
          // convention for the word a reader must not skim past.
          expect(tagged[0]).toContain('UNVERIFIED');
          expect(tagged[0]).toContain('RECORDED as degraded');
        });

        it('appends the stagnation clause under the same threshold (C2.3, feature 194)', () => {
          const stalled = transition({
            ...CAP_EXHAUSTED,
            capOutcome: 'continue-degraded',
            stalledCount: 4
          });
          const unstalled = transition({
            ...CAP_EXHAUSTED,
            capOutcome: 'continue-degraded',
            stalledCount: 1
          });

          const clause = 'metrics unchanged across the last 4 comparisons';
          expect(stalled.warnings.join(' ')).toContain(clause);
          // The threshold is strictly > 1, as feature 194 fixed it: a count of
          // exactly 1 is a real count that does not clear the bar.
          expect(unstalled.warnings.join(' ')).not.toContain('metrics unchanged');
        });

        // C2.4 — the two pre-existing strings and the cause, by exact
        // comparison. `toContain` would pass while a word was quietly added.
        it('leaves the fail and continue paths byte-identical (C2.4, FR-002, FR-003)', () => {
          const failed = transition({ ...CAP_EXHAUSTED, capOutcome: 'fail', stalledCount: 4 });
          expect(failed.kind).toBe('halt');
          if (failed.kind !== 'halt') return;
          expect(failed.cause).toBe('cap_exhausted');
          expect(failed.warnings).toContain(
            'retryCondition still truthy at cap (5) on security-audit; metrics unchanged across the last 4 comparisons'
          );

          const continued = transition({
            ...CAP_EXHAUSTED,
            capOutcome: 'continue',
            stalledCount: 4
          });
          expect(continued.warnings).toContain(
            '[notify] forced-continue security-audit: retryCondition still truthy at cap (5) — ' +
              'forced continue to done. The condition was never satisfied, so whatever it gates ' +
              'is UNVERIFIED; metrics unchanged across the last 4 comparisons.'
          );
          expect(FORCE_CONTINUE_NOTIFY_TAG).toBe('[notify] forced-continue');
        });

        // C2.5 — the mark's absence is load-bearing. `degradedPhases` absent
        // means NOT degraded (data-model §3), so any transition that attached
        // `degraded` where it did not belong would mark a clean run.
        it('attaches no mark to any other transition (C2.5)', () => {
          const others = [
            ['ordinary advance', transition({ ...CAP_EXHAUSTED, metrics: { open_questions: 0 } })],
            ['loop below the cap', transition({ ...CAP_EXHAUSTED, iteration: 2 })],
            ['halt at the cap', transition({ ...CAP_EXHAUSTED, capOutcome: 'fail' })],
            ['plain continue at the cap', transition({ ...CAP_EXHAUSTED, capOutcome: 'continue' })],
            [
              'condition satisfied at the cap',
              transition({
                ...CAP_EXHAUSTED,
                capOutcome: 'continue-degraded',
                metrics: { open_questions: 0 }
              })
            ]
          ] as const;
          for (const [label, result] of others) {
            expect(
              'degraded' in result && result.degraded !== undefined,
              `${label} carried a degraded mark`
            ).toBe(false);
          }
        });

        // C2.6 — the last phase. `continue-degraded` must resolve its successor
        // through the same `nextSuccessor` call and invent no terminus of its own.
        it('resolves the last phase to the same successor `continue` reaches (C2.6)', () => {
          const last = { ...CAP_EXHAUSTED, phase: 'finalize', phaseDef: { ...PHASE_DEF, id: 'finalize' } };
          const plain = transition({ ...last, capOutcome: 'continue' });
          const degraded = transition({ ...last, capOutcome: 'continue-degraded' });

          expect(degraded.kind).toBe('advance');
          if (plain.kind !== 'advance' || degraded.kind !== 'advance') return;
          expect(degraded.nextPhase).toBe(plain.nextPhase);
          expect(degraded.nextPhase).toBe(nextSuccessor('finalize', undefined));
        });
      });
    });

    it('failed outcome bypasses retryCondition (FR-010)', () => {
      const result = transition({
        phase: 'security-audit',
        outcome: 'failed',
        iteration: 2,
        iterationCap: 5,
        phaseDef: PHASE_DEF,
        metrics: { open_questions: 9 }
      });
      expect(result.kind).toBe('halt');
      if (result.kind === 'halt') {
        expect(result.status).toBe('failed');
        expect(result.cause).toBeUndefined();
      }
    });

    it('clean + falsy expression advances normally', () => {
      const result = transition({
        phase: 'security-audit',
        outcome: 'clean',
        iteration: 1,
        iterationCap: 5,
        phaseDef: PHASE_DEF,
        metrics: { open_questions: 0 }
      });
      expect(result.kind).toBe('advance');
    });
  });

  // Feature 194 — FR-010, contracts/audit-payload-deltas.md Delta 3, C3.1-C3.4.
  // `stalledCount` threads from the caller (PhaseSequencer.decideAfterPhase,
  // sourced from PhaseRunOutput — T017/T018) into transition(), which appends
  // the unchanged-iterations clause to BOTH cap warnings under the same
  // threshold. Neither warning's existing text is reworded; the clause is
  // appended, not substituted (C3.4).
  describe('stagnation clause on cap warnings (194, T013)', () => {
    const PHASE_DEF = {
      id: 'security-audit',
      retryCondition: 'open_questions > 0'
    };
    const CAP_EXHAUSTED = {
      phase: 'security-audit',
      outcome: 'clean' as const,
      iteration: 5,
      iterationCap: 5,
      metrics: { open_questions: 3 }
    };

    it('appends the clause to the terminal warning when stalledCount > 1', () => {
      const result = transition({ ...CAP_EXHAUSTED, phaseDef: PHASE_DEF, stalledCount: 4 });
      expect(result.kind).toBe('halt');
      expect(result.warnings).toContain(
        'retryCondition still truthy at cap (5) on security-audit; metrics unchanged across the last 4 comparisons'
      );
    });

    it('does NOT append the clause to the terminal warning when stalledCount is exactly 1 (C3.1)', () => {
      const result = transition({ ...CAP_EXHAUSTED, phaseDef: PHASE_DEF, stalledCount: 1 });
      expect(result.kind).toBe('halt');
      expect(result.warnings).toContain('retryCondition still truthy at cap (5) on security-audit');
      expect(result.warnings.join(' ')).not.toContain('metrics unchanged');
    });

    it('does NOT append the clause to the terminal warning when stalledCount is absent', () => {
      const result = transition({ ...CAP_EXHAUSTED, phaseDef: PHASE_DEF });
      expect(result.kind).toBe('halt');
      expect(result.warnings).toContain('retryCondition still truthy at cap (5) on security-audit');
      expect(result.warnings.join(' ')).not.toContain('metrics unchanged');
    });

    it('appends the clause to the forced-continue warning as one sentence, not "UNVERIFIED.; metrics unchanged" (C3.4)', () => {
      // The clause opens with `; `, which is right for the terminal warning
      // (it ends on the phase id) and wrong after this one's full stop. Only
      // the rendered string showed it, and every assertion about that string
      // used `toContain`, so both halves passed while the operator read a
      // stray `.;`.
      //
      // 2026-09-04 review: this absorbed the separate C3.4 test that preceded
      // it, which drove the identical input and then asserted `toContain
      // ('UNVERIFIED')` and `toContain('metrics unchanged across the last 3
      // comparisons')` — both strictly implied by the joined assertion below,
      // which pins the punctuation BETWEEN them. Two tests, one of them unable
      // to fail without the other failing first; its one distinct claim (the
      // decision is still an advance) is kept here.
      const stalled = transition({
        ...CAP_EXHAUSTED,
        phaseDef: PHASE_DEF,
        capOutcome: 'continue',
        stalledCount: 3
      });
      expect(stalled.kind).toBe('advance');
      const stalledWarning = stalled.warnings.find((w) => w.startsWith(FORCE_CONTINUE_NOTIFY_TAG));
      expect(stalledWarning).toBeDefined();
      expect(stalledWarning).not.toContain('.;');
      expect(stalledWarning).toContain('UNVERIFIED; metrics unchanged across the last 3 comparisons');
      // …and it still ENDS in one. Dropping the stop rather than moving it past
      // the clause left the stalled rendering terminatorless, which every
      // `toContain` above passes over: only the tail says which of the two
      // renderings the operator gets.
      expect(stalledWarning?.endsWith('comparisons.')).toBe(true);
      // The no-clause rendering's own full stop is asserted in the next test,
      // beside the two inputs that produce it, rather than a third time here.
    });

    it('does NOT append the clause to the forced-continue warning when stalledCount is 1 or absent', () => {
      // Both halves the name promises (2026-09-04 review). It drove only
      // `stalledCount: 1`, so `absent` was asserted by the title alone — and the
      // two reach the threshold check by different routes (`undefined > 1` is
      // false by coercion, `1 > 1` by comparison), which is exactly the pair a
      // `?? 0` or a truthiness rewrite would split.
      // FR-R3-157 — the opt-in is now the resolved `capOutcome`, not a field on
      // the definition. This test is about warning TEXT, so it states the outcome
      // directly; the precedence that produces it is asserted in its own block.
      const forceContinue = PHASE_DEF;
      const capOutcome = 'continue' as const;
      // Spread, not `stalledCount: undefined`. The absent case must genuinely
      // omit the key — writing the property with an `undefined` value is a
      // different input under `exactOptionalPropertyTypes`, and it is the shape
      // this test is not about.
      const cases: ReadonlyArray<[string, { stalledCount?: number }]> = [
        ['1', { stalledCount: 1 }],
        ['absent', {}]
      ];
      for (const [label, stalled] of cases) {
        const result = transition({
          ...CAP_EXHAUSTED,
          phaseDef: forceContinue,
          capOutcome,
          ...stalled
        });
        expect(result.kind, label).toBe('advance');
        const warning = result.warnings.find((w) => w.startsWith(FORCE_CONTINUE_NOTIFY_TAG));
        expect(warning, label).toBeDefined();
        expect(warning, label).not.toContain('metrics unchanged');
        // The sentence still ends in its own full stop rather than trailing off
        // where the clause would have started.
        expect(warning?.endsWith('UNVERIFIED.'), label).toBe(true);
      }
    });

    it('the same number in the warning is the number in stalledCount — one computation, two renderings (C3.3)', () => {
      // The number is read off the input rather than written twice, so the
      // assertion states C3.3 (one computation) instead of restating a literal
      // that can drift from the clause it is meant to pin. An earlier draft
      // hardcoded a phrasing the renderer never produced and asserted nothing.
      const stalledCount = 7;
      const result = transition({ ...CAP_EXHAUSTED, phaseDef: PHASE_DEF, stalledCount });
      expect(result.kind).toBe('halt');
      expect(result.warnings.join(' ')).toContain(
        `metrics unchanged across the last ${stalledCount} comparisons`
      );
    });
  });

  // Feature 194 (FR-009) — a pinning test for the cross-file invariant that
  // `PhaseRetryEvaluator`'s two error branches rest on, added by the 2026-09-04
  // code review rather than by the feature.
  //
  // Those branches (`phase-retry-evaluator.ts`, parse error and evaluation
  // error) deliberately do NOT evict the stagnation baseline, unlike the
  // `malformed`/`transient_error`/`rate_limited` branch in the same method,
  // which does. The asymmetry is correct only while an error here cannot
  // produce a `loop`: FR-013 collapses both error kinds to falsy, a falsy
  // condition advances, and every advance sets `evictStagnationTracker`. So the
  // baseline is dropped one layer up instead of twice.
  //
  // Nothing tested that. If a later change made an error retry instead of
  // advance — a plausible-sounding "don't advance past an unverified
  // condition" — the sequencer would stop evicting, a comparison would span the
  // iteration nobody compared, and `stalled` would OVERSTATE, the one direction
  // FR-009 forbids. That change would break this test first, which is the point
  // of it: the invariant lives in another file and had no guard.
  describe('an errored retryCondition cannot loop (FR-013 pins FR-009, 194)', () => {
    // Four shapes, not one, because the invariant has to hold for the whole
    // class rather than for the one string a single test happens to pass. All
    // four are PARSE errors — see the note below on why no case here is an
    // evaluation error.
    const ERROR_SOURCES: ReadonlyArray<[string, string]> = [
      ['incomplete comparison', 'open_questions >'],
      ['bare identifier, no comparison', 'open_questions'],
      ['arithmetic, which the DSL has no operator for', 'open_questions + 1'],
      ['unbalanced parentheses', '((']
    ];

    for (const [label, retryCondition] of ERROR_SOURCES) {
      it(`treats "${retryCondition}" as falsy and advances, so the sequencer still evicts`, () => {
        const result = transition({
          phase: 'security-audit',
          outcome: 'clean',
          iteration: 1,
          iterationCap: 5,
          phaseDef: { id: 'security-audit', retryCondition },
          // A value that would make a WORKING condition truthy, so each case is
          // "the condition errored", not "the condition was satisfied".
          metrics: { open_questions: 2 }
        });
        expect(result.kind, label).not.toBe('loop');
        // The prefix, not just the `kind`: an advance for some unrelated reason
        // would satisfy the line above while proving nothing about the error path.
        expect(
          result.warnings.some((w) => w.startsWith('retryCondition parse error:')),
          label
        ).toBe(true);
      });
    }

    // No evaluation-error case, and the absence is the finding rather than a
    // gap. `evaluate()` reports an error in exactly two situations: a top-level
    // value that is not a boolean, and a thrown error. Neither is reachable for
    // a source `parse()` accepts — the grammar requires a top-level comparison,
    // so `open_questions` alone is rejected as "expected comparison operator"
    // (it is the second case above, a PARSE error, not an evaluation one), and
    // the evaluator's only `throw` is a default arm whose own message reads
    // `unreachable comparison operator`. So the evaluation-error branch in
    // `phase.ts` — and its twin in `phase-retry-evaluator.ts` — is defensive
    // depth for a DSL that cannot currently produce it. It is left in place, and
    // left untested from here, deliberately: a test would have to fabricate an
    // `Expression` the parser never emits, which pins the fabrication rather
    // than the behaviour. A DSL change that makes evaluation errors reachable
    // (arithmetic, division, a non-boolean top level) owes this file a case.
  });
});
