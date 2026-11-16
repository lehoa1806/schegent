// Feature 012 T040 — Settings sub-tab list reduced to {General, Fatal Signatures}.
// Feature 017 — Queue sub-tab appended to the surface.
//
// Covers:
//   - Four sub-tab buttons render with stable data-testids.
//   - Order: General → Fatal Signatures.
//   - The legacy Phases / Pipelines / Models sub-tab buttons are gone.
//   - No PhasesTab / PipelinesTab / ModelsTab mount inside SettingsSurface.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import SettingsSurface from '../SettingsSurface.svelte';
import type { WorkflowSnapshot } from '../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../lib/snapshot-types';
import { foldLegacyRun } from '../../lib/__tests__/queue-runtime-fixture';
import { postCommand } from '../../lib/vscode-api';

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'corr-test' }))
}));
vi.mock('../../lib/snapshot-store.svelte', () => ({
  snapshotStore: {
    markPending: vi.fn(),
    onceAck: vi.fn()
  }
}));

afterEach(() => {
  cleanup();
  vi.mocked(postCommand).mockClear();
});

function isDisabled(element: HTMLElement): boolean {
  return (element as HTMLButtonElement).disabled;
}

/** The payload of every command posted so far, in order. */
function postedPayloads(): unknown[] {
  return vi.mocked(postCommand).mock.calls.map((call) => call[1]);
}

function buildSnapshot(): WorkflowSnapshot {
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
    generalSettings: IDLE_GENERAL_SETTINGS
  }) as unknown as unknown as WorkflowSnapshot;
}

describe('Feature 012 T040 — SettingsSurface sub-tab list', () => {
  it('renders two sub-tab buttons in order: general, fatal-signatures', () => {
    // Feature 030 (US3, T045) — the Queue sub-tab (`settings-tab-queue`)
    // was removed alongside QueueSettingsTab.svelte. The single unified
    // queue has no per-queue settings to render; concurrency and queue
    // defaults moved to General. The Wake up sub-tab was removed with
    // the Wake-up capability. Order is now general → fatal-signatures.
    const { container } = render(SettingsSurface, {
      props: { snapshot: buildSnapshot() }
    });
    const buttons = container.querySelectorAll('[data-testid^="settings-tab-"]');
    expect(buttons.length).toBe(2);
    expect(buttons[0].getAttribute('data-testid')).toBe('settings-tab-general');
    expect(buttons[1].getAttribute('data-testid')).toBe('settings-tab-fatal-signatures');
  });

  it('implements named tabs with roving focus and arrow-key navigation', async () => {
    const { getByTestId, container } = render(SettingsSurface, {
      props: { snapshot: buildSnapshot() }
    });
    const tablist = container.querySelector('[role="tablist"]');
    const general = getByTestId('settings-tab-general');
    const fatal = getByTestId('settings-tab-fatal-signatures');
    expect(tablist?.getAttribute('aria-label')).toBe('Settings sections');
    expect(general.getAttribute('role')).toBe('tab');
    expect(general.getAttribute('aria-selected')).toBe('true');
    expect(general.getAttribute('tabindex')).toBe('0');
    expect(fatal.getAttribute('tabindex')).toBe('-1');

    await fireEvent.keyDown(general, { key: 'ArrowDown' });
    await Promise.resolve();
    expect(fatal.getAttribute('aria-selected')).toBe('true');
    expect(fatal.getAttribute('tabindex')).toBe('0');
    expect(document.activeElement).toBe(fatal);
    expect(container.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby'))
      .toBe('settings-tab-fatal-signatures');
  });

  it('associates every general setting control with its visible field name', () => {
    const { container } = render(SettingsSurface, {
      props: { snapshot: buildSnapshot() }
    });
    const controls = container.querySelectorAll('[data-testid^="general-settings-input-"]');
    expect(controls.length).toBeGreaterThan(0);
    for (const control of Array.from(controls)) {
      // The field name, then a number's unit when it has one.
      const ids = (control.getAttribute('aria-labelledby') ?? '').split(' ').filter(Boolean);
      expect(ids.length, control.outerHTML).toBeGreaterThan(0);
      for (const id of ids) {
        expect(container.querySelector(`[id="${id}"]`)?.textContent.trim(), control.outerHTML)
          .toBeTruthy();
      }
    }
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

// Settings redesign — "One save model per page" (M1, Rules): edits accumulate, the header counts
// them and offers one Revert and one Save, and a changed row carries a dot. No row and no part of
// the page has a Save or Reset of its own.
describe('Settings redesign — one save model for the page', () => {
  function renderSurface() {
    return render(SettingsSurface, { props: { snapshot: buildSnapshot() } });
  }

  async function editLoopLimit(getByTestId: (id: string) => HTMLElement, value: string): Promise<void> {
    await fireEvent.input(getByTestId('general-settings-input-loopMaxIterations'), { target: { value } });
  }

  async function addSignature(getByTestId: (id: string) => HTMLElement, value: string): Promise<void> {
    await fireEvent.click(getByTestId('fatal-add'));
    if (value !== '') {
      await fireEvent.input(getByTestId('fatal-operator-input-0'), { target: { value } });
    }
  }

  it('heads the page with its title, the mockup purpose, and one Revert and Save, off while nothing changed', () => {
    const { getByTestId, container } = renderSurface();
    expect(container.querySelector('h1')?.textContent.trim()).toBe('Settings');
    expect(getByTestId('settings-purpose').textContent.trim())
      .toBe('Changes apply when you save. Each setting shows where it applies.');
    expect(getByTestId('settings-revert').textContent.trim()).toBe('Revert');
    expect(getByTestId('settings-save').textContent.trim()).toBe('Save');
    expect(isDisabled(getByTestId('settings-revert'))).toBe(true);
    expect(isDisabled(getByTestId('settings-save'))).toBe(true);
    expect(container.querySelector('[data-testid="settings-unsaved"]')).toBeNull();
  });

  it('gives no row and no part of the page a Save or Reset of its own', () => {
    const { container } = renderSurface();
    expect(container.querySelectorAll(
      '[data-testid^="general-settings-save-"], [data-testid^="general-settings-reset-"]'
    ).length).toBe(0);
    expect(container.querySelector('[data-testid="fatal-save"], [data-testid="fatal-reset"]')).toBeNull();
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent.trim());
    expect(labels.filter((label) => /^(Save|Reset|Revert)\b/.test(label))).toEqual(['Revert', 'Save']);
  });

  it('counts each edit in the header and marks the changed row with the mockup dot', async () => {
    const { getByTestId } = renderSurface();
    await editLoopLimit(getByTestId, '7');
    expect(getByTestId('settings-unsaved').textContent.trim()).toBe('1 unsaved change');
    const dot = getByTestId('general-settings-field-loopMaxIterations').querySelector('.lab .mod');
    expect(dot?.getAttribute('role')).toBe('img');
    expect(dot?.getAttribute('aria-label')).toBe('changed, not saved');
    expect(isDisabled(getByTestId('settings-save'))).toBe(false);
    expect(isDisabled(getByTestId('settings-revert'))).toBe(false);

    await addSignature(getByTestId, 'quota exceeded for project');
    expect(getByTestId('settings-unsaved').textContent.trim()).toBe('2 unsaved changes');
  });

  it('saves every part that has changes from the one Save: the fields as one batch, the signatures as theirs', async () => {
    const { getByTestId } = renderSurface();
    await editLoopLimit(getByTestId, '7');
    await fireEvent.input(getByTestId('general-settings-input-watchdogPollIntervalMinutes'), {
      target: { value: '15' }
    });
    await addSignature(getByTestId, ' quota exceeded for project ');

    await fireEvent.click(getByTestId('settings-save'));

    await vi.waitFor(() => expect(postCommand).toHaveBeenCalledTimes(2));
    expect(postedPayloads()).toContainEqual({
      updates: { 'loop.maxIterations': 7, 'watchdog.pollIntervalMinutes': 15 }
    });
    expect(postedPayloads()).toContainEqual({ updates: { fatalSignatures: ['quota exceeded for project'] } });
  });

  it('Revert drops every unsaved edit and writes nothing', async () => {
    const { getByTestId, queryByTestId } = renderSurface();
    await editLoopLimit(getByTestId, '7');
    await addSignature(getByTestId, 'quota exceeded for project');

    await fireEvent.click(getByTestId('settings-revert'));

    expect((getByTestId('general-settings-input-loopMaxIterations') as HTMLInputElement).value).toBe('10');
    expect(queryByTestId('fatal-operator-input-0')).toBeNull();
    expect(queryByTestId('settings-unsaved')).toBeNull();
    expect(isDisabled(getByTestId('settings-save'))).toBe(true);
    expect(postCommand).not.toHaveBeenCalled();
  });

  it('saves what it can while a signature row is still empty, and leaves that row to be finished', async () => {
    const { getByTestId } = renderSurface();
    await editLoopLimit(getByTestId, '7');
    await addSignature(getByTestId, '');
    expect(getByTestId('settings-unsaved').textContent.trim()).toBe('2 unsaved changes');
    expect(isDisabled(getByTestId('settings-save'))).toBe(false);

    await fireEvent.click(getByTestId('settings-save'));

    await vi.waitFor(() => expect(postCommand).toHaveBeenCalledTimes(1));
    expect(postedPayloads()).toEqual([{ updates: { 'loop.maxIterations': 7 } }]);
    expect(getByTestId('fatal-operator-warning-empty')).toBeTruthy();
  });

  it('keeps Save off while the only change is one that cannot be saved yet', async () => {
    const { getByTestId } = renderSurface();
    await addSignature(getByTestId, '');
    expect(getByTestId('settings-unsaved').textContent.trim()).toBe('1 unsaved change');
    expect(isDisabled(getByTestId('settings-save'))).toBe(true);
    expect(isDisabled(getByTestId('settings-revert'))).toBe(false);
  });

  it('sets a privacy profile in the draft on a press, and writes its five settings with the page Save', async () => {
    const { getByTestId } = renderSurface();
    await fireEvent.click(getByTestId('privacy-profile-apply-forensic'));

    expect(postCommand).not.toHaveBeenCalled();
    expect(getByTestId('privacy-profile-apply-forensic').getAttribute('aria-pressed')).toBe('true');
    expect(getByTestId('settings-unsaved').textContent.trim()).toBe('5 unsaved changes');

    await fireEvent.click(getByTestId('settings-save'));

    await vi.waitFor(() => expect(postCommand).toHaveBeenCalledTimes(1));
    expect(postedPayloads()).toEqual([{
      updates: {
        'logging.verbose': true,
        'logging.rawTranscriptMode': 'always',
        'logging.sessionRetentionMaxAgeDays': 365,
        'logging.sessionRetentionMaxBytes': 4 * 1024 * 1024 * 1024,
        'logging.transportCaptureMode': 'on'
      }
    }]);
  });
});
