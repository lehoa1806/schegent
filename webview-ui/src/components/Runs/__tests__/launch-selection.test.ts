// Feature 102 (T019, US2 — FR-013, FR-014) — what the surface remembers between
// one projection and the next.
//
// The surface holds exactly one selection, and the two things that can go wrong
// with it are both about identity:
//
//   * **`id` alone is not the identity.** A Pipeline and a Workflow may carry the
//     same id — nothing in the store forbids it, because the two catalogs are
//     separate documents with separate id spaces. A surface that compares ids
//     highlights a row in the other section, and, worse, opens the wrong form.
//     Every fixture here gives both definitions the *same* id, so a comparison
//     that drops `kind` fails on the first assertion rather than on the day a
//     workspace happens to collide.
//
//   * **A selection outlives the projection that justified it.** The operator
//     selects, the definition is deactivated in another window, the next
//     projection arrives without it. FR-013 says the selection clears and any
//     open form closes. The predicate is *absence from the projection*, never a
//     reason code: a Workflow disappears when a member Pipeline is deactivated,
//     and the surface is told nothing about why. Both routes out of the list are
//     therefore the same route, which is the point of testing them together.
//
// Absence of the whole projection is deliberately *not* that predicate. The host
// omits `launchables` until both catalogs resolve (FR-006), and a host that has
// not looked yet has not said the definition is gone. Treating the loading arm as
// a clearing signal would give absence two meanings — the exact conflation the
// section contract exists to prevent.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isSelected,
  reconcileSelection,
  selectedEntry,
  type LaunchSelection
} from '../launch-selection';
import { ANALYSIS, RESEARCH, buildSnapshot, entries, projection } from './launch-fixture';

vi.mock('../../../lib/workflow-run-ipc', () => ({
  continueWorkflow: vi.fn(),
  launchWorkflow: vi.fn()
}));
vi.mock('../../../lib/run-launcher-ipc', () => ({ launchPipeline: vi.fn() }));

// Late import so the surface binds to the stubs above.
import RunsSurface from '../../RunsSurface.svelte';

afterEach(() => cleanup());

const PIPELINE_SELECTION: LaunchSelection = { kind: 'pipeline', id: 'analysis-pipeline' };
const WORKFLOW_SELECTION: LaunchSelection = { kind: 'workflow', id: 'analysis-pipeline' };

describe('selection identity is (kind, id) (FR-014)', () => {
  it('does not match an entry of the other kind carrying the same id', () => {
    expect(isSelected(ANALYSIS, PIPELINE_SELECTION)).toBe(true);
    expect(isSelected(RESEARCH, PIPELINE_SELECTION)).toBe(false);
    expect(isSelected(RESEARCH, WORKFLOW_SELECTION)).toBe(true);
    expect(isSelected(ANALYSIS, WORKFLOW_SELECTION)).toBe(false);
  });

  it('matches nothing when there is no selection', () => {
    expect(isSelected(ANALYSIS, null)).toBe(false);
    expect(isSelected(RESEARCH, null)).toBe(false);
  });

  it('resolves a selection to the entry in its own section, not the other', () => {
    expect(selectedEntry(projection(), PIPELINE_SELECTION)).toBe(ANALYSIS);
    expect(selectedEntry(projection(), WORKFLOW_SELECTION)).toBe(RESEARCH);
  });

  it('resolves to nothing when the section it names carries no entries', () => {
    const withoutPipelines = projection({ state: 'none-active' });
    expect(selectedEntry(withoutPipelines, PIPELINE_SELECTION)).toBeUndefined();
    // The other section is untouched: one section emptying is not the other's news.
    expect(selectedEntry(withoutPipelines, WORKFLOW_SELECTION)).toBe(RESEARCH);
  });
});

describe('a selection the next projection no longer offers (FR-013)', () => {
  it('clears when the definition itself stops being offered', () => {
    // Route one: the operator deactivates the Pipeline in the Builder.
    expect(reconcileSelection(projection({ state: 'none-active' }), PIPELINE_SELECTION)).toBeNull();
  });

  it('clears when the definition stops being offered for a reason it was never told', () => {
    // Route two: a member Pipeline was deactivated, so the Workflow can no longer
    // be composed and the host stops offering it. The projection says only that
    // it is absent — there is no reason code, and the surface must not wait for
    // one before letting go of a selection it can no longer resolve.
    const stillHasPipelines = projection(entries(ANALYSIS), { state: 'no-definitions' });
    expect(reconcileSelection(stillHasPipelines, WORKFLOW_SELECTION)).toBeNull();
  });

  it('keeps a selection the projection still offers', () => {
    expect(reconcileSelection(projection(), PIPELINE_SELECTION)).toEqual(PIPELINE_SELECTION);
    expect(reconcileSelection(projection(), WORKFLOW_SELECTION)).toEqual(WORKFLOW_SELECTION);
  });

  it('keeps a selection while the projection is absent (FR-006)', () => {
    // Loading is not a statement about content, so it is not a statement that the
    // definition went away. Clearing here would drop the operator's selection on
    // every host restart.
    expect(reconcileSelection(undefined, PIPELINE_SELECTION)).toEqual(PIPELINE_SELECTION);
  });

  it('leaves an empty selection empty', () => {
    expect(reconcileSelection(projection(), null)).toBeNull();
    expect(reconcileSelection(undefined, null)).toBeNull();
  });
});

describe('the surface holds one selection across both sections (FR-014)', () => {
  it('shows the detail for the selected entry and only that entry', async () => {
    const { getByTestId, queryAllByTestId } = render(RunsSurface, {
      snapshot: buildSnapshot()
    });

    await fireEvent.click(getByTestId('launchable-select-pipeline-analysis-pipeline'));
    expect(queryAllByTestId('launchable-detail')).toHaveLength(1);
    expect(getByTestId('launchable-detail-name').textContent).toContain('Analysis Pipeline');
  });

  it('clears the other section when a selection is made in one', async () => {
    // One selection, so selecting in Workflows must un-select in Pipelines. Two
    // detail panels open at once would let an operator Run one while reading the
    // other's ports.
    const { getByTestId, queryAllByTestId } = render(RunsSurface, {
      snapshot: buildSnapshot()
    });

    await fireEvent.click(getByTestId('launchable-select-pipeline-analysis-pipeline'));
    await fireEvent.click(getByTestId('launchable-select-workflow-analysis-pipeline'));

    expect(queryAllByTestId('launchable-detail')).toHaveLength(1);
    expect(getByTestId('launchable-detail-name').textContent).toContain('Research Workflow');
    expect(
      getByTestId('launchable-select-pipeline-analysis-pipeline').getAttribute('aria-pressed')
    ).toBe('false');
  });

  it('drops the selection and closes the open form on the next projection (FR-013)', async () => {
    const { getByTestId, queryByTestId, rerender } = render(RunsSurface, {
      snapshot: buildSnapshot()
    });

    await fireEvent.click(getByTestId('launchable-select-pipeline-analysis-pipeline'));
    await fireEvent.click(getByTestId('launchable-detail-trigger'));
    expect(queryByTestId('run-launcher')).toBeTruthy();

    await rerender({
      snapshot: buildSnapshot({ launchables: projection({ state: 'none-active' }) })
    });

    expect(queryByTestId('launchable-detail')).toBeNull();
    expect(queryByTestId('run-launcher')).toBeNull();
  });
});
