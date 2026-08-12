// Feature 083 — the Workflow Library's mount site.
//
// `WorkflowCatalogEditor` is self-contained but not self-mounting: without a
// tab in `PipelineBuilder` the operator has no way to reach it, so SC-001
// ("compose, validate, and save a two-node Workflow in under 3 minutes without
// opening documentation") and the quickstart's "Open the Workflow Builder with
// no Pipelines defined" scenario are both unreachable. These tests pin the
// mount and the trust wiring that decides the editor's `trusted` prop.
//
// The capability is `workflowOverrides`, and it is deliberately *distinct*
// from `pipelineOverrides` (see docs/security/threat-model.md T22 and the
// per-capability trust scopes section) — a Workflow graph decides which
// Pipelines relate to which and under what conditions, a broader authority
// than editing one Pipeline's phase order. The "distinct capability" test
// below is the webview-side half of that invariant; the host-side half is
// tests/unit/state/state-projector-trust.test.ts.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
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
vi.mock('../../lib/save-phases', () => ({
  savePhases: vi.fn(async () => ({ status: 'accepted' as const }))
}));
vi.mock('../../lib/save-workflows', () => ({
  saveWorkflows: vi.fn(async () => ({ status: 'accepted' as const }))
}));

afterEach(() => cleanup());

interface SnapshotOpts {
  isPrimary?: boolean;
  workspaceTrust?: boolean;
  pipelineOverrides?: boolean;
  workflowOverrides?: boolean;
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
    availableModels: Object.freeze(['claude-sonnet-4-6']),
    phaseCatalog: {
      state: 'ready',
      records: [],
      effective: [],
      revisions: { user: 'user-phase-revision', workspace: 'workspace-phase-revision' },
      warnings: []
    },
    pipelineCatalog: {
      state: 'ready',
      records: [],
      effective: opts.pipelines ?? DEFAULT_EFFECTIVE_PIPELINES,
      revisions: { user: 'user-pipeline-revision', workspace: 'workspace-pipeline-revision' },
      warnings: []
    },
    workflowCatalog: {
      state: opts.workflowCatalogState ?? 'ready',
      records: [],
      effective: [],
      revisions: { user: 'user-workflow-revision', workspace: 'workspace-workflow-revision' },
      warnings: []
    },
    generalSettings: IDLE_GENERAL_SETTINGS,
    workspaceTrust: opts.workspaceTrust ?? true,
    resolvedTrust: {
      phases: true,
      retryConditions: true,
      pipelineOverrides: opts.pipelineOverrides ?? true,
      workflowOverrides: opts.workflowOverrides ?? true
    }
  }) as unknown as WorkflowSnapshot;
}

describe('PipelineBuilder — Workflow Library mount (083)', () => {
  it('exposes a Workflows tab alongside Pipelines, Phases, and Models', () => {
    const { container } = render(PipelineBuilder, { props: { snapshot: buildSnapshot() } });
    const labels = Array.from(container.querySelectorAll('.builder-tabs .tab-btn')).map(
      (btn) => btn.textContent?.trim()
    );
    expect(labels).toEqual(['Pipelines', 'Phases', 'Workflows', 'Models']);
  });

  it('mounts the Workflow Library when initialTab is "workflows"', () => {
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot(), initialTab: 'workflows' }
    });
    expect(container.querySelector('[data-testid="workflows-add"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="workflows-save-all"]')).not.toBeNull();
    // The other catalogs stay unmounted so their save affordances cannot be
    // reached from this tab.
    expect(container.querySelector('[data-testid="pipelines-save-all"]')).toBeNull();
    expect(container.querySelector('[data-testid="phases-save-all"]')).toBeNull();
  });

  it('mounts the Workflow Library when the Workflows tab is activated', async () => {
    const { container } = render(PipelineBuilder, { props: { snapshot: buildSnapshot() } });
    expect(container.querySelector('[data-testid="workflows-add"]')).toBeNull();
    const tab = Array.from(container.querySelectorAll('.builder-tabs .tab-btn')).find(
      (btn) => btn.textContent?.trim() === 'Workflows'
    ) as HTMLButtonElement;
    tab.click();
    await Promise.resolve();
    expect(container.querySelector('[data-testid="workflows-add"]')).not.toBeNull();
  });

  it('explains the missing prerequisite when the effective Pipeline catalog is empty', () => {
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot({ pipelines: [] }), initialTab: 'workflows' }
    });
    expect(container.querySelector('[data-testid="workflows-no-pipelines"]')).not.toBeNull();
  });
});

describe('PipelineBuilder — Workflow trust gating (083)', () => {
  it('disables every mutating control and shows the banner when workflowOverrides is false', () => {
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot({ workflowOverrides: false }), initialTab: 'workflows' }
    });
    const add = container.querySelector('[data-testid="workflows-add"]') as HTMLButtonElement;
    const save = container.querySelector('[data-testid="workflows-save-all"]') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(save.disabled).toBe(true);
    expect(container.querySelector('[data-testid="trust-banner-workflows"]')).not.toBeNull();
  });

  it('treats workflowOverrides as a capability distinct from pipelineOverrides', () => {
    const { container } = render(PipelineBuilder, {
      props: {
        snapshot: buildSnapshot({ pipelineOverrides: false, workflowOverrides: true }),
        initialTab: 'workflows'
      }
    });
    const add = container.querySelector('[data-testid="workflows-add"]') as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    expect(container.querySelector('[data-testid="trust-banner-workflows"]')).toBeNull();
  });

  it('fails closed when the host bundle omits resolvedTrust.workflowOverrides', () => {
    const legacy = buildSnapshot();
    const withoutField = {
      ...legacy,
      resolvedTrust: {
        phases: true,
        retryConditions: true,
        pipelineOverrides: true
      }
    } as unknown as WorkflowSnapshot;
    const { container } = render(PipelineBuilder, {
      props: { snapshot: withoutField, initialTab: 'workflows' }
    });
    const add = container.querySelector('[data-testid="workflows-add"]') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(container.querySelector('[data-testid="trust-banner-workflows"]')).not.toBeNull();
  });

  it('disables Workflow mutations in a secondary window', () => {
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot({ isPrimary: false }), initialTab: 'workflows' }
    });
    const add = container.querySelector('[data-testid="workflows-add"]') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
  });

  it('suppresses the per-capability banner under the workspace-trust ceiling', () => {
    const { container } = render(PipelineBuilder, {
      props: {
        snapshot: buildSnapshot({ workspaceTrust: false, workflowOverrides: false }),
        initialTab: 'workflows'
      }
    });
    expect(container.querySelector('[data-testid="trust-banner-workspace-trust"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="trust-banner-workflows"]')).toBeNull();
  });
});
