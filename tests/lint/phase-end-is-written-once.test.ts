// Feature 212 (FR-002, FR-003) — one attempt, one terminal row, enforced where
// the second one would be written rather than trusted not to happen.
//
// `PhaseAttempt.markClosedBy()` returns whether THIS call claimed the attempt, and
// `PhaseAttempt.close()` uses its own flag to make closing a closed attempt a
// no-op. `PhaseRunner.appendPhaseEnd()` — the OTHER terminal-write path, the one
// the six arms use — calls `markClosedBy(null)` and discards the answer. So the
// class guards itself and the runner does not, and what keeps the runner honest is
// that every arm `return`s the moment its row is written.
//
// WHY THIS IS A GATE AND NOT A BRANCH. A runtime `if (!markClosedBy(...))` inside
// `appendPhaseEnd` would be unreachable: it can only fire if an arm falls through
// to a second terminal write, which is the very thing the `return`s prevent. It
// would be untestable through `run()`, it would need a LoC-budget raise on a file
// sitting exactly at its ceiling, and it would have to answer a question this
// codebase has already answered twice in opposite directions — `close()` prefers
// ABSENCE to a duplicate (`phase-attempt-recorder.ts`, "a duplicate is worse than
// the absence here"), while an arm's row carries the outcome, exit code and counts
// that `close()`'s generic row does not. Checking the structure that makes the
// branch unreachable costs nothing in `src/` and cannot rot silently.
//
// WHAT IT CHECKS: after every `this.appendPhaseEnd(` call site, the arm reaches a
// `return` or a `throw` before it can reach another one. That is what makes "at
// most one terminal row per attempt" a property of the file rather than of the
// care taken by whoever adds the seventh arm.
//
// WHAT IT DOES NOT CHECK: that the row's CONTENTS are right, or that some arm
// writes a `phase-end` without going through `appendPhaseEnd` at all. The first is
// asserted in `phase-runner-outcome.test.ts` and `phase-runner-backend-posture.
// test.ts`; the second is what `attemptId` on the row exists to make visible.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const RUNNER = resolve(REPO_ROOT, 'src', 'controller', 'phase-runner.ts');

/** A call to the shared terminal-row writer. */
const CALL = /\bthis\.appendPhaseEnd\s*\(/;

/** The statement that makes the next call unreachable from this one. */
const EXIT = /^(?:return\b|throw\b)/;

interface CodeLine {
  readonly line: number;
  readonly text: string;
}

/**
 * Code lines with their real line numbers, comments and blanks dropped.
 *
 * Dropped rather than skipped for the same reason `result-envelope-unknown-is-
 * unwritten.test.ts` drops them: these arms carry multi-line notes between the
 * append and the `return`, and a scan that treated a comment as a code line would
 * measure distance rather than reachability.
 */
function codeLines(source: string): CodeLine[] {
  return source
    .split('\n')
    .map((text, index) => ({ line: index + 1, text: text.trim() }))
    .filter(({ text }) => text !== '')
    .filter(
      ({ text }) =>
        !text.startsWith('//') && !text.startsWith('*') && !text.startsWith('/*')
    );
}

interface Unguarded {
  readonly line: number;
  readonly reason: string;
}

function callsThatCanFallThrough(lines: CodeLine[]): Unguarded[] {
  const out: Unguarded[] = [];
  lines.forEach(({ line, text }, index) => {
    if (!CALL.test(text)) return;
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next]!;
      if (EXIT.test(candidate.text)) return;
      if (CALL.test(candidate.text)) {
        out.push({
          line,
          reason: `reaches the call at ${candidate.line} without returning first`
        });
        return;
      }
    }
    out.push({ line, reason: 'reaches the end of the file without returning' });
  });
  return out;
}

describe('one attempt gets one terminal row (feature 212)', () => {
  const lines = codeLines(readFileSync(RUNNER, 'utf8'));

  it('finds the call sites it governs', () => {
    // Vacuity control. The assertion below expects an empty list, and an empty
    // scan satisfies that for free — which is exactly what a renamed method or a
    // moved file produces. Six arms call it today; the floor sits below that so
    // adding an arm is not a failure and losing the matcher is.
    const calls = lines.filter(({ text }) => CALL.test(text));
    expect(
      calls.length,
      'no `this.appendPhaseEnd(` call was found in phase-runner.ts — the matcher ' +
        'no longer describes how this file writes terminal rows, so the assertion ' +
        'below is comparing nothing to nothing'
    ).toBeGreaterThanOrEqual(5);
  });

  it('leaves no path from one terminal row to a second', () => {
    expect(
      callsThatCanFallThrough(lines),
      'each of these appends a `phase-end` row and can then reach another append ' +
        'without returning. The second row would carry the SAME `attemptId` as the ' +
        'first, and `markClosedBy` would return `false` to a caller that discards ' +
        'it — so FR-002 pairing reads as satisfied twice, which FR-003 is written ' +
        'to keep distinguishable from the gap it actually is. Return straight after ' +
        'the append, as the other arms do.'
    ).toEqual([]);
  });

  it('matches the shapes it claims to match', () => {
    // The call spellings this file uses — bare and bound — and the near-miss that
    // must not be read as one.
    expect(CALL.test('await this.appendPhaseEnd(attemptRef, inputs, \'info\', {')).toBe(true);
    expect(CALL.test('const auditEntry = await this.appendPhaseEnd(')).toBe(true);
    expect(CALL.test('private async appendPhaseEnd(')).toBe(false);

    // The exits, and the values that merely mention one.
    expect(EXIT.test('return {')).toBe(true);
    expect(EXIT.test('return entry;')).toBe(true);
    expect(EXIT.test('throw err;')).toBe(true);
    expect(EXIT.test('terminationReason: \'error\',')).toBe(false);
    expect(EXIT.test('const returned = await this.appendPhaseEnd(')).toBe(false);
  });

  it('fails when an arm forgets to return', () => {
    // The rule proved against known-bad text, per the precedent in
    // `no-content-driven-process-control.test.ts`: a scan that silently stops
    // finding violations must fail here rather than ship as a comment.
    const bad = codeLines(
      [
        "await this.appendPhaseEnd(attemptRef, inputs, 'failure', { outcome: 'failed' });",
        'this.logger.warn(\'something\');',
        "await this.appendPhaseEnd(attemptRef, inputs, 'info', { outcome: 'clean' });",
        'return { outcome };'
      ].join('\n')
    );
    expect(callsThatCanFallThrough(bad)).toHaveLength(1);

    const good = codeLines(
      [
        "await this.appendPhaseEnd(attemptRef, inputs, 'failure', { outcome: 'failed' });",
        'return { outcome };',
        "await this.appendPhaseEnd(attemptRef, inputs, 'info', { outcome: 'clean' });",
        'return { outcome };'
      ].join('\n')
    );
    expect(callsThatCanFallThrough(good)).toEqual([]);
  });
});
