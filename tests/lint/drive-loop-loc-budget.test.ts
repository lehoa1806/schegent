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
 *
 * Next candidates, named so the next decrement does not start with a
 * re-measurement: the four pause arms — breakpoint, delayed-retry, rate-limit,
 * verify — are roughly 230 lines between them. The probe-failure arm is NOT a
 * candidate for merging into the shared sequence: its audit emission order differs,
 * and unifying it is an observable change.
 */
const DRIVE_MAX_LINES = 688;

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
