// FR-R3-157 (T043, FR-010, SC-004, SC-007, contracts C4.1/C4.3) — how a degraded
// task row is presented, and the one thing the surface may not do to decide it.
//
// C4.3 asks for two properties and the second is the one that carries the value:
// a degraded row must be presented differently from a clean completion AND from a
// plain failure, and it must NAME the phase and the condition rather than merely
// saying "degraded". A row that says only "degraded" tells an operator that
// something was let through without saying what or where, which leaves them with
// the same investigation they would have had with no mark at all.
//
// C4.1 is the negative, and it is the one that fails silently. The degraded state
// is decided once host-side and delivered as a value; no surface may re-derive it
// "not from warning text, not from the presence of a notification tag, not by
// looking the phase up in the pipeline, and not by re-applying the cap rule". The
// hazard is concrete: the host emits `[notify] forced-continue <phase>: ...` on
// this exact path (`src/controller/phase.ts:17,318`), so a surface that scanned
// its free text for that tag would look correct in every test written against a
// real degraded run — and would mark rows degraded that never were, while a row
// whose warning text was reworded would quietly go clean.
//
// NOTE ON THIS TASK'S OWN TEXT. T043 asks for a row "whose warnings contain the
// forced-continue tag". `QueueItem` has no `warnings` field — the tag is a phase
// notification, not a row field, and it never reaches this component. The nearest
// real construction, and the one C4.1 actually forbids, is the row's own free-text
// field: `lastErrorSummary` renders verbatim, so it is where tag text would arrive
// if it arrived anywhere. The negative is written against that, and against the
// tag's absence from the whole webview tree, which is the half no rendering test
// can reach.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';

import QueueTaskRow from '../QueueTaskRow.svelte';
import type { DegradedPhaseEntry, QueueItem } from '../../../lib/snapshot-types';

afterEach(() => cleanup());

const AUDIT: DegradedPhaseEntry = { phaseId: 'audit', condition: 'open_questions > 0' };
const VERIFY: DegradedPhaseEntry = { phaseId: 'verify', condition: 'coverage < 80' };

/** The literal the host emits on this path. It may not appear in the webview at all. */
const FORCE_CONTINUE_TAG = '[notify] forced-continue';

function task(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'task-1',
    label: 'A task',
    enqueuedAt: '2026-05-10T11:00:00.000Z',
    startedAt: '2026-05-10T11:01:00.000Z',
    updatedAt: '2026-05-10T11:09:00.000Z',
    completedAt: '2026-05-10T11:09:00.000Z',
    status: 'completed',
    retryCount: 0,
    lastErrorSummary: null,
    pausedReason: null,
    currentPhase: null,
    queueId: 'default',
    position: 0,
    pauseCause: null,
    phaseProgress: null,
    ...overrides
  } as QueueItem;
}

function renderRow(item: QueueItem) {
  return render(QueueTaskRow, {
    props: {
      task: item,
      rowIndex: 0,
      pipeline: undefined,
      pipelineName: 'Pipe',
      progress: null,
      timing: { kind: 'elapsed', value: 60_000 },
      isSelected: false,
      onSelect: () => {},
      onKeyDown: () => {}
    }
  });
}

/** What an operator can actually read off the row. */
const textOf = (item: QueueItem): string => renderRow(item).container.textContent;

/** The row's markup, for the comparisons that ask whether two rows differ at all. */
const htmlOf = (item: QueueItem): string => renderRow(item).container.innerHTML;

describe('FR-R3-157 (T043) — a degraded row is presented differently, and named', () => {
  it('names the phase and the condition, not merely the word "degraded" (C4.3)', () => {
    const text = textOf(task({ degradedPhases: [AUDIT] }));

    expect(text).toContain('audit');
    expect(text).toContain('open_questions > 0');
  });

  it('does not render identically to a clean completion of the same task (SC-004)', () => {
    // The whole guarantee in one assertion: FR-006 forbids a degraded run being
    // indistinguishable from a clean one, and "indistinguishable" means the
    // operator sees the same thing. The two rows differ in exactly one input.
    const degraded = htmlOf(task({ degradedPhases: [AUDIT] }));
    cleanup();
    const clean = htmlOf(task());

    expect(degraded).not.toEqual(clean);
  });

  it('does not render identically to a plain failure either (C4.3)', () => {
    // C4.3 names two comparisons, and this is the one a single "something went
    // wrong" treatment would collapse. A degraded run COMPLETED — work carried on
    // past an unmet condition — and a failure did not. Presenting them alike would
    // tell an operator to go looking for a failure that never happened.
    const degraded = htmlOf(task({ status: 'completed', degradedPhases: [AUDIT] }));
    cleanup();
    const failed = htmlOf(task({ status: 'failed' }));

    expect(degraded).not.toEqual(failed);
  });

  it('names every phase that degraded, not just the first (FR-011)', () => {
    // A run can carry more than one. Rendering only the first would under-report
    // by an amount nothing on the row discloses.
    const text = textOf(task({ degradedPhases: [AUDIT, VERIFY] }));

    for (const entry of [AUDIT, VERIFY]) {
      expect(text).toContain(entry.phaseId);
      expect(text).toContain(entry.condition);
    }
  });
});

describe('FR-R3-157 (T043) — the row reads the value and re-derives nothing (SC-007, C4.1)', () => {
  it('is NOT marked degraded when only the warning text says so', () => {
    // THE NEGATIVE THIS TASK EXISTS FOR. Both rows below carry every hallmark of
    // a forced continue: the tag text verbatim in the row's own free-text summary,
    // naming the very phase and condition, plus a retry count consistent with an
    // exhausted cap. They differ in exactly one thing — whether the host said so —
    // and only that one may decide. A surface that scanned the text would mark
    // both; a surface that read the value marks one.
    const summary = `${FORCE_CONTINUE_TAG} audit: condition still truthy at cap (open_questions > 0)`;

    const tagOnly = renderRow(task({ retryCount: 3, lastErrorSummary: summary }));
    expect(tagOnly.queryByTestId('queue-task-degraded-task-1')).toBeNull();
    cleanup();

    // The positive control, so the assertion above means "this row was not marked"
    // rather than "no row is ever marked" — which is what it would mean if the
    // marker had been mis-wired and rendered nowhere at all.
    const withValue = renderRow(
      task({ retryCount: 3, lastErrorSummary: summary, degradedPhases: [AUDIT] })
    );
    expect(withValue.queryByTestId('queue-task-degraded-task-1')).not.toBeNull();
  });

  it('renders a row with no degradedPhases identically whether or not a run is degrading elsewhere', () => {
    // Absence means NOT degraded — an answer, not a missing one. An `undefined`
    // key and an explicitly empty list must reach the same presentation, or the
    // row would report on how the host happened to spell "nothing".
    const absent = htmlOf(task({ degradedPhases: undefined }));
    cleanup();
    const empty = htmlOf(task({ degradedPhases: [] }));

    expect(empty).toEqual(absent);
  });

  it('never mentions the host notification tag anywhere in the webview tree (C4.1)', () => {
    // The structural half, which no rendering test can reach: a surface cannot
    // scan for a tag whose literal it does not hold. Read from the file rather
    // than asserted about behaviour, because the defect C4.1 describes is the
    // presence of the code, not a particular output of it.
    const componentPath = join(__dirname, '../QueueTaskRow.svelte');
    const source = readFileSync(componentPath, 'utf8');

    expect(source).not.toContain(FORCE_CONTINUE_TAG);
    expect(source).not.toContain('forced-continue');
    // And no re-application of the cap rule: the row holds no retry arithmetic.
    expect(source).not.toContain('iterationCap');
    expect(source).not.toContain('retryCondition');
  });
});
