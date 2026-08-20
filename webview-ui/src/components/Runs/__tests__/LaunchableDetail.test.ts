// Feature 102 (T017, US2 — FR-007, FR-008, FR-009, FR-017) — what an operator
// sees between choosing a definition and running it.
//
// The flow is four steps on purpose — select, read, Trigger, Run — and each of
// the three tests below pins one of the joints, because the failure modes are
// all collapses of the sequence rather than faults inside any one step:
//
//   * **The detail panel reads; it does not edit.** It is the last place an
//     operator confirms they picked the right thing, and a stray input there
//     would be a second, unsubmitted copy of the form's values. Asserted by
//     sweeping the panel for form controls rather than by naming the fields it
//     does not have, since the next field added would not be one this test knew
//     to look for.
//
//   * **Trigger and Run are two controls, not one.** Collapsing them turns
//     "I want to look at this" into "start it", which is exactly the accident the
//     explicit flow exists to prevent. Pinned by asserting the host is untouched
//     after Trigger and reached only after Run.
//
//   * **The ports are recomputed, never remembered.** A Workflow's ports are
//     derived from its graph and a Pipeline's from its active version; both move
//     when the definition is republished. A panel rendering a copy taken at
//     selection time shows the operator the shape of a version that is no longer
//     the one their run will freeze. Asserted by changing the projection under a
//     live selection and requiring the panel to follow without re-selecting.
//
// FR-009's requiredness marker is asserted on its text and on the port list's
// membership, never on a class or a colour — an operator who cannot distinguish
// the marker's colour must still be able to read which ports the definition
// insists on.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Launchable } from '../../../lib/snapshot-types';
import { ANALYSIS, RESEARCH, buildSnapshot, entries, projection } from './launch-fixture';

const launchPipeline = vi.fn();
vi.mock('../../../lib/workflow-run-ipc', () => ({
  continueWorkflow: vi.fn(),
  launchWorkflow: vi.fn()
}));
vi.mock('../../../lib/run-launcher-ipc', () => ({
  launchPipeline: (...args: readonly unknown[]) => launchPipeline(...args)
}));

// Late import so the surface binds to the stubs above.
import RunsSurface from '../../RunsSurface.svelte';

afterEach(() => {
  cleanup();
  launchPipeline.mockReset();
});

async function selectPipeline() {
  const view = render(RunsSurface, { snapshot: buildSnapshot() });
  await fireEvent.click(view.getByTestId('launchable-select-pipeline-analysis-pipeline'));
  return view;
}

describe('the detail panel for a selected definition (FR-007)', () => {
  it('states the description, the input ports, and the active version', async () => {
    const { getByTestId } = await selectPipeline();
    const detail = getByTestId('launchable-detail');

    expect(getByTestId('launchable-detail-name').textContent).toContain('Analysis Pipeline');
    expect(getByTestId('launchable-detail-description').textContent).toContain(
      'Reads a corpus and writes the findings up.'
    );
    expect(getByTestId('launchable-detail-version').textContent).toContain('v3');
    expect(getByTestId('launchable-detail-port-topic').textContent).toContain('Topic');
    expect(getByTestId('launchable-detail-port-notes').textContent).toContain('Notes');
    expect(detail.textContent).toContain('Reads a corpus');
  });

  it('marks the ports the definition declares required by a readable text marker (FR-009)', async () => {
    const { getByTestId, queryByTestId } = await selectPipeline();

    expect(getByTestId('launchable-detail-required-topic').textContent?.toLowerCase()).toContain(
      'required'
    );
    expect(queryByTestId('launchable-detail-required-notes')).toBeNull();
  });

  it('offers no editable field of its own', async () => {
    const { getByTestId } = await selectPipeline();
    const detail = getByTestId('launchable-detail');

    expect(detail.querySelectorAll('input, textarea, select')).toHaveLength(0);
  });

  it('recomputes its ports from the projection rather than a copy taken at selection (FR-017)', async () => {
    // The definition is republished under the operator's live selection: same id,
    // new active version, new ports. Nothing is re-selected — the panel must
    // follow the projection, because the run will freeze what the projection now
    // offers and not what the panel happened to capture.
    const republished: Launchable = {
      ...ANALYSIS,
      activeVersionId: 'v4',
      inputs: [{ portId: 'corpus', label: 'Corpus', type: 'text', required: true }]
    };
    const { getByTestId, queryByTestId, rerender } = await selectPipeline();
    expect(getByTestId('launchable-detail-port-topic')).toBeTruthy();

    await rerender({
      snapshot: buildSnapshot({ launchables: projection(entries(republished)) })
    });

    expect(queryByTestId('launchable-detail-port-topic')).toBeNull();
    expect(getByTestId('launchable-detail-port-corpus').textContent).toContain('Corpus');
    expect(getByTestId('launchable-detail-version').textContent).toContain('v4');
  });

  it('states the same three things for a Workflow, whose ports are derived', async () => {
    // A Workflow's derived ports carry no requiredness (FR-009), and the panel
    // must not invent one: an unmarked port is "not declared required", which is
    // a different claim from "optional".
    const { getByTestId, queryByTestId } = render(RunsSurface, { snapshot: buildSnapshot() });
    await fireEvent.click(getByTestId('launchable-select-workflow-analysis-pipeline'));

    expect(getByTestId('launchable-detail-name').textContent).toContain(RESEARCH.name);
    expect(getByTestId('launchable-detail-version').textContent).toContain('v2');
    expect(getByTestId('launchable-detail-port-seed').textContent).toContain('Seed');
    expect(queryByTestId('launchable-detail-required-seed')).toBeNull();
  });
});

describe('a window that cannot start work (FR-015)', () => {
  it('still lists and still selects, but withholds Trigger and says why', async () => {
    // Read-only is not a reduced surface. An operator in a second window is
    // usually there to look something up, and hiding the lists would answer a
    // question they did not ask. What they cannot do is start work — so the one
    // control that starts work is withheld, and the reason is on screen next to
    // it rather than left to be inferred from a control that does nothing.
    const { getByTestId, queryByTestId } = render(RunsSurface, {
      snapshot: buildSnapshot({ isPrimary: false })
    });

    await fireEvent.click(getByTestId('launchable-select-pipeline-analysis-pipeline'));

    expect(getByTestId('launchable-detail-name').textContent).toContain('Analysis Pipeline');
    expect(getByTestId('launchable-detail-port-topic')).toBeTruthy();
    expect((getByTestId('launchable-detail-trigger') as HTMLButtonElement).disabled).toBe(true);
    expect(getByTestId('launchable-detail-read-only').textContent).toContain('cannot start runs');

    await fireEvent.click(getByTestId('launchable-detail-trigger'));
    expect(queryByTestId('run-launcher')).toBeNull();
    expect(launchPipeline).not.toHaveBeenCalled();
  });

  it('states nothing about the window when it can start work', async () => {
    const { queryByTestId } = await selectPipeline();
    expect(queryByTestId('launchable-detail-read-only')).toBeNull();
  });
});

describe('Trigger and Run are distinct controls (FR-008)', () => {
  it('opens the form on Trigger without reaching the host', async () => {
    const { getByTestId, queryByTestId } = await selectPipeline();
    expect(queryByTestId('run-launcher')).toBeNull();

    await fireEvent.click(getByTestId('launchable-detail-trigger'));

    expect(getByTestId('run-launcher')).toBeTruthy();
    expect(launchPipeline).not.toHaveBeenCalled();
  });

  it('presents exactly the selected definition ports in the form, with the required one marked (FR-009)', async () => {
    const { getByTestId, queryByTestId } = await selectPipeline();
    await fireEvent.click(getByTestId('launchable-detail-trigger'));

    expect(getByTestId('run-input-topic')).toBeTruthy();
    expect(getByTestId('run-input-notes')).toBeTruthy();
    expect(queryByTestId('run-input-seed')).toBeNull();
    expect(getByTestId('run-input-required-topic').textContent?.toLowerCase()).toContain(
      'required'
    );
    expect(queryByTestId('run-input-required-notes')).toBeNull();
  });

  it('submits only on Run', async () => {
    launchPipeline.mockResolvedValue({ outcome: 'enqueued', requestId: 'request-9' });
    const { getByTestId } = await selectPipeline();
    await fireEvent.click(getByTestId('launchable-detail-trigger'));

    await fireEvent.click(getByTestId('run-launcher-submit'));

    expect(launchPipeline).toHaveBeenCalledTimes(1);
    expect(launchPipeline.mock.calls[0][0]).toMatchObject({ pipelineId: 'analysis-pipeline' });
  });
});
