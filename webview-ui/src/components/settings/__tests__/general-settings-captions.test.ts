/**
 * The General tab captions its settings and headings in sentence case, as the
 * redesign's settings surface does ("Default workflow", "Backend check
 * timeout") and as the tab's own hover titles already were. A word keeps its
 * capital mid-caption only when it is a name or one of the product's nouns,
 * which a caption keeps capitalised ("Default Workflow", as the Builder's
 * "Bound Phase") though the hover titles and the redesign write them in lower
 * case. A number's unit is not in its caption: the row writes it after the
 * field ("10 seconds"), as the redesign does. The evidence profile line, which
 * names the settings a custom posture changed, follows the same casing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import GeneralSettingsTab from '../GeneralSettingsTab.svelte';
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

describe('the General settings tab reads in sentence case', () => {
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
    expect(captions).toContain('Retry max attempts');
    expect(captions).toContain('Continue past retry cap');
  });

  it('tells a sentence-case caption from a Title Case one', () => {
    expect(isSentenceCase('Default Workflow')).toBe(true);
    expect(isSentenceCase('Inherit host environment (legacy)')).toBe(true);
    expect(isSentenceCase('Claude auto-compaction threshold')).toBe(true);
    expect(isSentenceCase('UI, trust, and Claude-specific behavior')).toBe(true);
    expect(isSentenceCase('Retry Max Attempts')).toBe(false);
    expect(isSentenceCase('Suppress Multi-Root Warning')).toBe(false);
    expect(isSentenceCase('Inherit Host Environment (legacy)')).toBe(false);
  });
});

describe('the General tab writes a number setting with its unit after the value', () => {
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

  it('reads the unit with the caption, as the Phase editor\x27s time limit is read', () => {
    const { getByRole } = render(GeneralSettingsTab, { props: { snapshot: buildSnapshot() } });
    for (const name of [
      'Session artifact retention days',
      'Session artifact budget bytes',
      'Audit rotation size MB',
      'Runtime logs kept files',
      'Loop max iterations times',
      'Invocation idle timeout seconds',
      'Watchdog poll interval minutes',
      'Retry max attempts attempts',
      'Backend probe timeout seconds',
      'Claude auto-compaction threshold %',
      'Per-run spend bound USD'
    ]) {
      expect(getByRole('spinbutton', { name })).toBeTruthy();
    }
  });
});

describe('the evidence privacy profile line reads in sentence case', () => {
  const DIAGNOSTIC = privacyProfile('diagnostic').settings;

  function profileLine(changes: Partial<PrivacyProfileSettings>): string {
    const { getByTestId } = render(PrivacyProfileSelector, {
      props: { ...DIAGNOSTIC, ...changes, chooseProfile: () => {} }
    });
    return getByTestId('privacy-profile-detected').textContent.replace(/\s+/g, ' ').trim();
  }

  it('names the logging and capture settings that differ in sentence case', () => {
    // The host contract's own tie: three fields off diagnostic, and three off forensic.
    expect(
      profileLine({ loggingVerbose: true, rawTranscriptMode: 'always', transportCaptureMode: 'off' })
    ).toBe(
      'Current profile: custom — differs from diagnostic in Verbose logging, Raw transcript mode, CLI transport capture'
    );
  });

  it('names the retention settings that differ in sentence case', () => {
    expect(profileLine({ sessionRetentionMaxAgeDays: 3, sessionRetentionMaxBytes: 12_345 })).toBe(
      'Current profile: custom — differs from diagnostic in Session retention (days), Session retention (bytes)'
    );
  });
});
