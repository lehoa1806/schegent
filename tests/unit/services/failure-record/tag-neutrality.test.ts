/**
 * FR-R4-F15 (feature 243, contract T2.2, T6.4; FR-009; User Story 5 scenario 6; SC-006) — tags and
 * sources change no decision.
 *
 * An agent's tag is a claim about its own issue, kept in a record for an operator to read. It must
 * never steer the Run, so this test drives the REAL decision code with outputs that differ in nothing
 * but their issue tags and sources, and asserts the decisions are deep-equal:
 *
 *   - `PhaseSequencer.decideAfterPhase` (which runs the retry-condition transition);
 *   - `PhaseRetryEvaluator.maybeEmit`, whose stall count and audit record are the retry decision;
 *   - `failureCauseOf`, over the facts the sequencer's `fail` decision carries;
 *   - `evaluateQueueHalt`, over the row status the decision leads to.
 *
 * Non-vacuity: the variants' serialized issues are pairwise unequal, so equal decisions are not the
 * result of feeding the same input six times, and each scenario's expected decision kind is asserted,
 * so a decision that never reached `fail` or a loop cannot pass by being equally trivial.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '../../../../src/audit/audit-entry';
import type { AuditLogWriter } from '../../../../src/audit/audit-log-writer';
import type { PhaseDef } from '../../../../src/config/pipeline-config';
import { failureCauseOf } from '../../../../src/controller/fail-decision-cause';
import type { PhaseRunOutput } from '../../../../src/controller/phase-runner';
import { PhaseRetryEvaluator } from '../../../../src/controller/phase-retry-evaluator';
import { PhaseSequencer, type PostPhaseDecision } from '../../../../src/controller/phase-sequencer';
import { SanitizedLogger } from '../../../../src/lib/logger';
import type { InvocationResult } from '../../../../src/parser/stdout-parser';
import type { FeatureRequest } from '../../../../src/queue/feature-request';
import { evaluateQueueHalt } from '../../../../src/queue/queue-halt-policy';
import type { WorkflowRun } from '../../../../src/state/workflow-run';

type Issue = { tag?: string; summary: string; source?: 'host' };

/** The same issue text under every tag and source the record can meet. */
const VARIANTS: ReadonlyArray<{ readonly name: string; readonly issue: Issue }> = [
  { name: 'no tag', issue: { summary: 'the export test fails' } },
  { name: 'regression', issue: { tag: 'regression', summary: 'the export test fails' } },
  { name: 'pre-existing', issue: { tag: 'pre-existing', summary: 'the export test fails' } },
  { name: 'environment', issue: { tag: 'environment', summary: 'the export test fails' } },
  { name: 'needs-approval', issue: { tag: 'needs-approval', summary: 'the export test fails' } },
  { name: 'needs-decision', issue: { tag: 'needs-decision', summary: 'the export test fails' } },
  { name: 'constitution, forged by the agent', issue: { tag: 'constitution', summary: 'the export test fails' } },
  { name: 'blocker, which is no closed tag', issue: { tag: 'blocker', summary: 'the export test fails' } },
  {
    name: 'a host source added to an agent issue',
    issue: { tag: 'regression', summary: 'the export test fails', source: 'host' }
  }
];

const NOW = 1_700_000_002_000;
const METRICS = { open_questions: 2 };

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    featureId: 'task-1',
    featureDir: '/tmp/feat',
    status: 'running',
    currentPhase: 'implement',
    currentIteration: 0,
    startedAt: 1_700_000_000_000,
    lastTransitionAt: 1_700_000_000_000,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    ...overrides
  } as unknown as WorkflowRun;
}

function resultWith(issue: Issue): InvocationResult {
  return {
    kind: 'remaining_issues',
    issues: [issue],
    auditEntry: { metrics: METRICS } as never
  } as InvocationResult;
}

function output(issue: Issue): PhaseRunOutput {
  return {
    result: resultWith(issue),
    outcome: 'issues_remain',
    terminationReason: 'token',
    stdoutSummary: '',
    stderrSummary: '',
    exitCode: 0,
    auditEntryId: null,
    warnings: []
  } as unknown as PhaseRunOutput;
}

const RETRY_PHASE = {
  id: 'implement',
  name: 'Implement',
  instruction: 'implement',
  retryCondition: 'open_questions > 0'
} as unknown as PhaseDef;

interface Scenario {
  readonly name: string;
  readonly run: WorkflowRun;
  readonly iteration: number;
  readonly iterationCap: number;
  readonly phaseDef: PhaseDef | undefined;
  readonly expectKind: PostPhaseDecision['kind'];
  readonly expectCause?: string;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'a required last phase that ends with issues fails',
    run: run({
      currentPhase: 'finalize',
      pipeline: {
        id: 'pipe',
        name: 'Pipe',
        phases: [
          { id: 'implement', name: 'Implement', instruction: 'implement' },
          { id: 'finalize', name: 'Finalize', instruction: 'finish' }
        ]
      } as never
    }),
    iteration: 1,
    iterationCap: 5,
    phaseDef: undefined,
    expectKind: 'fail',
    expectCause: 'last_phase_issues_remain'
  },
  {
    name: 'a phase under its cap with a truthy retry condition loops',
    run: run({ pipeline: { id: 'pipe', name: 'Pipe', phases: [RETRY_PHASE] } as never }),
    iteration: 1,
    iterationCap: 3,
    phaseDef: RETRY_PHASE,
    expectKind: 'advance-or-loop'
  },
  {
    name: 'a phase at its cap with a truthy retry condition fails',
    run: run({ pipeline: { id: 'pipe', name: 'Pipe', phases: [RETRY_PHASE] } as never }),
    iteration: 3,
    iterationCap: 3,
    phaseDef: RETRY_PHASE,
    expectKind: 'fail',
    expectCause: 'cap_exhausted'
  }
];

function decide(scenario: Scenario, issue: Issue): PostPhaseDecision {
  return new PhaseSequencer().decideAfterPhase({
    run: scenario.run,
    output: output(issue),
    iteration: scenario.iteration,
    iterationCap: scenario.iterationCap,
    activePhaseDef: scenario.phaseDef,
    latestManualPauseAt: null,
    now: NOW
  });
}

describe('the variants really differ (the control)', () => {
  it('serializes to pairwise-unequal issues, so equal decisions are not one input fed six times', () => {
    const serialized = VARIANTS.map((variant) => {
      const result = resultWith(variant.issue);
      return JSON.stringify(result.kind === 'remaining_issues' ? result.issues : null);
    });
    expect(new Set(serialized).size).toBe(VARIANTS.length);
  });
});

describe('PhaseSequencer.decideAfterPhase takes no tag or source into account (T2.2)', () => {
  it.each(SCENARIOS)('$name', (scenario) => {
    const baseline = decide(scenario, VARIANTS[0]?.issue as Issue);
    expect(baseline.kind).toBe(scenario.expectKind);
    if (scenario.expectCause !== undefined) {
      expect(baseline).toMatchObject({ kind: 'fail', failureCause: scenario.expectCause });
    }
    for (const variant of VARIANTS) {
      expect(decide(scenario, variant.issue), variant.name).toEqual(baseline);
    }
  });
});

describe('failureCauseOf, over the facts a fail decision carries (T2.2)', () => {
  it('names the same cause for every variant, and the facts hold no issue', () => {
    for (const scenario of SCENARIOS.filter((entry) => entry.expectKind === 'fail')) {
      const causes = VARIANTS.map((variant) => {
        const decision = decide(scenario, variant.issue);
        if (decision.kind !== 'fail') throw new Error(`${scenario.name}: expected fail for ${variant.name}`);
        return failureCauseOf({
          decisionCause: decision.decisionCause,
          fatalMatched: decision.fatalCause !== undefined,
          outcome: output(variant.issue).outcome,
          terminationReason: output(variant.issue).terminationReason
        });
      });
      expect(new Set(causes).size, scenario.name).toBe(1);
      expect(causes[0]).toBe(scenario.expectCause);
    }
  });
});

describe('PhaseRetryEvaluator.maybeEmit takes no tag or source into account (T2.2)', () => {
  async function evaluate(issue: Issue): Promise<{ stalled: number | undefined; appends: unknown[] }> {
    const appends: unknown[] = [];
    const writer = {
      append: vi.fn(async (entry: Omit<AuditEntry, 'id' | 'timestamp'>) => {
        appends.push({ eventType: entry.eventType, payload: entry.payload, outcome: entry.outcome });
        return { id: 'a', timestamp: '2026-10-28T00:00:00Z', ...entry } as AuditEntry;
      }),
      logPath: '/tmp/.schegent/audit.log'
    } as unknown as AuditLogWriter;
    const evaluator = new PhaseRetryEvaluator(writer, new SanitizedLogger([]));
    const stalled: Array<number | undefined> = [];
    for (const iteration of [1, 2, 3]) {
      stalled.push(
        await evaluator.maybeEmit({
          phase: 'implement',
          phaseDef: RETRY_PHASE,
          pipelineId: 'pipe',
          runId: 'run-1',
          iteration,
          result: resultWith(issue),
          metrics: METRICS
        })
      );
    }
    return { stalled: stalled.at(-1), appends };
  }

  it('returns the same stall count and appends the same records for every variant', async () => {
    const baseline = await evaluate(VARIANTS[0]?.issue as Issue);
    // Control: three evaluations of unchanged figures did record a retry decision and a stall.
    expect(baseline.appends.length).toBeGreaterThan(0);
    expect(baseline.stalled).toBeGreaterThan(1);
    for (const variant of VARIANTS) {
      expect(await evaluate(variant.issue), variant.name).toEqual(baseline);
    }
  });
});

describe('evaluateQueueHalt, on the row status the decision leads to (T2.2)', () => {
  const row = (status: FeatureRequest['status']): FeatureRequest =>
    ({ id: 'task-1', description: 'Add the export button', position: 0, status }) as unknown as FeatureRequest;

  it('reaches the same verdict for every variant of a failing phase', () => {
    const scenario = SCENARIOS[0] as Scenario;
    const verdicts = VARIANTS.map((variant) => {
      const decision = decide(scenario, variant.issue);
      return evaluateQueueHalt('halt-on-failure', [row(decision.kind === 'fail' ? 'failed' : 'in-flight')]);
    });
    // Control: a failed row halts the queue, so the verdict being equal is not an equal null.
    expect(verdicts[0]).toEqual({ taskId: 'task-1', taskName: 'Add the export button' });
    for (const verdict of verdicts) expect(verdict).toEqual(verdicts[0]);
  });

  it('reaches the same verdict for every variant of a phase that loops', () => {
    const scenario = SCENARIOS[1] as Scenario;
    const verdicts = VARIANTS.map((variant) => {
      const decision = decide(scenario, variant.issue);
      return evaluateQueueHalt('halt-on-failure', [row(decision.kind === 'fail' ? 'failed' : 'in-flight')]);
    });
    expect(verdicts[0]).toBeNull();
    for (const verdict of verdicts) expect(verdict).toEqual(verdicts[0]);
  });
});
