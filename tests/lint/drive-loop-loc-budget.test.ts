// FR-R3-128 (T1484) — `RunDriver.drive()` is governed as a METHOD, shrink-only.
//
// WHY A SECOND BUDGET WHEN `source-loc-budget.test.ts` EXISTS. That gate bounds
// FILES, and the debt this item is about is one method. The two diverge in a way
// that matters: extracting a method's body into a new module costs the file an
// import, a binding and a call shape, so a real decrement in the method can leave
// the file flat or larger. `FR-R3-128`'s acceptance is "`drive()` is under its
// recorded target", and a file ceiling cannot express that.
//
// SHRINK-ONLY, and deliberately not a ratchet with slack. The number below may be
// LOWERED by a change that extracts more, and may not be raised. There is no
// "raise it with a reason" path here, which is the difference from the file gate:
// the file gate governs a whole module that legitimately acquires responsibilities,
// while this governs one method that the audit named as the thing to reduce. A
// change that needs `drive()` longer is a change that needs another arm extracted.
//
// MEASURED, NOT PARSED. Brace-depth counting from the signature, which is enough
// for one known method in one known file and avoids standing up a TypeScript program
// in a gate that runs on every `test:host`.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const DRIVER = 'src/services/run-driver.ts';
const SIGNATURE = 'public async drive(';

/**
 * The recorded target.
 *
 * 688 lines measured 2026-08-27, down from 708. `FR-R3-107` and the audit of
 * 2026-08-27 both recorded **744**, which was stale by 36 when this was measured —
 * corrected here rather than inherited, because a target computed from a stale
 * baseline is not a target.
 *
 * History, so a later reader can see the direction rather than one number:
 *
 *   744  as recorded by FR-R3-107 (stale by the time FR-R3-128 measured it)
 *   708  measured 2026-08-27, before this feature
 *   688  after the terminal effect sequence moved to `run-terminal-effects.ts`
 *   687  FR-R3-153 (2026-09-03) — `finish`/`pause` started refusing an illegal
 *        transition instead of always succeeding; the four call sites this
 *        method makes now log a refusal via one shared `logQueueRefusal`
 *        helper (extracted, not inlined here) rather than each hand-rolling
 *        an `if (result.ok === false) { this.deps.logger.warn(...) }` block —
 *        a net decrease even after adding the refusal check.
 *   685  Feature 194 (FR-009, T019, 2026-09-03) — the `for (const w of
 *        postDecision.warnings) { this.deps.logger.warn(w); }` loop and the
 *        new stagnation-tracker eviction call both left for
 *        `handlePostPhaseDecisionSideEffects()`, a private method outside
 *        `drive()`. One call site replaced three lines of pre-existing code
 *        plus what the new eviction check would otherwise have cost inline —
 *        a real two-line decrement, not a comment trim, even though this
 *        feature needed `drive()` to do one more thing.
 *   684  Feature 194 (FR-009, 2026-09-03, same change) — the eviction wiring
 *        above covers only the decideAfterPhase()-mediated exits; two more
 *        (mid-loop cancellation, a skip-phase override) bypass it entirely
 *        and need their own eviction call or the tracker for the phase they
 *        left off at leaks for the rest of the window's lifetime. The
 *        cancellation arm's whole body (persistTransition/emit/record, plus
 *        the new eviction call) moved to `handleCancellation()`, a private
 *        method outside `drive()` — replacing a 6-line inline block with a
 *        4-line call, a net decrease even with the new call added. The
 *        skip-phase arm's eviction call is the one line `decideBeforePhase()`
 *        has no equivalent hook for, so it stays inline.
 *   681  Feature 194 code review (FR-009, 2026-09-04) — the enumeration above
 *        was still incomplete: a rethrown error from anywhere in the loop body
 *        and the override-abort restart both exit without a
 *        `PostPhaseDecision`, so neither reached any of the five eviction
 *        calls, and a resumed run compared fresh figures against a
 *        pre-interruption snapshot. The first fix is an extraction, so the
 *        method shrank while gaining the coverage: the `finally`'s three
 *        state-reset assignments moved into `endOfDriveReset()` (3 lines → 1),
 *        and the unconditional eviction rides along there rather than being
 *        enumerated per exit. The override-abort arm keeps its eviction inline
 *        (+2 including the comment): extracting it too would have shrunk this
 *        method by another 2 while pushing `run-driver.ts` itself to within 2
 *        lines of its 1,330 ceiling, which the FR-R3-119 tight-ceiling gate in
 *        source-loc-budget.test.ts reads as an ungoverned file. The whole-file
 *        margin is the binding constraint on that arm, not this one.
 *
 *   668  FR-R3-157 (2026-09-04) — the degraded-cap mark had to be appended in the
 *        SAME persisted transition as the phase result it describes, which meant
 *        adding to the post-phase `advanced` literal. Seven lines there put
 *        `drive()` at 688 and `run-driver.ts` at 1,309 — 21 lines under a 1,330
 *        ceiling whose FR-R3-119 tight margin is 26, so the whole-file gate the
 *        681 entry above predicted would bind is exactly what bound. Both gates
 *        name the same response and neither has a raise path, so the whole
 *        `advanced` fold (30 lines) moved to `services/run-advance.ts` as
 *        `advancedRun()` — a pure function of the Run, the decision and the
 *        phase result — replaced by an 8-line call plus a 2-line comment. The
 *        one-write guarantee is now stated and tested where it lives.
 *
 *   664  FR-R3-175 (T1758, 2026-09-13) — an activation resume was dropping the
 *        persisted CLI conversation silently, and the line that says so has to be
 *        emitted where the disposition is DECIDED, which is this loop (the
 *        controller that triggers the resume holds only a prediction the
 *        per-phase runner-kind resolution can falsify). So the feature needed
 *        `drive()` to do one more thing, and this budget names the response:
 *        extract another arm. The 8-line `resolveSessionDispatch({...})` literal
 *        and the new once-per-drive reporting both went to
 *        `services/session-disposition.ts` as `SessionDispositionReporter`,
 *        replaced by a 4-line call — a net decrement even though the method
 *        gained a responsibility. `run-driver.ts` itself moved 1,290 → 1,291,
 *        which keeps 39 lines under its 1,330 ceiling against a `tightMargin` of
 *        26, so the whole-file gate that bound the 681 and 668 entries does not
 *        bind here.
 *
 *   660  FR-R3-209 (feature 237, 2026-10-26) — the Run now keeps the session's cost
 *        figure beside its id, so the three session fields are cleared and carried
 *        together. The skip-phase clear (six lines) and the manual-pause carry (two)
 *        became one line each, through `NO_CLI_SESSION` and `cliSessionOf` in
 *        `state/workflow-run.ts`. That paid for the figure's write and its dispatch
 *        line, 664 → 660, a net decrement even though the method now carries one more
 *        field. `run-driver.ts` itself moved 1,301 → 1,294 by `wc -l`, which keeps 35
 *        lines under its 1,330 ceiling against a `tightMargin` of 26.
 *
 * Next candidates, named so the next decrement does not start with a
 * re-measurement: the four pause arms — breakpoint, delayed-retry, rate-limit,
 * verify — are roughly 230 lines between them. The probe-failure arm is NOT a
 * candidate for merging into the shared sequence: its audit emission order differs,
 * and unifying it is an observable change.
 */
const DRIVE_MAX_LINES = 660;

/** Lines from the signature to the closing brace, inclusive. */
export function methodLineCount(source: string, signature: string): number {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.includes(signature));
  if (start < 0) return -1;
  let depth = 0;
  let opened = false;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]!;
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (line.includes('{')) opened = true;
    if (opened && depth === 0) return index - start + 1;
  }
  return -1;
}

describe('RunDriver.drive() is shrink-only (FR-R3-128)', () => {
  const source = readFileSync(resolve(REPO_ROOT, DRIVER), 'utf8');

  it('finds the method it governs', () => {
    // Vacuity control. A renamed method, a changed modifier or a moved file would
    // make the count -1, and a gate comparing -1 to a ceiling passes silently — the
    // failure mode that matters most for a shrink-only budget.
    expect(
      methodLineCount(source, SIGNATURE),
      `${DRIVER} no longer contains '${SIGNATURE}'. If the method was renamed or moved, point ` +
        'this gate at it in the same change — a budget that cannot find its subject is not a budget.'
    ).toBeGreaterThan(0);
  });

  it('stays at or below its recorded target', () => {
    const actual = methodLineCount(source, SIGNATURE);
    expect(
      actual,
      `RunDriver.drive() is ${actual} lines, over its recorded ${DRIVE_MAX_LINES}. This budget is ` +
        'SHRINK-ONLY: there is no raise-with-a-reason path, because the audit of 2026-08-27 named ' +
        'this method the thing to reduce. Extract another arm — the four pause arms are the named ' +
        'candidates — and lower the number in the same change.'
    ).toBeLessThanOrEqual(DRIVE_MAX_LINES);
  });

  it('the target is not slack, so a real decrement is visible', () => {
    // A ceiling far above the method is a high-water mark nobody decided on: the
    // next edit fits under it and the number stops meaning anything.
    // `source-loc-budget.test.ts` makes the same argument for files, with a 25-line
    // margin; here the target is set AT the measurement, because the method may only
    // shrink and there is nothing for slack to absorb.
    expect(DRIVE_MAX_LINES - methodLineCount(source, SIGNATURE)).toBeLessThanOrEqual(0);
  });

  it('counts a method, proved on a fixture', () => {
    // The counter is the whole gate; a counter that returned a small number for
    // anything would pass every assertion above.
    const fixture = [
      'class X {',
      '  public async drive(a: number): Promise<void> {',
      '    if (a > 0) {',
      '      return;',
      '    }',
      '  }',
      '}'
    ].join('\n');
    expect(methodLineCount(fixture, 'public async drive(')).toBe(5);
    expect(methodLineCount(fixture, 'public async nope(')).toBe(-1);
  });
});
