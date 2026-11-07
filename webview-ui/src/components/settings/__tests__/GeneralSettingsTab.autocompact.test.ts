// Feature 012 — Claude auto-compact override field in GeneralSettingsTab.
//
// Covers:
//   - Empty input when snapshot value is undefined.
//   - Numeric input populated when snapshot has a value in [1, 100].
//   - Saving empty input dispatches { 'claude.autoCompactPctOverride': null }.
//   - Saving a valid integer dispatches { 'claude.autoCompactPctOverride': <int> }.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import GeneralSettingsTab from '../GeneralSettingsTab.svelte';
import { CMD_SAVE_GENERAL_SETTINGS } from '../../../lib/messages';
import type { WorkflowSnapshot, GeneralSettings } from '../../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../../lib/snapshot-types';
import { foldLegacyRun } from '../../../lib/__tests__/queue-runtime-fixture';

const postCommandSpy = vi.fn(
  (_cmd: string, _payload: unknown) => ({ correlationId: 'corr-test' })
);
vi.mock('../../../lib/vscode-api', () => ({
  postCommand: (cmd: string, payload: unknown) => postCommandSpy(cmd, payload)
}));
vi.mock('../../../lib/snapshot-store.svelte', () => ({
  snapshotStore: {
    markPending: vi.fn(),
    onceAck: vi.fn()
  }
}));

beforeEach(() => {
  postCommandSpy.mockClear();
});
afterEach(() => cleanup());

function buildGeneralSettings(autoCompact: number | undefined): GeneralSettings {
  return Object.freeze({
    ...IDLE_GENERAL_SETTINGS,
    claudeAutoCompactPctOverride: autoCompact,
    scopes: Object.freeze({
      ...IDLE_GENERAL_SETTINGS.scopes,
      claudeAutoCompactPctOverride: autoCompact === undefined ? 'default' : 'workspace'
    })
  }) as unknown as GeneralSettings;
}

function buildSnapshot(gs: GeneralSettings): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: 4,
    isPrimary: true,
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
    availablePipelines: Object.freeze([]),
    availablePhases: Object.freeze([]),
    availableModels: Object.freeze([]),
    generalSettings: gs
  }) as unknown as unknown as WorkflowSnapshot;
}

describe('Feature 012 — GeneralSettingsTab autoCompactPctOverride field', () => {
  it('renders the field with empty value when override is undefined', () => {
    const snap = buildSnapshot(buildGeneralSettings(undefined));
    const { container } = render(GeneralSettingsTab, { props: { snapshot: snap } });
    const input = container.querySelector(
      '[data-testid="general-settings-input-claudeAutoCompactPctOverride"]'
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input!.type).toBe('number');
    expect(input!.min).toBe('1');
    expect(input!.max).toBe('100');
    expect(input!.value).toBe('');
  });

  it('renders the field populated with 80 when override is 80', () => {
    const snap = buildSnapshot(buildGeneralSettings(80));
    const { container } = render(GeneralSettingsTab, { props: { snapshot: snap } });
    const input = container.querySelector(
      '[data-testid="general-settings-input-claudeAutoCompactPctOverride"]'
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input!.value).toBe('80');
  });

  it('dispatches { "claude.autoCompactPctOverride": <int> } on save', async () => {
    const snap = buildSnapshot(buildGeneralSettings(undefined));
    const { container } = render(GeneralSettingsTab, { props: { snapshot: snap } });
    const input = container.querySelector(
      '[data-testid="general-settings-input-claudeAutoCompactPctOverride"]'
    ) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: '50' } });
    const saveBtn = container.querySelector(
      '[data-testid="general-settings-save-claudeAutoCompactPctOverride"]'
    ) as HTMLButtonElement;
    await fireEvent.click(saveBtn);
    expect(postCommandSpy).toHaveBeenCalledOnce();
    const [cmd, payload] = postCommandSpy.mock.calls[0];
    expect(cmd).toBe(CMD_SAVE_GENERAL_SETTINGS);
    expect(payload).toEqual({ updates: { 'claude.autoCompactPctOverride': 50 } });
  });

  it('dispatches { "claude.autoCompactPctOverride": null } when input is cleared', async () => {
    const snap = buildSnapshot(buildGeneralSettings(50));
    const { container } = render(GeneralSettingsTab, { props: { snapshot: snap } });
    const input = container.querySelector(
      '[data-testid="general-settings-input-claudeAutoCompactPctOverride"]'
    ) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: '' } });
    const saveBtn = container.querySelector(
      '[data-testid="general-settings-save-claudeAutoCompactPctOverride"]'
    ) as HTMLButtonElement;
    await fireEvent.click(saveBtn);
    expect(postCommandSpy).toHaveBeenCalledOnce();
    const [, payload] = postCommandSpy.mock.calls[0];
    expect(payload).toEqual({ updates: { 'claude.autoCompactPctOverride': null } });
  });
});

// Feature 285 (OD-2, FR-003) — the default select lists the effective Workflows, never a
// Pipeline row, and saves `defaultWorkflowId`. This file renders GeneralSettingsTab already.
describe('Feature 285 — GeneralSettingsTab default Workflow select', () => {
  function snapshotWith(defaultWorkflowId: string): WorkflowSnapshot {
    const gs = Object.freeze({ ...IDLE_GENERAL_SETTINGS, defaultWorkflowId }) as GeneralSettings;
    return Object.freeze({
      ...buildSnapshot(gs),
      availablePipelines: Object.freeze([{ id: 'legacy-pipe', name: 'Legacy Pipe' }]),
      workflowCatalog: Object.freeze({
        effective: Object.freeze([{ workflowId: 'wf-ship', name: 'Ship It' }])
      })
    }) as unknown as WorkflowSnapshot;
  }

  function selectOf(container: HTMLElement): HTMLSelectElement {
    const select = container.querySelector(
      '[data-testid="general-settings-input-defaultWorkflowId"]'
    );
    expect(select).not.toBeNull();
    return select as HTMLSelectElement;
  }

  it('lists the effective Workflows and no Pipeline row', () => {
    const { container } = render(GeneralSettingsTab, { props: { snapshot: snapshotWith('') } });
    const labels = Array.from(selectOf(container).options).map((o) => o.textContent.trim());
    expect(labels).toEqual(['No default', 'Ship It (wf-ship)']);
  });

  it('keeps a stored value no effective Workflow carries as its own row', () => {
    const { container } = render(GeneralSettingsTab, {
      props: { snapshot: snapshotWith('legacy-pipe') }
    });
    const select = selectOf(container);
    expect(select.value).toBe('legacy-pipe');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['legacy-pipe', 'wf-ship']);
  });

  it('saves the choice under `defaultWorkflowId`', async () => {
    const { container } = render(GeneralSettingsTab, { props: { snapshot: snapshotWith('') } });
    const select = selectOf(container);
    select.value = 'wf-ship';
    await fireEvent.change(select);
    const saveBtn = container.querySelector(
      '[data-testid="general-settings-save-defaultWorkflowId"]'
    ) as HTMLButtonElement;
    await fireEvent.click(saveBtn);
    expect(postCommandSpy).toHaveBeenCalledOnce();
    const call = postCommandSpy.mock.calls.at(0);
    expect(call?.at(1)).toEqual({ updates: { defaultWorkflowId: 'wf-ship' } });
  });
});
