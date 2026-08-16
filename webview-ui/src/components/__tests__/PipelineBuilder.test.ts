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

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
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
import { useConfirm } from '../../lib/use-confirm';
import { foldLegacyRun } from '../../lib/__tests__/queue-runtime-fixture';

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
vi.mock('../../lib/use-confirm', () => ({
  useConfirm: vi.fn(async () => true)
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function buildSnapshot(
  phases: readonly PhaseDefinition[] = [],
  pipelines: readonly PipelineDefinition[] = [],
  models: readonly string[] = [],
  phasePrecedence?: PhasePrecedenceProjection
): WorkflowSnapshot {
  const portable = phases.map((phase) => ({
    phaseId: phase.id,
    name: phase.name,
    version: phase.version ?? 1,
    ...(phase.description !== undefined ? { description: phase.description } : {}),
    ...(phase.instruction !== undefined ? { instruction: phase.instruction } : {}),
    ...(phase.skill !== undefined ? { skill: phase.skill } : {}),
    ...(phase.model !== undefined ? { model: phase.model } : {}),
    ...(phase.effort !== undefined ? { effort: phase.effort } : {}),
    ...(phase.loopable !== undefined ? { loopable: phase.loopable } : {}),
    ...(phase.retryCondition !== undefined ? { retryCondition: phase.retryCondition } : {}),
    ...(phase.isRequired !== undefined ? { isRequired: phase.isRequired } : {}),
    ...(phase.runner !== undefined ? { runner: phase.runner } : {})
  }));
  const portablePipelines = pipelines.map((pipeline) => ({
    pipelineId: pipeline.id,
    name: pipeline.name,
    version: 1,
    phaseIds: [...pipeline.phases],
    inputs: [],
    outputs: [],
    bindings: [],
    recommendedNext: []
  }));
  return Object.freeze({
    schemaVersion: 4,
    isPrimary: true,
    workspaceTrust: true,
    resolvedTrust: Object.freeze({
      phases: true,
      retryConditions: true,
      pipelineOverrides: true
    }),
    // Feature 092 — the v3 root run singulars now hang off the queue that owns
    // the Run. `foldLegacyRun` performs that fold, so the call sites below keep
    // their v3 wording.
    queues: foldLegacyRun({
      status: 'idle',
      activeFeature: null,
      phases: Object.freeze([]),
      liveActivity: Object.freeze({
      summary: null,
      category: null,
      lastEventAt: null,
      freshness: 'idle',
      staleSeconds: null
      }),
      workflowElapsedMs: null
    }),
    queue: Object.freeze({
      orderedItems: [],
      inFlight: null,
      pending: Object.freeze([]),
      recent: Object.freeze([]),
      paused: false
    }),
    auditTail: Object.freeze([]),
    monitor: null,
    history: Object.freeze([]),
    producedAt: '2026-05-11T00:00:00.000Z',
    availablePipelines: Object.freeze(pipelines),
    availablePhases: Object.freeze(phases),
    availableModels: Object.freeze({ claude: models, codex: [], agy: [] }) as Record<BackendRunnerKind, readonly string[]>,
    availableBackends: Object.freeze(['claude', 'codex', 'agy']) as readonly BackendRunnerKind[],
    phaseCatalog: {
      state: 'ready',
      records: portable.map((definition) => ({
        key: `workspace::${definition.phaseId}::0`,
        phaseId: definition.phaseId,
        scope: 'workspace',
        status: 'effective',
        definition,
        display: definition,
        errors: []
      })),
      effective: portable,
      revisions: { user: 'user-revision', workspace: 'workspace-revision' },
      warnings: []
    },
    // Feature 082 — the Pipeline tab reads the authoritative catalog
    // projection, not `availablePipelines` (which keeps its runtime-selection
    // meaning). Legacy fixtures declare a Pipeline once; both fields mirror it.
    pipelineCatalog: {
      state: 'ready',
      records: portablePipelines.map((definition) => ({
        key: `workspace::${definition.pipelineId}::0`,
        pipelineId: definition.pipelineId,
        scope: 'workspace',
        status: 'effective',
        definition,
        display: definition,
        errors: []
      })),
      effective: portablePipelines,
      revisions: { user: 'user-pipeline-revision', workspace: 'workspace-pipeline-revision' },
      warnings: []
    },
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
  it('does not remove a persisted Phase when confirmation is cancelled', async () => {
    const phase: PhaseDefinition = Object.freeze({
      id: 'remove-me', name: 'Remove me', version: 1, instruction: 'Run.'
    });
    vi.mocked(useConfirm).mockResolvedValueOnce(false);
    const { container } = render(PipelineBuilder, { props: { snapshot: buildSnapshot([phase]) } });
    await switchTab(container, 'Phases');
    await fireEvent.click(container.querySelector('[data-testid="phases-list-item-workspace-remove-me"]')!);
    await fireEvent.click(container.querySelector('[data-testid="phases-remove"]')!);
    await tick();
    expect(useConfirm).toHaveBeenCalledWith('catalog.remove-phase', expect.objectContaining({
      context: { phaseName: 'Remove me', phaseId: 'remove-me', scope: 'workspace' }
    }));
    expect(savePhasesHelper).not.toHaveBeenCalled();
  });

  it('submits one scoped remove mutation after confirmation', async () => {
    const phase: PhaseDefinition = Object.freeze({
      id: 'remove-me', name: 'Remove me', version: 1, instruction: 'Run.'
    });
    vi.mocked(useConfirm).mockResolvedValueOnce(true);
    const { container } = render(PipelineBuilder, { props: { snapshot: buildSnapshot([phase]) } });
    await switchTab(container, 'Phases');
    await fireEvent.click(container.querySelector('[data-testid="phases-list-item-workspace-remove-me"]')!);
    await fireEvent.click(container.querySelector('[data-testid="phases-remove"]')!);
    await tick();
    expect(savePhasesHelper).toHaveBeenCalledOnce();
    expect(savePhasesHelper).toHaveBeenCalledWith({
      scope: 'workspace',
      expectedRevision: 'workspace-revision',
      mutation: { kind: 'remove', phaseId: 'remove-me' },
      phases: []
    });
  });

  it('duplicates a built-in Phase into a writable version-1 draft', async () => {
    const phase: PhaseDefinition = Object.freeze({
      id: 'built-in-phase', name: 'Built-in Phase', version: 7, instruction: 'Run.'
    });
    const base = buildSnapshot([phase]);
    const record = base.phaseCatalog!.records[0];
    const snapshot = {
      ...base,
      phaseCatalog: {
        ...base.phaseCatalog!,
        records: [{
          ...record,
          key: 'built-in::built-in-phase::0',
          scope: 'built-in' as const
        }]
      }
    } as WorkflowSnapshot;
    const { container } = render(PipelineBuilder, {
      props: { snapshot, initialTab: 'phases' }
    });
    await fireEvent.click(container.querySelector(
      '[data-testid="phases-list-item-built-in-built-in-phase"]'
    )!);
    await fireEvent.click(container.querySelector('[data-testid="phases-duplicate"]')!);
    await tick();
    expect(container.textContent).toContain('built-in-phase-copy');
    const scope = [...container.querySelectorAll('select')].find((element) =>
      element.textContent?.includes('Workspace') && element.textContent?.includes('User')
    ) as HTMLSelectElement;
    expect(scope.value).toBe('workspace');
    const version = [...container.querySelectorAll('.form-field')]
      .find((field) => field.querySelector('.form-label')?.textContent === 'Version')
      ?.querySelector('input') as HTMLInputElement;
    expect(version.value).toBe('1');
  });

  it('preserves a dirty draft and shows refresh/reapply guidance after stale rejection', async () => {
    const phase: PhaseDefinition = Object.freeze({
      id: 'stale-phase', name: 'Original', version: 1, instruction: 'Run.'
    });
    vi.mocked(savePhasesHelper).mockResolvedValueOnce({
      status: 'rejected',
      reason: 'stale-catalog',
      result: {
        currentRevision: 'new-workspace-revision',
        current: { scope: 'workspace', phaseId: 'stale-phase', legalActions: ['refresh', 'reapply'] }
      }
    });
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot([phase]), initialTab: 'phases' }
    });
    await fireEvent.click(container.querySelector(
      '[data-testid="phases-list-item-workspace-stale-phase"]'
    )!);
    const name = container.querySelector(
      '[data-testid="phases-name-field-stale-phase"]'
    ) as HTMLInputElement;
    await fireEvent.input(name, { target: { value: 'Dirty draft' } });
    await fireEvent.click(container.querySelector('[data-testid="phases-save-all"]')!);
    await tick();
    expect(name.value).toBe('Dirty draft');
    expect(container.querySelector('[data-testid="save-error-banner"]')?.textContent)
      .toContain('refresh the catalog, then reapply the draft');
  });

  it('shows actionable structured validation details after a rejected save', async () => {
    const phase: PhaseDefinition = Object.freeze({
      id: 'invalid-phase', name: 'Original', version: 1, instruction: 'Run.'
    });
    vi.mocked(savePhasesHelper).mockResolvedValueOnce({
      status: 'rejected',
      reason: 'phase-validation',
      result: {
        errors: [{
          phaseId: 'invalid-phase', field: 'retryCondition', code: 'invalid-syntax',
          message: 'Retry condition has invalid syntax'
        }],
        total: 1
      }
    });
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot([phase]), initialTab: 'phases' }
    });
    await fireEvent.click(container.querySelector(
      '[data-testid="phases-list-item-workspace-invalid-phase"]'
    )!);
    await fireEvent.input(container.querySelector(
      '[data-testid="phases-name-field-invalid-phase"]'
    )!, { target: { value: 'Dirty draft' } });
    await fireEvent.click(container.querySelector('[data-testid="phases-save-all"]')!);
    await tick();
    expect(container.querySelector('[data-testid="save-error-banner"]')?.textContent)
      .toContain('invalid-phase.retryCondition: Retry condition has invalid syntax');
  });

  it('adopts the host revision after a stale rejection and retries the preserved draft', async () => {
    const phase: PhaseDefinition = Object.freeze({
      id: 'concurrent-phase', name: 'Original', version: 1, instruction: 'Run.'
    });
    const sibling: PhaseDefinition = Object.freeze({
      id: 'sibling-phase', name: 'Original sibling', version: 1, instruction: 'Run.'
    });
    const initial = buildSnapshot([phase, sibling]);
    vi.mocked(savePhasesHelper)
      .mockResolvedValueOnce({
        status: 'rejected', reason: 'stale-catalog',
        result: { currentRevision: 'intermediate-workspace-revision' }
      })
      .mockResolvedValueOnce({ status: 'accepted' });
    const { container, rerender } = render(PipelineBuilder, {
      props: { snapshot: initial, initialTab: 'phases' }
    });
    await fireEvent.click(container.querySelector(
      '[data-testid="phases-list-item-workspace-concurrent-phase"]'
    )!);
    await fireEvent.input(container.querySelector(
      '[data-testid="phases-name-field-concurrent-phase"]'
    )!, { target: { value: 'Dirty draft' } });
    const inserted: PhaseDefinition = Object.freeze({
      id: 'inserted-phase', name: 'Concurrent insertion', version: 1, instruction: 'Run.'
    });
    const concurrent = buildSnapshot([
      inserted, phase, { ...sibling, name: 'Concurrent sibling edit' }
    ]);
    const newer = {
      ...concurrent,
      phaseCatalog: {
        ...concurrent.phaseCatalog!,
        revisions: { user: 'user-revision', workspace: 'new-workspace-revision' }
      }
    } as WorkflowSnapshot;
    await rerender({ snapshot: newer, initialTab: 'phases' });
    await fireEvent.click(container.querySelector('[data-testid="phases-save-all"]')!);
    await tick();

    expect(savePhasesHelper).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 'workspace-revision',
      phases: expect.arrayContaining([expect.objectContaining({ name: 'Dirty draft' })])
    }));
    const retry = container.querySelector('[data-testid="phases-save-all"]') as HTMLButtonElement;
    await vi.waitFor(() => expect(retry.disabled).toBe(false));
    await fireEvent.click(retry);
    await tick();
    expect(savePhasesHelper).toHaveBeenNthCalledWith(2, expect.objectContaining({
      expectedRevision: 'new-workspace-revision',
      phases: [
        expect.objectContaining({ id: 'inserted-phase', name: 'Concurrent insertion' }),
        expect.objectContaining({ name: 'Dirty draft' }),
        expect.objectContaining({ id: 'sibling-phase', name: 'Concurrent sibling edit' })
      ]
    }));
  });

  it('accepts a newer authoritative revision when the acknowledged revision was skipped', async () => {
    const phase: PhaseDefinition = Object.freeze({
      id: 'fast-phase', name: 'Original', version: 1, instruction: 'Run.'
    });
    let resolveSave!: (result: { status: 'accepted'; result: { revision: string } }) => void;
    vi.mocked(savePhasesHelper).mockImplementationOnce(() => new Promise((resolve) => {
      resolveSave = resolve;
    }));
    const initial = buildSnapshot([phase]);
    const { container, rerender } = render(PipelineBuilder, {
      props: { snapshot: initial, initialTab: 'phases' }
    });
    await fireEvent.click(container.querySelector(
      '[data-testid="phases-list-item-workspace-fast-phase"]'
    )!);
    await fireEvent.input(container.querySelector(
      '[data-testid="phases-name-field-fast-phase"]'
    )!, { target: { value: 'Local edit' } });
    await fireEvent.click(container.querySelector('[data-testid="phases-save-all"]')!);
    const laterBase = buildSnapshot([{ ...phase, name: 'Later authoritative edit' }]);
    const later = {
      ...laterBase,
      phaseCatalog: {
        ...laterBase.phaseCatalog!,
        revisions: { user: 'user-revision', workspace: 'later-revision' }
      }
    } as WorkflowSnapshot;
    await rerender({ snapshot: later, initialTab: 'phases' });
    resolveSave({ status: 'accepted', result: { revision: 'acknowledged-revision' } });
    await vi.waitFor(() => expect(container.textContent).not.toContain('Saving…'));
    expect(container.textContent).toContain('Later authoritative edit');
  });

  it('saves the selected source scope when user and workspace share a Phase id', async () => {
    const phase: PhaseDefinition = Object.freeze({
      id: 'shared', name: 'Workspace copy', version: 2, instruction: 'Workspace.'
    });
    const base = buildSnapshot([phase]);
    const definition = base.phaseCatalog!.records[0].definition!;
    const snapshot = {
      ...base,
      phaseCatalog: {
        ...base.phaseCatalog!,
        records: [
          {
            key: 'user::shared::0', phaseId: 'shared', scope: 'user' as const,
            status: 'shadowed' as const, definition: { ...definition, name: 'User copy' },
            display: { ...definition, name: 'User copy' }, errors: []
          },
          base.phaseCatalog!.records[0]
        ]
      }
    } as WorkflowSnapshot;
    const { container } = render(PipelineBuilder, { props: { snapshot, initialTab: 'phases' } });
    await fireEvent.click(container.querySelector(
      '[data-testid="phases-list-item-workspace-shared"]'
    )!);
    await fireEvent.input(container.querySelector(
      '[data-testid="phases-name-field-shared"]'
    )!, { target: { value: 'Workspace edited' } });
    await fireEvent.click(container.querySelector('[data-testid="phases-save-all"]')!);
    await tick();

    expect(savePhasesHelper).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'workspace', expectedRevision: 'workspace-revision',
      mutation: { kind: 'edit', phaseId: 'shared' },
      phases: [expect.objectContaining({ id: 'shared', name: 'Workspace edited' })]
    }));
  });

  it('discards an unsaved new Phase draft', async () => {
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot(), initialTab: 'phases' }
    });
    await fireEvent.click(container.querySelector('[data-testid="phases-add"]')!);
    expect(container.textContent).toContain('new-phase');
    const discard = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Discard Draft'
    );
    await fireEvent.click(discard!);
    await tick();
    expect(container.textContent).not.toContain('new-phase');
    expect(savePhasesHelper).not.toHaveBeenCalled();
  });

  it('preserves configured unavailable runner and model values visibly', async () => {
    const phase: PhaseDefinition = Object.freeze({
      id: 'p-unavailable', name: 'Unavailable backend', instruction: 'check',
      runner: 'agy', model: 'agy-operator-model'
    });
    const snap = {
      ...buildSnapshot([phase]),
      availableBackends: ['claude'] as readonly BackendRunnerKind[]
    } as WorkflowSnapshot;
    const { container } = render(PipelineBuilder, { props: { snapshot: snap } });
    await switchTab(container, 'Phases');
    await fireEvent.click(container.querySelector('[data-testid="phases-list-item-workspace-p-unavailable"]')!);
    const runner = container.querySelector('[data-testid="phases-runner-p-unavailable"]') as HTMLSelectElement;
    const model = container.querySelector('[data-testid="phases-model-p-unavailable"]') as HTMLSelectElement;
    expect(runner.value).toBe('agy');
    expect(runner.selectedOptions[0]?.textContent).toContain('Unavailable');
    expect(model.value).toBe('agy-operator-model');
    expect(model.selectedOptions[0]?.textContent).toContain('Unavailable');
  });

  // Feature 083 added the Workflows tab; the Workflow Library has no other
  // mount site, so the tab bar is 4-wide from this feature forward.
  it('renders the 4-tab bar: Pipelines, Phases, Workflows, Models', () => {
    const snap = buildSnapshot();
    const { container } = render(PipelineBuilder, { props: { snapshot: snap } });
    const tabs = [...container.querySelectorAll('.tab-btn')].map((t) => t.textContent?.trim());
    expect(tabs).toEqual(['Pipelines', 'Phases', 'Workflows', 'Models']);
  });

  it('implements the catalog switcher as keyboard-operable tabs', async () => {
    const { container } = render(PipelineBuilder, { props: { snapshot: buildSnapshot() } });
    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('.builder-tabs .tab-btn'));
    expect(container.querySelector('.builder-tabs')?.getAttribute('role')).toBe('tablist');
    expect(tabs[0]?.getAttribute('role')).toBe('tab');
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(tabs[0]?.getAttribute('tabindex')).toBe('0');
    expect(tabs[1]?.getAttribute('tabindex')).toBe('-1');

    await fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' });
    await tick();
    await Promise.resolve();
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs[1]);
    expect(container.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby'))
      .toBe('builder-tab-phases');
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
    const item = container.querySelector('[data-testid="phases-list-item-workspace-p-1"]');
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
    const item = container.querySelector('[data-testid="phases-list-item-workspace-p-1"]') as HTMLButtonElement;
    expect(item).not.toBeNull();
    await fireEvent.click(item);
    await tick();
    const toggle = container.querySelector('[data-testid="phases-raw-json-toggle"]');
    expect(toggle).not.toBeNull();
  });

  it('targets the persisted identity when Raw JSON repairs a malformed id', async () => {
    const base = buildSnapshot();
    const snapshot = {
      ...base,
      phaseCatalog: {
        ...base.phaseCatalog!,
        records: [{
          key: 'workspace::INVALID::0', phaseId: 'INVALID', scope: 'workspace' as const,
          status: 'invalid' as const, definition: null,
          display: { id: 'INVALID', name: 'Invalid', version: 2, instruction: 'Run.' },
          errors: [{
            field: 'phaseId', code: 'invalid-pattern', message: 'Phase id is invalid'
          }]
        }]
      }
    } as WorkflowSnapshot;
    const { container } = render(PipelineBuilder, {
      props: { snapshot, initialTab: 'phases' }
    });
    await fireEvent.click(container.querySelector(
      '[data-testid="phases-list-item-workspace-INVALID"]'
    )!);
    await fireEvent.click(container.querySelector('[data-testid="phases-raw-json-toggle"]')!);
    await tick();
    await fireEvent.input(container.querySelector('[data-testid="raw-json-input"]')!, {
      target: { value: JSON.stringify({
        id: 'repaired-id', name: 'Repaired', version: 2, instruction: 'Run.'
      }) }
    });
    await fireEvent.click(container.querySelector('[data-testid="raw-json-save"]')!);
    await fireEvent.click(container.querySelector('[data-testid="phases-save-all"]')!);
    await tick();
    expect(savePhasesHelper).toHaveBeenCalledWith(expect.objectContaining({
      mutation: { kind: 'edit', phaseId: 'INVALID' },
      phases: [expect.objectContaining({ id: 'repaired-id' })]
    }));
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
    const item = container.querySelector('[data-testid="phases-list-item-workspace-p-nl"]') as HTMLButtonElement;
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

  // Feature 096 T025 — the Model Catalog import trigger. Unmounted on every
  // other tab, same as the per-tab save affordances above: it must not be
  // reachable before the Models tab is active.
  it('Models tab: mounts the Model Catalog import entry point', async () => {
    const snap = buildSnapshot([], [], ['claude-sonnet-4-6']);
    const { container } = render(PipelineBuilder, { props: { snapshot: snap } });
    expect(container.querySelector('[data-testid="process-import-preflight"]')).toBeNull();
    await switchTab(container, 'Models');
    expect(container.querySelector('[data-testid="process-import-preflight"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="process-import-inspect"]')).not.toBeNull();
  });

  // Feature 082 — saves are mutation-scoped: the operator declares a change,
  // and only that change is submitted against the adopted layer revision. A
  // Save click with nothing declared is inert (FR-029).
  it('Pipelines tab: save is inert until a mutation is declared', async () => {
    vi.mocked(savePipelinesHelper).mockClear();
    const pipeline: PipelineDefinition = Object.freeze({
      id: 'custom',
      name: 'Custom Pipeline',
      phases: Object.freeze(['speckit-specify', 'speckit-plan'])
    }) as unknown as PipelineDefinition;
    const snap = buildSnapshot([], [pipeline]);
    const { container } = render(PipelineBuilder, { props: { snapshot: snap } });
    await tick();
    const saveBtn = container.querySelector(
      '[data-testid="pipelines-save-all"]'
    ) as HTMLButtonElement | null;
    expect(saveBtn).not.toBeNull();
    await fireEvent.click(saveBtn!);
    await tick();
    expect(savePipelinesHelper).not.toHaveBeenCalled();
  });

  it('Models tab: saves through the shared save-models helper', async () => {
    vi.mocked(saveModelsHelper).mockClear();
    const snap = buildSnapshot([], [], ['claude-sonnet-4-6', 'claude-opus-4-6']);
    const { container } = render(PipelineBuilder, { props: { snapshot: snap } });
    await switchTab(container, 'Models');
    const saveBtn = [...container.querySelectorAll('button')].find(
      (btn) => btn.textContent?.trim() === 'Save All Models'
    ) as HTMLButtonElement | undefined;
    expect(saveBtn).toBeDefined();
    await fireEvent.click(saveBtn!);
    await tick();
    expect(saveModelsHelper).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveModelsHelper).mock.calls[0][0]).toEqual({
      claude: ['claude-sonnet-4-6', 'claude-opus-4-6'],
      codex: [],
      agy: []
    });
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
    const saveBtn = container.querySelector(
      '[data-testid="pipelines-save-all"]'
    ) as HTMLButtonElement | null;
    expect(saveBtn).not.toBeNull();
    await fireEvent.click(saveBtn!);
    await tick();

    expect(savePipelinesHelper).toHaveBeenCalledTimes(1);
    expect(vi.mocked(savePipelinesHelper).mock.calls[0][0]).toEqual({
      scope: 'workspace',
      expectedRevision: 'workspace-pipeline-revision',
      mutation: { kind: 'edit', pipelineId: 'custom' },
      pipelines: [
        { id: 'custom', name: 'Renamed Pipeline', version: 1, phases: ['speckit-specify'] }
      ]
    });
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
    const item = container.querySelector(`[data-testid="phases-list-item-workspace-${p.id}"]`) as HTMLButtonElement;
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
    const [{ phases }] = vi.mocked(savePhasesHelper).mock.calls[0];
    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatchObject({ id: 'speckit-plan', effort: 'high' });
  });

  it('preserves the deprecated loopable field during structured saves', async () => {
    vi.mocked(savePhasesHelper).mockClear();
    const { container } = await openPhasesEditor({
      ...phase,
      loopable: true
    });
    const loopable = container.querySelector('.checkbox-field input') as HTMLInputElement;
    await fireEvent.click(loopable);
    await fireEvent.click(loopable);
    await fireEvent.click(
      container.querySelector('[data-testid="phases-save-all"]') as HTMLButtonElement
    );
    await tick();

    expect(vi.mocked(savePhasesHelper).mock.calls[0][0].phases[0]).toMatchObject({
      id: 'speckit-plan',
      loopable: true
    });
  });

  it('defaults legacy phases to Required and saves an explicit optional choice', async () => {
    vi.mocked(savePhasesHelper).mockClear();
    const { container } = await openPhasesEditorForPlan();
    const required = container.querySelector(
      '[data-testid="phases-required-speckit-plan"]'
    ) as HTMLInputElement;

    expect(required.checked).toBe(true);
    await fireEvent.click(required);
    await fireEvent.click(
      container.querySelector('[data-testid="phases-save-all"]') as HTMLButtonElement
    );
    await tick();

    expect(vi.mocked(savePhasesHelper).mock.calls[0][0].phases[0]).toMatchObject({
      id: 'speckit-plan',
      isRequired: false
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

    expect(vi.mocked(savePhasesHelper).mock.calls[0][0].phases[0]).toMatchObject({
      id: 'speckit-plan',
      runner: 'agy'
    });
  });

  it('does not apply built-in runner restrictions to a custom shadow', async () => {
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

    expect(select.querySelector('option[value=""]')?.hasAttribute('disabled')).toBe(false);
    expect(select.querySelector('option[value="codex"]')?.hasAttribute('disabled')).toBe(false);
    expect(select.querySelector('option[value="claude"]')?.hasAttribute('disabled')).toBe(false);
    expect(select.querySelector('option[value="agy"]')?.hasAttribute('disabled')).toBe(false);
  });

  it.each(['speckit-specify', 'specify-brainstorm', 'superpowers-implement'])(
    'does not restrict runners for custom phase shadow %s',
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

      expect(select.querySelector('option[value=""]')?.hasAttribute('disabled')).toBe(false);
      expect(select.querySelector('option[value="codex"]')?.hasAttribute('disabled')).toBe(false);
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

    expect(vi.mocked(savePhasesHelper).mock.calls[0][0].phases[0].runner).toBeUndefined();
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
    const [{ phases }] = vi.mocked(savePhasesHelper).mock.calls[0];
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
    const [{ phases }] = vi.mocked(savePhasesHelper).mock.calls[0];
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
    const [{ phases }] = vi.mocked(savePhasesHelper).mock.calls[0];
    expect(phases[0]).toMatchObject({ id: 'speckit-plan', model: 'claude-sonnet-4-6' });
    expect((phases[0] as unknown as Record<string, unknown>).effort).toBeUndefined();
  });


});

describe('PipelineBuilder — BUG-002 cross-tab phase visibility', () => {
  it('offers a newly created phase only after its authoritative save round-trip', async () => {
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

    const { container, rerender } = render(PipelineBuilder, {
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

    // 2. Switch to Pipelines tab before saving.
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

    // An unsaved draft must not be offered to a persistable Pipeline.
    expect(optionValues).toContain('speckit-specify');
    expect(optionValues).not.toContain('new-phase');

    // 5. Also check the inline sequence select for the existing pipeline phase
    const sequenceSelect = container.querySelector('.sequence-select') as HTMLSelectElement;
    expect(sequenceSelect).not.toBeNull();
    const seqOptions = Array.from(sequenceSelect.querySelectorAll('option')).map(o => o.value);
    expect(seqOptions).toContain('speckit-specify');
    expect(seqOptions).not.toContain('new-phase');

    // The authoritative catalog refresh makes the saved Phase available.
    const savedPhase: PhaseDefinition = Object.freeze({
      id: 'new-phase', name: 'New Phase', version: 1,
      instruction: 'Describe the phase objective here.'
    });
    await rerender({
      snapshot: buildSnapshot([existingPhase, savedPhase], [pipeline]),
      initialTab: 'phases'
    });
    await tick();
    expect(Array.from(addPhaseDropdown.querySelectorAll('option')).map(o => o.value))
      .toContain('new-phase');
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

  it('persists a same-scope Phase reorder as one atomic edit mutation', async () => {
    const container = await renderPhasesList();
    await fireEvent.click(container.querySelector(
      '[data-testid="phases-move-down-phase-a"]'
    )!);
    await fireEvent.click(container.querySelector('[data-testid="phases-save-all"]')!);
    await tick();

    expect(savePhasesHelper).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'workspace',
      mutation: { kind: 'edit', phaseId: 'phase-a' },
      phases: [
        expect.objectContaining({ id: 'phase-b' }),
        expect.objectContaining({ id: 'phase-a' }),
        expect.objectContaining({ id: 'phase-c' })
      ]
    }));
  });

  it('disables reordering across source-scope boundaries', async () => {
    const base = buildSnapshot([phaseA, phaseB]);
    const snapshot = {
      ...base,
      phaseCatalog: {
        ...base.phaseCatalog!,
        records: [
          { ...base.phaseCatalog!.records[0], key: 'user::phase-a::0', scope: 'user' as const },
          base.phaseCatalog!.records[1]
        ]
      }
    } as WorkflowSnapshot;
    const { container } = render(PipelineBuilder, {
      props: { snapshot, initialTab: 'phases' }
    });
    const moveDown = container.querySelector(
      '[data-testid="phases-move-down-phase-a"]'
    ) as HTMLButtonElement;
    const moveUp = container.querySelector(
      '[data-testid="phases-move-up-phase-b"]'
    ) as HTMLButtonElement;
    expect(moveDown.disabled).toBe(true);
    expect(moveUp.disabled).toBe(true);
    await fireEvent.click(moveDown);
    expect(getPhaseIds(container)).toEqual(['phase-a', 'phase-b']);
    expect(savePhasesHelper).not.toHaveBeenCalled();
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
    const itemA = container.querySelector('[data-testid="phases-list-item-workspace-phase-a"]') as HTMLButtonElement;
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
    const itemC = container.querySelector('[data-testid="phases-list-item-workspace-phase-c"]') as HTMLButtonElement;
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
  it('appends one new phase and blocks a second concurrent draft', async () => {
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

    expect(addBtn.disabled).toBe(true);

    // An atomic Phase save carries one explicit mutation only.
    await fireEvent.click(addBtn);
    await tick();

    ids = Array.from(container.querySelectorAll('.phase-list-item'))
      .map((el) => el.querySelector('.phase-list-id')?.textContent?.trim() ?? '');
    expect(ids).toEqual(['existing-1', 'new-phase']);
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
    const item = container.querySelector('[data-testid="phases-list-item-workspace-p-1"]') as HTMLButtonElement;
    await fireEvent.click(item);
    await tick();

    // Verify no "order" or "position" label exists in the form grid
    const labels = Array.from(container.querySelectorAll('.form-label'))
      .map((el) => el.textContent?.trim().toLowerCase() ?? '');
    expect(labels.some((l) => l.includes('order'))).toBe(false);
    expect(labels.some((l) => l.includes('position'))).toBe(false);
  });
});

// Feature 082 (US7, T054) — the Pipeline delete control is destructive, so it
// is gated on the shared confirmation and never on its own click (FR-023). The
// prompt has to describe the target, not just the action, and the triggering
// control is handed to `useConfirm` so focus returns to it when the dialog
// closes (FR-038).
describe('PipelineBuilder — confirmed Pipeline removal (US7, T054)', () => {
  const REMOVABLE: PipelineDefinition = Object.freeze({
    id: 'custom',
    name: 'Custom Pipeline',
    phases: Object.freeze(['speckit-specify'])
  }) as unknown as PipelineDefinition;

  /** Renders the Pipelines tab, selects the row, and returns its delete button. */
  async function openDeleteControl(): Promise<{
    container: HTMLElement;
    deleteBtn: HTMLButtonElement;
  }> {
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot([], [REMOVABLE]) }
    });
    await tick();
    await fireEvent.click(container.querySelector('.phase-list-item') as HTMLButtonElement);
    await tick();
    const deleteBtn = container.querySelector(
      '[data-testid="pipelines-remove"]'
    ) as HTMLButtonElement | null;
    expect(deleteBtn).not.toBeNull();
    return { container, deleteBtn: deleteBtn! };
  }

  beforeEach(() => {
    vi.mocked(savePipelinesHelper).mockClear();
    vi.mocked(useConfirm).mockClear();
  });

  it('names the Pipeline and its scope in the confirmation prompt', async () => {
    vi.mocked(useConfirm).mockResolvedValueOnce(false);
    const { deleteBtn } = await openDeleteControl();

    await fireEvent.click(deleteBtn);
    await tick();

    expect(useConfirm).toHaveBeenCalledWith(
      'catalog.remove-pipeline',
      expect.objectContaining({
        context: { pipelineName: 'Custom Pipeline', pipelineId: 'custom', scope: 'workspace' }
      })
    );
  });

  it('does not remove a persisted Pipeline when confirmation is cancelled', async () => {
    vi.mocked(useConfirm).mockResolvedValueOnce(false);
    const { deleteBtn } = await openDeleteControl();

    await fireEvent.click(deleteBtn);
    await tick();

    expect(savePipelinesHelper).not.toHaveBeenCalled();
  });

  it('submits one scoped remove mutation after confirmation', async () => {
    vi.mocked(useConfirm).mockResolvedValueOnce(true);
    const { deleteBtn } = await openDeleteControl();

    await fireEvent.click(deleteBtn);
    await tick();

    expect(savePipelinesHelper).toHaveBeenCalledTimes(1);
    expect(vi.mocked(savePipelinesHelper).mock.calls[0][0]).toEqual({
      scope: 'workspace',
      expectedRevision: 'workspace-pipeline-revision',
      mutation: { kind: 'remove', pipelineId: 'custom' },
      pipelines: []
    });
  });

  it('hands the triggering control to the dialog so focus can return to it', async () => {
    vi.mocked(useConfirm).mockResolvedValueOnce(false);
    const { deleteBtn } = await openDeleteControl();

    await fireEvent.click(deleteBtn);
    await tick();

    expect(useConfirm).toHaveBeenCalledWith(
      'catalog.remove-pipeline',
      expect.objectContaining({ originatingElement: deleteBtn })
    );
  });
});
