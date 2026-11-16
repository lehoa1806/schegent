// The Settings surface: the settings page of the redesign mockup (`schegent_redesign_surfaces.html`).
//
// Covers:
//   - The section navigation: the mockup's sections in its order and words, Backends first and
//     current, one section shown at a time, and the mockup's dot on a section with unsaved edits.
//   - Every part of the page stays mounted while its section is hidden, so an edit in a hidden
//     section is still counted, saved and reverted (the one save model below edits the loop limit
//     and the failure signatures, both in sections hidden on arrival).
//   - The legacy Phases / Pipelines / Models sub-tabs stay gone (Feature 012 T040).
//   - The page's one save model: the header's count, Revert and Save.

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

// Settings redesign — the section navigation (M1: `SET_SECS`, `st.setSec` and the `.set-nav`
// markup). A `nav` of buttons, the current one marked with `aria-current`; a click shows that
// section and leaves focus on the button.
describe('Settings redesign — the section navigation', () => {
  const SECTIONS = [
    ['backends', 'Backends'],
    ['execution', 'Runs and retries'],
    ['logging', 'Logs and retention'],
    ['privacy', 'Privacy and evidence'],
    ['trust', 'Trust and prompts'],
    ['signatures', 'Failure signatures']
  ] as const;

  function renderSurface() {
    return render(SettingsSurface, { props: { snapshot: buildSnapshot() } });
  }

  function navButton(container: HTMLElement, id: string): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(`nav [data-testid="settings-nav-${id}"]`);
    if (button === null) throw new Error(`no section button for ${id}`);
    return button;
  }

  function shownSections(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll<HTMLElement>('[data-testid^="settings-section-"]'))
      .filter((section) => !section.hidden)
      .map((section) => section.getAttribute('data-testid') ?? '');
  }

  function markedSections(container: HTMLElement): string[] {
    return SECTIONS.filter(([id]) => navButton(container, id).querySelector('.mod') !== null)
      .map(([id]) => id);
  }

  it('lists the mockup sections in a navigation landmark, Backends first and current', () => {
    const { container } = renderSurface();
    const nav = container.querySelector('nav.set-nav');
    expect(nav?.getAttribute('aria-label')).toBe('Settings sections');
    const buttons = Array.from(nav?.querySelectorAll('button') ?? []);
    expect(buttons.map((button) => [button.getAttribute('data-testid'), button.textContent.trim()]))
      .toEqual(SECTIONS.map(([id, label]) => [`settings-nav-${id}`, label]));
    expect(buttons.map((button) => button.getAttribute('aria-current')))
      .toEqual(['true', null, null, null, null, null]);
    expect(container.querySelector('[role="tablist"], [role="tab"], [role="tabpanel"]')).toBeNull();
  });

  it('shows one section at a time, each named by its heading', () => {
    const { container } = renderSurface();
    expect(shownSections(container)).toEqual(['settings-section-backends']);
    for (const [id, label] of SECTIONS) {
      const section = container.querySelector(`section[data-testid="settings-section-${id}"]`);
      const heading = container.querySelector(`[id="${section?.getAttribute('aria-labelledby') ?? ''}"]`);
      expect(heading?.tagName, id).toBe('H2');
      expect(heading?.textContent.trim(), id).toBe(label);
    }
  });

  it('shows the section a button names, marks it current, and keeps focus on the button', async () => {
    const { container } = renderSurface();
    const runs = navButton(container, 'execution');
    runs.focus();
    await fireEvent.click(runs);

    expect(shownSections(container)).toEqual(['settings-section-execution']);
    expect(runs.getAttribute('aria-current')).toBe('true');
    expect(navButton(container, 'backends').hasAttribute('aria-current')).toBe(false);
    expect(document.activeElement).toBe(runs);
  });

  it('puts each part of the page in the section the mockup gives it', () => {
    const { getByTestId } = renderSurface();
    const parts: ReadonlyArray<readonly [string, string]> = [
      ['backends', 'settings-group-backend-environment'],
      ['execution', 'settings-group-execution-retry'],
      ['logging', 'settings-group-audit-logging'],
      ['privacy', 'privacy-profiles'],
      ['privacy', 'session-artifact-usage'],
      ['trust', 'settings-group-ui-trust'],
      ['signatures', 'settings-fatal-signatures-tab']
    ];
    for (const [section, part] of parts) {
      expect(getByTestId(`settings-section-${section}`).contains(getByTestId(part)), part).toBe(true);
    }
  });

  // "Review in Settings" on a launch notice opens this page fresh and scrolls to the Backend
  // health heading (`dashboard/App.svelte`). The scroll only lands while that heading is in the
  // section the page opens on, since a hidden section has no box to scroll to.
  it('opens on the section that holds the Backend health heading a launch notice scrolls to', () => {
    const { container } = renderSurface();
    const heading = container.querySelector('#backend-health-heading');
    expect(heading?.closest('[data-testid^="settings-section-"]')?.getAttribute('data-testid'))
      .toBe('settings-section-backends');
    expect(shownSections(container)).toEqual(['settings-section-backends']);
  });

  it('marks a section that holds an unsaved edit with the mockup dot, until Revert', async () => {
    const { container, getByTestId } = renderSurface();
    expect(markedSections(container)).toEqual([]);

    await fireEvent.input(getByTestId('general-settings-input-loopMaxIterations'), { target: { value: '7' } });
    await fireEvent.click(getByTestId('fatal-add'));
    expect(markedSections(container)).toEqual(['execution', 'signatures']);
    const dot = navButton(container, 'execution').querySelector('.mod');
    expect(dot?.getAttribute('role')).toBe('img');
    expect(dot?.getAttribute('aria-label')).toBe('has unsaved changes');

    await fireEvent.click(getByTestId('settings-revert'));
    expect(markedSections(container)).toEqual([]);
  });

  it('associates every general setting control with its visible field name', () => {
    const { container } = renderSurface();
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

  // Feature 012 T040 — Phases, Pipelines and Models left Settings for the Workflow builder, and
  // neither their sub-tab buttons nor their tab markup may come back as sections.
  it.each(['phases', 'pipelines', 'models'])('has no %s section, sub-tab or tab markup', (name) => {
    const { container } = renderSurface();
    expect(container.querySelector(
      `[data-testid="settings-nav-${name}"], [data-testid="settings-tab-${name}"], [data-testid="settings-${name}-tab"]`
    )).toBeNull();
    const labels = Array.from(container.querySelectorAll('nav button')).map((button) => button.textContent.trim());
    expect(labels.map((label) => label.toLowerCase())).not.toContain(name);
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
