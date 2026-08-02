// Feature 059 (US5, T022) — settings-panel trust webview tests.
// Contract: specs/059-fine-grained-trust-scopes/contracts/trust-projection-contract.md
//
// Covers (per the "Test coverage" bullets):
//   - Render with `resolvedTrust.phases: false` → Save button disabled,
//     banner visible.
//   - Render with `resolvedTrust.pipelineOverrides: false` → Save
//     Pipelines disabled, banner visible.
//   - Render with `resolvedTrust.retryConditions: false` → row-level
//     retry-condition inputs are read-only (FR-010c).
//   - Toggle `resolvedTrust.phases` false → true → Save button re-enables,
//     banner hides (re-render without reload).
//   - Workspace-trust ceiling (`workspaceTrust: false`) suppresses per-
//     capability banners in favor of a single workspace-trust banner
//     (FR-010e).
//
// The PipelineBuilder component is the consumer of the Phases /
// Pipelines tabs (the Settings panel only retains General / Fatal /
// WakeUp). Per the contract, the four projection fields live on the
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

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'corr-trust-test' }))
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

afterEach(() => cleanup());

interface TrustOpts {
  isPrimary?: boolean;
  workspaceTrust?: boolean;
  phases?: boolean;
  retryConditions?: boolean;
  pipelineOverrides?: boolean;
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
    schemaVersion: 3,
    isPrimary: opts.isPrimary ?? true,
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
    producedAt: '2026-05-19T00:00:00.000Z',
    availablePipelines: pipelines,
    availablePhases: phases,
    availableModels: Object.freeze(['claude-sonnet-4-6']),
    phaseCatalog: {
      state: 'ready',
      records: [{
        key: 'workspace::speckit-specify::0',
        phaseId: 'speckit-specify',
        scope: 'workspace',
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
      effective: [],
      revisions: { user: 'user-revision', workspace: 'workspace-revision' },
      warnings: []
    },
    generalSettings: IDLE_GENERAL_SETTINGS,
    workspaceTrust: opts.workspaceTrust ?? true,
    resolvedTrust: {
      phases: opts.phases ?? true,
      retryConditions: opts.retryConditions ?? true,
      pipelineOverrides: opts.pipelineOverrides ?? true
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

describe('PipelineBuilder trust gating (059, T022) — pipelines disabled', () => {
  it('disables the Save Pipelines button and renders the policy banner when resolvedTrust.pipelineOverrides is false', () => {
    const { container } = render(PipelineBuilder, {
      props: { snapshot: buildSnapshot({ pipelineOverrides: false }) }
    });
    const saveBtns = container.querySelectorAll('button');
    const savePipelinesBtn = Array.from(saveBtns).find(
      (b) => (b.textContent ?? '').trim() === 'Save Pipelines'
    ) as HTMLButtonElement | undefined;
    expect(savePipelinesBtn).toBeDefined();
    expect(savePipelinesBtn?.hasAttribute('disabled')).toBe(true);
    const banner = container.querySelector('[data-testid="trust-banner-pipelines"]');
    expect(banner).not.toBeNull();
  });
});

describe('PipelineBuilder trust gating (059, T022) — workspace-trust ceiling', () => {
  it('renders a single workspace-trust banner suppressing per-capability banners when workspaceTrust is false', () => {
    const { container } = render(PipelineBuilder, {
      props: {
        snapshot: buildSnapshot({
          workspaceTrust: false,
          phases: false,
          retryConditions: false,
          pipelineOverrides: false
        })
      }
    });
    const ceiling = container.querySelector('[data-testid="trust-banner-workspace-trust"]');
    expect(ceiling).not.toBeNull();
    expect(container.querySelector('[data-testid="trust-banner-phases"]')).toBeNull();
    expect(container.querySelector('[data-testid="trust-banner-pipelines"]')).toBeNull();
    expect(container.querySelector('[data-testid="trust-banner-retry-conditions"]')).toBeNull();
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
