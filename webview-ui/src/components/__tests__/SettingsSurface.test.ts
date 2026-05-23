// Feature 012 T040 — Settings sub-tab list reduced to {General, Fatal Signatures}.
// Feature 014 — Wake up sub-tab appended to the surface.
// Feature 017 — Queue sub-tab appended to the surface.
//
// Covers:
//   - Four sub-tab buttons render with stable data-testids.
//   - Order: General → Fatal Signatures → Queue → Wake Up.
//   - The legacy Phases / Pipelines / Models sub-tab buttons are gone.
//   - No PhasesTab / PipelinesTab / ModelsTab mount inside SettingsSurface.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import SettingsSurface from '../SettingsSurface.svelte';
import type { WorkflowSnapshot } from '../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../lib/snapshot-types';

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'corr-test' }))
}));
vi.mock('../../lib/snapshot-store.svelte', () => ({
  snapshotStore: {
    markPending: vi.fn(),
    onceAck: vi.fn()
  }
}));

afterEach(() => cleanup());

function buildSnapshot(): WorkflowSnapshot {
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
    availablePipelines: Object.freeze([]),
    availablePhases: Object.freeze([]),
    availableModels: Object.freeze([]),
    generalSettings: IDLE_GENERAL_SETTINGS
  }) as unknown as unknown as WorkflowSnapshot;
}

describe('Feature 012 T040 — SettingsSurface sub-tab list', () => {
  it('renders three sub-tab buttons in order: general, fatal-signatures, wake-up', () => {
    // Feature 030 (US3, T045) — the Queue sub-tab (`settings-tab-queue`)
    // was removed alongside QueueSettingsTab.svelte. The single unified
    // queue has no per-queue settings to render; concurrency and queue
    // defaults moved to General. Order is now general → fatal-signatures
    // → wake-up.
    const { container } = render(SettingsSurface, {
      props: { snapshot: buildSnapshot() }
    });
    const buttons = container.querySelectorAll('[data-testid^="settings-tab-"]');
    expect(buttons.length).toBe(3);
    expect(buttons[0].getAttribute('data-testid')).toBe('settings-tab-general');
    expect(buttons[1].getAttribute('data-testid')).toBe('settings-tab-fatal-signatures');
    expect(buttons[2].getAttribute('data-testid')).toBe('settings-tab-wakeup');
  });

  it('does NOT render the Phases sub-tab button', () => {
    const { container } = render(SettingsSurface, {
      props: { snapshot: buildSnapshot() }
    });
    expect(container.querySelector('[data-testid="settings-tab-phases"]')).toBeNull();
  });

  it('does NOT render the Pipelines sub-tab button', () => {
    const { container } = render(SettingsSurface, {
      props: { snapshot: buildSnapshot() }
    });
    expect(container.querySelector('[data-testid="settings-tab-pipelines"]')).toBeNull();
  });

  it('does NOT render the Models sub-tab button', () => {
    const { container } = render(SettingsSurface, {
      props: { snapshot: buildSnapshot() }
    });
    expect(container.querySelector('[data-testid="settings-tab-models"]')).toBeNull();
  });

  it('does NOT mount PhasesTab markup (no settings-phases-tab testid)', () => {
    const { container } = render(SettingsSurface, {
      props: { snapshot: buildSnapshot() }
    });
    expect(container.querySelector('[data-testid="settings-phases-tab"]')).toBeNull();
  });

  it('does NOT mount PipelinesTab markup (no settings-pipelines-tab testid)', () => {
    const { container } = render(SettingsSurface, {
      props: { snapshot: buildSnapshot() }
    });
    expect(container.querySelector('[data-testid="settings-pipelines-tab"]')).toBeNull();
  });

  it('does NOT mount ModelsTab markup (no settings-models-tab testid)', () => {
    const { container } = render(SettingsSurface, {
      props: { snapshot: buildSnapshot() }
    });
    expect(container.querySelector('[data-testid="settings-models-tab"]')).toBeNull();
  });
});
