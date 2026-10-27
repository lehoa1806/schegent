/**
 * FR-R3-198 (T1877) — a turn that ended unfinished is resumed straight away, in
 * the same dispatch, at most `MAX_IMMEDIATE_RESUMES` times.
 *
 * Contract L2 to L6, N2 and N3
 * (`specs/228-background-work-settle-hold/contracts/incomplete-turn.md`) and
 * data-model §7's table. The runner is a scripted double, so each case reads
 * the inputs every call received. A real `PhaseRunner` and `RunDriver` drive
 * the same loop in `tests/integration/incomplete-turn-resume.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CONTINUATION_NOTES,
  MAX_IMMEDIATE_RESUMES,
  dispatchResumingIncompleteTurns
} from '../../../src/controller/incomplete-turn-resume';
import type { PhaseRunInputs, PhaseRunOutput } from '../../../src/controller/phase-runner';
import type { IncompleteTurnCause } from '../../../src/parser/stdout-parser';

const INPUTS: PhaseRunInputs = {
  phase: 'finalize',
  iteration: 1,
  iterationCap: 5,
  featureDescription: 'desc',
  featureDir: null,
  cliPath: 'claude',
  cwd: '/work',
  timeoutMs: 1_000,
  runId: 'run-1',
  resumeSessionId: 's0'
};

const CAUSES = ['background-work-open', 'no-contract-block'] as const;

function clean(): PhaseRunOutput {
  return {
    result: { kind: 'clean', auditEntry: null },
    outcome: 'clean',
    terminationReason: 'token',
    stdoutSummary: '',
    stderrSummary: '',
    exitCode: 0,
    auditEntryId: null,
    warnings: []
  };
}

function incomplete(cause: IncompleteTurnCause, cliSessionId?: string): PhaseRunOutput {
  return {
    result: { kind: 'incomplete_turn', cause, auditEntry: null, warnings: [`incomplete-turn:${cause}`] },
    outcome: 'incomplete_turn',
    terminationReason: 'incomplete_turn',
    stdoutSummary: '',
    stderrSummary: '',
    exitCode: 143,
    auditEntryId: null,
    warnings: [`incomplete-turn:${cause}`],
    ...(cliSessionId !== undefined ? { cliSessionId } : {})
  };
}

function scriptedRunner(...script: PhaseRunOutput[]) {
  const run = vi.fn<(inputs: PhaseRunInputs) => Promise<PhaseRunOutput>>();
  for (const output of script) run.mockResolvedValueOnce(output);
  return { run };
}

function inputsOfCall(runner: ReturnType<typeof scriptedRunner>, index: number): PhaseRunInputs | undefined {
  return runner.run.mock.calls.at(index)?.[0];
}

describe('dispatchResumingIncompleteTurns FR-R3-198 (T1877)', () => {
  it('L-a: a clean first output is returned after one call', async () => {
    const first = clean();
    const runner = scriptedRunner(first);
    const seen: PhaseRunOutput[] = [];
    const result = await dispatchResumingIncompleteTurns(runner, INPUTS, (each) => { seen.push(each); });
    expect(result).toBe(first);
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(inputsOfCall(runner, 0)).toEqual(INPUTS);
    expect(seen).toEqual([first]);
  });

  it('L-b (L2, L3): an unfinished turn is resumed at once, in its own session, with the note', async () => {
    const second = clean();
    const runner = scriptedRunner(incomplete('background-work-open', 's1'), second);
    const seen: PhaseRunOutput[] = [];
    const result = await dispatchResumingIncompleteTurns(runner, INPUTS, (each) => { seen.push(each); });
    expect(result).toBe(second);
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(inputsOfCall(runner, 1)).toEqual({
      ...INPUTS,
      isContinue: true,
      sessionReuse: false,
      resumeSessionId: 's1',
      resumePrompt: undefined,
      continuationNote: CONTINUATION_NOTES['background-work-open']
    });
  });

  it('L-c (L3): a resume after a turn that reported no session uses the dispatch session', async () => {
    const runner = scriptedRunner(incomplete('no-contract-block'), clean());
    await dispatchResumingIncompleteTurns(runner, INPUTS, () => {});
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(inputsOfCall(runner, 1)?.resumeSessionId).toBe('s0');
  });

  it('L-d (L2, L4): three unfinished turns make three calls, and the third output is returned', async () => {
    expect(MAX_IMMEDIATE_RESUMES).toBe(2);
    const third = incomplete('no-contract-block');
    // A fourth output is scripted so that a fourth call would return it.
    const runner = scriptedRunner(incomplete('no-contract-block'), incomplete('background-work-open'), third, clean());
    const seen: PhaseRunOutput[] = [];
    const result = await dispatchResumingIncompleteTurns(runner, INPUTS, (each) => { seen.push(each); });
    expect(result).toBe(third);
    expect(runner.run).toHaveBeenCalledTimes(3);
    expect(seen).toHaveLength(3);
    // Each resume's note names the cause of the turn before it.
    expect(inputsOfCall(runner, 1)?.continuationNote).toBe(CONTINUATION_NOTES['no-contract-block']);
    expect(inputsOfCall(runner, 2)?.continuationNote).toBe(CONTINUATION_NOTES['background-work-open']);
  });

  it('L-e (L2): a live signal lets the resume start, and an aborted one stops it', async () => {
    const live = { aborted: false, addEventListener: () => {} };
    const resumed = scriptedRunner(incomplete('background-work-open'), clean());
    await dispatchResumingIncompleteTurns(resumed, { ...INPUTS, cancellationSignal: live }, () => {});
    expect(resumed.run).toHaveBeenCalledTimes(2);

    const signal = { aborted: false, addEventListener: () => {} };
    const first = incomplete('background-work-open');
    const run = vi
      .fn<(inputs: PhaseRunInputs) => Promise<PhaseRunOutput>>()
      .mockImplementationOnce(async () => {
        signal.aborted = true;
        return first;
      })
      .mockResolvedValueOnce(clean());
    const result = await dispatchResumingIncompleteTurns({ run }, { ...INPUTS, cancellationSignal: signal }, () => {});
    expect(result).toBe(first);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('L-f (N3): the operator prompt goes on the first call only, and the note on the resume only', async () => {
    const runner = scriptedRunner(incomplete('no-contract-block'), clean());
    await dispatchResumingIncompleteTurns(runner, { ...INPUTS, resumePrompt: 'operator' }, () => {});
    expect(runner.run).toHaveBeenCalledTimes(2);
    const first = inputsOfCall(runner, 0);
    const resume = inputsOfCall(runner, 1);
    expect(first?.resumePrompt).toBe('operator');
    expect(first?.continuationNote).toBeUndefined();
    expect(resume?.resumePrompt).toBeUndefined();
    expect(resume?.continuationNote).toBe(CONTINUATION_NOTES['no-contract-block']);
  });

  it('L-g (L5): each dispatch starts its resume count at 0', async () => {
    const runner = scriptedRunner(
      incomplete('no-contract-block'),
      incomplete('no-contract-block'),
      clean(),
      incomplete('no-contract-block'),
      incomplete('no-contract-block'),
      clean()
    );
    const firstDispatch = await dispatchResumingIncompleteTurns(runner, INPUTS, () => {});
    const secondDispatch = await dispatchResumingIncompleteTurns(runner, INPUTS, () => {});
    expect(firstDispatch.outcome).toBe('clean');
    expect(secondDispatch.outcome).toBe('clean');
    expect(runner.run).toHaveBeenCalledTimes(6);
  });

  it('L-h (L6): each output reaches onOutput in call order, and a call that throws hands over nothing', async () => {
    const first = incomplete('background-work-open', 's1');
    const second = clean();
    const seen: PhaseRunOutput[] = [];
    await dispatchResumingIncompleteTurns(scriptedRunner(first, second), INPUTS, (each) => { seen.push(each); });
    expect(seen).toHaveLength(2);
    expect(seen.at(0)).toBe(first);
    expect(seen.at(1)).toBe(second);

    const failure = new Error('spawn failed');
    const run = vi
      .fn<(inputs: PhaseRunInputs) => Promise<PhaseRunOutput>>()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(failure);
    const seenBeforeThrow: PhaseRunOutput[] = [];
    await expect(
      dispatchResumingIncompleteTurns({ run }, INPUTS, (each) => { seenBeforeThrow.push(each); })
    ).rejects.toBe(failure);
    expect(seenBeforeThrow).toHaveLength(1);
    expect(seenBeforeThrow.at(0)).toBe(first);
  });

  // FR-R3-209 — the persisted figure belongs to the dispatch's own session only.
  it('L-i (FR-R3-209): a resume carries the session figure only for the dispatch session', async () => {
    const withFigure = { ...INPUTS, resumeSessionCostUsd: 1.0 };

    const noReport = scriptedRunner(incomplete('no-contract-block'), clean());
    await dispatchResumingIncompleteTurns(noReport, withFigure, () => {});
    expect(inputsOfCall(noReport, 1)?.resumeSessionId).toBe('s0');
    expect(inputsOfCall(noReport, 1)?.resumeSessionCostUsd).toBe(1.0);

    const sameSession = scriptedRunner(incomplete('background-work-open', 's0'), clean());
    await dispatchResumingIncompleteTurns(sameSession, withFigure, () => {});
    expect(inputsOfCall(sameSession, 1)?.resumeSessionId).toBe('s0');
    expect(inputsOfCall(sameSession, 1)?.resumeSessionCostUsd).toBe(1.0);

    const otherSession = scriptedRunner(incomplete('background-work-open', 's1'), clean());
    await dispatchResumingIncompleteTurns(otherSession, withFigure, () => {});
    expect(inputsOfCall(otherSession, 1)?.resumeSessionId).toBe('s1');
    expect(inputsOfCall(otherSession, 1)).not.toHaveProperty('resumeSessionCostUsd');
  });

  it('N2: each note names its cause and asks for the work in the foreground and the block at the end', () => {
    expect(CONTINUATION_NOTES['background-work-open']).toMatch(/still running/);
    expect(CONTINUATION_NOTES['background-work-open']).toMatch(/in the background/);
    expect(CONTINUATION_NOTES['no-contract-block']).toMatch(/without the contract block/);
    for (const cause of CAUSES) {
      expect(CONTINUATION_NOTES[cause]).toMatch(/in the foreground/);
      expect(CONTINUATION_NOTES[cause]).toMatch(/end this turn with your contract block/);
    }
  });
});
