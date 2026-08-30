// Feature 184 (FR-R3-141, T006/T008/T009) — one Phase card on the canvas.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import PipelineFlowNode from '../PipelineBuilderEditors/PipelineFlowNode.svelte';
import { draftError, makeFlowView } from './pipeline-flow-fixtures';

afterEach(cleanup);

const REGION = 'pipeline-errors-release-flow-phase-1';

function mount(handles: ReturnType<typeof makeFlowView>, position: number) {
  return render(PipelineFlowNode, {
    props: { view: handles.view, position, errorRegionId: REGION }
  });
}

describe('PipelineFlowNode (T006)', () => {
  it('renders the position badge, the Phase name and the Phase id', () => {
    const handles = makeFlowView();
    const { container } = mount(handles, 1);
    const at = (id: string) => container.querySelector(`[data-testid="${id}"]`);

    expect(at('pipelines-phase-position-1')?.textContent.trim()).toBe('2');
    expect(at('pipelines-phase-title-1')?.textContent.trim()).toBe('Done');
    expect(at('pipelines-phase-id-1')?.textContent.trim()).toBe('done');
    // Mapping row 28 — the hover summary the old sequence row carried came with
    // the card, from the same provider rather than a second copy of the rule.
    expect(at('pipelines-phase-card-1')?.getAttribute('title')).toBe('tooltip:done');
  });

  it('keeps the three action buttons under their existing test ids and aria-labels', () => {
    const handles = makeFlowView();
    const { container } = mount(handles, 1);
    const at = (id: string) => container.querySelector(`[data-testid="${id}"]`);

    // The ids and labels are the ones the old sequence rows carried. They are
    // asserted here because the visual and a11y gates address them by name, and
    // a rename would move the surface without any test failing on the move.
    expect(at('pipelines-move-phase-up-1')?.getAttribute('aria-label')).toBe('Move Phase 2 up');
    expect(at('pipelines-move-phase-down-1')?.getAttribute('aria-label')).toBe('Move Phase 2 down');
    expect(at('pipelines-remove-phase-1')?.getAttribute('aria-label')).toBe('Remove Phase 2');
  });

  it('selects by position, and the reorder and remove buttons carry the position through', async () => {
    const handles = makeFlowView();
    const { container } = mount(handles, 1);
    const at = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement;

    await fireEvent.click(at('pipelines-phase-card-1'));
    expect(handles.onselect).toHaveBeenCalledWith({ kind: 'phase', position: 1 });

    await fireEvent.click(at('pipelines-move-phase-up-1'));
    expect(handles.onmoveup).toHaveBeenCalledWith(1);
    await fireEvent.click(at('pipelines-remove-phase-1'));
    expect(handles.onremove).toHaveBeenCalledWith(1);
  });

  it('shows the id of a position the effective catalog does not hold, and says so', () => {
    const handles = makeFlowView({ phases: ['ghost-phase'] });
    const { container } = mount(handles, 0);
    const at = (id: string) => container.querySelector(`[data-testid="${id}"]`);

    expect(at('pipelines-phase-id-0')?.textContent.trim()).toBe('ghost-phase');
    expect(at('pipelines-phase-unknown-0')).not.toBeNull();
  });
});

describe('PipelineFlowNode readonly (T008)', () => {
  it('renders all three buttons present and disabled, not absent', () => {
    const handles = makeFlowView({ readonly: true });
    const { container } = mount(handles, 0);
    const at = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement;

    // The assertion is deliberately two-part. `WorkflowFlowNode.svelte:93` wraps
    // these three in `{#if !view.readonly}`, and a suite that only asked whether
    // they were disabled would pass against that port: an absent element is
    // never enabled. Presence is checked first, so porting the `{#if}` by reflex
    // fails here rather than silently reflowing the card on every save.
    for (const id of ['pipelines-move-phase-up-0', 'pipelines-move-phase-down-0', 'pipelines-remove-phase-0']) {
      expect(at(id), `${id} must render under readonly`).not.toBeNull();
      expect(at(id).disabled, `${id} must be disabled under readonly`).toBe(true);
    }
  });

  it('disables up at the first position and down at the last, while editable', () => {
    const handles = makeFlowView();
    const first = mount(handles, 0).container;
    const last = mount(handles, 1).container;
    const at = (root: ParentNode, id: string) =>
      root.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement;

    expect(at(first, 'pipelines-move-phase-up-0').disabled).toBe(true);
    expect(at(first, 'pipelines-move-phase-down-0').disabled).toBe(false);
    expect(at(last, 'pipelines-move-phase-up-1').disabled).toBe(false);
    expect(at(last, 'pipelines-move-phase-down-1').disabled).toBe(true);
    expect(at(first, 'pipelines-remove-phase-0').disabled).toBe(false);
  });

  it('leaves the sole position with both reorder buttons disabled and remove enabled', () => {
    const handles = makeFlowView({ phases: ['done'] });
    const { container } = mount(handles, 0);
    const at = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement;

    expect(at('pipelines-move-phase-up-0').disabled).toBe(true);
    expect(at('pipelines-move-phase-down-0').disabled).toBe(true);
    expect(at('pipelines-remove-phase-0').disabled).toBe(false);
  });
});

describe('PipelineFlowNode defect cue (T009)', () => {
  it('shows a defect three ways: a flag, a badge, and a described-by region', () => {
    const handles = makeFlowView({
      phaseDefects: [[], [draftError('phaseIds[1]', 'Phase "done" is not effective.')]]
    });
    const { container } = mount(handles, 1);
    const card = container.querySelector('[data-testid="pipelines-phase-card-1"]') as HTMLElement;

    // Three cues, because one is not enough for every reader: the flag drives
    // the border, the badge is text a monochrome display still shows, and the
    // described-by is what a screen reader follows to the message itself.
    expect(card.getAttribute('data-invalid')).toBe('true');
    expect(container.querySelector('[data-testid="pipelines-phase-error-1"]')).not.toBeNull();
    expect(card.getAttribute('aria-describedby')).toBe(REGION);
    expect(container.querySelector(`#${REGION}`)?.textContent).toContain('is not effective');
  });

  it('names no error region on a clean card', () => {
    const handles = makeFlowView();
    const { container } = mount(handles, 1);
    const card = container.querySelector('[data-testid="pipelines-phase-card-1"]') as HTMLElement;

    // An `aria-describedby` pointing at a region that is not rendered is a
    // broken reference, so the attribute has to be absent rather than empty.
    expect(card.getAttribute('aria-describedby')).toBeNull();
    expect(card.getAttribute('data-invalid')).toBeNull();
    expect(container.querySelector('[data-testid="pipelines-phase-error-1"]')).toBeNull();
  });
});
