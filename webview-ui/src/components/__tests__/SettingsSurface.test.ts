// The Settings surface: the settings page of the redesign mockup (`schegent_redesign_surfaces.html`).
//
// Covers:
//   - The section navigation: the mockup's sections in its order and words, Backends first and
//     current unless the page is opened on another, one section shown at a time, and the
//     mockup's dot on a section with unsaved edits.
//   - Every part of the page stays mounted while its section is hidden, so an edit in a hidden
//     section is still counted, saved and reverted (the one save model below edits the loop limit
//     and the failure signatures, both in sections hidden on arrival).
//   - The legacy Phases / Pipelines / Models sub-tabs stay gone (Feature 012 T040).
//   - The page's one save model: the header's count, Revert and Save.
//   - The header's "Search settings" field: what the page shows while it holds a word, and that
//     a search changes nothing about what is counted and saved.
//   - A save the host refuses comes into sight, wherever on the page the refused setting is.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import SettingsSurface from '../SettingsSurface.svelte';
import type { WorkflowSnapshot } from '../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../lib/snapshot-types';
import { FATAL_SIGNATURES } from '../../lib/fatal-signature-registry';
import { buildQueueRuntime, foldLegacyRun } from '../../lib/__tests__/queue-runtime-fixture';
import { postCommand } from '../../lib/vscode-api';
import { snapshotStore, type AckListener } from '../../lib/snapshot-store.svelte';

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

function navButton(container: HTMLElement, id: string): HTMLButtonElement {
  const selector = `nav [data-testid="settings-nav-${id}"]`;
  const button = container.querySelector<HTMLButtonElement>(selector);
  if (button === null) throw new Error(`no section button for ${id}`);
  return button;
}

function shownSections(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-testid^="settings-section-"]'))
    .filter((section) => !section.hidden)
    .map((section) => section.getAttribute('data-testid') ?? '');
}

async function fill(
  getByTestId: (id: string) => HTMLElement,
  id: string,
  text: string
): Promise<void> {
  await fireEvent.input(getByTestId(id), { target: { value: text } });
}

/** True when neither the element nor anything around it is hidden. */
function isShown(element: Element): boolean {
  return element.closest('[hidden]') === null;
}

// Settings redesign — the section navigation (M1: `SET_SECS`, `st.setSec` and the `.set-nav`
// markup). A `nav` of buttons, the current one marked with `aria-current`; a click shows that
// section and leaves focus on the button.
describe('Settings redesign — the section navigation', () => {
  const SECTIONS = [
    ['backends', 'Backends'],
    ['execution', 'Runs and retries'],
    ['queues', 'Queues'],
    ['logging', 'Logs and retention'],
    ['privacy', 'Privacy and evidence'],
    ['trust', 'Trust and prompts'],
    ['signatures', 'Failure signatures']
  ] as const;

  function renderSurface() {
    return render(SettingsSurface, { props: { snapshot: buildSnapshot() } });
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
      .toEqual(['true', null, null, null, null, null, null]);
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
      ['queues', 'queue-defaults'],
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

  // "Review in Settings" on a launch notice opens this page fresh and scrolls to the Installed
  // backends heading (`dashboard/App.svelte`). The scroll only lands while that heading is in the
  // section the page opens on, since a hidden section has no box to scroll to.
  it('opens on the section that holds the Installed backends heading a launch notice scrolls to', () => {
    const { container } = renderSurface();
    const heading = container.querySelector('#backend-health-heading');
    expect(heading?.closest('[data-testid^="settings-section-"]')?.getAttribute('data-testid'))
      .toBe('settings-section-backends');
    expect(shownSections(container)).toEqual(['settings-section-backends']);
  });

  // The Queues list's "Queue defaults" opens this page on its Queues section
  // (`dashboard/App.svelte`), as the mockup's button carries `data-sec="queues"`.
  it('opens on the section it is given, marked current', () => {
    const { container } = render(SettingsSurface, {
      props: { snapshot: buildSnapshot(), section: 'queues' }
    });
    expect(shownSections(container)).toEqual(['settings-section-queues']);
    expect(navButton(container, 'queues').getAttribute('aria-current')).toBe('true');
    expect(navButton(container, 'backends').hasAttribute('aria-current')).toBe(false);
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

// Settings redesign — the "Search settings" field (M1: `search('Search settings')`, the first of
// the page header's actions). The mockup draws the field and gives it no behaviour. Here it
// filters the page, as the port's other mockup search fields filter theirs: while it holds a word
// the page shows every section that holds a matching setting, each under its name, and in them
// only the settings that match. `settings-search.test.ts` holds the rules for what a query finds,
// `SettingsPageHeader.test.ts` the field itself and its status line.
describe('Settings redesign — the search field', () => {
  /** A built-in failure signature, as the "Built in" list shows it. */
  const BUILT_IN_ENTRY = 'Autocompact is thrashing';
  const FIELD_ROWS = '[data-testid^="general-settings-field-"]';

  function renderSurface(snapshot: WorkflowSnapshot = buildSnapshot()) {
    return render(SettingsSurface, { props: { snapshot } });
  }

  async function search(getByTestId: (id: string) => HTMLElement, text: string): Promise<void> {
    await fill(getByTestId, 'settings-search', text);
  }

  /** The field rows on screen, by test id, in page order. */
  function shownRows(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll(FIELD_ROWS))
      .filter(isShown)
      .map((row) => row.getAttribute('data-testid') ?? '');
  }

  function byId(container: HTMLElement, id: string): HTMLElement {
    const element = container.querySelector<HTMLElement>(`#${id}`);
    if (element === null) throw new Error(`nothing has the id ${id}`);
    return element;
  }

  it('finds a setting by its key and shows it alone, in its section', async () => {
    const { container, getByTestId } = renderSurface();

    await search(getByTestId, 'schegent.retry.maxAttempts');

    expect(shownSections(container)).toEqual(['settings-section-execution']);
    expect(shownRows(container)).toEqual(['general-settings-field-retryMaxAttempts']);
  });

  it('names each section it shows, and hides the name again when the search ends', async () => {
    const { container, getByTestId } = renderSurface();
    const heading = byId(container, 'settings-section-execution-heading');
    expect(heading.classList.contains('sr-only')).toBe(true);

    await search(getByTestId, 'schegent.retry.maxAttempts');
    expect(heading.classList.contains('sr-only')).toBe(false);
    expect(heading.textContent.trim()).toBe('Runs and retries');

    await search(getByTestId, '');
    expect(heading.classList.contains('sr-only')).toBe(true);
  });

  it('shows every setting of a section that is found by its name', async () => {
    const { container, getByTestId } = renderSurface();

    await search(getByTestId, 'logs and retention');

    expect(shownSections(container)).toContain('settings-section-logging');
    const logging = getByTestId('settings-section-logging');
    const rows = Array.from(logging.querySelectorAll(FIELD_ROWS));
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.filter(isShown).length).toBe(rows.length);
  });

  it('finds the words in any order and any case', async () => {
    const { container, getByTestId } = renderSurface();

    await search(getByTestId, 'loop limit');
    const found = shownRows(container);
    expect(found).toContain('general-settings-field-loopMaxIterations');

    await search(getByTestId, '  LIMIT   Loop ');
    expect(shownRows(container)).toEqual(found);
  });

  it('marks no section as current while it searches', async () => {
    const { container, getByTestId } = renderSurface();
    await fireEvent.click(navButton(container, 'trust'));
    expect(navButton(container, 'trust').getAttribute('aria-current')).toBe('true');

    await search(getByTestId, 'loop limit');

    expect(container.querySelectorAll('nav [aria-current]').length).toBe(0);
  });

  it('ends the search when a section is chosen, and shows that section', async () => {
    const { container, getByTestId } = renderSurface();
    await search(getByTestId, 'loop limit');

    await fireEvent.click(navButton(container, 'logging'));

    expect((getByTestId('settings-search') as HTMLInputElement).value).toBe('');
    expect(shownSections(container)).toEqual(['settings-section-logging']);
    expect(navButton(container, 'logging').getAttribute('aria-current')).toBe('true');
  });

  it('returns to the section it showed, with every row, when the field is emptied', async () => {
    const { container, getByTestId } = renderSurface();
    await fireEvent.click(navButton(container, 'trust'));
    const hiddenBefore = Array.from(container.querySelectorAll('[hidden]'));

    await search(getByTestId, 'loop limit');
    await search(getByTestId, '');

    expect(shownSections(container)).toEqual(['settings-section-trust']);
    expect(navButton(container, 'trust').getAttribute('aria-current')).toBe('true');
    const hiddenAfter = Array.from(container.querySelectorAll('[hidden]'));
    expect(hiddenAfter.length).toBe(hiddenBefore.length);
    expect(hiddenAfter.every((element, index) => element === hiddenBefore[index])).toBe(true);
  });

  it('says so in the page when nothing matches', async () => {
    const { container, getByTestId, queryByTestId } = renderSurface();
    expect(queryByTestId('settings-search-empty')).toBeNull();

    await search(getByTestId, '  no-such-setting ');
    const empty = getByTestId('settings-search-empty');
    expect(empty.textContent.trim()).toBe('No setting matches "no-such-setting".');
    expect(getByTestId('settings-body').contains(empty)).toBe(true);
    expect(shownSections(container)).toEqual([]);
    // The header's status line is the one live region; this line is plain text.
    expect(empty.hasAttribute('role')).toBe(false);
    expect(empty.hasAttribute('aria-live')).toBe(false);

    await search(getByTestId, 'loop limit');
    expect(queryByTestId('settings-search-empty')).toBeNull();
  });

  it('shows the words typed as text, never as markup', async () => {
    const { getByTestId } = renderSurface();

    await search(getByTestId, '<b>x</b>');

    const empty = getByTestId('settings-search-empty');
    expect(empty.textContent.trim()).toBe('No setting matches "<b>x</b>".');
    expect(empty.querySelector('b')).toBeNull();
  });

  it('opens the backend card that holds a match, and hides the other cards', async () => {
    const { getByTestId } = renderSurface();
    expect(getByTestId('backend-details-codex').hidden).toBe(true);

    await search(getByTestId, 'schegent.codex.path');

    expect(getByTestId('backend-details-codex').hidden).toBe(false);
    expect(getByTestId('backend-details-toggle-codex').getAttribute('aria-expanded')).toBe('true');
    expect(isShown(getByTestId('backend-health-codex'))).toBe(true);
    expect(isShown(getByTestId('backend-health-claude'))).toBe(false);
    expect(isShown(getByTestId('backend-health-agy'))).toBe(false);
  });

  it('lets the Details link close a card that a match opened', async () => {
    const { getByTestId } = renderSurface();
    await search(getByTestId, 'schegent.codex.path');

    await fireEvent.click(getByTestId('backend-details-toggle-codex'));

    expect(getByTestId('backend-details-codex').hidden).toBe(true);
    expect(isShown(getByTestId('backend-health-codex'))).toBe(true);
  });

  it('closes a card that a match opened once the search ends', async () => {
    const { getByTestId } = renderSurface();
    await search(getByTestId, 'schegent.codex.path');

    await search(getByTestId, '');

    expect(getByTestId('backend-details-codex').hidden).toBe(true);
  });

  it('hides a block of a backend card when no setting inside it matches', async () => {
    const { getByTestId } = renderSurface();
    // A card's Details draw a line round each block of rows; a block with no row shown would
    // leave its line behind.
    const blockOf = (rowId: string): HTMLElement => {
      const block = getByTestId(rowId).parentElement;
      if (block === null) throw new Error(`${rowId} stands in no block`);
      return block;
    };
    const pathBlock = blockOf('general-settings-field-cliPath');
    const ownBlock = blockOf('general-settings-field-claudeAutoCompactPctOverride');

    await search(getByTestId, 'schegent.claude.autoCompactPctOverride');
    expect(pathBlock.hidden).toBe(true);
    expect(ownBlock.hidden).toBe(false);

    await search(getByTestId, 'schegent.cli.path');
    expect(pathBlock.hidden).toBe(false);
    expect(ownBlock.hidden).toBe(true);

    await search(getByTestId, '');
    expect(pathBlock.hidden).toBe(false);
    expect(ownBlock.hidden).toBe(false);
  });

  it('ends the search when a card action needs a path field the search has hidden', async () => {
    const { container, getByTestId } = renderSurface();
    const row = getByTestId('general-settings-field-cliPath');
    await fireEvent.click(navButton(container, 'execution'));

    await search(getByTestId, 'schegent.claude.autoCompactPctOverride');
    expect(isShown(row)).toBe(false);
    await fireEvent.click(getByTestId('backend-change-path-claude'));

    // The user asked for the field, so the page shows it: the search ends, and the section on
    // screen is the card's own, not the one shown before the search.
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(row.querySelector('input'));
    });
    expect((getByTestId('settings-search') as HTMLInputElement).value).toBe('');
    expect(isShown(row)).toBe(true);
    expect(shownSections(container)).toEqual(['settings-section-backends']);
    expect(navButton(container, 'backends').getAttribute('aria-current')).toBe('true');
  });

  it('keeps the search when a card action needs a path field that is in sight', async () => {
    const { getByTestId } = renderSurface();
    const row = getByTestId('general-settings-field-cliPath');

    await search(getByTestId, 'schegent.cli.path');
    await fireEvent.click(getByTestId('backend-change-path-claude'));

    await vi.waitFor(() => {
      expect(document.activeElement).toBe(row.querySelector('input'));
    });
    expect((getByTestId('settings-search') as HTMLInputElement).value).toBe('schegent.cli.path');
    expect(isShown(row)).toBe(true);
  });

  it('hides a group that holds no match, heading and all', async () => {
    const { container, getByTestId } = renderSurface();

    await search(getByTestId, 'schegent.cli.environmentMode');

    expect(shownSections(container)).toEqual(['settings-section-backends']);
    expect(shownRows(container)).toEqual(['general-settings-field-cliEnvironmentMode']);
    expect(isShown(getByTestId('backend-selection'))).toBe(false);
    expect(isShown(byId(container, 'backend-health-heading'))).toBe(false);
    // The group that holds the match keeps its heading.
    expect(isShown(byId(container, 'process-environment-heading'))).toBe(true);
  });

  it('finds the settings of a group by the group heading', async () => {
    const { container, getByTestId } = renderSurface();

    await search(getByTestId, 'process environment');

    // "Backend check timeout" holds neither word itself; its group's heading holds both.
    const found = shownRows(container);
    expect(found).toContain('general-settings-field-backendProbeTimeoutSeconds');
    expect(found).toContain('general-settings-field-cliEnvironmentMode');
  });

  it('never searches the text of a failure signature, which the user can edit', async () => {
    const { container, getByTestId } = renderSurface();
    await fireEvent.click(getByTestId('fatal-add'));
    await fill(getByTestId, 'fatal-operator-input-0', 'zebra-crossing');

    await search(getByTestId, 'zebra-crossing');
    expect(shownSections(container)).toEqual([]);
    const empty = getByTestId('settings-search-empty').textContent.trim();
    expect(empty).toBe('No setting matches "zebra-crossing".');

    await search(getByTestId, 'your additions');
    expect(shownSections(container)).toEqual(['settings-section-signatures']);
    expect(isShown(getByTestId('fatal-operator-section'))).toBe(true);
    expect(isShown(getByTestId('fatal-built-in-section'))).toBe(false);
    const input = getByTestId('fatal-operator-input-0') as HTMLInputElement;
    expect(input.value).toBe('zebra-crossing');
  });

  it('finds the built-in list by the text of a built-in signature', async () => {
    expect(FATAL_SIGNATURES).toContain(BUILT_IN_ENTRY);
    const { container, getByTestId } = renderSurface();

    await search(getByTestId, BUILT_IN_ENTRY);

    expect(shownSections(container)).toEqual(['settings-section-signatures']);
    expect(isShown(getByTestId('fatal-built-in-section'))).toBe(true);
    expect(isShown(getByTestId('fatal-operator-section'))).toBe(false);
  });

  it('finds a queue by its name, and hides the other rows of the Queues section', async () => {
    const snapshot: WorkflowSnapshot = {
      ...buildSnapshot(),
      queues: Object.freeze([
        buildQueueRuntime({ queueId: 'default', name: 'Default', position: 0 }),
        buildQueueRuntime({ queueId: 'q-gamma', name: 'Review Lane', position: 1 })
      ])
    };
    const { container, getByTestId } = renderSurface(snapshot);

    await search(getByTestId, 'review lane');

    expect(shownSections(container)).toEqual(['settings-section-queues']);
    expect(isShown(getByTestId('queue-failure-policy-row-q-gamma'))).toBe(true);
    expect(isShown(getByTestId('queue-failure-policy-row-default'))).toBe(false);
    expect(isShown(getByTestId('queue-defaults-cap-row'))).toBe(false);
    expect(isShown(getByTestId('queue-defaults-default-queue-row'))).toBe(false);
  });

  it('still counts and saves an edit to a setting the search has hidden', async () => {
    const { getByTestId } = renderSurface();
    await fill(getByTestId, 'general-settings-input-loopMaxIterations', '7');

    await search(getByTestId, 'schegent.codex.path');
    expect(isShown(getByTestId('general-settings-field-loopMaxIterations'))).toBe(false);
    expect(getByTestId('settings-unsaved').textContent.trim()).toBe('1 unsaved change');

    await fireEvent.click(getByTestId('settings-save'));
    await vi.waitFor(() => expect(postCommand).toHaveBeenCalledTimes(1));
    expect(postedPayloads()).toEqual([{ updates: { 'loop.maxIterations': 7 } }]);
  });

  it('opens a settings group the user had closed when a setting inside it matches', async () => {
    const { getByTestId } = renderSurface();
    const group = getByTestId('settings-group-execution-retry') as HTMLDetailsElement;
    group.open = false;

    await search(getByTestId, 'schegent.retry.maxAttempts');

    expect(group.open).toBe(true);
  });

  it('closes a settings group it opened once the search ends', async () => {
    const { getByTestId } = renderSurface();
    const group = getByTestId('settings-group-execution-retry') as HTMLDetailsElement;
    group.open = false;

    await search(getByTestId, 'schegent.retry.maxAttempts');
    expect(group.open).toBe(true);

    await search(getByTestId, '');
    expect(group.open).toBe(false);
  });

  it('finds settings that are not fields: a trust capability, the evidence profile', async () => {
    const { container, getByTestId } = renderSurface();

    await search(getByTestId, 'schegent.trust.allowCustomPhases');
    expect(shownSections(container)).toEqual(['settings-section-trust']);
    expect(isShown(getByTestId('trust-row-phases'))).toBe(true);
    expect(isShown(getByTestId('trust-row-retryConditions'))).toBe(false);
    expect(shownRows(container)).toEqual([]);

    await search(getByTestId, 'evidence profile');
    expect(shownSections(container)).toContain('settings-section-privacy');
    expect(isShown(getByTestId('privacy-profiles'))).toBe(true);
  });
});

// Settings redesign — a refused save comes into sight. The page's one Save writes every section at
// once, so the host can refuse a setting the user cannot see: in a section not shown, under a
// search that hides it, or in a group the user closed. The refusal is said beside the setting, and
// the page brings it into sight, unless a refusal is in sight already.
describe('Settings redesign — a refused save comes into sight', () => {
  /** The host's answer to each command posted, waiting to be given, in the order posted. */
  let unanswered: AckListener[] = [];

  beforeEach(() => {
    unanswered = [];
    vi.mocked(snapshotStore.onceAck).mockImplementation((_correlationId, listener) => {
      unanswered.push(listener);
      return () => undefined;
    });
  });

  afterEach(() => {
    vi.mocked(snapshotStore.onceAck).mockReset();
  });

  function renderSurface() {
    return render(SettingsSurface, { props: { snapshot: buildSnapshot() } });
  }

  /** Saves the page, and the host refuses each of the `posts` commands the save sends. */
  async function saveRefused(getByTestId: (id: string) => HTMLElement, posts: number): Promise<void> {
    await fireEvent.click(getByTestId('settings-save'));
    await vi.waitFor(() => expect(unanswered).toHaveLength(posts));
    for (const answer of unanswered.splice(0)) answer({ status: 'rejected', reason: 'out-of-range' });
  }

  /** Waits until the page has done all it does after a refusal is drawn. */
  function settled(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  it('shows a refused setting the search hides, ending the search', async () => {
    const { container, getByTestId } = renderSurface();
    await fill(getByTestId, 'general-settings-input-loopMaxIterations', '23');
    await fill(getByTestId, 'settings-search', 'schegent.codex.path');
    expect(isShown(getByTestId('general-settings-field-loopMaxIterations'))).toBe(false);

    await saveRefused(getByTestId, 1);

    await vi.waitFor(() => {
      expect(isShown(getByTestId('general-settings-status-loopMaxIterations'))).toBe(true);
    });
    expect((getByTestId('settings-search') as HTMLInputElement).value).toBe('');
    expect(shownSections(container)).toEqual(['settings-section-execution']);
  });

  it('shows the section of a refused setting in place of the section on screen', async () => {
    const { container, getByTestId } = renderSurface();
    await fill(getByTestId, 'general-settings-input-loopMaxIterations', '9');
    expect(shownSections(container)).toEqual(['settings-section-backends']);

    await saveRefused(getByTestId, 1);

    await vi.waitFor(() => {
      expect(shownSections(container)).toEqual(['settings-section-execution']);
    });
    expect(navButton(container, 'execution').getAttribute('aria-current')).toBe('true');
    expect(isShown(getByTestId('general-settings-status-loopMaxIterations'))).toBe(true);
  });

  it('keeps the section on screen when a refusal is in sight there', async () => {
    const { container, getByTestId } = renderSurface();
    await fill(getByTestId, 'general-settings-input-loopMaxIterations', '11');
    await fireEvent.click(navButton(container, 'logging'));
    await fill(getByTestId, 'general-settings-input-runtimeLogFilePath', '/var/log/schegent-kept.log');

    await saveRefused(getByTestId, 1);
    await vi.waitFor(() => {
      expect(getByTestId('general-settings-status-loopMaxIterations').textContent).toContain('Rejected');
    });
    await settled();

    expect(shownSections(container)).toEqual(['settings-section-logging']);
    expect(isShown(getByTestId('general-settings-status-runtimeLogFilePath'))).toBe(true);
  });

  it('brings the first refusal in page order into sight when none is in sight', async () => {
    const { container, getByTestId } = renderSurface();
    await fill(getByTestId, 'general-settings-input-runtimeLogFilePath', '/var/log/schegent-later.log');
    await fill(getByTestId, 'general-settings-input-loopMaxIterations', '13');

    await saveRefused(getByTestId, 1);
    await vi.waitFor(() => {
      expect(shownSections(container)).toEqual(['settings-section-execution']);
    });
    await settled();

    expect(shownSections(container)).toEqual(['settings-section-execution']);
  });

  it('opens a settings group the user closed when a setting inside it is refused', async () => {
    const { container, getByTestId } = renderSurface();
    await fireEvent.click(navButton(container, 'execution'));
    const group = getByTestId('settings-group-execution-retry') as HTMLDetailsElement;
    group.open = false;
    await fill(getByTestId, 'general-settings-input-loopMaxIterations', '17');

    await saveRefused(getByTestId, 1);

    await vi.waitFor(() => expect(group.open).toBe(true));
  });

  it('shows the failure signatures when the host refuses them', async () => {
    const { container, getByTestId } = renderSurface();
    await fireEvent.click(getByTestId('fatal-add'));
    await fill(getByTestId, 'fatal-operator-input-0', 'refused signature for a test');

    await saveRefused(getByTestId, 1);

    await vi.waitFor(() => {
      expect(shownSections(container)).toEqual(['settings-section-signatures']);
    });
    expect(isShown(getByTestId('fatal-status'))).toBe(true);
  });

  it('shows the queue settings when the host refuses them', async () => {
    const { container, getByTestId } = renderSurface();
    await fill(getByTestId, 'queue-config-cap', '6');

    await saveRefused(getByTestId, 1);

    await vi.waitFor(() => {
      expect(shownSections(container)).toEqual(['settings-section-queues']);
    });
    expect(isShown(getByTestId('queue-config-refusal'))).toBe(true);
  });

  it("shows a queue's failure policy when the host refuses it", async () => {
    const { container, getByTestId } = renderSurface();
    await fireEvent.change(getByTestId('queue-failure-policy-select-default'), {
      target: { value: 'continue' }
    });

    await saveRefused(getByTestId, 1);

    await vi.waitFor(() => {
      expect(shownSections(container)).toEqual(['settings-section-queues']);
    });
    expect(isShown(getByTestId('queue-failure-policy-message-default'))).toBe(true);
  });
});
