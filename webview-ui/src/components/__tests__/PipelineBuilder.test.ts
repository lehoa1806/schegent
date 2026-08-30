// PipelineBuilder restored 3-tab design tests.
//
// Covers:
//   - The 3-tab bar renders (Pipelines, Phases, Models).
//   - Switching to Phases tab shows the phase list.
//   - Phase editor exposes Raw-JSON toggle on selection.
//   - RetryCondition editor renders for ALL phases (not gated behind loopable).
//   - Models tab renders and allows add/remove.
//   - Feature 026 T011 — per-phase Effort dropdown + FR-003 orthogonality of
//     effort/model overrides. Feature 099 (T496f, FR-041) — the precedence
//     badges left with the layer tier; precedence answered "which layer won",
//     and one layer answers it by existing.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import PipelineBuilder from '../PipelineBuilder.svelte';
import type {
  WorkflowSnapshot,
  PhaseDefinition,
  PipelineDefinition,
  BackendRunnerKind
} from '../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../lib/snapshot-types';
import {
  deactivateDefinition as deactivateHelper,
  saveDefinitionDraft as saveDraftHelper
} from '../../lib/catalog-lifecycle';
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
// Feature 101 (T030) — `save-phases.ts` and `save-pipelines.ts` folded into
// `catalog-lifecycle.ts`, so one mock replaces two. Only the senders are stubbed;
// `draftTokenOfRecord` in particular keeps its real body, because it is the
// derivation that turns a record's lifecycle block into the write token and
// stubbing it would let the editors send any token while the assertions below
// still read 'no-draft'.
vi.mock('../../lib/catalog-lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/catalog-lifecycle')>()),
  saveDefinitionDraft: vi.fn(async () => ({ status: 'accepted' as const })),
  deactivateDefinition: vi.fn(async () => ({ status: 'accepted' as const }))
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
  models: readonly string[] = []
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
    // The `models` argument is the operator's catalog — `schegent.models` —
    // which is what the Models tab edits and saves. `availableModels` is the
    // capability service's detected list, and Claude reports none of its own:
    // the CLI cannot enumerate its models. The two are deliberately not the
    // same value here, because seeding the page from detection is the defect
    // that made a confirmed import invisible.
    availableModels: Object.freeze({ claude: [], codex: [], agy: [] }) as Record<BackendRunnerKind, readonly string[]>,
    configuredModels: Object.freeze({ claude: models, codex: [], agy: [] }) as Record<BackendRunnerKind, readonly string[]>,
    availableBackends: Object.freeze(['claude', 'codex', 'agy']) as readonly BackendRunnerKind[],
    phaseCatalog: {
      state: 'ready',
      records: portable.map((definition) => ({
        key: `${definition.phaseId}::0`,
        phaseId: definition.phaseId,
        status: 'effective',
        definition,
        display: definition,
        errors: []
      })),
      effective: portable,
      revision: 'phase-revision',
      warnings: []
    },
    // Feature 082 — the Pipeline tab reads the authoritative catalog
    // projection, not `availablePipelines` (which keeps its runtime-selection
    // meaning). Legacy fixtures declare a Pipeline once; both fields mirror it.
    pipelineCatalog: {
      state: 'ready',
      records: portablePipelines.map((definition) => ({
        key: `${definition.pipelineId}::0`,
        pipelineId: definition.pipelineId,
        status: 'effective',
        definition,
        display: definition,
        errors: []
      })),
      effective: portablePipelines,
      revision: 'pipeline-revision',
      warnings: []
    },
    generalSettings: IDLE_GENERAL_SETTINGS
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

/**
 * The row a draft write carried, defaulting to the first write.
 *
 * Feature 101 (T030) — the cases below used to destructure `phases` off the
 * request and index into it, because the write was the whole layer and the
 * edited row was one entry in it. A draft write carries exactly one definition,
 * so the index is gone and this is what replaces it.
 */
function savedBody(call = 0): Record<string, unknown> {
  return vi.mocked(saveDraftHelper).mock.calls[call][0].body as Record<string, unknown>;
}

describe('PipelineBuilder — restored 3-tab design', () => {
  const REMOVABLE_PHASE: PhaseDefinition = Object.freeze({
    id: 'remove-me', name: 'Remove me', version: 1, instruction: 'Run.'
  });

  /** Renders the Phases tab, selects the row, and returns its delete button. */
  async function openPhaseDeleteControl(): Promise<{
    container: HTMLElement;
    deleteBtn: HTMLButtonElement;
  }> {
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot([REMOVABLE_PHASE]) }
    });
    await switchTab(container, 'Phases');
    await fireEvent.click(container.querySelector('[data-testid="phases-list-item-remove-me"]')!);
    const deleteBtn = container.querySelector(
      '[data-testid="phases-remove"]'
    ) as HTMLButtonElement | null;
    expect(deleteBtn).not.toBeNull();
    return { container, deleteBtn: deleteBtn! };
  }

  // Feature 100 (T509b, FR-049) — this pair used to assert that the Builder
  // raised `catalog.remove-phase` itself and sent nothing when the operator said
  // no. The prompt moved into `deactivateDefinition`, the only function that can
  // post the command it authorises, so the Builder's side of the contract is now:
  // hand the helper the removal and everything the prompt has to say, ask nothing,
  // and treat a decline as neither a save nor a failure.
  it('hands the removal to the helper that owns the prompt, and asks nothing itself', async () => {
    const { deleteBtn } = await openPhaseDeleteControl();
    await fireEvent.click(deleteBtn);
    await tick();

    expect(deactivateHelper).toHaveBeenCalledOnce();
    // Feature 101 (T030) — `toEqual` on both arguments is exact, and that is the
    // point. The surviving rows used to travel with the removal because the
    // Builder held a whole layer; a per-definition deactivation names one id and
    // carries no rows, so there is nothing left for a stale sibling to ride in on.
    expect(deactivateHelper).toHaveBeenCalledWith(
      {
        kind: 'phase',
        id: 'remove-me',
        // The fixture record carries no draft, so the staleness token is the
        // sentinel rather than a version id (FR-024).
        expectedDraftVersion: 'no-draft'
      },
      { definitionName: 'Remove me', originatingElement: deleteBtn }
    );
    // Asking here as well would prompt twice for one removal.
    expect(useConfirm).not.toHaveBeenCalled();
  });

  it('reports nothing when the operator declines, because nothing was sent', async () => {
    vi.mocked(deactivateHelper).mockResolvedValueOnce({
      status: 'rejected' as const,
      reason: 'declined'
    });
    const { container, deleteBtn } = await openPhaseDeleteControl();
    await fireEvent.click(deleteBtn);
    await tick();
    await tick();

    // A decline is not a rejection to report: the operator closed a dialog.
    expect(container.querySelector('[data-testid="save-error-banner"]')).toBeNull();
    // And the row is still there, still deletable — the pending flag cleared.
    expect(container.querySelector('[data-testid="phases-list-item-remove-me"]')).not.toBeNull();
    expect(
      (container.querySelector('[data-testid="phases-remove"]') as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it('duplicates a Phase into a version-1 draft', async () => {
    // Feature 099 (T496f, FR-042, FR-043) — this seeded the row at `built-in`
    // and asserted the copy landed at `workspace`: duplicate was how an operator
    // got a writable copy of a row they could not edit in place. There is one
    // layer and every row in it is writable, so the destination assertion has no
    // question left to answer and the scope picker it read is gone. What
    // duplicate still decides is the copy's identity and its version — a fresh
    // definition starts its history at 1, whatever the row it was copied from
    // had reached — and that is what remains here.
    const phase: PhaseDefinition = Object.freeze({
      id: 'source-phase', name: 'Source Phase', version: 7, instruction: 'Run.'
    });
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot([phase]), initialTab: 'phases' }
    });
    await fireEvent.click(container.querySelector(
      '[data-testid="phases-list-item-source-phase"]'
    )!);
    await fireEvent.click(container.querySelector('[data-testid="phases-duplicate"]')!);
    await tick();
    expect(container.textContent).toContain('source-phase-copy');
    const version = [...container.querySelectorAll('.form-field')]
      .find((field) => field.querySelector('.form-label')?.textContent === 'Version')
      ?.querySelector('input') as HTMLInputElement;
    expect(version.value).toBe('1');
  });

  it('preserves a dirty draft and shows refresh/reapply guidance after stale rejection', async () => {
    const phase: PhaseDefinition = Object.freeze({
      id: 'stale-phase', name: 'Original', version: 1, instruction: 'Run.'
    });
    vi.mocked(saveDraftHelper).mockResolvedValueOnce({
      status: 'rejected',
      reason: 'stale-catalog',
      result: {
        currentRevision: 'newer-phase-revision',
        current: { phaseId: 'stale-phase', legalActions: ['refresh', 'reapply'] }
      }
    });
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot([phase]), initialTab: 'phases' }
    });
    await fireEvent.click(container.querySelector(
      '[data-testid="phases-list-item-stale-phase"]'
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
    vi.mocked(saveDraftHelper).mockResolvedValueOnce({
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
      '[data-testid="phases-list-item-invalid-phase"]'
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
    vi.mocked(saveDraftHelper)
      .mockResolvedValueOnce({
        status: 'rejected', reason: 'stale-catalog',
        result: { currentRevision: 'intermediate-workspace-revision' }
      })
      .mockResolvedValueOnce({ status: 'accepted' });
    const { container, rerender } = render(PipelineBuilder, {
      props: { snapshot: initial, initialTab: 'phases' }
    });
    await fireEvent.click(container.querySelector(
      '[data-testid="phases-list-item-concurrent-phase"]'
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
        revision: 'newer-phase-revision'
      }
    } as WorkflowSnapshot;
    await rerender({ snapshot: newer, initialTab: 'phases' });
    await fireEvent.click(container.querySelector('[data-testid="phases-save-all"]')!);
    await tick();

    expect(saveDraftHelper).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'phase',
      id: 'concurrent-phase',
      body: expect.objectContaining({ name: 'Dirty draft' })
    }));
    const retry = container.querySelector('[data-testid="phases-save-all"]') as HTMLButtonElement;
    await vi.waitFor(() => expect(retry.disabled).toBe(false));
    await fireEvent.click(retry);
    await tick();
    // Feature 101 (T030) — the retry used to be asserted as a whole layer: the
    // concurrently inserted row, then the preserved draft, then the concurrently
    // edited sibling, in projection order. That assertion existed because the
    // rebase had to fold the operator's edit back into rows it would otherwise
    // republish stale. A draft write names one definition, so the rebase has
    // nothing to fold and the two concurrent rows are simply not in the payload.
    // What survives — and is the only part that was ever about this test's
    // subject — is that the preserved edit is what gets retried.
    expect(saveDraftHelper).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: 'phase',
      id: 'concurrent-phase',
      body: expect.objectContaining({ name: 'Dirty draft' })
    }));
    const retried = vi.mocked(saveDraftHelper).mock.calls[1][0] as { body: unknown };
    expect(retried.body).not.toMatchObject({ id: 'inserted-phase' });
    expect(retried.body).not.toMatchObject({ id: 'sibling-phase' });
  });

  it('accepts a newer authoritative revision when the acknowledged revision was skipped', async () => {
    const phase: PhaseDefinition = Object.freeze({
      id: 'fast-phase', name: 'Original', version: 1, instruction: 'Run.'
    });
    // Feature 101 (T030) — the ack used to carry the revision it had written, and
    // this test resolved it with a revision already overtaken by `later-revision`.
    // Lifecycle acks carry no revision at all, so "the acknowledged revision was
    // skipped" is now the only case there is: the editor settles on the projection
    // moving, whatever the ack says, which is exactly what is asserted below.
    let resolveSave!: (result: { status: 'accepted' }) => void;
    vi.mocked(saveDraftHelper).mockImplementationOnce(() => new Promise((resolve) => {
      resolveSave = resolve;
    }));
    const initial = buildSnapshot([phase]);
    const { container, rerender } = render(PipelineBuilder, {
      props: { snapshot: initial, initialTab: 'phases' }
    });
    await fireEvent.click(container.querySelector(
      '[data-testid="phases-list-item-fast-phase"]'
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
        revision: 'later-revision'
      }
    } as WorkflowSnapshot;
    await rerender({ snapshot: later, initialTab: 'phases' });
    resolveSave({ status: 'accepted' });
    await vi.waitFor(() => expect(container.textContent).not.toContain('Saving…'));
    expect(container.textContent).toContain('Later authoritative edit');
  });

  it('edits the selected row when two stored rows claim one Phase id', async () => {
    // Feature 099 (T496f, FR-042, FR-043) — this seeded the id twice across two
    // layers, one `shadowed` behind the other, and asked which the editor saved.
    // Two rows can still claim one id in a single catalog; what changed is the
    // verdict — neither wins, both resolve `invalid` — and the question the
    // editor answers is unchanged: the operator selected a row, and that row is
    // the one the edit lands on. `key` is what tells them apart now.
    const phase: PhaseDefinition = Object.freeze({
      id: 'shared', name: 'Second row', version: 2, instruction: 'Run.'
    });
    const base = buildSnapshot([phase]);
    const record = base.phaseCatalog!.records[0];
    const definition = record.definition!;
    const snapshot = {
      ...base,
      phaseCatalog: {
        ...base.phaseCatalog!,
        records: [
          {
            key: 'shared::0', phaseId: 'shared', status: 'invalid' as const,
            definition: { ...definition, name: 'First row' },
            display: { ...definition, name: 'First row' }, errors: []
          },
          { ...record, key: 'shared::1', status: 'invalid' as const }
        ]
      }
    } as WorkflowSnapshot;
    const { container } = render(PipelineBuilder, { props: { snapshot, initialTab: 'phases' } });
    const rows = container.querySelectorAll('[data-testid="phases-list-item-shared"]');
    expect(rows).toHaveLength(2);
    await fireEvent.click(rows[1]!);
    await fireEvent.input(container.querySelector(
      '[data-testid="phases-name-field-shared"]'
    )!, { target: { value: 'Second row edited' } });
    await fireEvent.click(container.querySelector('[data-testid="phases-save-all"]')!);
    await tick();

    expect(saveDraftHelper).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'phase',
      id: 'shared',
      body: expect.objectContaining({ id: 'shared', name: 'Second row edited' })
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
    expect(saveDraftHelper).not.toHaveBeenCalled();
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
    await fireEvent.click(container.querySelector('[data-testid="phases-list-item-p-unavailable"]')!);
    const runner = container.querySelector('[data-testid="phases-runner-p-unavailable"]') as HTMLSelectElement;
    const model = container.querySelector('[data-testid="phases-model-p-unavailable"]') as HTMLSelectElement;
    expect(runner.value).toBe('agy');
    expect(runner.selectedOptions[0]?.textContent).toContain('Unavailable');
    expect(model.value).toBe('agy-operator-model');
    expect(model.selectedOptions[0]?.textContent).toContain('Unavailable');
  });

  // Feature 083 added the Workflows tab; the Workflow Library has no other
  // mount site, so the tab bar is 4-wide from this feature forward.
  it('renders the 4-tab bar: Phases, Pipelines, Workflows, Models', () => {
    const snap = buildSnapshot();
    const { container } = render(PipelineBuilder, { props: { snapshot: snap } });
    const tabs = [...container.querySelectorAll('.tab-btn')].map((t) => t.textContent?.trim());
    expect(tabs).toEqual(['Phases', 'Pipelines', 'Workflows', 'Models']);
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
      .toBe('builder-tab-pipelines');
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

  it('targets the persisted identity when Raw JSON repairs a malformed id', async () => {
    const base = buildSnapshot();
    const snapshot = {
      ...base,
      phaseCatalog: {
        ...base.phaseCatalog!,
        records: [{
          key: 'INVALID::0', phaseId: 'INVALID',
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
      '[data-testid="phases-list-item-INVALID"]'
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
    // Feature 101 (T030) — the mutation addressed the row by the id it had BEFORE
    // the repair while the payload carried the new one, because a whole-layer
    // write needed to say which existing row it was replacing. A draft write
    // addresses the definition it writes, so the repaired id is both the address
    // and the body: repairing an id writes a new definition rather than renaming
    // the broken one, and that is the behaviour this now pins.
    expect(saveDraftHelper).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'phase',
      id: 'repaired-id',
      body: expect.objectContaining({ id: 'repaired-id' })
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

  // Feature 096 T025 — the Model Catalog import trigger. Unmounted on every
  // other tab, same as the per-tab save affordances above: it must not be
  // reachable before the Models tab is active.
  //
  // Feature 101 (US6, T065) — the pre-switch assertion used to be "no preflight
  // at all", which held only because this fixture opens on Pipelines and that
  // tab had no import entry. It has one now: an empty catalog renders the shared
  // front door, and the front door offers the import (FR-032). The claim the
  // test is actually for survives intact — each tab mounts exactly one entry
  // point and unmounts it with the tab — so that is what it asserts.
  it('Models tab: mounts the Model Catalog import entry point', async () => {
    const snap = buildSnapshot([], [], ['claude-sonnet-4-6']);
    // Feature 180 (T1555, FR-004) — the assertions before the switch describe
    // the tab this starts on, so the start is pinned rather than inherited.
    const { container } = render(PipelineBuilder, {
      props: { snapshot: snap, initialTab: 'pipelines' }
    });
    expect(container.querySelectorAll('[data-testid="process-import-preflight"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="catalog-empty-state-pipeline"]')).not.toBeNull();
    await switchTab(container, 'Models');
    expect(container.querySelector('[data-testid="catalog-empty-state-pipeline"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="process-import-preflight"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="process-import-inspect"]')).not.toBeNull();
  });

  // Feature 082 — saves are mutation-scoped: the operator declares a change,
  // and only that change is submitted against the adopted layer revision. A
  // Save click with nothing declared is inert (FR-029).
  it('Pipelines tab: save is inert until a mutation is declared', async () => {
    vi.mocked(saveDraftHelper).mockClear();
    const pipeline: PipelineDefinition = Object.freeze({
      id: 'custom',
      name: 'Custom Pipeline',
      phases: Object.freeze(['speckit-specify', 'speckit-plan'])
    }) as unknown as PipelineDefinition;
    const snap = buildSnapshot([], [pipeline]);
    const { container } = render(PipelineBuilder, {
      props: { snapshot: snap, initialTab: 'pipelines' }
    });
    await tick();
    const saveBtn = container.querySelector(
      '[data-testid="pipelines-save-all"]'
    ) as HTMLButtonElement | null;
    expect(saveBtn).not.toBeNull();
    await fireEvent.click(saveBtn!);
    await tick();
    expect(saveDraftHelper).not.toHaveBeenCalled();
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
    vi.mocked(saveDraftHelper).mockClear();
    const pipeline: PipelineDefinition = Object.freeze({
      id: 'custom',
      name: 'Custom Pipeline',
      phases: Object.freeze(['speckit-specify'])
    }) as unknown as PipelineDefinition;
    const snap = buildSnapshot([], [pipeline]);
    const { container } = render(PipelineBuilder, {
      props: { snapshot: snap, initialTab: 'pipelines' }
    });
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

    expect(saveDraftHelper).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveDraftHelper).mock.calls[0][0]).toEqual({
      kind: 'pipeline',
      id: 'custom',
      // The fixture record carries no draft, so the staleness token is the
      // sentinel rather than a version id (FR-024).
      expectedDraftVersion: 'no-draft',
      body: { id: 'custom', name: 'Renamed Pipeline', version: 1, phases: ['speckit-specify'] }
    });
  });
});

describe('PipelineBuilder — Feature 026 per-phase Effort + runner overrides', () => {
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
    }> = {}
  ): Promise<{ container: HTMLElement }> {
    const seeded = {
      ...p,
      ...(extra.effort ? { effort: extra.effort } : {}),
      ...(extra.model ? { model: extra.model } : {}),
      ...(extra.runner ? { runner: extra.runner } : {})
    } as PhaseDefinition;
    const snap = buildSnapshot([seeded], [], ['claude-sonnet-4-6', 'claude-opus-4-6']);
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

  it('saves with the chosen Effort by routing through the draft-write helper', async () => {
    vi.mocked(saveDraftHelper).mockClear();
    const { container } = await openPhasesEditorForPlan();
    const select = container.querySelector(
      '[data-testid="phases-effort-speckit-plan"]'
    ) as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: 'high' } });
    await tick();
    const saveBtn = container.querySelector('[data-testid="phases-save-all"]') as HTMLButtonElement;
    await fireEvent.click(saveBtn);
    await tick();
    expect(saveDraftHelper).toHaveBeenCalledTimes(1);
    expect(savedBody()).toMatchObject({ id: 'speckit-plan', effort: 'high' });
  });

  it('preserves the deprecated loopable field during structured saves', async () => {
    vi.mocked(saveDraftHelper).mockClear();
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

    expect(savedBody()).toMatchObject({ id: 'speckit-plan', loopable: true });
  });

  it('defaults legacy phases to Required and saves an explicit optional choice', async () => {
    vi.mocked(saveDraftHelper).mockClear();
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

    expect(savedBody()).toMatchObject({ id: 'speckit-plan', isRequired: false });
  });

  it('renders and saves every supported runner through the shared helper', async () => {
    vi.mocked(saveDraftHelper).mockClear();
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

    expect(savedBody()).toMatchObject({ id: 'speckit-plan', runner: 'agy' });
  });

  it('does not restrict runners on a Phase named for a former built-in', async () => {
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
    'does not restrict runners for the once-restricted id %s',
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
    vi.mocked(saveDraftHelper).mockClear();
    const { container } = await openPhasesEditor(phase, { runner: 'codex' });
    const select = container.querySelector(
      '[data-testid="phases-runner-speckit-plan"]'
    ) as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: '' } });
    await fireEvent.click(
      container.querySelector('[data-testid="phases-save-all"]') as HTMLButtonElement
    );
    await tick();

    expect(savedBody().runner).toBeUndefined();
  });

  it.each([
    ['a declared runner', 'agy' as const],
    ['an inherited runner', undefined]
  ])('shows the runner the row itself declares and no badge beside it (%s)', async (_case, runner) => {
    // Feature 099 (T496f, FR-041) — three cases here read a
    // `phases-runner-precedence-*` badge naming the layer whose `runner` won,
    // and a fourth pinned its absence when the winning row inherited. The badge
    // is deleted with the tier: precedence answered "which layer won", and one
    // layer answers it by existing. The question survives in the only form the
    // surface still allows — can anything but the row's own declaration reach
    // the runner control — and the answer is now structural, so both a declared
    // runner and an inherited one are asserted against the same absent badge.
    const { container } = await openPhasesEditor(phase, runner ? { runner } : {});
    const select = container.querySelector(
      '[data-testid="phases-runner-speckit-plan"]'
    ) as HTMLSelectElement;
    expect(select.value).toBe(runner ?? '');
    expect(
      container.querySelector('[data-testid="phases-runner-precedence-speckit-plan"]')
    ).toBeNull();
  });



  it('Inherit option submits the row with effort omitted (not null, not empty string)', async () => {
    vi.mocked(saveDraftHelper).mockClear();
    const { container } = await openPhasesEditor(phase, { effort: 'high' });
    const select = container.querySelector(
      '[data-testid="phases-effort-speckit-plan"]'
    ) as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: '' } });
    await tick();
    const saveBtn = container.querySelector('[data-testid="phases-save-all"]') as HTMLButtonElement;
    await fireEvent.click(saveBtn);
    await tick();
    expect(saveDraftHelper).toHaveBeenCalledTimes(1);
    expect(savedBody()).toMatchObject({ id: 'speckit-plan' });
    expect(savedBody().effort).toBeUndefined();
  });

  it('FR-003 orthogonality: changing Effort does not clear an existing Model override', async () => {
    vi.mocked(saveDraftHelper).mockClear();
    const { container } = await openPhasesEditor(phase, { model: 'claude-sonnet-4-6' });
    const effort = container.querySelector(
      '[data-testid="phases-effort-speckit-plan"]'
    ) as HTMLSelectElement;
    await fireEvent.change(effort, { target: { value: 'high' } });
    await tick();
    const saveBtn = container.querySelector('[data-testid="phases-save-all"]') as HTMLButtonElement;
    await fireEvent.click(saveBtn);
    await tick();
    expect(savedBody()).toMatchObject({
      id: 'speckit-plan',
      effort: 'high',
      model: 'claude-sonnet-4-6'
    });
  });

  it('FR-003 orthogonality: choosing Inherit for Effort leaves an existing Model override intact', async () => {
    vi.mocked(saveDraftHelper).mockClear();
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
    expect(savedBody()).toMatchObject({ id: 'speckit-plan', model: 'claude-sonnet-4-6' });
    expect(savedBody().effort).toBeUndefined();
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

    // 4. Check what the append affordance offers. Feature 184 (T038) — the
    //    `<select>` + "Add Phase" pair became the palette, one button per
    //    effective Phase, so the offer is read off the buttons that render.
    const offered = Array.from(
      container.querySelectorAll('[data-testid^="pipelines-palette-phase-"]')
    ).map((button) => button.getAttribute('data-testid'));

    // An unsaved draft must not be offered to a persistable Pipeline.
    expect(offered).toContain('pipelines-palette-phase-speckit-specify');
    expect(offered).not.toContain('pipelines-palette-phase-new-phase');

    // 5. Also check the sequence select for the existing pipeline phase, which
    //    moved to the inspector and exists for the selected position (T037).
    await fireEvent.click(
      container.querySelector('[data-testid="pipelines-phase-card-0"]') as HTMLButtonElement
    );
    await tick();
    const sequenceSelect = container.querySelector(
      '[data-testid="pipelines-phase-select-0"]'
    ) as HTMLSelectElement;
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
    // Feature 184 (T038) — re-read the palette rather than the node captured
    // before the refresh: the offer is what the surface renders *now*.
    expect(
      Array.from(container.querySelectorAll('[data-testid^="pipelines-palette-phase-"]')).map(
        (button) => button.getAttribute('data-testid')
      )
    ).toContain('pipelines-palette-phase-new-phase');
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

  it('saves the moved row after a reorder, the list order being the store\'s to keep', async () => {
    const container = await renderPhasesList();
    await fireEvent.click(container.querySelector(
      '[data-testid="phases-move-down-phase-a"]'
    )!);
    await fireEvent.click(container.querySelector('[data-testid="phases-save-all"]')!);
    await tick();

    // Feature 101 (T030) — this asserted the reordered layer travelled as one
    // atomic write: `phase-b`, `phase-a`, `phase-c`, in that order. It could,
    // because the write WAS the layer and the array's order was the catalog's
    // order. A draft write names one definition, and the order definitions are
    // listed in belongs to the store's manifest (FR-002, FR-018), which no
    // lifecycle command reorders. So the reorder is a view arrangement, and what
    // the save persists is the moved row's body.
    expect(saveDraftHelper).toHaveBeenCalledTimes(1);
    expect(saveDraftHelper).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'phase',
      id: 'phase-a',
      body: expect.objectContaining({ id: 'phase-a' })
    }));
  });

  it('reorders any two adjacent rows, there being no boundary left to cross', async () => {
    // Feature 099 (T496f, FR-042) — this seeded `phase-a` at `user` and
    // `phase-b` at `workspace` and pinned both move controls DISABLED: a reorder
    // is one save against one layer, so a pair straddling two layers had no
    // single save to express it. One layer removes the straddle, and the
    // inversion is the point — the same fixture that could not move must now
    // move, or the controls are dead for a reason nothing states.
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot([phaseA, phaseB]), initialTab: 'phases' }
    });
    const moveDown = container.querySelector(
      '[data-testid="phases-move-down-phase-a"]'
    ) as HTMLButtonElement;
    const moveUp = container.querySelector(
      '[data-testid="phases-move-up-phase-b"]'
    ) as HTMLButtonElement;
    expect(moveDown.disabled).toBe(false);
    expect(moveUp.disabled).toBe(false);
    await fireEvent.click(moveDown);
    await tick();
    expect(getPhaseIds(container)).toEqual(['phase-b', 'phase-a']);
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
      props: { snapshot: buildSnapshot([], [REMOVABLE]), initialTab: 'pipelines' }
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
    vi.mocked(deactivateHelper).mockClear();
    vi.mocked(useConfirm).mockClear();
  });

  // Feature 100 (T509b, FR-049) — the prompt is raised by `deactivateDefinition`,
  // which is the only function that can post the command it authorises. What the
  // Pipelines tab still owns is everything the prompt needs in order to name the
  // right row and return focus to the control that opened it.
  it('submits one removal, addressed by id, carrying what the prompt must say', async () => {
    const { deleteBtn } = await openDeleteControl();

    await fireEvent.click(deleteBtn);
    await tick();

    expect(deactivateHelper).toHaveBeenCalledTimes(1);
    // Feature 101 (T030) — `toEqual` on both arguments is exact. The empty
    // `pipelines: []` that stood here was the removal itself, an omission from a
    // republished layer; a deactivation names the definition and carries no rows.
    expect(deactivateHelper).toHaveBeenCalledWith(
      {
        kind: 'pipeline',
        id: 'custom',
        // The fixture record carries no draft, so the staleness token is the
        // sentinel rather than a version id (FR-024).
        expectedDraftVersion: 'no-draft'
      },
      { definitionName: 'Custom Pipeline', originatingElement: deleteBtn }
    );
  });

  it('asks nothing itself, so one removal cannot prompt twice', async () => {
    const { deleteBtn } = await openDeleteControl();

    await fireEvent.click(deleteBtn);
    await tick();

    expect(useConfirm).not.toHaveBeenCalled();
  });

  it('settles without an error when the operator declines', async () => {
    vi.mocked(deactivateHelper).mockResolvedValueOnce({
      status: 'rejected' as const,
      reason: 'declined'
    });
    const { container, deleteBtn } = await openDeleteControl();

    await fireEvent.click(deleteBtn);
    await tick();
    await tick();

    // Nothing was sent and nothing failed, so there is no rejection to report —
    // and the row stays selected with its delete control live.
    expect(container.querySelector('[data-testid="save-error-banner"]')).toBeNull();
    expect(
      (container.querySelector('[data-testid="pipelines-remove"]') as HTMLButtonElement).disabled
    ).toBe(false);
  });
});

// Feature 184 (FR-R3-141, T031a/T031b/T031c) — the three claims the per-component
// suites structurally cannot make, because each one is about the assembled
// surface driven through the real `PipelineCatalogStore`.
//
// They live in this file rather than a new one because this is where the harness
// for that already is: `buildSnapshot` builds the catalog projection the store
// adopts, and `savedBody`/`saveDraftHelper` observe what actually left. A new
// file would have to copy both to say anything.
describe('PipelineBuilder — Pipeline canvas behaviour (Feature 184)', () => {
  const SPECIFY: PhaseDefinition = Object.freeze({
    id: 'speckit-specify', name: 'Specify', version: 1, instruction: 'Specify.'
  }) as unknown as PhaseDefinition;
  const PLAN: PhaseDefinition = Object.freeze({
    id: 'speckit-plan', name: 'Plan', version: 1, instruction: 'Plan.'
  }) as unknown as PhaseDefinition;
  const CUSTOM: PipelineDefinition = Object.freeze({
    id: 'custom',
    name: 'Custom Pipeline',
    phases: Object.freeze(['speckit-specify'])
  }) as unknown as PipelineDefinition;

  /** Renders the Pipelines tab on a two-Phase catalog and opens the stored row. */
  async function openCanvas(): Promise<HTMLElement> {
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot([SPECIFY, PLAN], [CUSTOM]), initialTab: 'pipelines' }
    });
    await tick();
    await fireEvent.click(container.querySelector('.phase-list-item') as HTMLButtonElement);
    await tick();
    return container;
  }

  const at = (container: HTMLElement, id: string) =>
    container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

  /** The single button carrying this exact accessible name. Undo and Redo have no test id. */
  function byLabel(container: HTMLElement, label: string): HTMLButtonElement {
    const found = (Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]).filter(
      (button) => button.textContent.trim() === label
    );
    expect(found).toHaveLength(1);
    return found[0];
  }

  it('T031a: Undo reverts the row and Redo returns it, across panes', async () => {
    const container = await openCanvas();
    const name = () => at(container, 'pipelines-name-field-custom') as HTMLInputElement;

    expect(name().value).toBe('Custom Pipeline');
    await fireEvent.input(name(), { target: { value: 'Renamed Pipeline' } });
    await tick();
    expect(name().value).toBe('Renamed Pipeline');

    // The assertion is on the *row*, not on the buttons. T027 proves Undo and
    // Redo render with the right disabled bounds, which stays true if the
    // handlers no longer reach the store's history at all — the exact shape a
    // literal port takes when it carries the markup and drops the wiring.
    await fireEvent.click(byLabel(container, 'Undo'));
    await tick();
    expect(name().value).toBe('Custom Pipeline');

    await fireEvent.click(byLabel(container, 'Redo'));
    await tick();
    expect(name().value).toBe('Renamed Pipeline');
  });

  it('T031b: a stored Pipeline is editable in place, on the canvas and in the inspector', async () => {
    vi.mocked(saveDraftHelper).mockClear();
    const container = await openCanvas();

    // The canvas-side edit is the sequence: FR-010 retired the header's name
    // input, so the name is now only authorable in the inspector and the two
    // edits below are one from each pane.
    await fireEvent.click(at(container, 'pipelines-palette-phase-speckit-plan') as HTMLElement);
    await tick();
    await fireEvent.input(at(container, 'pipelines-name-field-custom') as HTMLInputElement, {
      target: { value: 'Renamed Pipeline' }
    });
    await tick();

    await fireEvent.click(at(container, 'pipelines-save-all') as HTMLButtonElement);
    await tick();

    // Both reached the store, so neither pane is read-only for a stored row.
    expect(saveDraftHelper).toHaveBeenCalledTimes(1);
    expect(savedBody()).toEqual({
      id: 'custom',
      name: 'Renamed Pipeline',
      version: 1,
      phases: ['speckit-specify', 'speckit-plan']
    });
  });

  it('T031b: nothing but the ID field is gated on `persisted`', async () => {
    const container = await openCanvas();
    const id = at(container, 'pipelines-id-field-custom') as HTMLInputElement;

    // T019 proves the ID field is read-only when persisted, which is true under
    // both the Pipeline rule (identity is frozen, the body is not) and the
    // Workflow rule (a stored row is read-only outright). Only the pairing tells
    // them apart: under the Workflow rule every assertion below flips.
    expect(id.readOnly).toBe(true);
    expect((at(container, 'pipelines-name-field-custom') as HTMLInputElement).readOnly).toBe(false);
    expect((at(container, 'pipelines-description-custom') as HTMLTextAreaElement).readOnly).toBe(
      false
    );
    for (const control of [
      'pipelines-save-all',
      'pipelines-remove',
      'pipelines-duplicate',
      'pipelines-discard',
      'pipelines-palette-phase-speckit-plan',
      'pipelines-remove-phase-0'
    ]) {
      expect((at(container, control) as HTMLButtonElement).disabled).toBe(false);
    }
  });

  // T031c. Every leg is a forward walk over the surface's own tab order, so an
  // element that is disabled, carries `tabindex="-1"`, or is not focusable at all
  // is unreachable and the walk throws. Per-control assertions all pass while one
  // element stays untabbable, and that element is what T1548's acceptance line —
  // "every add, reorder, and remove operable from the keyboard alone" — is about.
  const TABBABLE = 'a[href], button, input, select, textarea, [tabindex]';

  function tabUntil(container: HTMLElement, testId: string): HTMLElement {
    const order = (Array.from(container.querySelectorAll(TABBABLE)) as HTMLElement[]).filter(
      (element) =>
        !(element as HTMLButtonElement).disabled &&
        element.getAttribute('tabindex') !== '-1' &&
        element.getAttribute('aria-hidden') !== 'true'
    );
    const from = order.indexOf(document.activeElement as HTMLElement);
    for (let index = from + 1; index < order.length; index++) {
      order[index].focus();
      if (order[index].dataset.testid === testId) return order[index];
    }
    throw new Error(`"${testId}" is not reachable by Tab (${order.length} stops walked)`);
  }

  it('T031c: add, select, reorder and remove are all reachable by Tab alone', async () => {
    const container = await openCanvas();
    // Each leg restarts the walk: a click re-renders the canvas and detaches the
    // node that had focus, so continuing from a stale `activeElement` would prove
    // nothing. Restarting keeps every leg's claim intact — "reachable by Tab".
    const leg = (testId: string) => {
      (document.activeElement as HTMLElement | null)?.blur();
      return tabUntil(container, testId);
    };
    // jsdom does not synthesise the click a browser fires when Enter lands on a
    // focused native button, so the walk proves reachability and the click stands
    // in for the platform's own activation.
    const press = async (testId: string) => {
      await fireEvent.click(leg(testId));
      await tick();
    };

    await press('pipelines-palette-phase-speckit-plan');
    expect(at(container, 'pipelines-phase-card-1')).not.toBeNull();

    await press('pipelines-phase-card-1');
    expect(at(container, 'pipelines-phase-select-1')).not.toBeNull();

    await press('pipelines-move-phase-up-1');
    expect(at(container, 'pipelines-phase-id-0')?.textContent.trim()).toBe('speckit-plan');

    await press('pipelines-remove-phase-0');
    expect(at(container, 'pipelines-phase-card-1')).toBeNull();
    expect(at(container, 'pipelines-phase-id-0')?.textContent.trim()).toBe('speckit-specify');
  });
});
