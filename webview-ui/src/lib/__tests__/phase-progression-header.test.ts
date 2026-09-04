// Feature 201 (T023) — the Phase Progression header line, asserted without
// rendering.
//
// The four combinations below are the header's whole input space: a Task id
// present or absent, crossed with a named Pipeline present or absent. They were
// previously reachable only through `PhaseProgression.test.ts`'s rendered
// heading, which is the right level for "is the heading shown" and the wrong
// one for "which of the two optional parts appears" — a render assertion on the
// full string passes for the wrong reason as soon as either half changes.

import { describe, expect, it } from 'vitest';

import { phaseProgressionHeader } from '../phase-progression-header';

const CUSTOM = { id: 'research-flow', name: 'Research Flow' };
const STANDARD = { id: 'standard', name: 'Standard' };

describe('phaseProgressionHeader', () => {
  it('names neither when there is no Task and no chosen Pipeline', () => {
    expect(phaseProgressionHeader(null, null)).toBe('Phase Progression');
  });

  it('names the in-flight Task', () => {
    expect(phaseProgressionHeader('task-7', null)).toBe('Phase Progression (Active: task-7)');
  });

  it('names the Pipeline with no Task in flight', () => {
    expect(phaseProgressionHeader(null, CUSTOM)).toBe('Phase Progression — Pipeline: Research Flow');
  });

  it('names both, Task first', () => {
    expect(phaseProgressionHeader('task-7', CUSTOM)).toBe(
      'Phase Progression (Active: task-7) — Pipeline: Research Flow'
    );
  });

  it("suppresses the default Pipeline by id, so nobody is told about a choice they didn't make", () => {
    expect(phaseProgressionHeader('task-7', STANDARD)).toBe('Phase Progression (Active: task-7)');
  });

  it('suppresses by id and not by name: a custom Pipeline called Standard is still named', () => {
    // The exclusion above could be written against either field and would look
    // identical in every other case. It must be the id: the id is what says "no
    // choice was made", and an operator who deliberately built a Pipeline and
    // called it Standard has made one.
    expect(phaseProgressionHeader(null, { id: 'my-flow', name: 'Standard' })).toBe(
      'Phase Progression — Pipeline: Standard'
    );
  });

  it('treats the empty Task id as no Task, matching the falsy check it replaced', () => {
    // Pinned because the extraction turned an inline `activeTaskId ? …` into a
    // parameter, and a reader could reasonably expect a null check instead.
    expect(phaseProgressionHeader('', CUSTOM)).toBe('Phase Progression — Pipeline: Research Flow');
  });
});
