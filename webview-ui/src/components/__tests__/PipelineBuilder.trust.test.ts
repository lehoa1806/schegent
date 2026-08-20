// Feature 059 (US5, T022) — settings-panel trust webview tests.
// Contract: specs/059-fine-grained-trust-scopes/contracts/trust-projection-contract.md
//
// Covers (per the "Test coverage" bullets):
//   - Render with `resolvedTrust.phases: false` → Save button disabled,
//     banner visible.
//   - Feature 099 (T496f, FR-046) — a `resolvedTrust.pipelineOverrides: false`
//     bullet stood here. The capability asked which layer was permitted to
//     redefine another layer's row, and one catalog has no such question; the
//     Pipelines tab is gated by Workspace Trust alone now.
//   - Render with `resolvedTrust.retryConditions: false` → row-level
//     retry-condition inputs are read-only (FR-010c).
//   - Toggle `resolvedTrust.phases` false → true → Save button re-enables,
//     banner hides (re-render without reload).
//   - Workspace-trust ceiling (`workspaceTrust: false`) suppresses per-
//     capability banners in favor of a single workspace-trust banner
//     (FR-010e).
//
// The PipelineBuilder component is the consumer of the Phases /
// Pipelines tabs (the Settings panel only retains General / Fatal).
// Per the contract, the four projection fields live on the
// `WorkflowSnapshot` envelope as `workspaceTrust` and `resolvedTrust.*`.

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
  postCommand: vi.fn(() => ({ correlationId: 'corr-trust-test' }))
}));
vi.mock('../../lib/snapshot-store.svelte', () => ({
  snapshotStore: {
    markPending: vi.fn(),
    onceAck: vi.fn()
  }
}));
// Feature 101 (T030) — `save-phases.ts` folded into `catalog-lifecycle.ts`.
// Only the sender is stubbed; `draftTokenOfRecord` keeps its real body because
// the editor derives its write token through it.
vi.mock('../../lib/catalog-lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/catalog-lifecycle')>()),
  saveDefinitionDraft: vi.fn(async () => ({ status: 'accepted' as const }))
}));

afterEach(() => cleanup());

interface TrustOpts {
  isPrimary?: boolean;
  workspaceTrust?: boolean;
  phases?: boolean;
  retryConditions?: boolean;
}

function buildSnapshot(opts: TrustOpts = {}): WorkflowSnapshot {
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
    producedAt: '2026-05-19T00:00:00.000Z',
    availablePipelines: pipelines,
    availablePhases: phases,
    availableModels: Object.freeze(['claude-sonnet-4-6']),
    phaseCatalog: {
      state: 'ready',
      records: [{
        key: 'speckit-specify::0',
        phaseId: 'speckit-specify',
        status: 'effective',
        definition: {
          phaseId: 'speckit-specify',
          name: 'Specify',
          version: 1,
          instruction: 'Specify',
          loopable: false
        },
        display: {},
        errors: []
      }],
      // An `effective` row that agrees with the record above. It was empty here,
      // which left the Pipelines tab reporting its missing-Phase prerequisite and
      // made every control on that tab disabled for a reason unrelated to trust —
      // no use as a probe for what trust gates.
      effective: [{
        phaseId: 'speckit-specify',
        name: 'Specify',
        version: 1,
        instruction: 'Specify',
        loopable: false
      }],
      revision: 'phase-revision',
      warnings: []
    },
    // Feature 082 — the Pipeline tab's controls only exist once the
    // authoritative projection arrives (FR-028); trust gating layers on top.
    pipelineCatalog: {
      state: 'ready',
      records: [],
      effective: [],
      revision: 'pipeline-revision',
      warnings: []
    },
    generalSettings: IDLE_GENERAL_SETTINGS,
    workspaceTrust: opts.workspaceTrust ?? true,
    resolvedTrust: {
      phases: opts.phases ?? true,
      retryConditions: opts.retryConditions ?? true
    }
  }) as unknown as unknown as WorkflowSnapshot;
}

describe('PipelineBuilder trust gating (059, T022) — phases disabled', () => {
  it('disables the Save Phases button and renders the policy banner when resolvedTrust.phases is false', () => {
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot({ phases: false }), initialTab: 'phases' }
    });
    const saveBtn = container.querySelector('[data-testid="phases-save-all"]') as HTMLButtonElement | null;
    expect(saveBtn).not.toBeNull();
    expect(saveBtn?.hasAttribute('disabled')).toBe(true);
    const banner = container.querySelector('[data-testid="trust-banner-phases"]');
    expect(banner).not.toBeNull();
  });

  it('disables every Phase editing control in a secondary window', () => {
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot({ isPrimary: false }), initialTab: 'phases' }
    });
    const add = container.querySelector('[data-testid="phases-add"]') as HTMLButtonElement;
    const save = container.querySelector('[data-testid="phases-save-all"]') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(save.disabled).toBe(true);
  });
});

describe('PipelineBuilder trust gating (059, T022) — pipelines under Workspace Trust', () => {
  // Feature 099 (T496f, FR-046) — one case stood here, seeding
  // `resolvedTrust.pipelineOverrides: false` and pinning Save Pipelines disabled
  // beside its own banner. The capability and the banner variant are both
  // deleted: an *override* is a statement about one layer redefining another's
  // row, and there is one catalog. What gates the tab now is Workspace Trust,
  // which the pair below pins in both directions — a control dead either way
  // would satisfy one of them on its own, and neither alone is the claim.
  it('opens the Pipelines tab for editing under workspace trust, with no per-capability banner', () => {
    const { container } = render(PipelineBuilder, { props: { snapshot: buildSnapshot() } });
    const add = container.querySelector('[data-testid="pipelines-add"]') as HTMLButtonElement | null;
    expect(add).not.toBeNull();
    expect(add?.disabled).toBe(false);
    expect(container.querySelector('[data-testid="trust-banner-pipelines"]')).toBeNull();
    expect(container.querySelector('[data-testid="trust-banner-workspace-trust"]')).toBeNull();
  });

  it('withholds the editor entirely in an untrusted workspace, and says why (FR-052)', () => {
    // Not a disabled control: an untrusted workspace activates no catalog at all
    // (T493c), so rendering the editor would present an empty Library — which
    // reads as "nothing is defined here" when the truth is "this workspace is not
    // trusted". The banner and the gated line are the report.
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot({ workspaceTrust: false }) }
    });
    expect(container.querySelector('[data-testid="pipelines-add"]')).toBeNull();
    expect(container.querySelector('[data-testid="builder-trust-gated"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="trust-banner-workspace-trust"]')).not.toBeNull();
  });
});

describe('PipelineBuilder trust gating (059, T022) — workspace-trust ceiling', () => {
  it('renders a single workspace-trust banner suppressing per-capability banners when workspaceTrust is false', () => {
    const { container } = render(PipelineBuilder, {
      props: {
        snapshot: buildSnapshot({
          workspaceTrust: false,
          phases: false,
          retryConditions: false
        })
      }
    });
    const ceiling = container.querySelector('[data-testid="trust-banner-workspace-trust"]');
    expect(ceiling).not.toBeNull();
    expect(container.querySelector('[data-testid="trust-banner-phases"]')).toBeNull();
    expect(container.querySelector('[data-testid="trust-banner-retry-conditions"]')).toBeNull();
    // Feature 099 (T496f, FR-046) — a `trust-banner-pipelines` line stood with
    // these two. Asserting the absence of a variant that no longer exists in the
    // component's union would pass on any build; the ceiling's reach over the two
    // surviving per-capability banners is the claim that still has content.
  });
});

describe('PipelineBuilder trust gating (059, T022) — re-render on toggle', () => {
  it('re-enables Phase mutations and hides banner when resolvedTrust.phases flips false → true', async () => {
    const { container, rerender } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot({ phases: false }), initialTab: 'phases' }
    });
    let saveBtn = container.querySelector('[data-testid="phases-save-all"]') as HTMLButtonElement | null;
    expect(saveBtn?.hasAttribute('disabled')).toBe(true);
    await rerender({ snapshot: buildSnapshot({ phases: true }), initialTab: 'phases' });
    saveBtn = container.querySelector('[data-testid="phases-save-all"]') as HTMLButtonElement | null;
    const addBtn = container.querySelector('[data-testid="phases-add"]') as HTMLButtonElement | null;
    expect(addBtn?.hasAttribute('disabled')).toBe(false);
    expect(saveBtn?.hasAttribute('disabled')).toBe(true);
    expect(container.querySelector('[data-testid="trust-banner-phases"]')).toBeNull();
  });
});

describe('PipelineBuilder — untrusted beats empty (101 US6, T063, FR-032)', () => {
  // An untrusted workspace activates no catalog, so every definition tab is
  // empty for a reason that has nothing to do with the catalog being empty.
  // "Import one to get started" would point at an action that cannot succeed,
  // and the operator would go looking for a document to import when what they
  // need is to trust the workspace. The trust check is ordered first for that
  // reason, and this pins the order rather than the wording.
  const EMPTY_TAB_STATES = ['pipelines', 'phases', 'workflows'] as const;

  for (const initialTab of EMPTY_TAB_STATES) {
    it(`shows the trust banner and no empty-catalog guidance on the ${initialTab} tab`, () => {
      const { container } = render(PipelineBuilder, {
        props: { snapshot: buildSnapshot({ workspaceTrust: false }), initialTab }
      });
      expect(container.querySelector('[data-testid="trust-banner-workspace-trust"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="builder-trust-gated"]')).not.toBeNull();
      expect(container.querySelector('[data-testid^="catalog-empty-state-"]')).toBeNull();
    });
  }

  it('shows the empty-catalog guidance once the workspace is trusted', () => {
    // The other half: withholding it when untrusted is only correct if it does
    // appear when the reason for the emptiness really is an empty catalog. The
    // fixture's Pipeline catalog projects no records.
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot({ workspaceTrust: true }), initialTab: 'pipelines' }
    });
    expect(container.querySelector('[data-testid="trust-banner-workspace-trust"]')).toBeNull();
    expect(container.querySelector('[data-testid="catalog-empty-state-pipeline"]')).not.toBeNull();
  });
});
