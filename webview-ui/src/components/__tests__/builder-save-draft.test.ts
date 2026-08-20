// Feature 101 (FR-R3-017) T020-T024 — a Builder save writes a DRAFT.
//
// This is the feature's headline behaviour and the one test file that pins it at
// the surface. Before this, all three editors answered every save with
// `publishDefinitionPackage` over the whole layer: editing one Phase's name made
// it live, and manufactured a fresh version of every other Phase in the catalog
// as a side effect. `deriveDefinitionState` could therefore only ever return
// `'active'` from the UI, which is why every other story in this feature had
// nothing to render.
//
// The assertions here are deliberately about the DISPATCH and not about the
// wrapper that made it: the mock seam is `lib/catalog-lifecycle.ts`, the single
// sender pinned by `tests/lint/catalog-lifecycle-dispatch.test.ts`. A rewrite
// that swapped one shim for another would still fail these, which is the point.
//
// Placement note (T020-T022 name three per-editor test files): the two Phase and
// Pipeline editors are presentational — they take `onsave` as a prop and cannot
// observe a dispatch at all. The dispatch lives in `PipelineBuilder.svelte`, in
// `pipeline-catalog-store.svelte.ts` which it constructs, and in
// `WorkflowCatalogEditor.svelte`. The assertion belongs where the dispatch is, and
// keeping all three kinds in one table-driven file is what makes "the three tabs
// agree" checkable rather than three near-copies that can drift apart.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PipelineBuilder from '../PipelineBuilder.svelte';
import WorkflowCatalogEditor from '../PipelineBuilderEditors/WorkflowCatalogEditor.svelte';
import type { BuilderLifecycle, WorkflowSnapshot } from '../../lib/snapshot-types';
import {
  deactivateDefinition,
  publishDefinitionPackage,
  saveDefinitionDraft
} from '../../lib/catalog-lifecycle';

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'corr-test' }))
}));
vi.mock('../../lib/snapshot-store.svelte', () => ({
  snapshotStore: { markPending: vi.fn(), onceAck: vi.fn() }
}));
vi.mock('../../lib/save-models', () => ({
  saveModels: vi.fn(async () => ({ status: 'accepted' as const })),
  saveModelsImport: vi.fn(async () => ({ status: 'accepted' as const }))
}));
vi.mock('../../lib/use-confirm', () => ({
  useConfirm: vi.fn(async () => true),
  isModalOpen: () => false
}));
// The one seam. Every lifecycle write in the webview goes through this module and
// no other, so mocking it observes the whole dispatch surface at once.
//
// The six senders are stubbed; everything else keeps its real implementation.
// `draftTokenOfRecord` in particular has to: it is the derivation that turns the
// projection's lifecycle block into the write token, and stubbing it would let
// the editors pass any token at all while these tests still read `'v-pending'`.
vi.mock('../../lib/catalog-lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/catalog-lifecycle')>()),
  saveDefinitionDraft: vi.fn(async () => ({ status: 'accepted' as const })),
  publishDefinition: vi.fn(async () => ({ status: 'accepted' as const })),
  restoreDefinitionVersion: vi.fn(async () => ({ status: 'accepted' as const })),
  publishDefinitionPackage: vi.fn(async () => ({ status: 'accepted' as const })),
  deactivateDefinition: vi.fn(async () => ({ status: 'accepted' as const })),
  discardDefinitionDraft: vi.fn(async () => ({ status: 'accepted' as const })),
  DECLINED: Object.freeze({ status: 'rejected', reason: 'declined' }),
  EMPTY_LAYER: Object.freeze({ status: 'rejected', reason: 'empty-layer' })
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ── Fixtures ───────────────────────────────────────────────────────────────

/**
 * A published definition with a pending draft on top of it.
 *
 * `'active-with-draft'` rather than `'active'` because the token is what the
 * second save has to carry: the three retired shims each hardcoded `NO_DRAFT`,
 * which is right for the first write to a definition and refused as stale for
 * every one after it. A fixture in `'active'` state would pass against that bug.
 */
function lifecycle(overrides: Partial<BuilderLifecycle> = {}): BuilderLifecycle {
  return {
    state: 'active-with-draft',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    activeVersionId: 'v-live',
    expectedDraftVersion: 'v-pending',
    versions: [
      { versionId: 'v-pending', createdAt: 1_700_000_100_000, publishedAt: null, isActive: false },
      { versionId: 'v-live', createdAt: 1_700_000_000_000, publishedAt: 1_700_000_000_000, isActive: true }
    ],
    ...overrides
  } as BuilderLifecycle;
}

const PHASE_DEFINITION = Object.freeze({
  phaseId: 'edit-me',
  name: 'Edit me',
  version: 3,
  instruction: 'Run.'
});

const SIBLING_PHASE = Object.freeze({
  phaseId: 'leave-me-alone',
  name: 'Leave me alone',
  version: 1,
  instruction: 'Idle.'
});

const PIPELINE_DEFINITION = Object.freeze({
  pipelineId: 'ship-it',
  name: 'Ship it',
  version: 2,
  phaseIds: ['edit-me'],
  inputs: [],
  outputs: [],
  bindings: [],
  recommendedNext: []
});

const WORKFLOW_DEFINITION = Object.freeze({
  workflowId: 'design-then-build',
  name: 'Design then Build',
  version: 1,
  nodes: [{ nodeId: 'ship', pipelineId: 'ship-it' }],
  connections: [],
  startNodeIds: ['ship']
});

function phaseRecord(definition: Record<string, unknown>, life = lifecycle()) {
  return {
    key: `${definition.phaseId as string}::0`,
    phaseId: definition.phaseId,
    status: 'effective',
    definition,
    display: definition,
    errors: [],
    lifecycle: life
  };
}

function buildSnapshot(): WorkflowSnapshot {
  return {
    schemaVersion: 4,
    isPrimary: true,
    workspaceTrust: true,
    resolvedTrust: { phases: true, retryConditions: true },
    availableBackends: ['claude', 'codex', 'agy'],
    availableModels: { claude: [], codex: [], agy: [] },
    configuredModels: { claude: [], codex: [], agy: [] },
    availablePhases: [],
    availablePipelines: [],
    phaseCatalog: {
      state: 'ready',
      records: [phaseRecord(PHASE_DEFINITION), phaseRecord(SIBLING_PHASE)],
      effective: [PHASE_DEFINITION, SIBLING_PHASE],
      revision: 'phase-revision',
      warnings: []
    },
    pipelineCatalog: {
      state: 'ready',
      records: [
        {
          key: 'ship-it::0',
          pipelineId: 'ship-it',
          status: 'effective',
          definition: PIPELINE_DEFINITION,
          display: PIPELINE_DEFINITION,
          errors: [],
          lifecycle: lifecycle({ activeVersionId: 'v-live-pipeline' })
        }
      ],
      effective: [PIPELINE_DEFINITION],
      revision: 'pipeline-revision',
      warnings: []
    },
    workflowCatalog: {
      state: 'ready',
      records: [
        {
          key: 'design-then-build::0',
          workflowId: 'design-then-build',
          status: 'effective',
          definition: WORKFLOW_DEFINITION,
          display: {},
          errors: [],
          derivedInputs: [],
          derivedOutputs: [],
          lifecycle: lifecycle({ activeVersionId: 'v-live-workflow' })
        }
      ],
      effective: [],
      revision: 'workflow-revision',
      warnings: []
    }
  } as unknown as WorkflowSnapshot;
}

async function switchTab(container: HTMLElement, label: string): Promise<void> {
  for (const tab of container.querySelectorAll('.tab-btn')) {
    if (tab.textContent?.trim() === label) {
      await fireEvent.click(tab);
      await tick();
      return;
    }
  }
  throw new Error(`Tab "${label}" not found`);
}

/** The single `saveDefinitionDraft` request the interaction produced. */
function soleDraftRequest(): Record<string, unknown> {
  const calls = vi.mocked(saveDefinitionDraft).mock.calls;
  expect(calls, 'exactly one draft save must have been dispatched').toHaveLength(1);
  return calls[0][0] as unknown as Record<string, unknown>;
}

// ── The three kinds ────────────────────────────────────────────────────────

describe('a Builder save writes a draft (T020-T022, FR-026a, FR-026b)', () => {
  it('phase: editing a name dispatches saveDefinitionDraft for that Phase alone', async () => {
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot(), initialTab: 'phases' }
    });
    await fireEvent.click(container.querySelector('[data-testid="phases-list-item-edit-me"]')!);
    await fireEvent.input(container.querySelector('[data-testid="phases-name-field-edit-me"]')!, {
      target: { value: 'Edited name' }
    });
    await fireEvent.click(container.querySelector('[data-testid="phases-save-all"]')!);
    await tick();

    const request = soleDraftRequest();
    expect(request.kind).toBe('phase');
    expect(request.id).toBe('edit-me');
    // FR-012 — the token the record carried, echoed back verbatim. Hardcoding
    // `NO_DRAFT` here is the bug the three shims shipped: correct for the first
    // write to a definition, refused as stale for every one after it.
    expect(request.expectedDraftVersion).toBe('v-pending');
    expect((request.body as { name?: string }).name).toBe('Edited name');
  });

  it('pipeline: editing a name dispatches saveDefinitionDraft for that Pipeline alone', async () => {
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot(), initialTab: 'pipelines' }
    });
    await fireEvent.click(container.querySelector('[data-testid="pipelines-list-item-ship-it"]')!);
    await fireEvent.input(container.querySelector('[data-testid="pipelines-name-field-ship-it"]')!, {
      target: { value: 'Ship it later' }
    });
    await fireEvent.click(container.querySelector('[data-testid="pipelines-save-all"]')!);
    await tick();

    const request = soleDraftRequest();
    expect(request.kind).toBe('pipeline');
    expect(request.id).toBe('ship-it');
    expect(request.expectedDraftVersion).toBe('v-pending');
    expect((request.body as { name?: string }).name).toBe('Ship it later');
  });

  it('workflow: saving a duplicated draft dispatches saveDefinitionDraft for the copy', async () => {
    // A stored Workflow row is not editable in place — duplicating it is the path
    // the editor offers (FR-026 of feature 083) — so the copy is what gets saved.
    // Its target is a definition the store has never seen, which is the one case
    // where `NO_DRAFT` is the correct token rather than a hardcoded guess.
    const { container, getByTestId } = render(WorkflowCatalogEditor, {
      props: { snapshot: buildSnapshot(), trusted: true }
    });
    await fireEvent.click(
      container.querySelector('[data-testid="workflows-list-item-design-then-build"]')!
    );
    await fireEvent.click(getByTestId('workflows-duplicate'));
    await tick();
    await fireEvent.click(getByTestId('workflows-save-all'));
    await tick();

    const request = soleDraftRequest();
    expect(request.kind).toBe('workflow');
    expect(request.id).toBe('design-then-build-copy');
    expect(request.expectedDraftVersion).toBe('no-draft');
  });
});

describe('a save publishes nothing (T020-T022, FR-026b, SC-001a)', () => {
  it('phase: no package publish, so the active version cannot have moved', async () => {
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot(), initialTab: 'phases' }
    });
    await fireEvent.click(container.querySelector('[data-testid="phases-list-item-edit-me"]')!);
    await fireEvent.input(container.querySelector('[data-testid="phases-name-field-edit-me"]')!, {
      target: { value: 'Edited name' }
    });
    await fireEvent.click(container.querySelector('[data-testid="phases-save-all"]')!);
    await tick();

    // The Builder has exactly one way to move an active pointer, and this is it.
    // Asserting the negative here rather than re-reading the projection is what
    // makes the claim independent of what the host happens to send back.
    expect(publishDefinitionPackage).not.toHaveBeenCalled();
    expect(deactivateDefinition).not.toHaveBeenCalled();
  });

  it('pipeline: no package publish', async () => {
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot(), initialTab: 'pipelines' }
    });
    await fireEvent.click(container.querySelector('[data-testid="pipelines-list-item-ship-it"]')!);
    await fireEvent.input(container.querySelector('[data-testid="pipelines-name-field-ship-it"]')!, {
      target: { value: 'Ship it later' }
    });
    await fireEvent.click(container.querySelector('[data-testid="pipelines-save-all"]')!);
    await tick();

    expect(publishDefinitionPackage).not.toHaveBeenCalled();
  });

  it('workflow: no package publish', async () => {
    const { container, getByTestId } = render(WorkflowCatalogEditor, {
      props: { snapshot: buildSnapshot(), trusted: true }
    });
    await fireEvent.click(
      container.querySelector('[data-testid="workflows-list-item-design-then-build"]')!
    );
    await fireEvent.click(getByTestId('workflows-duplicate'));
    await tick();
    await fireEvent.click(getByTestId('workflows-save-all'));
    await tick();

    expect(publishDefinitionPackage).not.toHaveBeenCalled();
  });
});

describe('a save names one definition (T023, FR-026c)', () => {
  it('carries the edited Phase and no sibling, so no sibling gains a version', async () => {
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot(), initialTab: 'phases' }
    });
    await fireEvent.click(container.querySelector('[data-testid="phases-list-item-edit-me"]')!);
    await fireEvent.input(container.querySelector('[data-testid="phases-name-field-edit-me"]')!, {
      target: { value: 'Edited name' }
    });
    await fireEvent.click(container.querySelector('[data-testid="phases-save-all"]')!);
    await tick();

    // The whole-layer save named every stored definition in one publication, so
    // an untouched sibling's head went live as a side effect of editing this one.
    // The serialized request is checked rather than just the `id` field: a body
    // that still carried the array would reintroduce exactly that.
    const request = soleDraftRequest();
    expect(JSON.stringify(request)).not.toContain('leave-me-alone');
  });

  it('does not dispatch a second draft save for a definition the operator did not touch', async () => {
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot(), initialTab: 'phases' }
    });
    await fireEvent.click(container.querySelector('[data-testid="phases-list-item-edit-me"]')!);
    await fireEvent.input(container.querySelector('[data-testid="phases-name-field-edit-me"]')!, {
      target: { value: 'Edited name' }
    });
    await fireEvent.click(container.querySelector('[data-testid="phases-save-all"]')!);
    await tick();

    expect(vi.mocked(saveDefinitionDraft).mock.calls).toHaveLength(1);
  });
});

describe('an unchanged save is a successful save (T024, FR-026d)', () => {
  it('reports no error when the host answers `unchanged`', async () => {
    // The store short-circuits on the content hash and manufactures no version
    // (099 FR-011a). It acks `accepted` with `appended: false`, and the surface
    // must treat that as a save — an error banner here would train the operator
    // to expect a failure every time they save without changing anything.
    vi.mocked(saveDefinitionDraft).mockResolvedValueOnce({
      status: 'accepted',
      result: { draftVersionId: 'v-pending', appended: false }
    });
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot(), initialTab: 'phases' }
    });
    await fireEvent.click(container.querySelector('[data-testid="phases-list-item-edit-me"]')!);
    await fireEvent.input(container.querySelector('[data-testid="phases-name-field-edit-me"]')!, {
      target: { value: 'Edit me' }
    });
    await fireEvent.click(container.querySelector('[data-testid="phases-save-all"]')!);
    await tick();
    await tick();

    expect(container.querySelector('[data-testid="save-error-banner"]')).toBeNull();
    expect(publishDefinitionPackage).not.toHaveBeenCalled();
  });
});

describe('removal is still a deactivation, not a draft (FR-026a boundary)', () => {
  it('routes a Phase removal to deactivateDefinition with the record token', async () => {
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot(), initialTab: 'phases' }
    });
    await fireEvent.click(container.querySelector('[data-testid="phases-list-item-edit-me"]')!);
    await fireEvent.click(container.querySelector('[data-testid="phases-remove"]')!);
    await tick();

    expect(saveDefinitionDraft).not.toHaveBeenCalled();
    expect(deactivateDefinition).toHaveBeenCalledOnce();
    const [request] = vi.mocked(deactivateDefinition).mock.calls[0];
    expect(request).toMatchObject({
      kind: 'phase',
      id: 'edit-me',
      expectedDraftVersion: 'v-pending'
    });
  });
});
