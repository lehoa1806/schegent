/**
 * The settings page captions its settings and headings in sentence case, and a
 * row the redesign's settings page draws in the redesign's words ("Default
 * workflow", "Backend check timeout"); a row it does not draw keeps the
 * product's words. A word keeps its capital mid-caption only when it is a name
 * or one of the product's nouns (the Builder's "Bound Phase"), which the
 * product's sentences capitalise too. A number's unit is not in its caption:
 * the row writes it after the field ("10 seconds"), as the redesign does. The
 * evidence profile line, which names the settings a custom posture changed,
 * names them by their captions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import GeneralSettingsTab from '../GeneralSettingsTab.svelte';
import { SettingsPage, type SettingsSectionId } from '../settings-page.svelte';
import PrivacyProfileSelector from '../general/PrivacyProfileSelector.svelte';
import {
  privacyProfile,
  type PrivacyProfileSettings
} from '../../../../../src/contracts/privacy-profiles';
import type { WorkflowSnapshot } from '../../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../../lib/snapshot-types';
import { foldLegacyRun } from '../../../lib/__tests__/queue-runtime-fixture';

vi.mock('../../../lib/vscode-api', () => ({
  postCommand: () => ({ correlationId: 'corr-test' })
}));
vi.mock('../../../lib/snapshot-store.svelte', () => ({
  snapshotStore: {
    markPending: vi.fn(),
    onceAck: vi.fn()
  }
}));

afterEach(() => cleanup());

/** Words a caption keeps capitalised mid-sentence: names and the product's nouns. */
const KEEPS_CAPITAL = new Set(['Agy', 'CLI', 'Claude', 'Codex', 'Phase', 'Workflow']);
const EDGE_PUNCTUATION = /^[^\p{L}]+|[^\p{L}]+$/gu;

/** Each word, and each part of a hyphenated one, is checked on its own. */
function isSentenceCase(caption: string): boolean {
  const [, ...later] = caption.split(/[\s-]+/);
  return later.every((word) => {
    const bare = word.replace(EDGE_PUNCTUATION, '');
    return bare === bare.toLowerCase() || KEEPS_CAPITAL.has(bare);
  });
}

function buildSnapshot(): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: 4,
    isPrimary: true,
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
  }) as unknown as WorkflowSnapshot;
}

function textsOf(container: HTMLElement, selector: string): string[] {
  return [...container.querySelectorAll(selector)].map((node) =>
    node.textContent.replace(/\s+/g, ' ').trim()
  );
}

describe('the settings page reads in sentence case', () => {
  it('captions every setting in sentence case', () => {
    const { container } = render(GeneralSettingsTab, { props: { snapshot: buildSnapshot() } });
    const captions = textsOf(container, '.field-name');
    expect(captions.length).toBeGreaterThan(25);
    expect(captions.filter((caption) => !isSentenceCase(caption))).toEqual([]);
  });

  it('heads its groups and sections in sentence case', () => {
    const { container } = render(GeneralSettingsTab, { props: { snapshot: buildSnapshot() } });
    const headings = textsOf(container, 'summary, h3');
    expect(headings).toContain('Backend health');
    expect(headings.filter((heading) => !isSentenceCase(heading))).toEqual([]);
  });

  it('names the retry settings the way their hover text titles them', () => {
    const { container } = render(GeneralSettingsTab, { props: { snapshot: buildSnapshot() } });
    const captions = textsOf(container, '.field-name');
    expect(captions).toContain('Retry attempts per step');
    expect(captions).toContain('When the loop limit is reached');
  });

  it('tells a sentence-case caption from a Title Case one', () => {
    expect(isSentenceCase('Bound Phase')).toBe(true);
    expect(isSentenceCase('Inherit host environment (legacy)')).toBe(true);
    expect(isSentenceCase('Claude compaction threshold')).toBe(true);
    expect(isSentenceCase('UI, trust, and Claude-specific behavior')).toBe(true);
    expect(isSentenceCase('Retry Max Attempts')).toBe(false);
    expect(isSentenceCase('Suppress Multi-Root Warning')).toBe(false);
    expect(isSentenceCase('Inherit Host Environment (legacy)')).toBe(false);
  });
});

describe('the settings page writes a number setting with its unit after the value', () => {
  // The redesign draws "10 seconds", never "Backend check timeout (seconds)": the
  // unit follows the field, and the field is read with it.
  it('puts a unit after every number field and none in its caption', () => {
    const { container } = render(GeneralSettingsTab, { props: { snapshot: buildSnapshot() } });
    const fields = [...container.querySelectorAll('input[type="number"]')];
    expect(fields.length).toBeGreaterThanOrEqual(14);
    const misdrawn = fields.flatMap((field) => {
      const [captionId = '', unitId = ''] = (field.getAttribute('aria-labelledby') ?? '').split(' ');
      const caption = container.querySelector(`[id="${captionId}"]`)?.textContent.trim() ?? '';
      const unit = field.parentElement?.querySelector(`[id="${unitId}"]`)?.textContent.trim() ?? '';
      const drawn = unit !== '' && caption !== '' && !caption.includes('(');
      return drawn ? [] : [`${field.getAttribute('data-testid') ?? '?'}: "${caption}" then "${unit}"`];
    });
    expect(misdrawn).toEqual([]);
  });

  it('reads the unit with the caption, as the Phase editor\x27s time limit is read', async () => {
    // The page shows one section at a time and hides the rest from the accessibility tree, so
    // each field is read by role with its own section shown.
    const page = new SettingsPage();
    const { getByRole } = render(GeneralSettingsTab, { props: { snapshot: buildSnapshot(), page } });
    const namesBySection: ReadonlyArray<readonly [SettingsSectionId, readonly string[]]> = [
      ['backends', [
        'Backend check timeout seconds',
        'Claude compaction threshold %',
        'Spend limit per run USD'
      ]],
      ['execution', [
        'Retry attempts per step attempts',
        'Stop a step that is silent for seconds',
        'Time limit per step seconds',
        'Loop limit times',
        'Check paused runs every minutes'
      ]],
      ['logging', [
        'Keep audit events for days',
        'Start a new audit file at MB',
        'Keep run artifacts for days',
        'Run artifact space bytes',
        'Log file size bytes',
        'Log files kept files'
      ]]
    ];
    for (const [section, names] of namesBySection) {
      page.select(section);
      await tick();
      for (const name of names) {
        expect(getByRole('spinbutton', { name }), name).toBeTruthy();
      }
    }
  });
});

describe('the evidence privacy profile line names the settings by their captions', () => {
  const DIAGNOSTIC = privacyProfile('diagnostic').settings;

  function profileLine(changes: Partial<PrivacyProfileSettings>): string {
    const { getByTestId } = render(PrivacyProfileSelector, {
      props: { ...DIAGNOSTIC, ...changes, chooseProfile: () => {} }
    });
    return getByTestId('privacy-profile-detected').textContent.replace(/\s+/g, ' ').trim();
  }

  it('names the logging and capture settings that differ', () => {
    // The host contract's own tie: three fields off diagnostic, and three off forensic.
    expect(
      profileLine({ loggingVerbose: true, rawTranscriptMode: 'always', transportCaptureMode: 'off' })
    ).toBe(
      'Current profile: custom — differs from diagnostic in Verbose logging, Keep raw transcripts, Record backend traffic'
    );
  });

  it('names the retention settings that differ', () => {
    expect(profileLine({ sessionRetentionMaxAgeDays: 3, sessionRetentionMaxBytes: 12_345 })).toBe(
      'Current profile: custom — differs from diagnostic in Keep run artifacts for, Run artifact space'
    );
  });
});
