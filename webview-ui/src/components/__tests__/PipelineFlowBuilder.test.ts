// Feature 184 (FR-R3-141, T030) — the three panes and the selection that ties
// them together.
//
// The clamp is the case with no Workflow counterpart: `WorkflowFlowSelection`
// addresses a node by id, so a removal there can only ever orphan the selection,
// never leave it pointing at a *different* node. A positional selection can, and
// this is the only test that would notice.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowSnapshot } from '../../lib/snapshot-types';
import PipelineFlowBuilder from '../PipelineBuilderEditors/PipelineFlowBuilder.svelte';
import type { MutablePipeline } from '../PipelineBuilderEditors/types';
import { FLOW_PHASES, flowPipelineRow } from './pipeline-flow-fixtures';

vi.mock('../../lib/process-yaml-ipc', () => ({ exportPipelineYaml: vi.fn() }));

afterEach(cleanup);

const SNAPSHOT = {
  isPrimary: true,
  availablePipelines: [],
  pipelineCatalog: {
    state: 'ready',
    records: [],
    effective: [],
    revisions: { user: 'u', workspace: 'w' },
    warnings: []
  }
} as unknown as WorkflowSnapshot;

const THREE = flowPipelineRow({ phases: ['speckit-specify', 'speckit-plan', 'done'] });
const OTHER = flowPipelineRow({ id: 'hotfix', name: 'Hotfix', sourceKey: 'user::hotfix' });

function mount(
  options: {
    pipelines?: readonly MutablePipeline[];
    selectedIndex?: number | null;
    trusted?: boolean;
  } = {}
) {
  const handlers = {
    onselect: vi.fn(),
    onadd: vi.fn(),
    onremove: vi.fn(),
    onreset: vi.fn(),
    onduplicate: vi.fn(),
    onpipelinechange: vi.fn(),
    onphasechange: vi.fn(),
    onundo: vi.fn(),
    onredo: vi.fn(),
    onsave: vi.fn(),
    onaddphase: vi.fn(),
    onremovephase: vi.fn(),
    onmovephaseup: vi.fn(),
    onmovephasedown: vi.fn()
  };
  const props = {
    snapshot: SNAPSHOT,
    pipelines: options.pipelines ?? [THREE, OTHER],
    phases: FLOW_PHASES,
    selectedIndex: options.selectedIndex === undefined ? 0 : options.selectedIndex,
    historyIndex: 1,
    historyLength: 3,
    trusted: options.trusted ?? true,
    savePending: false,
    mutationActive: false,
    editableSourceKey: null,
    getPhaseTooltip: (phaseId: string) => `tooltip:${phaseId}`,
    ...handlers
  };
  const { container, rerender } = render(PipelineFlowBuilder, { props });
  return {
    container,
    rerender: (next: Partial<typeof props>) => rerender({ ...props, ...next }),
    at: (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null,
    ...handlers
  };
}

describe('PipelineFlowBuilder panes (T030)', () => {
  it('renders the top bar, the action bar and the three panes', () => {
    const { at } = mount();

    expect(at('pipelines-topbar')).not.toBeNull();
    expect(at('pipelines-toolbar')).not.toBeNull();
    expect(at('pipelines-palette')).not.toBeNull();
    expect(at('pipelines-canvas')).not.toBeNull();
    expect(at('pipelines-inspector')).not.toBeNull();
  });

  it('renders the bar and the canvas with nothing open, and no inspector', () => {
    const { at } = mount({ selectedIndex: null });

    // The bar stays so Add is reachable; the inspector would have no subject, and
    // the canvas states the empty case itself rather than leaving a blank column.
    expect(at('pipelines-toolbar')).not.toBeNull();
    expect(at('pipelines-canvas-no-selection')).not.toBeNull();
    expect(at('pipelines-inspector')).toBeNull();
  });

  it('hides the palette behind a rail and restores it', async () => {
    const { at } = mount();

    await fireEvent.click(at('pipelines-palette-close') as HTMLElement);
    expect(at('pipelines-palette')).toBeNull();
    expect(at('pipelines-palette-rail')).not.toBeNull();

    await fireEvent.click(at('pipelines-palette-open') as HTMLElement);
    expect(at('pipelines-palette')).not.toBeNull();
  });

  it('disables the palette when no Pipeline is open', () => {
    const { container } = mount({ selectedIndex: null });
    const items = Array.from(
      container.querySelectorAll('[data-testid^="pipelines-palette-phase-"]')
    ) as HTMLButtonElement[];

    // Adding a Phase to nothing is not a state the store can absorb, and a live
    // button that silently does nothing is worse than a disabled one.
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.disabled).toBe(true);
  });
});

describe('PipelineFlowBuilder selection (T030)', () => {
  it('rests on the Pipeline, and the canvas moves it to a position', async () => {
    const { at } = mount();

    expect(at('pipelines-inspector-phase')).toBeNull();
    await fireEvent.click(at('pipelines-phase-card-1') as HTMLElement);
    expect(at('pipelines-phase-select-1')).not.toBeNull();
  });

  it('resets the selection to the Pipeline when the open row changes', async () => {
    const { at, rerender } = mount();

    await fireEvent.click(at('pipelines-phase-card-2') as HTMLElement);
    expect(at('pipelines-phase-select-2')).not.toBeNull();

    await rerender({ selectedIndex: 1 });

    // Position 2 exists in neither row the same way: indices address the authored
    // sequence, so carrying one across rows would render an inspector for a Phase
    // the operator never selected.
    expect(at('pipelines-inspector-phase')).toBeNull();
    // The pane followed the row, so the reset is a reset and not a crash.
    expect((at('pipelines-name-field-hotfix') as HTMLInputElement).value).toBe('Hotfix');
  });

  it('clamps the selection to the last card when a removal shortens the sequence', async () => {
    const { at, rerender } = mount();

    await fireEvent.click(at('pipelines-phase-card-2') as HTMLElement);
    expect(at('pipelines-phase-select-2')).not.toBeNull();

    // The same row, one Phase shorter — the shape a removal leaves behind.
    await rerender({
      pipelines: [flowPipelineRow({ phases: ['speckit-specify', 'speckit-plan'] }), OTHER]
    });

    expect(at('pipelines-phase-select-2')).toBeNull();
    expect(at('pipelines-phase-select-1')).not.toBeNull();
  });

  it('falls back to the Pipeline when the sequence empties', async () => {
    const { at, rerender } = mount();

    await fireEvent.click(at('pipelines-phase-card-0') as HTMLElement);
    expect(at('pipelines-phase-select-0')).not.toBeNull();

    await rerender({ pipelines: [flowPipelineRow({ phases: [] }), OTHER] });

    // There is no position to clamp to, so the Pipeline is the only honest answer.
    expect(at('pipelines-inspector-phase')).toBeNull();
    expect(at('pipelines-inspector-identity')).not.toBeNull();
  });

  it('leaves a selection inside the sequence alone when a later position is removed', async () => {
    const { at, rerender } = mount();

    await fireEvent.click(at('pipelines-phase-card-0') as HTMLElement);
    await rerender({
      pipelines: [flowPipelineRow({ phases: ['speckit-specify', 'speckit-plan'] }), OTHER]
    });

    // The clamp corrects an out-of-range selection; it is not a reset that fires
    // on every edit to the sequence.
    expect(at('pipelines-phase-select-0')).not.toBeNull();
  });
});

describe('PipelineFlowBuilder wiring (T030)', () => {
  it('routes an inspector edit to the open row’s index', async () => {
    const { at, onpipelinechange, rerender } = mount({ selectedIndex: 1 });

    await rerender({ selectedIndex: 1 });
    await fireEvent.input(at('pipelines-name-field-hotfix') as HTMLInputElement, {
      target: { value: 'Hotfix Flow' }
    });
    expect(onpipelinechange).toHaveBeenCalledWith(1, { name: 'Hotfix Flow' });
  });

  it('routes a canvas reorder and a palette add through the store callbacks', async () => {
    const { at, onmovephaseup, onaddphase } = mount();

    await fireEvent.click(at('pipelines-move-phase-up-1') as HTMLElement);
    expect(onmovephaseup).toHaveBeenCalledWith(1);

    await fireEvent.click(at('pipelines-palette-phase-done') as HTMLElement);
    expect(onaddphase).toHaveBeenCalledWith('done');
  });

  it('routes the inspector’s phase select through the open row’s index', async () => {
    // Row 1, not row 0: `onphasechange` takes the Pipeline index and the position,
    // and both are numbers. Driving this from the first row would let a hard-coded
    // 0 — the shape a careless port takes — pass.
    const { at, onphasechange } = mount({
      pipelines: [OTHER, THREE],
      selectedIndex: 1
    });

    await fireEvent.click(at('pipelines-phase-card-1') as HTMLElement);
    await fireEvent.change(at('pipelines-phase-select-1') as HTMLSelectElement, {
      target: { value: 'done' }
    });
    expect(onphasechange).toHaveBeenCalledWith(1, 1, 'done');
  });
});
