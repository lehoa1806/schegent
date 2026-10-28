// FR-R4-F02 (spec 240, US8; contract E1; US8-1 to US8-4; SC-010) — the limits one Run runs under.
//
// The resolver is checked against the functions execution calls, with conflicting layers: the shown
// value must be the value execution would use, and the origin must name the layer that supplied it.
// The frozen plan is the only place a Phase's own values are read from, so a value authored after the
// Run froze is not seen.
import { describe, expect, it } from 'vitest';
import { snapshotPhaseDef, snapshotPipelineContract } from '../../../src/config/pipeline-snapshot';
import { DELAYED_RETRY_CAP } from '../../../src/contracts/retry-bounds';
import {
  resolveEffectiveLimits,
  type EffectiveLimit,
  type EffectiveLimitsInput,
  type LimitOrigin
} from '../../../src/services/effective-limits';
import { effectivePhaseTimeoutMs } from '../../../src/controller/effective-phase-timeout';
import { effectiveSpendBound } from '../../../src/services/spend-bound';
import { resolveRetryCapOutcome } from '../../../src/contracts/retry-cap-outcome';
import type { PhaseDef, PipelineDef } from '../../../src/config/pipeline-config';
import type { BackendRunnerKind } from '../../../src/contracts/backend-kinds';

const limit = <T>(value: T, origin: LimitOrigin): EffectiveLimit<T> => ({ value, origin });

const PHASE_ID = 'implement';

function runWith(
  phase: Partial<PhaseDef> = {},
  defaultRunnerKind: BackendRunnerKind = 'claude'
): EffectiveLimitsInput['run'] {
  const phaseDef: PhaseDef = { id: PHASE_ID, name: 'Implement', version: 1, instruction: 'Do it.', ...phase };
  const flow: PipelineDef = { id: 'flow', name: 'Flow', phases: [PHASE_ID] };
  return {
    pipeline: snapshotPipelineContract(flow, [snapshotPhaseDef(phaseDef, defaultRunnerKind)]),
    currentPhase: PHASE_ID,
    defaultRunnerKind
  } as unknown as EffectiveLimitsInput['run'];
}

function input(overrides: Partial<EffectiveLimitsInput> = {}): EffectiveLimitsInput {
  return {
    settings: {
      iterationCap: limit(10, 'default'),
      idleTimeoutSeconds: limit(5400, 'default'),
      maxDurationSeconds: limit(21600, 'default')
    },
    live: {
      forceContinueOnCap: limit(false, 'default'),
      limitUsd: limit<number | null>(null, 'default'),
      limitTokens: limit<number | null>(null, 'default')
    },
    run: runWith(),
    spendTrust: () => 'enforced',
    ...overrides
  };
}

describe('the settings layers carry through with their origin (US8-1)', () => {
  it.each<LimitOrigin>(['default', 'user', 'workspace', 'workspace-folder'])(
    'iteration cap, idle and wall-clock bounds from %s are shown as that layer',
    (origin) => {
      const result = resolveEffectiveLimits(
        input({
          settings: {
            iterationCap: limit(7, origin),
            idleTimeoutSeconds: limit(900, origin),
            maxDurationSeconds: limit(3600, origin)
          }
        })
      );

      expect(result.iterationCap).toEqual({ value: 7, origin });
      expect(result.idleTimeoutSeconds).toEqual({ value: 900, origin });
      expect(result.maxDurationSeconds).toEqual({ value: 3600, origin });
    }
  );

  it('a Phase that states its own timeout wins, with origin `phase`, and is the value execution computes', () => {
    const run = runWith({ timeoutSeconds: 120 });
    const result = resolveEffectiveLimits(
      input({
        run,
        settings: {
          iterationCap: limit(10, 'user'),
          idleTimeoutSeconds: limit(900, 'workspace'),
          maxDurationSeconds: limit(3600, 'workspace-folder')
        }
      })
    );

    expect(result.idleTimeoutSeconds).toEqual({ value: 120, origin: 'phase' });
    const phase = run.pipeline?.phases[0];
    expect(result.idleTimeoutSeconds.value * 1000).toBe(
      effectivePhaseTimeoutMs({ timeoutMs: 900 * 1000, phaseDef: phase })
    );
    // The bounds a Phase cannot state keep their layer.
    expect(result.iterationCap.origin).toBe('user');
    expect(result.maxDurationSeconds.origin).toBe('workspace-folder');
  });

  it('a Phase that states no timeout leaves the idle bound at its settings layer', () => {
    const result = resolveEffectiveLimits(
      input({
        settings: {
          iterationCap: limit(10, 'default'),
          idleTimeoutSeconds: limit(900, 'workspace'),
          maxDurationSeconds: limit(21600, 'default')
        }
      })
    );

    expect(result.idleTimeoutSeconds).toEqual({ value: 900, origin: 'workspace' });
  });
});

describe('the retry cap and its outcome (US8-3)', () => {
  it('the cap is the code constant, with origin `default`, whatever the settings say', () => {
    expect(resolveEffectiveLimits(input()).retryCap).toEqual({ value: DELAYED_RETRY_CAP, origin: 'default' });
  });

  it('the workspace default `continue` is shown, with the workspace layer that set it', () => {
    const result = resolveEffectiveLimits(
      input({ live: { ...input().live, forceContinueOnCap: limit(true, 'workspace') } })
    );

    expect(result.onRetryCap).toEqual({ value: 'continue', origin: 'workspace' });
    expect(result.retryCap.value).toBe(DELAYED_RETRY_CAP);
  });

  it('a Phase that states its outcome wins over the workspace default, including the opposite, as execution does', () => {
    const run = runWith({ onRetryCap: 'fail' });
    const live = { ...input().live, forceContinueOnCap: limit(true, 'user') };
    const result = resolveEffectiveLimits(input({ run, live }));

    expect(result.onRetryCap).toEqual({ value: 'fail', origin: 'phase' });
    expect(result.onRetryCap.value).toBe(resolveRetryCapOutcome(run.pipeline?.phases[0], true));
  });

  it('shows `continue-degraded` as itself and never as a plain continue', () => {
    expect(resolveEffectiveLimits(input({ run: runWith({ onRetryCap: 'continue-degraded' }) })).onRetryCap).toEqual({
      value: 'continue-degraded',
      origin: 'phase'
    });
  });

  it('with nothing stated anywhere the outcome is `fail`, from the default layer', () => {
    expect(resolveEffectiveLimits(input()).onRetryCap).toEqual({ value: 'fail', origin: 'default' });
  });
});

describe('the spend bound follows the ended Phase\'s backend (US8-2)', () => {
  const bounds = {
    forceContinueOnCap: limit(false, 'default'),
    limitUsd: limit<number | null>(5, 'workspace'),
    limitTokens: limit<number | null>(2_000_000, 'user')
  };

  it('a claude phase shows USD, from the layer that set it', () => {
    const result = resolveEffectiveLimits(input({ live: bounds, run: runWith({}, 'claude') }));

    expect(result.spend).toEqual({
      kind: 'bounded',
      denomination: 'usd',
      limit: { value: 5, origin: 'workspace' },
      trust: 'enforced'
    });
  });

  it('a codex phase shows tokens, from its own layer, and never the dollar figure', () => {
    const result = resolveEffectiveLimits(input({ live: bounds, run: runWith({ runner: 'codex' }, 'claude') }));

    expect(result.spend).toEqual({
      kind: 'bounded',
      denomination: 'tokens',
      limit: { value: 2_000_000, origin: 'user' },
      trust: 'enforced'
    });
  });

  it('a Phase override wins in its denomination with origin `phase`, as `effectiveSpendBound` computes', () => {
    const run = runWith({ spendBoundUsd: 1.5 });
    const result = resolveEffectiveLimits(input({ live: bounds, run }));

    expect(result.spend).toMatchObject({ kind: 'bounded', limit: { value: 1.5, origin: 'phase' } });
    expect(effectiveSpendBound({ limitUsd: 5, limitTokens: 2_000_000 }, run.pipeline?.phases[0]).limitUsd).toBe(1.5);
  });

  it('a null limit in the applicable denomination is `none`, even when the other denomination has one', () => {
    const live = { ...bounds, limitUsd: limit<number | null>(null, 'default') };

    expect(resolveEffectiveLimits(input({ live, run: runWith({}, 'claude') })).spend).toEqual({ kind: 'none' });
    expect(resolveEffectiveLimits(input({ run: runWith({}, 'claude') })).spend).toEqual({ kind: 'none' });
  });

  it('carries the watcher\'s trust through, asked for the applicable denomination', () => {
    const asked: string[] = [];
    const result = resolveEffectiveLimits(
      input({
        live: bounds,
        run: runWith({}, 'claude'),
        spendTrust: (denomination) => {
          asked.push(denomination);
          return 'not-trustworthy';
        }
      })
    );

    expect(result.spend).toMatchObject({ kind: 'bounded', trust: 'not-trustworthy' });
    expect(asked).toEqual(['usd']);
  });

  it('asks no trust when no bound applies', () => {
    const asked: string[] = [];
    resolveEffectiveLimits(input({ spendTrust: (denomination) => { asked.push(denomination); return 'enforced'; } }));

    expect(asked).toEqual([]);
  });
});

describe('the frozen plan is read, never written, and a later authoring is not seen (G4)', () => {
  it('a Phase value absent from the frozen plan does not appear, whatever the catalog now says', () => {
    // The Run froze without a timeout. A catalog edit after that does not reach this input at all,
    // because the resolver reads only `run.pipeline`; the shown value is the settings layer's.
    const frozen = runWith({});
    const result = resolveEffectiveLimits(input({ run: frozen }));

    expect(result.idleTimeoutSeconds.origin).toBe('default');
    expect(result.onRetryCap.origin).toBe('default');
  });

  it('does not modify the plan it reads', () => {
    const run = runWith({ timeoutSeconds: 60, spendBoundUsd: 1 });
    const before = JSON.stringify(run.pipeline);

    resolveEffectiveLimits(input({ run }));

    expect(JSON.stringify(run.pipeline)).toBe(before);
  });

  it('a Run with no plan, or whose current phase is not in it, shows the settings layers', () => {
    const noPlan = { pipeline: undefined, currentPhase: PHASE_ID, defaultRunnerKind: 'claude' } as unknown as EffectiveLimitsInput['run'];
    expect(resolveEffectiveLimits(input({ run: noPlan })).idleTimeoutSeconds).toEqual({ value: 5400, origin: 'default' });

    const elsewhere = { ...runWith({ timeoutSeconds: 60 }), currentPhase: 'not-in-plan' };
    expect(resolveEffectiveLimits(input({ run: elsewhere })).idleTimeoutSeconds).toEqual({ value: 5400, origin: 'default' });
  });
});
