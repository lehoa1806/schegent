// Feature 184 (FR-R3-141, T016/T018) — the Pipeline canvas.

import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import PipelineFlowCanvas from '../PipelineBuilderEditors/PipelineFlowCanvas.svelte';
import { pipelineSequenceStatus } from '../PipelineBuilderEditors/pipeline-catalog-state';
import type { PipelineDraftError } from '../PipelineBuilderEditors/pipeline-catalog-state';
import type { MutablePipeline } from '../PipelineBuilderEditors/types';
import { draftError, flowPipelineRow, makeFlowView } from './pipeline-flow-fixtures';

afterEach(cleanup);

function mount(
  options: {
    pipeline?: MutablePipeline | null;
    phases?: readonly string[];
    sequenceErrors?: readonly PipelineDraftError[];
    phaseDefects?: readonly (readonly PipelineDraftError[])[];
  } = {}
) {
  const pipeline = options.pipeline === undefined ? flowPipelineRow() : options.pipeline;
  const phases = options.phases ?? pipeline?.phases ?? [];
  const handles = makeFlowView({
    phases,
    ...(options.phaseDefects ? { phaseDefects: options.phaseDefects } : {})
  });
  const { container } = render(PipelineFlowCanvas, {
    props: { pipeline, view: handles.view, sequenceErrors: options.sequenceErrors ?? [] }
  });
  return {
    container,
    handles,
    at: (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
  };
}

describe('PipelineFlowCanvas (T016)', () => {
  it('renders one card per position, in sequence order', () => {
    const { container, at } = mount({ phases: ['speckit-specify', 'speckit-plan', 'done'] });
    const titles = Array.from(
      container.querySelectorAll('[data-testid^="pipelines-phase-title-"]')
    ).map((node) => node.textContent.trim());

    expect(titles).toEqual(['Specify', 'Plan', 'Done']);
    expect(at('pipelines-phase-card-0')).not.toBeNull();
    expect(at('pipelines-phase-card-2')).not.toBeNull();
    expect(at('pipelines-phase-card-3')).toBeNull();
  });

  it('renders one lane and calls no layout module', () => {
    const { container } = mount();

    // FR-036. The Workflow canvas has a second lane for nodes no start reaches;
    // a Pipeline sequence has no unreachable position, so a second lane here
    // would be a region that can never hold anything.
    expect(container.querySelectorAll('.wf-lane')).toHaveLength(1);
    expect(container.querySelector('[data-testid="workflow-lane-detached"]')).toBeNull();
  });

  it('carries pipelineSequenceStatus verbatim in a polite live region', () => {
    const pipeline = flowPipelineRow({ phases: ['speckit-plan', 'done'] });
    const { at } = mount({ pipeline, phases: pipeline.phases });
    const status = at('pipelines-sequence-status') as HTMLElement;

    // Verbatim on purpose: the wording is the module's, and a canvas that
    // rephrased it would be a second answer to "what order is this in".
    expect(status.textContent.trim()).toBe(pipelineSequenceStatus(pipeline));
    expect(status.textContent).toContain('1. speckit-plan, 2. done');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
  });

  it('renders sequence-anchored errors under the lane and points the lane at them', () => {
    const errors = [draftError('phaseIds', 'A Pipeline must name at least one Phase.')];
    const { container, at } = mount({ sequenceErrors: errors });
    const lane = at('pipelines-lane-sequence') as HTMLElement;
    const region = container.querySelector('#pipeline-errors-release-flow-sequence');

    expect(region?.textContent).toContain('at least one Phase');
    expect(lane.getAttribute('aria-describedby')).toBe('pipeline-errors-release-flow-sequence');
    // Under the lane, not inside it: the error names the list, not a position.
    expect(lane.contains(region)).toBe(false);
  });

  it('gives each card its own position-anchored error region id', () => {
    const { at } = mount({
      phases: ['speckit-plan', 'done'],
      phaseDefects: [[], [draftError('phaseIds[1]', 'Phase "done" is not effective.')]]
    });

    expect(at('pipelines-phase-card-1')?.getAttribute('aria-describedby')).toBe(
      'pipeline-errors-release-flow-phase-1'
    );
    expect(at('pipelines-phase-card-0')?.getAttribute('aria-describedby')).toBeNull();
  });

  it('renders a repeated Phase as two cards rather than throwing on a duplicate key', () => {
    const { container } = mount({ phases: ['done', 'speckit-plan', 'done'] });

    // `['review','fix','review']` is an authored Pipeline, not a defect, so the
    // list is keyed by position. A keyed-by-id `#each` throws here.
    expect(container.querySelectorAll('[data-testid^="pipelines-phase-card-"]')).toHaveLength(3);
  });
});

describe('PipelineFlowCanvas empty states (T018)', () => {
  it('names the palette when a Pipeline is open with no Phase, and not the picker', () => {
    const { at } = mount({ pipeline: flowPipelineRow({ phases: [] }), phases: [] });
    const empty = at('pipelines-canvas-empty') as HTMLElement;

    expect(empty).not.toBeNull();
    expect(empty.textContent).toMatch(/palette/i);
    expect(empty.textContent).not.toMatch(/choose|list above|pipeline is open/i);
    expect(at('pipelines-canvas-no-selection')).toBeNull();
  });

  it('names the picker when no Pipeline is open, and not the palette', () => {
    const { at } = mount({ pipeline: null, phases: [] });
    const empty = at('pipelines-canvas-no-selection') as HTMLElement;

    expect(empty).not.toBeNull();
    expect(empty.textContent).toMatch(/choose|list above/i);
    expect(empty.textContent).not.toMatch(/palette|phase/i);
    expect(at('pipelines-canvas-empty')).toBeNull();
  });

  it('withholds the sequence status entirely when no Pipeline is open', () => {
    const { at } = mount({ pipeline: null, phases: [] });

    // A live region describing an order there is none of would announce
    // "No Phases in this sequence." for a Pipeline the operator never opened.
    expect(at('pipelines-sequence-status')).toBeNull();
  });

  it('still announces the order for an open Pipeline with no Phase', () => {
    const { at } = mount({ pipeline: flowPipelineRow({ phases: [] }), phases: [] });

    expect(at('pipelines-sequence-status')?.textContent.trim()).toBe(
      'No Phases in this sequence.'
    );
  });
});
