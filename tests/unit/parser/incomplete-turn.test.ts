/**
 * FR-R3-198 (T1877) — an invocation that ended its turn unfinished is
 * `incomplete_turn`, decided from the runner's turn-end facts.
 *
 * Contract C1 to C5 (`specs/228-background-work-settle-hold/contracts/incomplete-turn.md`)
 * and data-model §5's table. Each case passes a literal `turnEnd`, as the eval
 * harness does, and the rest of `ParseInputs` as
 * `tests/unit/parser/stdout-parser-blocks.test.ts` does.
 *
 * I4, I7, I8 and I9 are guards: they pin today's path, so they pass before and
 * after the arm exists. The exit status 143 is the runner's own SIGTERM; no case
 * expects the parser to read it (C5).
 */
import { describe, it, expect } from 'vitest';
import { parseInvocation } from '../../../src/parser/stdout-parser';
import type { InvocationResult, ParseInputs } from '../../../src/parser/stdout-parser';
import { NO_REGION } from '../../../src/parser/audit-log-parser';

const SIGTERM_EXIT_CODE = 143;
const NO_BLOCK = 'the build is still running in the background';
const REMAINING_ISSUES = ['Remaining issues:', '- [test-failure] one case still fails'].join('\n');
const OPEN_QUESTIONS = ['Open questions:', '- Which branch should the fix target?'].join('\n');

const REST: Omit<ParseInputs, 'stdout' | 'exitCode'> = {
  stderr: '',
  rateLimit: { matched: false, cause: '' },
  auditEntry: null,
  auditWarnings: [],
  region: NO_REGION
};

function incompleteTurnWarnings(result: InvocationResult): string[] {
  const warnings = 'warnings' in result ? result.warnings ?? [] : [];
  return warnings.filter((warning) => warning.startsWith('incomplete-turn:'));
}

describe('parseInvocation incomplete_turn FR-R3-198 (T1877)', () => {
  it('I1 (Story 2 s1): a settled turn with no contract block is incomplete, cause no-contract-block', () => {
    const result = parseInvocation({
      ...REST,
      stdout: NO_BLOCK,
      exitCode: SIGTERM_EXIT_CODE,
      turnEnd: { killed: false, completedAwaitingExit: true }
    });

    expect(result).toMatchObject({ kind: 'incomplete_turn', cause: 'no-contract-block' });
    expect(incompleteTurnWarnings(result)).toEqual(['incomplete-turn:no-contract-block']);
  });

  it('I2 (Story 2 s2): a turn that ended with work open is incomplete at exit 0, cause background-work-open', () => {
    const result = parseInvocation({
      ...REST,
      stdout: NO_BLOCK,
      exitCode: 0,
      turnEnd: { killed: false, backgroundWorkOpenAtResult: true }
    });

    expect(result).toMatchObject({ kind: 'incomplete_turn', cause: 'background-work-open' });
    expect(incompleteTurnWarnings(result)).toEqual(['incomplete-turn:background-work-open']);
  });

  it('I3: with both facts, the open work names the cause', () => {
    const result = parseInvocation({
      ...REST,
      stdout: NO_BLOCK,
      exitCode: SIGTERM_EXIT_CODE,
      turnEnd: { killed: false, completedAwaitingExit: true, backgroundWorkOpenAtResult: true }
    });

    expect(result).toMatchObject({ kind: 'incomplete_turn', cause: 'background-work-open' });
    expect(incompleteTurnWarnings(result)).toEqual(['incomplete-turn:background-work-open']);
  });

  it('I4 (Story 2 s5; C5): a 143 with neither fact is transient_error, as today (guard)', () => {
    const absent = parseInvocation({ ...REST, stdout: NO_BLOCK, exitCode: SIGTERM_EXIT_CODE });
    const bothFalse = parseInvocation({
      ...REST,
      stdout: NO_BLOCK,
      exitCode: SIGTERM_EXIT_CODE,
      turnEnd: { killed: false, completedAwaitingExit: false, backgroundWorkOpenAtResult: false }
    });

    expect(absent).toMatchObject({ kind: 'transient_error', exitCode: SIGTERM_EXIT_CODE });
    expect(bothFalse).toMatchObject({ kind: 'transient_error', exitCode: SIGTERM_EXIT_CODE });
  });

  it('I5 (Story 2 s6; C4): a settled turn with a "Remaining issues:" section is decided by it, past the floor', () => {
    const result = parseInvocation({
      ...REST,
      stdout: REMAINING_ISSUES,
      exitCode: SIGTERM_EXIT_CODE,
      turnEnd: { killed: false, completedAwaitingExit: true }
    });

    expect(result).toMatchObject({
      kind: 'remaining_issues',
      issues: [{ tag: 'test-failure', summary: 'one case still fails' }]
    });
    expect(incompleteTurnWarnings(result)).toEqual([]);
  });

  it('I6 (C4): a settled turn with an "Open questions:" section is decided by it, past the floor', () => {
    const result = parseInvocation({
      ...REST,
      stdout: OPEN_QUESTIONS,
      exitCode: SIGTERM_EXIT_CODE,
      turnEnd: { killed: false, completedAwaitingExit: true }
    });

    expect(result).toMatchObject({
      kind: 'open_questions',
      questions: ['Which branch should the fix target?']
    });
    expect(incompleteTurnWarnings(result)).toEqual([]);
  });

  it('I7 (Story 2 s7): a genuine rate-limit signal keeps its precedence over the arm (guard)', () => {
    const result = parseInvocation({
      ...REST,
      stdout: NO_BLOCK,
      stderr: '429 too many requests',
      exitCode: SIGTERM_EXIT_CODE,
      rateLimit: { matched: true, cause: 'rate_limit' },
      turnEnd: { killed: false, completedAwaitingExit: true }
    });

    expect(result).toMatchObject({ kind: 'rate_limited', cause: 'rate_limit' });
  });

  it('I8 (data-model §5, last row): work open but not settled keeps the floor, even with a block (guard)', () => {
    const result = parseInvocation({
      ...REST,
      stdout: REMAINING_ISSUES,
      exitCode: SIGTERM_EXIT_CODE,
      turnEnd: { killed: false, backgroundWorkOpenAtResult: true }
    });

    expect(result).toMatchObject({ kind: 'transient_error', exitCode: SIGTERM_EXIT_CODE });
    expect(incompleteTurnWarnings(result)).toEqual([]);
  });

  it('I9 (C3): a killed invocation is never incomplete, as today (guard)', () => {
    const result = parseInvocation({
      ...REST,
      stdout: NO_BLOCK,
      exitCode: SIGTERM_EXIT_CODE,
      turnEnd: { killed: true, completedAwaitingExit: true }
    });

    expect(result).toMatchObject({ kind: 'transient_error', exitCode: SIGTERM_EXIT_CODE });
    expect(incompleteTurnWarnings(result)).toEqual([]);
  });
});
