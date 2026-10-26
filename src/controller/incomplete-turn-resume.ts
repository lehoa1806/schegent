import type { IncompleteTurnCause } from '../parser/stdout-parser';
import type { PhaseRunInputs, PhaseRunner, PhaseRunOutput } from './phase-runner';

/**
 * FR-R3-198 — a turn that ended unfinished is resumed straight away, inside the
 * dispatch that ran it, at most `MAX_IMMEDIATE_RESUMES` times.
 *
 * Unfinished means the CLI ended the turn while work it started in the
 * background was still running, or without the contract block. Neither is a
 * backend failure, so neither waits out a delayed retry: the same session is
 * resumed at once, and told why. Each resume is a full `PhaseRunner.run()`
 * attempt with its own `phase-start` and `phase-end` (hard rule 68).
 *
 * The count lives in one call and nowhere else. Nothing is persisted, so a host
 * restart starts the phase fresh. See
 * `specs/228-background-work-settle-hold/contracts/incomplete-turn.md`, L1 to L7.
 */
export const MAX_IMMEDIATE_RESUMES = 2;

const FINISH_IN_THE_FOREGROUND =
  'Finish the remaining work in the foreground, and end this turn with your contract block.';

/**
 * The note a resume's prompt carries, keyed by the cause of the turn before it.
 * Code-resident: no text from the CLI's output is sent back through this path.
 */
export const CONTINUATION_NOTES: Readonly<Record<IncompleteTurnCause, string>> = {
  'background-work-open':
    'The previous turn ended while work it started in the background was still running. ' +
    FINISH_IN_THE_FOREGROUND,
  'no-contract-block':
    'The previous turn ended without the contract block the OUTPUT CONTRACT requires. ' +
    FINISH_IN_THE_FOREGROUND
};

/**
 * Run one phase dispatch, resuming each unfinished turn at once, and return the
 * last output.
 *
 * Each output reaches `onOutput` in call order, before the loop decides whether
 * to resume. A call that throws hands nothing over, and the error propagates.
 * A resume never starts once the cancellation signal is aborted. The loop reads
 * no pause stamp: a spend-bound pause takes effect when the dispatch returns.
 */
export async function dispatchResumingIncompleteTurns(
  runner: Pick<PhaseRunner, 'run'>,
  inputs: PhaseRunInputs,
  onOutput: (output: PhaseRunOutput) => void
): Promise<PhaseRunOutput> {
  let output = await runner.run(inputs);
  onOutput(output);
  let resumes = 0;
  while (
    output.outcome === 'incomplete_turn' &&
    output.result.kind === 'incomplete_turn' &&
    resumes < MAX_IMMEDIATE_RESUMES &&
    !aborted(inputs.cancellationSignal)
  ) {
    resumes += 1;
    // An operator's custom prompt is one-shot, and `sessionReuse: false` skips
    // the pre-phase compaction a reused session would get.
    const { resumePrompt: _dropped, resumeSessionCostUsd, ...resumed } = inputs;
    const resumeSessionId = output.cliSessionId ?? inputs.resumeSessionId;
    output = await runner.run({
      ...resumed,
      isContinue: true,
      sessionReuse: false,
      ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
      // FR-R3-209 — the persisted figure belongs to the dispatch's own session only.
      ...(resumeSessionCostUsd !== undefined &&
      resumeSessionId !== undefined &&
      resumeSessionId === inputs.resumeSessionId
        ? { resumeSessionCostUsd }
        : {}),
      continuationNote: CONTINUATION_NOTES[output.result.cause]
    });
    onOutput(output);
  }
  return output;
}

function aborted(signal: PhaseRunInputs['cancellationSignal']): boolean {
  return signal !== undefined && signal.aborted;
}
