// FR-R4-F20 (feature 248, contract T7.6 and W4) — the tooltips a disabled phase control carries,
// asserted without rendering.
//
// `PhaseControlMenu.test.ts` reads the Skip button's `title` through the DOM, which is the right level
// for "does the operator see it" and the wrong one for the three-way choice `skipControlTitle` makes:
// the failed-task sentence, the off-target text, or the control's own label. A render shows whichever
// one won; it cannot show the others lost for the right reason. The failed-task sentence is the host
// refusal's own (`lifecycleRefusalText('run-failed')`), so the title and the alert line a refused Skip
// raises are one table entry and cannot drift apart (FR-011).

import { describe, expect, it } from 'vitest';

import { lifecycleRefusalText } from '../lifecycle-control-ipc';
import { OFF_TARGET_TITLE, controlTitle, skipControlTitle } from '../phase-control-titles';

const BASE = 'Skip active phase';
const RUN_FAILED_SENTENCE = 'A failed task cannot be skipped: retry it, mark it completed, or remove it.';

describe('controlTitle', () => {
  it('returns the control\'s own label on the Run the surface is about', () => {
    expect(controlTitle(BASE, true)).toBe(BASE);
  });

  it('returns the off-target text when the surface is showing another task', () => {
    expect(controlTitle(BASE, false)).toBe(OFF_TARGET_TITLE);
  });
});

describe('skipControlTitle', () => {
  it('says why a failed task cannot be skipped, in the host refusal\'s own words, when off target', () => {
    expect(skipControlTitle(BASE, false, true)).toBe(lifecycleRefusalText('run-failed'));
    expect(skipControlTitle(BASE, false, true)).toBe(RUN_FAILED_SENTENCE);
  });

  it('says the same on target: a failed row\'s Skip is refused whichever Run the queue holds', () => {
    expect(skipControlTitle(BASE, true, true)).toBe(RUN_FAILED_SENTENCE);
  });

  it('names the three exits a failed task has', () => {
    const sentence = skipControlTitle(BASE, false, true);
    expect(sentence).toContain('retry');
    expect(sentence).toContain('mark it completed');
    expect(sentence).toContain('remove');
  });

  it('falls back to controlTitle for a task that has not failed', () => {
    expect(skipControlTitle(BASE, true, false)).toBe(controlTitle(BASE, true));
    expect(skipControlTitle(BASE, false, false)).toBe(controlTitle(BASE, false));
    expect(skipControlTitle(BASE, false, false)).toBe(OFF_TARGET_TITLE);
  });

  // The control for the cases above: the failed-task sentence and the off-target text are different
  // strings, so a title that always read one of them would fail one of these assertions.
  it('control: the failed-task sentence is not the off-target text', () => {
    expect(RUN_FAILED_SENTENCE).not.toBe(OFF_TARGET_TITLE);
    expect(skipControlTitle(BASE, false, true)).not.toBe(skipControlTitle(BASE, false, false));
  });
});
