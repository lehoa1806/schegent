// Feature 083 — the Workflow Library's mount site.
//
// `WorkflowCatalogEditor` is self-contained but not self-mounting: without a
// tab in `PipelineBuilder` the operator has no way to reach it, so SC-001
// ("compose, validate, and save a two-node Workflow in under 3 minutes without
// opening documentation") and the quickstart's "Open the Workflow Builder with
// no Pipelines defined" scenario are both unreachable. These tests pin the
// mount and the trust wiring that decides the editor's `trusted` prop.
//
// Feature 099 (T496f, FR-046) — this paragraph argued that `workflowOverrides`
// was deliberately distinct from `pipelineOverrides`, a Workflow graph deciding
// which Pipelines relate to which being a broader authority than editing one
// Pipeline's phase order. Both settings are deleted with the layer tier: an
// *override* names one layer redefining another layer's row, and there is one
// catalog. The authority argument is unaffected and unenforced by either
// setting — what gates both tabs is Workspace Trust, which is the single gate
// precisely because a cloned repository can carry a `.schegent/catalog/`
// directory (FR-052). The host-side half is
// tests/unit/state/state-projector-trust.test.ts.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import PipelineBuilder from '../PipelineBuilder.svelte';
import type {
  WorkflowSnapshot,
  PhaseDefinition,
  PipelineDefinition
} from '../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../lib/snapshot-types';
import { foldLegacyRun } from '../../lib/__tests__/queue-runtime-fixture';

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'corr-workflows-tab-test' }))
}));
vi.mock('../../lib/snapshot-store.svelte', () => ({
  snapshotStore: {
    markPending: vi.fn(),
    onceAck: vi.fn()
  }
}));
// Feature 101 (T030) — the three `save-*` transports collapsed into one module,
// so one mock replaces two. Only the senders are stubbed: `draftTokenOfRecord`
// keeps its real body because the editors derive their write token through it.
vi.mock('../../lib/catalog-lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/catalog-lifecycle')>()),
  saveDefinitionDraft: vi.fn(async () => ({ status: 'accepted' as const })),
  deactivateDefinition: vi.fn(async () => ({ status: 'accepted' as const }))
}));

afterEach(() => cleanup());

interface SnapshotOpts {
  isPrimary?: boolean;
  workspaceTrust?: boolean;
  workflowCatalogState?: 'ready' | 'error';
  pipelines?: readonly PortablePipelineRow[];
}

interface PortablePipelineRow {
  readonly pipelineId: string;
  readonly name: string;
  readonly version: number;
  readonly phases: readonly { readonly phaseId: string }[];
}

const DEFAULT_EFFECTIVE_PIPELINES: readonly PortablePipelineRow[] = Object.freeze([
  Object.freeze({
    pipelineId: 'pipeline-a',
    name: 'Pipeline A',
    version: 1,
    phases: Object.freeze([Object.freeze({ phaseId: 'speckit-specify' })])
  })
]);

function buildSnapshot(opts: SnapshotOpts = {}): WorkflowSnapshot {
  const phases: readonly PhaseDefinition[] = Object.freeze([
    {
      id: 'speckit-specify',
      name: 'Specify',
      instruction: 'Specify',
      loopable: false
    } as PhaseDefinition
  ]);
  const pipelines: readonly PipelineDefinition[] = Object.freeze([
    {
      id: 'pipeline-a',
      name: 'Pipeline A',
      phases: ['speckit-specify']
    } as PipelineDefinition
  ]);
  return Object.freeze({
    schemaVersion: 4,
    isPrimary: opts.isPrimary ?? true,
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
    producedAt: '2026-08-03T00:00:00.000Z',
    availablePipelines: pipelines,
    availablePhases: phases,
    availableModels: Object.freeze(['claude-sonnet-5-5']),
    phaseCatalog: {
      state: 'ready',
      records: [],
      effective: [],
      revision: 'phase-revision',
      warnings: []
    },
    pipelineCatalog: {
      state: 'ready',
      records: [],
      effective: opts.pipelines ?? DEFAULT_EFFECTIVE_PIPELINES,
      revision: 'pipeline-revision',
      warnings: []
    },
    workflowCatalog: {
      state: opts.workflowCatalogState ?? 'ready',
      records: [],
      effective: [],
      revision: 'workflow-revision',
      warnings: []
    },
    generalSettings: IDLE_GENERAL_SETTINGS,
    workspaceTrust: opts.workspaceTrust ?? true,
    resolvedTrust: {
      phases: true,
      retryConditions: true
    }
  }) as unknown as WorkflowSnapshot;
}

describe('PipelineBuilder — Workflow Library mount (083)', () => {
  it('exposes a Workflows tab alongside Phases and Models', () => {
    const { container } = render(PipelineBuilder, { props: { snapshot: buildSnapshot() } });
    const labels = Array.from(container.querySelectorAll('.builder-tabs .tab-btn')).map(
      (btn) => btn.textContent?.trim()
    );
    expect(labels).toEqual(['Phases', 'Workflows', 'Models']);
  });

  it('mounts the Workflows list when initialTab is "workflows" and opens the full-page editor on New workflow', async () => {
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot(), initialTab: 'workflows' }
    });
    const add = container.querySelector('[data-testid="workflows-add"]') as HTMLButtonElement | null;
    expect(add).not.toBeNull();
    expect(container.querySelector('[data-testid="workflow-catalog-list"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="workflows-save-all"]')).toBeNull();
    expect(container.querySelector('[data-testid="pipelines-save-all"]')).toBeNull();
    expect(container.querySelector('[data-testid="phases-save-all"]')).toBeNull();

    await fireEvent.click(add!);
    expect(container.querySelector('[data-testid="workflow-catalog-editor"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="workflows-save-all"]')).not.toBeNull();
    // Full-page Workflow Editor hides the top-level Builder header and tabs.
    expect(container.querySelector('.builder-tabs')).toBeNull();
  });

  it('mounts the Workflows list when the Workflows tab is activated', async () => {
    const { container } = render(PipelineBuilder, { props: { snapshot: buildSnapshot() } });
    expect(container.querySelector('[data-testid="workflows-add"]')).toBeNull();
    const tab = Array.from(container.querySelectorAll('.builder-tabs .tab-btn')).find(
      (btn) => btn.textContent?.trim() === 'Workflows'
    ) as HTMLButtonElement;
    tab.click();
    await Promise.resolve();
    expect(container.querySelector('[data-testid="workflows-add"]')).not.toBeNull();
  });

  it('explains the missing prerequisite in the Workflow Editor when the effective Pipeline/Phase catalog is empty', async () => {
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot({ pipelines: [] }), initialTab: 'workflows' }
    });
    await fireEvent.click(container.querySelector('[data-testid="workflows-add"]') as HTMLButtonElement);
    expect(container.querySelector('[data-testid="workflows-no-pipelines"]')).not.toBeNull();
  });
});

describe('PipelineBuilder — Workflow trust gating (083)', () => {
  it('opens the Workflows list for editing under workspace trust', () => {
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot(), initialTab: 'workflows' }
    });
    const add = container.querySelector('[data-testid="workflows-add"]') as HTMLButtonElement | null;
    expect(add).not.toBeNull();
    expect(add?.disabled).toBe(false);
    expect(container.querySelector('[data-testid="trust-banner-workflows"]')).toBeNull();
  });

  it('withholds the editor entirely in an untrusted workspace, and says why (FR-052)', () => {
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot({ workspaceTrust: false }), initialTab: 'workflows' }
    });
    expect(container.querySelector('[data-testid="workflows-add"]')).toBeNull();
    expect(container.querySelector('[data-testid="builder-trust-gated"]')).not.toBeNull();
  });

  it('fails closed when the host bundle omits workspaceTrust', () => {
    const { workspaceTrust: _omitted, ...withoutField } = buildSnapshot() as unknown as Record<
      string,
      unknown
    >;
    const { container } = render(PipelineBuilder, {
      props: { snapshot: withoutField as unknown as WorkflowSnapshot, initialTab: 'workflows' }
    });
    expect(
      (container.querySelector('[data-testid="workflows-add"]') as HTMLButtonElement | null)?.disabled
    ).toBe(true);
  });

  it('disables Workflow mutations in a secondary window', () => {
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot({ isPrimary: false }), initialTab: 'workflows' }
    });
    expect(
      (container.querySelector('[data-testid="workflows-add"]') as HTMLButtonElement | null)?.disabled
    ).toBe(true);
  });

  it('reports the ceiling once, and no per-capability banner beside it', () => {
    // Feature 099 (T496f, FR-046) — the second assertion named
    // `trust-banner-workflows`, a variant the component's union no longer has, so
    // it would pass on any build. The two surviving variants are what the ceiling
    // still has to suppress, and they are what it asserts instead.
    const { container } = render(PipelineBuilder, {
      props: {
        snapshot: buildSnapshot({ workspaceTrust: false }),
        initialTab: 'workflows'
      }
    });
    expect(container.querySelector('[data-testid="trust-banner-workspace-trust"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="trust-banner-phases"]')).toBeNull();
    expect(container.querySelector('[data-testid="trust-banner-retry-conditions"]')).toBeNull();
  });
});
