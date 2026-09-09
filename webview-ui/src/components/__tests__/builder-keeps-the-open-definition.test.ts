// BUG-002 (101) — a save must not close the definition it just saved.
//
// The three Builder tabs adopt the host's projection when the catalog revision
// moves, and each one dropped the operator's selection as part of that adopt.
// The revision moves on every lifecycle write — a draft save, a publish, a
// discard, a deactivation — and on a write from another window, so the surface
// the operator was working in closed underneath them each time.
//
// The Publish control makes it circular rather than merely irritating: it lives
// in `DefinitionLifecyclePanel`, which mounts inside the selection-gated pane.
// Saving a draft therefore removed the only control that could publish it.
//
// Every case below is "the definition that was open is still open", asserted on
// the pane that only renders for a selected row. None of them assert the
// selection is *editable* afterwards — that is FR-026's separate question and
// the three tabs answer it differently.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PipelineBuilder from '../PipelineBuilder.svelte';
import WorkflowCatalogEditor from '../PipelineBuilderEditors/WorkflowCatalogEditor.svelte';
import type {
  PhaseDefinition,
  PipelineDefinition,
  WorkflowCatalogSourceProjection,
  WorkflowSnapshot
} from '../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../lib/snapshot-types';

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'corr-test' }))
}));
vi.mock('../../lib/snapshot-store.svelte', () => ({
  snapshotStore: { markPending: vi.fn(), onceAck: vi.fn() }
}));
vi.mock('../../lib/catalog-lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/catalog-lifecycle')>()),
  saveDefinitionDraft: vi.fn(async () => ({ status: 'accepted' as const })),
  deactivateDefinition: vi.fn(async () => ({ status: 'accepted' as const }))
}));
vi.mock('../../lib/save-models', () => ({
  saveModels: vi.fn(async () => ({ status: 'accepted' as const }))
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const PHASE: PhaseDefinition = Object.freeze({
  id: 'open-phase',
  name: 'Open Phase',
  version: 1,
  instruction: 'Run.'
});

const PIPELINE: PipelineDefinition = Object.freeze({
  id: 'open-pipeline',
  name: 'Open Pipeline',
  phases: ['open-phase']
});

/**
 * A Builder snapshot at a named revision.
 *
 * Both catalogs carry the same revision string, so a case can move one kind's
 * projection without the other tab adopting for a reason the case did not set
 * up. `key` is `${id}::0` — the projection's own shape, and the value the fixed
 * re-selection matches on first.
 */
function buildSnapshot(revision: string, phaseName = PHASE.name): WorkflowSnapshot {
  const phase = {
    phaseId: PHASE.id,
    name: phaseName,
    version: 1,
    instruction: PHASE.instruction
  };
  const pipeline = {
    pipelineId: PIPELINE.id,
    name: PIPELINE.name,
    version: 1,
    phaseIds: [...PIPELINE.phases],
    inputs: [],
    outputs: [],
    bindings: [],
    recommendedNext: []
  };
  return {
    schemaVersion: 4,
    isPrimary: true,
    workspaceTrust: true,
    resolvedTrust: { phases: true, retryConditions: true },
    queues: [],
    queue: { orderedItems: [], inFlight: null, pending: [], recent: [], paused: false },
    auditTail: [],
    monitor: null,
    history: [],
    producedAt: '2026-09-08T00:00:00.000Z',
    availablePipelines: [PIPELINE],
    availablePhases: [{ ...PHASE, name: phaseName }],
    availableModels: { claude: [], codex: [], agy: [] },
    configuredModels: { claude: [], codex: [], agy: [] },
    availableBackends: ['claude', 'codex', 'agy'],
    phaseCatalog: {
      state: 'ready',
      records: [
        {
          key: `${PHASE.id}::0`,
          phaseId: PHASE.id,
          status: 'effective',
          definition: phase,
          display: phase,
          errors: []
        }
      ],
      effective: [phase],
      revision,
      warnings: []
    },
    pipelineCatalog: {
      state: 'ready',
      records: [
        {
          key: `${PIPELINE.id}::0`,
          pipelineId: PIPELINE.id,
          status: 'effective',
          definition: pipeline,
          display: pipeline,
          errors: []
        }
      ],
      effective: [pipeline],
      revision,
      warnings: []
    },
    generalSettings: IDLE_GENERAL_SETTINGS
  } as unknown as WorkflowSnapshot;
}

describe('BUG-002 (101) — the Phases tab keeps the open Phase across an adopt', () => {
  it('leaves the saved Phase open, so its Publish control is still reachable', async () => {
    const { container, rerender } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot('rev-1'), initialTab: 'phases' }
    });
    await fireEvent.click(
      container.querySelector('[data-testid="phases-list-item-open-phase"]')!
    );
    await fireEvent.input(
      container.querySelector('[data-testid="phases-name-field-open-phase"]')!,
      { target: { value: 'Edited name' } }
    );
    await fireEvent.click(container.querySelector('[data-testid="phases-save-all"]')!);
    await tick();

    // The write landed and the store's projection moved with it.
    await rerender({ snapshot: buildSnapshot('rev-2', 'Edited name'), initialTab: 'phases' });
    await vi.waitFor(() =>
      expect(container.textContent).not.toContain('Saving…')
    );

    expect(
      container.querySelector('[data-testid="phases-editor-open-phase"]')
    ).not.toBeNull();
  });

  it('keeps the open Phase across a revision move it did not cause', async () => {
    // The publish, discard and deactivate paths all reach here: they move the
    // revision without declaring a mutation, so this is also what a write from
    // another window does to a row the operator has open.
    const { container, rerender } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot('rev-1'), initialTab: 'phases' }
    });
    await fireEvent.click(
      container.querySelector('[data-testid="phases-list-item-open-phase"]')!
    );
    expect(
      container.querySelector('[data-testid="phases-editor-open-phase"]')
    ).not.toBeNull();

    await rerender({ snapshot: buildSnapshot('rev-2'), initialTab: 'phases' });
    await tick();

    expect(
      container.querySelector('[data-testid="phases-editor-open-phase"]')
    ).not.toBeNull();
  });

  it('closes the pane when the open Phase is gone from the projection', async () => {
    // The containment case. Re-selection is by identity, so a definition the
    // projection no longer carries must not come back selected.
    const { container, rerender } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot('rev-1'), initialTab: 'phases' }
    });
    await fireEvent.click(
      container.querySelector('[data-testid="phases-list-item-open-phase"]')!
    );
    const emptied = buildSnapshot('rev-2');
    const removed = {
      ...emptied,
      phaseCatalog: { ...emptied.phaseCatalog!, records: [], effective: [] }
    } as WorkflowSnapshot;

    await rerender({ snapshot: removed, initialTab: 'phases' });
    await tick();

    expect(container.querySelector('[data-testid="phases-editor-open-phase"]')).toBeNull();
  });
});

describe('BUG-002 (101) — the Pipelines tab keeps the open Pipeline across an adopt', () => {
  it('leaves the saved Pipeline open', async () => {
    const { container, rerender } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot('rev-1'), initialTab: 'pipelines' }
    });
    await fireEvent.click(
      container.querySelector('[data-testid="pipelines-list-item-open-pipeline"]')!
    );
    await fireEvent.input(
      container.querySelector('[data-testid="pipelines-name-field-open-pipeline"]')!,
      { target: { value: 'Edited pipeline' } }
    );
    await fireEvent.click(container.querySelector('[data-testid="pipelines-save-all"]')!);
    await tick();

    await rerender({ snapshot: buildSnapshot('rev-2'), initialTab: 'pipelines' });
    await tick();

    expect(container.querySelector('[data-testid="pipelines-inspector"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="pipelines-topbar-name"]')?.textContent)
      .toContain('Open Pipeline');
  });

  it('keeps the open Pipeline across a revision move it did not cause', async () => {
    const { container, rerender } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot('rev-1'), initialTab: 'pipelines' }
    });
    await fireEvent.click(
      container.querySelector('[data-testid="pipelines-list-item-open-pipeline"]')!
    );
    expect(container.querySelector('[data-testid="pipelines-inspector"]')).not.toBeNull();

    await rerender({ snapshot: buildSnapshot('rev-2'), initialTab: 'pipelines' });
    await tick();

    expect(container.querySelector('[data-testid="pipelines-inspector"]')).not.toBeNull();
  });
});

// ── The Workflows tab, which selects by key rather than by index ─────────────

const WORKFLOW_NODES = [{ nodeId: 'build', pipelineId: 'build-it' }];

function workflowRecord(
  overrides: Partial<WorkflowCatalogSourceProjection> = {}
): WorkflowCatalogSourceProjection {
  const workflowId = overrides.workflowId ?? 'open-workflow';
  return {
    key: `${workflowId}::0`,
    workflowId,
    status: 'effective',
    definition: {
      workflowId,
      name: 'Open Workflow',
      description: 'Build it.',
      version: 1,
      nodes: WORKFLOW_NODES,
      connections: [],
      startNodeIds: ['build']
    },
    display: {},
    errors: [],
    derivedInputs: [],
    derivedOutputs: [],
    ...overrides
  } as WorkflowCatalogSourceProjection;
}

function workflowSnapshot(
  records: readonly WorkflowCatalogSourceProjection[],
  revision: string
): WorkflowSnapshot {
  return {
    isPrimary: true,
    availableBackends: ['claude'],
    availableModels: { claude: ['model-a'], codex: [], agy: [] },
    availablePipelines: [{ id: 'build-it', name: 'Build It', phases: ['done'] }],
    pipelineCatalog: {
      state: 'ready',
      records: [],
      effective: [{ pipelineId: 'build-it', name: 'Build It', version: 1, phaseIds: ['done'] }],
      revision: 'p',
      warnings: []
    },
    workflowCatalog: { state: 'ready', records, effective: [], revision, warnings: [] }
  } as unknown as WorkflowSnapshot;
}

describe('BUG-002 (101) — the Workflows tab keeps the open Workflow across an adopt', () => {
  it('leaves the stored Workflow open when the projection re-keys it', async () => {
    // The Workflow editor selects by `sourceKey`, and a record's key carries its
    // position in the manifest listing. A sibling published ahead of the open row
    // re-keys it from `::0` to `::1`, which is the same identity the operator is
    // looking at and a key their selection no longer matches.
    const { container, rerender } = render(WorkflowCatalogEditor, {
      snapshot: workflowSnapshot([workflowRecord()], 'rev-1'),
      trusted: true
    });
    await fireEvent.click(
      container.querySelector('[data-testid="workflows-list-item-open-workflow"]')!
    );
    expect(container.querySelector('[data-testid="workflows-no-selection"]')).toBeNull();

    await rerender({
      snapshot: workflowSnapshot(
        [
          workflowRecord({ workflowId: 'newcomer', key: 'newcomer::0' }),
          workflowRecord({ key: 'open-workflow::1' })
        ],
        'rev-2'
      ),
      trusted: true
    });
    await tick();

    expect(container.querySelector('[data-testid="workflows-no-selection"]')).toBeNull();
  });

  it('closes the canvas when the open Workflow is gone from the projection', async () => {
    const { container, rerender } = render(WorkflowCatalogEditor, {
      snapshot: workflowSnapshot([workflowRecord()], 'rev-1'),
      trusted: true
    });
    await fireEvent.click(
      container.querySelector('[data-testid="workflows-list-item-open-workflow"]')!
    );

    await rerender({ snapshot: workflowSnapshot([], 'rev-2'), trusted: true });
    await tick();

    expect(container.querySelector('[data-testid="workflows-no-selection"]')).not.toBeNull();
  });
});
