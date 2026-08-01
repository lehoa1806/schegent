// PipelineBuilder restored 3-tab design tests.
//
// Covers:
//   - The 3-tab bar renders (Pipelines, Phases, Models).
//   - Switching to Phases tab shows the phase list.
//   - Phase editor exposes Raw-JSON toggle on selection.
//   - RetryCondition editor renders for ALL phases (not gated behind loopable).
//   - Models tab renders and allows add/remove.
//   - Feature 026 T011 — per-phase Effort dropdown + precedence badges +
//     FR-003 orthogonality of effort/model overrides.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import PipelineBuilder from '../PipelineBuilder.svelte';
import type {
  WorkflowSnapshot,
  PhaseDefinition,
  PipelineDefinition,
  PhasePrecedenceProjection,
  BackendRunnerKind
} from '../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../lib/snapshot-types';
import { savePhases as savePhasesHelper } from '../../lib/save-phases';
import { savePipelines as savePipelinesHelper } from '../../lib/save-pipelines';
import { saveModels as saveModelsHelper } from '../../lib/save-models';

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'corr-test' }))
}));
vi.mock('../../lib/snapshot-store.svelte', () => ({
  snapshotStore: {
    markPending: vi.fn(),
    onceAck: vi.fn()
  }
}));
vi.mock('../../lib/save-phases', () => ({
  savePhases: vi.fn(async () => ({ status: 'accepted' as const }))
}));
vi.mock('../../lib/save-pipelines', () => ({
  savePipelines: vi.fn(async () => ({ status: 'accepted' as const }))
}));
vi.mock('../../lib/save-models', () => ({
  saveModels: vi.fn(async () => ({ status: 'accepted' as const }))
}));

afterEach(() => cleanup());

function buildSnapshot(
  phases: readonly PhaseDefinition[] = [],
  pipelines: readonly PipelineDefinition[] = [],
  models: readonly string[] = [],
  phasePrecedence?: PhasePrecedenceProjection
): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: 3,
    isPrimary: true,
    status: 'idle',
    activeFeature: null,
    phases: Object.freeze([]),
    queue: Object.freeze({
      orderedItems: [],
      inFlight: null,
      pending: Object.freeze([]),
      recent: Object.freeze([]),
      paused: false
    }),
    auditTail: Object.freeze([]),
    liveActivity: Object.freeze({
      summary: null,
      category: null,
      lastEventAt: null,
      freshness: 'idle',
      staleSeconds: null
    }),
    workflowElapsedMs: null,
    monitor: null,
    history: Object.freeze([]),
    producedAt: '2026-05-11T00:00:00.000Z',
    availablePipelines: Object.freeze(pipelines),
    availablePhases: Object.freeze(phases),
    availableModels: Object.freeze({ claude: models, codex: [], agy: [] }) as Record<BackendRunnerKind, readonly string[]>,
    availableBackends: Object.freeze(['claude', 'codex', 'agy']) as readonly BackendRunnerKind[],
    generalSettings: IDLE_GENERAL_SETTINGS,
    ...(phasePrecedence !== undefined ? { phasePrecedence } : {})
  }) as unknown as unknown as WorkflowSnapshot;
}

/** Click a tab button by its text content. */
async function switchTab(container: HTMLElement, label: string): Promise<void> {
  const tabs = container.querySelectorAll('.tab-btn');
  for (const tab of tabs) {
    if (tab.textContent?.trim() === label) {
      await fireEvent.click(tab);
      await tick();
      return;
    }
  }
  throw new Error(`Tab "${label}" not found`);
}

describe('PipelineBuilder — restored 3-tab design', () => {
  it('renders the 3-tab bar: Pipelines, Phases, Models', () => {
    const snap = buildSnapshot();
    const { container } = render(PipelineBuilder, { props: { snapshot: snap } });
    const tabs = [...container.querySelectorAll('.tab-btn')].map((t) => t.textContent?.trim());
    expect(tabs).toEqual(['Pipelines', 'Phases', 'Models']);
  });

  it('Phases tab: phase list renders after switching tabs', async () => {
    const phase: PhaseDefinition = Object.freeze({
      id: 'p-1',
      name: 'Phase One',
      instruction: 'do the thing',
      loopable: false
    }) as unknown as PhaseDefinition;
    const snap = buildSnapshot([phase]);
    const { container } = render(PipelineBuilder, { props: { snapshot: snap } });
    await switchTab(container, 'Phases');
    const item = container.querySelector('[data-testid="phases-list-item-p-1"]');
    expect(item).not.toBeNull();
  });

  it('Phases tab: Raw-JSON toggle visible when a phase is selected', async () => {
    const phase: PhaseDefinition = Object.freeze({
      id: 'p-1',
      name: 'Phase One',
      instruction: 'do the thing',
      loopable: false
    }) as unknown as PhaseDefinition;
    const snap = buildSnapshot([phase]);
    const { container } = render(PipelineBuilder, { props: { snapshot: snap } });
    await switchTab(container, 'Phases');
    const item = container.querySelector('[data-testid="phases-list-item-p-1"]') as HTMLButtonElement;
    expect(item).not.toBeNull();
    await fireEvent.click(item);
    await tick();
    const toggle = container.querySelector('[data-testid="phases-raw-json-toggle"]');
    expect(toggle).not.toBeNull();
  });

  it('Phases tab: RetryCondition editor renders for ALL phases (not just loopable)', async () => {
    const nonLoopable: PhaseDefinition = Object.freeze({
      id: 'p-nl',
      name: 'Non-Loopable',
      instruction: 'run once',
      loopable: false,
      retryCondition: ''
    }) as unknown as PhaseDefinition;
    const snap = buildSnapshot([nonLoopable]);
    const { container } = render(PipelineBuilder, { props: { snapshot: snap } });
    await switchTab(container, 'Phases');
    const item = container.querySelector('[data-testid="phases-list-item-p-nl"]') as HTMLButtonElement;
    expect(item).not.toBeNull();
    await fireEvent.click(item);
    await tick();
    const editor = container.querySelector('[data-testid="retry-condition-editor"]');
    expect(editor).not.toBeNull();
  });

  it('Models tab: renders the model list', async () => {
    const snap = buildSnapshot([], [], ['claude-sonnet-4-6', 'claude-opus-4-6']);
    const { container } = render(PipelineBuilder, { props: { snapshot: snap } });
    await switchTab(container, 'Models');
    const items = container.querySelectorAll('.model-list-item');
    expect(items.length).toBe(2);
  });

  it('Pipelines tab: saves through the shared save-pipelines helper', async () => {
    vi.mocked(savePipelinesHelper).mockClear();
    const pipeline: PipelineDefinition = Object.freeze({
      id: 'custom',
      name: 'Custom Pipeline',
      phases: Object.freeze(['speckit-specify', 'speckit-plan'])
    }) as unknown as PipelineDefinition;
    const snap = buildSnapshot([], [pipeline]);
    const { container } = render(PipelineBuilder, { props: { snapshot: snap } });
    await tick();
    const saveBtn = [...container.querySelectorAll('button')].find(
      (btn) => btn.textContent?.trim() === 'Save Pipelines'
    ) as HTMLButtonElement | undefined;
    expect(saveBtn).toBeDefined();
    await fireEvent.click(saveBtn!);
    await tick();
    expect(savePipelinesHelper).toHaveBeenCalledTimes(1);
    expect(vi.mocked(savePipelinesHelper).mock.calls[0][0]).toEqual([
      { id: 'custom', name: 'Custom Pipeline', phases: ['speckit-specify', 'speckit-plan'] }
    ]);
  });

  it('Models tab: saves through the shared save-models helper', async () => {
    vi.mocked(saveModelsHelper).mockClear();
    const snap = buildSnapshot([], [], ['claude-sonnet-4-6', 'claude-opus-4-6']);
    const { container } = render(PipelineBuilder, { props: { snapshot: snap } });
    await switchTab(container, 'Models');
    const saveBtn = [...container.querySelectorAll('button')].find(
      (btn) => btn.textContent?.trim() === 'Save Models'
    ) as HTMLButtonElement | undefined;
    expect(saveBtn).toBeDefined();
    await fireEvent.click(saveBtn!);
    await tick();
    expect(saveModelsHelper).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveModelsHelper).mock.calls[0][0]).toEqual([
      'claude-sonnet-4-6',
      'claude-opus-4-6'
    ]);
  });
  it('Pipelines tab: Pipeline Name field updates name and saves correctly (BUG-005)', async () => {
    vi.mocked(savePipelinesHelper).mockClear();
    const pipeline: PipelineDefinition = Object.freeze({
      id: 'custom',
      name: 'Custom Pipeline',
      phases: Object.freeze(['speckit-specify'])
    }) as unknown as PipelineDefinition;
    const snap = buildSnapshot([], [pipeline]);
    const { container } = render(PipelineBuilder, { props: { snapshot: snap } });
    await tick();

    // Select pipeline
    const pipelineItem = container.querySelector('.phase-list-item') as HTMLButtonElement;
    expect(pipelineItem).not.toBeNull();
    await fireEvent.click(pipelineItem);
    await tick();

    // Find the Name field in the form grid
    const nameInput = container.querySelector('[data-testid="pipelines-name-field-custom"]') as HTMLInputElement;
    expect(nameInput).not.toBeNull();
    expect(nameInput.value).toBe('Custom Pipeline');

    // Edit Name
    await fireEvent.input(nameInput, { target: { value: 'Renamed Pipeline' } });
    await tick();

    // Save
    const saveBtn = [...container.querySelectorAll('button')].find(
      (btn) => btn.textContent?.trim() === 'Save Pipeline'
    ) as HTMLButtonElement | undefined;
    expect(saveBtn).toBeDefined();
    await fireEvent.click(saveBtn!);
    await tick();

    expect(savePipelinesHelper).toHaveBeenCalledTimes(1);
    expect(vi.mocked(savePipelinesHelper).mock.calls[0][0]).toEqual([
      { id: 'custom', name: 'Renamed Pipeline', phases: ['speckit-specify'] }
    ]);
  });
});

describe('PipelineBuilder — Feature 026 per-phase Effort + precedence badges', () => {
  const phase: PhaseDefinition = Object.freeze({
    id: 'speckit-plan',
    name: 'Plan',
    instruction: 'Plan the work.',
    loopable: false
  }) as unknown as PhaseDefinition;

  async function openPhasesEditorForPlan(): Promise<{ container: HTMLElement }> {
    return openPhasesEditor(phase);
  }

  async function openPhasesEditor(
    p: PhaseDefinition,
    extra: Partial<{
      effort: PhaseDefinition['effort'];
      model: string;
      runner: PhaseDefinition['runner'];
      precedence: PhasePrecedenceProjection;
    }> = {}
  ): Promise<{ container: HTMLElement }> {
    const seeded = {
      ...p,
      ...(extra.effort ? { effort: extra.effort } : {}),
      ...(extra.model ? { model: extra.model } : {}),
      ...(extra.runner ? { runner: extra.runner } : {})
    } as PhaseDefinition;
    const snap = buildSnapshot(
      [seeded],
      [],
      ['claude-sonnet-4-6', 'claude-opus-4-6'],
      extra.precedence
    );
    const { container } = render(PipelineBuilder, { props: { snapshot: snap } });
    await switchTab(container, 'Phases');
    const item = container.querySelector(`[data-testid="phases-list-item-${p.id}"]`) as HTMLButtonElement;
    expect(item).not.toBeNull();
    await fireEvent.click(item);
    await tick();
    return { container };
  }

  it('renders an Effort dropdown on the phase row (with Inherit as the default option)', async () => {
    const { container } = await openPhasesEditorForPlan();
    const select = container.querySelector(
      '[data-testid="phases-effort-speckit-plan"]'
    ) as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    const options = Array.from(select!.querySelectorAll('option')).map((o) => o.value);
    expect(options).toContain('');
    for (const lvl of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(options).toContain(lvl);
    }
    expect(select!.value).toBe('');
  });

  it('saves with the chosen Effort by routing through the save-phases helper', async () => {
    vi.mocked(savePhasesHelper).mockClear();
    const { container } = await openPhasesEditorForPlan();
    const select = container.querySelector(
      '[data-testid="phases-effort-speckit-plan"]'
    ) as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: 'high' } });
    await tick();
    const saveBtn = container.querySelector('[data-testid="phases-save-all"]') as HTMLButtonElement;
    await fireEvent.click(saveBtn);
    await tick();
    expect(savePhasesHelper).toHaveBeenCalledTimes(1);
    const [phases] = vi.mocked(savePhasesHelper).mock.calls[0];
    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatchObject({ id: 'speckit-plan', effort: 'high' });
  });

  it('preserves the deprecated loopable field during structured saves', async () => {
    vi.mocked(savePhasesHelper).mockClear();
    const { container } = await openPhasesEditor({
      ...phase,
      loopable: true
    });
    await fireEvent.click(
      container.querySelector('[data-testid="phases-save-all"]') as HTMLButtonElement
    );
    await tick();

    expect(vi.mocked(savePhasesHelper).mock.calls[0][0][0]).toMatchObject({
      id: 'speckit-plan',
      loopable: true
    });
  });

  it('renders and saves every supported runner through the shared helper', async () => {
    vi.mocked(savePhasesHelper).mockClear();
    const { container } = await openPhasesEditorForPlan();
    const select = container.querySelector(
      '[data-testid="phases-runner-speckit-plan"]'
    ) as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      '',
      'claude',
      'codex',
      'agy'
    ]);

    await fireEvent.change(select, { target: { value: 'agy' } });
    await fireEvent.click(
      container.querySelector('[data-testid="phases-save-all"]') as HTMLButtonElement
    );
    await tick();

    expect(vi.mocked(savePhasesHelper).mock.calls[0][0][0]).toMatchObject({
      id: 'speckit-plan',
      runner: 'agy'
    });
  });

  it('disables inherited and Codex runners for Git-mutating built-in phases', async () => {
    const finalizePhase = {
      ...phase,
      id: 'finalize',
      name: 'Finalize',
      runner: 'claude'
    } as PhaseDefinition;
    const { container } = await openPhasesEditor(finalizePhase);
    const select = container.querySelector(
      '[data-testid="phases-runner-finalize"]'
    ) as HTMLSelectElement;

    expect(select.querySelector('option[value=""]')?.hasAttribute('disabled')).toBe(true);
    expect(select.querySelector('option[value="codex"]')?.hasAttribute('disabled')).toBe(true);
    expect(select.querySelector('option[value="claude"]')?.hasAttribute('disabled')).toBe(false);
    expect(select.querySelector('option[value="agy"]')?.hasAttribute('disabled')).toBe(false);
  });

  it.each(['speckit-specify', 'specify-brainstorm', 'superpowers-implement'])(
    'disables inherited and Codex runners for worktree-creating phase %s',
    async (phaseId) => {
      const branchPhase = {
        ...phase,
        id: phaseId,
        runner: 'claude'
      } as PhaseDefinition;
      const { container } = await openPhasesEditor(branchPhase);
      const select = container.querySelector(
        `[data-testid="phases-runner-${phaseId}"]`
      ) as HTMLSelectElement;

      expect(select.querySelector('option[value=""]')?.hasAttribute('disabled')).toBe(true);
      expect(select.querySelector('option[value="codex"]')?.hasAttribute('disabled')).toBe(true);
      expect(select.querySelector('option[value="claude"]')?.hasAttribute('disabled')).toBe(false);
      expect(select.querySelector('option[value="agy"]')?.hasAttribute('disabled')).toBe(false);
    }
  );

  it('omits runner when the operator selects Inherit', async () => {
    vi.mocked(savePhasesHelper).mockClear();
    const { container } = await openPhasesEditor(phase, { runner: 'codex' });
    const select = container.querySelector(
      '[data-testid="phases-runner-speckit-plan"]'
    ) as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: '' } });
    await fireEvent.click(
      container.querySelector('[data-testid="phases-save-all"]') as HTMLButtonElement
    );
    await tick();

    expect(vi.mocked(savePhasesHelper).mock.calls[0][0][0].runner).toBeUndefined();
  });

  it.each([
    ['built-in', 'Built-in'],
    ['workspace', 'Workspace'],
    ['user', 'User']
  ] as const)('shows the %s runner precedence badge', async (layer, label) => {
    const { container } = await openPhasesEditor(phase, {
      runner: 'agy',
      precedence: { 'speckit-plan::runner': layer }
    });
    expect(
      container.querySelector('[data-testid="phases-runner-precedence-speckit-plan"]')
        ?.textContent
        ?.trim()
    ).toBe(label);
  });

  it('hides runner precedence when the winning phase row inherits the runner', async () => {
    const { container } = await openPhasesEditor(phase, {
      precedence: { 'speckit-plan::runner': 'workspace' }
    });

    expect(
      container.querySelector('[data-testid="phases-runner-precedence-speckit-plan"]')
    ).toBeNull();
  });



  it('Inherit option submits the row with effort omitted (not null, not empty string)', async () => {
    vi.mocked(savePhasesHelper).mockClear();
    const { container } = await openPhasesEditor(phase, { effort: 'high' });
    const select = container.querySelector(
      '[data-testid="phases-effort-speckit-plan"]'
    ) as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: '' } });
    await tick();
    const saveBtn = container.querySelector('[data-testid="phases-save-all"]') as HTMLButtonElement;
    await fireEvent.click(saveBtn);
    await tick();
    expect(savePhasesHelper).toHaveBeenCalledTimes(1);
    const [phases] = vi.mocked(savePhasesHelper).mock.calls[0];
    expect(phases[0]).toMatchObject({ id: 'speckit-plan' });
    expect((phases[0] as unknown as Record<string, unknown>).effort).toBeUndefined();
  });

  it('FR-003 orthogonality: changing Effort does not clear an existing Model override', async () => {
    vi.mocked(savePhasesHelper).mockClear();
    const { container } = await openPhasesEditor(phase, { model: 'claude-sonnet-4-6' });
    const effort = container.querySelector(
      '[data-testid="phases-effort-speckit-plan"]'
    ) as HTMLSelectElement;
    await fireEvent.change(effort, { target: { value: 'high' } });
    await tick();
    const saveBtn = container.querySelector('[data-testid="phases-save-all"]') as HTMLButtonElement;
    await fireEvent.click(saveBtn);
    await tick();
    const [phases] = vi.mocked(savePhasesHelper).mock.calls[0];
    expect(phases[0]).toMatchObject({
      id: 'speckit-plan',
      effort: 'high',
      model: 'claude-sonnet-4-6'
    });
  });

  it('FR-003 orthogonality: choosing Inherit for Effort leaves an existing Model override intact', async () => {
    vi.mocked(savePhasesHelper).mockClear();
    const { container } = await openPhasesEditor(phase, {
      effort: 'high',
      model: 'claude-sonnet-4-6'
    });
    const effort = container.querySelector(
      '[data-testid="phases-effort-speckit-plan"]'
    ) as HTMLSelectElement;
    await fireEvent.change(effort, { target: { value: '' } });
    await tick();
    const saveBtn = container.querySelector('[data-testid="phases-save-all"]') as HTMLButtonElement;
    await fireEvent.click(saveBtn);
    await tick();
    const [phases] = vi.mocked(savePhasesHelper).mock.calls[0];
    expect(phases[0]).toMatchObject({ id: 'speckit-plan', model: 'claude-sonnet-4-6' });
    expect((phases[0] as unknown as Record<string, unknown>).effort).toBeUndefined();
  });


});

describe('PipelineBuilder — BUG-002 cross-tab phase visibility', () => {
  it('newly created phase appears in pipeline editor dropdown without save round-trip', async () => {
    // Start with one existing phase and one pipeline referencing it
    const existingPhase: PhaseDefinition = Object.freeze({
      id: 'speckit-specify',
      name: 'Spec-kit Specify',
      instruction: 'Write the spec.',
      loopable: false
    }) as unknown as PhaseDefinition;
    const pipeline: PipelineDefinition = Object.freeze({
      id: 'default',
      name: 'Default Pipeline',
      phases: Object.freeze(['speckit-specify'])
    }) as unknown as PipelineDefinition;
    const snap = buildSnapshot([existingPhase], [pipeline]);

    const { container } = render(PipelineBuilder, {
      props: { snapshot: snap, initialTab: 'phases' }
    });
    await tick();

    // 1. Add a new phase via the "Add Phase" button in the Phases tab
    const addPhaseBtn = container.querySelector('[data-testid="phases-add"]') as HTMLButtonElement;
    expect(addPhaseBtn).not.toBeNull();
    await fireEvent.click(addPhaseBtn);
    await tick();

    // Verify the new phase appears in the Phases tab sidebar
    const phaseItems = container.querySelectorAll('.phase-list-item');
    expect(phaseItems.length).toBe(2); // existing + new

    // 2. Switch to Pipelines tab (without saving!)
    await switchTab(container, 'Pipelines');

    // 3. Select the existing pipeline to open its editor
    const pipelineItem = container.querySelector('.phase-list-item') as HTMLButtonElement;
    expect(pipelineItem).not.toBeNull();
    await fireEvent.click(pipelineItem);
    await tick();

    // 4. Check the "Add Phase" dropdown in the pipeline editor
    const addPhaseDropdown = container.querySelector('.add-phase-row .select-input') as HTMLSelectElement;
    expect(addPhaseDropdown).not.toBeNull();
    const optionValues = Array.from(addPhaseDropdown.querySelectorAll('option')).map(o => o.value);

    // The dropdown should contain both the existing phase AND the newly created phase
    expect(optionValues).toContain('speckit-specify');
    expect(optionValues).toContain('new-phase'); // default id from addPhase()

    // 5. Also check the inline sequence select for the existing pipeline phase
    const sequenceSelect = container.querySelector('.sequence-select') as HTMLSelectElement;
    expect(sequenceSelect).not.toBeNull();
    const seqOptions = Array.from(sequenceSelect.querySelectorAll('option')).map(o => o.value);
    expect(seqOptions).toContain('speckit-specify');
    expect(seqOptions).toContain('new-phase');
  });
});

describe('PipelineBuilder — BUG-012 phase list reordering', () => {
  const phaseA: PhaseDefinition = Object.freeze({
    id: 'phase-a', name: 'Alpha', instruction: 'Do alpha.'
  }) as unknown as PhaseDefinition;
  const phaseB: PhaseDefinition = Object.freeze({
    id: 'phase-b', name: 'Beta', instruction: 'Do beta.'
  }) as unknown as PhaseDefinition;
  const phaseC: PhaseDefinition = Object.freeze({
    id: 'phase-c', name: 'Charlie', instruction: 'Do charlie.'
  }) as unknown as PhaseDefinition;

  async function renderPhasesList() {
    const snap = buildSnapshot([phaseA, phaseB, phaseC]);
    const { container } = render(PipelineBuilder, {
      props: { snapshot: snap, initialTab: 'phases' }
    });
    await tick();
    return container;
  }

  function getPhaseIds(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll('.phase-list-item'))
      .map((el) => {
        const idEl = el.querySelector('.phase-list-id');
        return idEl?.textContent?.trim() ?? '';
      });
  }

  it('move down swaps a phase with the one below it', async () => {
    const container = await renderPhasesList();
    expect(getPhaseIds(container)).toEqual(['phase-a', 'phase-b', 'phase-c']);

    const moveDown = container.querySelector('[data-testid="phases-move-down-phase-a"]') as HTMLButtonElement;
    expect(moveDown).not.toBeNull();
    await fireEvent.click(moveDown);
    await tick();

    expect(getPhaseIds(container)).toEqual(['phase-b', 'phase-a', 'phase-c']);
  });

  it('move up swaps a phase with the one above it', async () => {
    const container = await renderPhasesList();

    const moveUp = container.querySelector('[data-testid="phases-move-up-phase-c"]') as HTMLButtonElement;
    expect(moveUp).not.toBeNull();
    await fireEvent.click(moveUp);
    await tick();

    expect(getPhaseIds(container)).toEqual(['phase-a', 'phase-c', 'phase-b']);
  });

  it('first item up button is disabled', async () => {
    const container = await renderPhasesList();
    const upBtn = container.querySelector('[data-testid="phases-move-up-phase-a"]') as HTMLButtonElement;
    expect(upBtn).not.toBeNull();
    expect(upBtn.disabled).toBe(true);
  });

  it('last item down button is disabled', async () => {
    const container = await renderPhasesList();
    const downBtn = container.querySelector('[data-testid="phases-move-down-phase-c"]') as HTMLButtonElement;
    expect(downBtn).not.toBeNull();
    expect(downBtn.disabled).toBe(true);
  });

  it('selectedPhaseIndex follows the moved phase when moving down', async () => {
    const container = await renderPhasesList();

    // Select phase-a (index 0)
    const itemA = container.querySelector('[data-testid="phases-list-item-phase-a"]') as HTMLButtonElement;
    await fireEvent.click(itemA);
    await tick();

    // Verify it's selected (has the editor open)
    expect(container.querySelector('[data-testid="phases-editor-phase-a"]')).not.toBeNull();

    // Move phase-a down
    const moveDown = container.querySelector('[data-testid="phases-move-down-phase-a"]') as HTMLButtonElement;
    await fireEvent.click(moveDown);
    await tick();

    // phase-a is now at index 1 — selection should follow it
    // The editor should still show phase-a
    expect(container.querySelector('[data-testid="phases-editor-phase-a"]')).not.toBeNull();
  });

  it('selectedPhaseIndex follows the moved phase when moving up', async () => {
    const container = await renderPhasesList();

    // Select phase-c (index 2)
    const itemC = container.querySelector('[data-testid="phases-list-item-phase-c"]') as HTMLButtonElement;
    await fireEvent.click(itemC);
    await tick();

    expect(container.querySelector('[data-testid="phases-editor-phase-c"]')).not.toBeNull();

    // Move phase-c up
    const moveUp = container.querySelector('[data-testid="phases-move-up-phase-c"]') as HTMLButtonElement;
    await fireEvent.click(moveUp);
    await tick();

    // phase-c is now at index 1 — selection should follow
    expect(container.querySelector('[data-testid="phases-editor-phase-c"]')).not.toBeNull();
  });
});

describe('PipelineBuilder — BUG-012 addPhase append regression guard', () => {
  it('addPhase() always appends the new phase at the end of the list', async () => {
    const existing: PhaseDefinition = Object.freeze({
      id: 'existing-1', name: 'Existing', instruction: 'Already here.'
    }) as unknown as PhaseDefinition;
    const snap = buildSnapshot([existing]);
    const { container } = render(PipelineBuilder, {
      props: { snapshot: snap, initialTab: 'phases' }
    });
    await tick();

    const addBtn = container.querySelector('[data-testid="phases-add"]') as HTMLButtonElement;
    expect(addBtn).not.toBeNull();

    // Add first new phase
    await fireEvent.click(addBtn);
    await tick();

    let ids = Array.from(container.querySelectorAll('.phase-list-item'))
      .map((el) => el.querySelector('.phase-list-id')?.textContent?.trim() ?? '');
    expect(ids).toEqual(['existing-1', 'new-phase']);

    // Add second new phase — should still append at the end
    await fireEvent.click(addBtn);
    await tick();

    ids = Array.from(container.querySelectorAll('.phase-list-item'))
      .map((el) => el.querySelector('.phase-list-id')?.textContent?.trim() ?? '');
    expect(ids.length).toBe(3);
    expect(ids[0]).toBe('existing-1');
    // Both new phases should be after the existing one
    expect(ids[ids.length - 1]).toBe('new-phase');
  });

  it('no order or position dropdown exists in the phase form grid', async () => {
    const phase: PhaseDefinition = Object.freeze({
      id: 'p-1', name: 'Phase', instruction: 'test'
    }) as unknown as PhaseDefinition;
    const snap = buildSnapshot([phase]);
    const { container } = render(PipelineBuilder, {
      props: { snapshot: snap, initialTab: 'phases' }
    });
    await tick();

    // Select the phase to open the form grid
    const item = container.querySelector('[data-testid="phases-list-item-p-1"]') as HTMLButtonElement;
    await fireEvent.click(item);
    await tick();

    // Verify no "order" or "position" label exists in the form grid
    const labels = Array.from(container.querySelectorAll('.form-label'))
      .map((el) => el.textContent?.trim().toLowerCase() ?? '');
    expect(labels.some((l) => l.includes('order'))).toBe(false);
    expect(labels.some((l) => l.includes('position'))).toBe(false);
  });
});
