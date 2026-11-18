/**
 * The setting rows read as the redesign's settings page writes them. Each row says where its value
 * applies in the mockup's words ("Applies to: this workspace"), the rows of a section come in the
 * mockup's order, a choice is offered in words while the setting keeps its values, the outcome at
 * the loop limit is a select of the two outcomes its boolean holds, and the multi-root row asks
 * whether to warn, the opposite of the stored `multiRoot.suppressWarning`. The privacy section's
 * profile row and its "Stored locally" line, and the spend row's unit line, use the same words.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import GeneralSettingsTab from '../GeneralSettingsTab.svelte';
import SettingsSurface from '../../SettingsSurface.svelte';
import type { GeneralSettings, WorkflowSnapshot } from '../../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../../lib/snapshot-types';
import { foldLegacyRun } from '../../../lib/__tests__/queue-runtime-fixture';

const postCommandSpy = vi.fn((_cmd: string, _payload: unknown) => ({ correlationId: 'corr-test' }));
vi.mock('../../../lib/vscode-api', () => ({
  postCommand: (cmd: string, payload: unknown) => postCommandSpy(cmd, payload)
}));
vi.mock('../../../lib/snapshot-store.svelte', () => ({
  snapshotStore: { markPending: vi.fn(), onceAck: vi.fn(() => () => {}) }
}));

beforeEach(() => postCommandSpy.mockClear());
afterEach(() => cleanup());

function buildSnapshot(settings: GeneralSettings = IDLE_GENERAL_SETTINGS): WorkflowSnapshot {
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
    producedAt: '2026-11-16T00:00:00.000Z',
    availablePipelines: Object.freeze([]),
    availablePhases: Object.freeze([]),
    availableModels: Object.freeze([]),
    generalSettings: settings
  }) as unknown as WorkflowSnapshot;
}

function textOf(node: Element | null): string {
  return (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function rowLabels(container: HTMLElement, section: string): string[] {
  return [...container.querySelectorAll(`[data-testid="settings-section-${section}"] .field-name`)].map(textOf);
}

function optionsOf(container: HTMLElement, key: string): Array<readonly [string, string]> {
  const select = container.querySelector(`[data-testid="general-settings-input-${key}"]`);
  expect(select?.tagName, key).toBe('SELECT');
  return [...(select as HTMLSelectElement).options].map((option) => [option.value, textOf(option)] as const);
}

async function saveAll(container: HTMLElement): Promise<unknown> {
  await fireEvent.click(container.querySelector('[data-testid="settings-save"]') as HTMLButtonElement);
  await waitFor(() => expect(postCommandSpy).toHaveBeenCalledOnce());
  return postCommandSpy.mock.calls[0][1];
}

describe('a setting row says where its value applies', () => {
  it('writes the scope in the mockup\x27s words', () => {
    const settings = Object.freeze({
      ...IDLE_GENERAL_SETTINGS,
      scopes: Object.freeze({
        ...IDLE_GENERAL_SETTINGS.scopes,
        runtimeLogLevel: 'workspace',
        rawTranscriptMode: 'user',
        loggingVerbose: 'default'
      })
    }) as unknown as GeneralSettings;
    const { getByTestId } = render(GeneralSettingsTab, { props: { snapshot: buildSnapshot(settings) } });
    expect(textOf(getByTestId('general-settings-scope-runtimeLogLevel'))).toBe('Applies to: this workspace');
    expect(textOf(getByTestId('general-settings-scope-rawTranscriptMode'))).toBe('Applies to: you, all workspaces');
    expect(textOf(getByTestId('general-settings-scope-loggingVerbose'))).toBe('Applies to: default');
  });
});

describe('the rows of a section come in the mockup\x27s order', () => {
  it('lists the run and retry settings as the mockup does, the loop-limit outcome beside the loop limit', () => {
    const { container } = render(GeneralSettingsTab, { props: { snapshot: buildSnapshot() } });
    expect(rowLabels(container, 'execution')).toEqual([
      'Default workflow',
      'Retry attempts per step',
      'Stop a step that is silent for',
      'Time limit per step',
      'Loop limit',
      'When the loop limit is reached',
      'Check paused runs every'
    ]);
  });

  it('lists the log settings as the mockup does, each setting it lacks beside its kin', () => {
    const { container } = render(GeneralSettingsTab, { props: { snapshot: buildSnapshot() } });
    expect(rowLabels(container, 'logging')).toEqual([
      'Log level',
      'Verbose logging',
      'Keep raw transcripts',
      'Record backend traffic',
      'Keep audit events for',
      'Start a new audit file at',
      'Keep run artifacts for',
      'Run artifact space',
      'Log file path',
      'Log file size',
      'Log files kept'
    ]);
  });

  it('names the trust rows as the mockup does', () => {
    const { container } = render(GeneralSettingsTab, { props: { snapshot: buildSnapshot() } });
    expect(rowLabels(container, 'trust')).toEqual(['Ask before destructive actions', 'Warn about multi-root workspaces']);
  });

  it('names the backend rows as the mockup does', () => {
    const { container } = render(GeneralSettingsTab, { props: { snapshot: buildSnapshot() } });
    const labels = rowLabels(container, 'backends');
    for (const label of [
      'Backend for new runs',
      'Spend limit per run',
      'Environment passed to backends',
      'Allowed variables',
      'Backend check timeout'
    ]) {
      expect(labels, label).toContain(label);
    }
  });
});

describe('a choice is offered in words and keeps its values', () => {
  it('names the log levels, raw transcript and backend traffic choices in words', () => {
    const { container } = render(GeneralSettingsTab, { props: { snapshot: buildSnapshot() } });
    expect(optionsOf(container, 'runtimeLogLevel')).toEqual([
      ['DEBUG', 'Debug'],
      ['INFO', 'Info'],
      ['WARN', 'Warning'],
      ['ERROR', 'Error']
    ]);
    // The host keeps a raw transcript for a run that fails, is canceled or pauses, and drops it
    // when the run completes; it keeps backend traffic only for a run that fails or is canceled.
    expect(optionsOf(container, 'rawTranscriptMode')).toEqual([
      ['errors-only', 'Unless the run completes'],
      ['always', 'Always'],
      ['off', 'Never']
    ]);
    expect(optionsOf(container, 'transportCaptureMode')).toEqual([
      ['inherit', 'Same as raw transcripts'],
      ['off', 'Never'],
      ['errors-only', 'For failed or canceled runs'],
      ['on', 'Always']
    ]);
  });

  it('offers the outcome at the loop limit as the two outcomes the setting holds, and saves its boolean', async () => {
    const { container } = render(SettingsSurface, { props: { snapshot: buildSnapshot() } });
    expect(optionsOf(container, 'retryForceContinueOnCap')).toEqual([
      ['false', 'Fail the run'],
      ['true', 'Continue with a warning']
    ]);
    const select = container.querySelector('[data-testid="general-settings-input-retryForceContinueOnCap"]') as HTMLSelectElement;
    expect(select.value).toBe('false');
    await fireEvent.change(select, { target: { value: 'true' } });
    expect(await saveAll(container)).toEqual({ updates: { 'retry.forceContinueOnCap': true } });
  });

  it('asks whether to warn about multi-root workspaces, the opposite of the stored setting', async () => {
    const { container } = render(SettingsSurface, { props: { snapshot: buildSnapshot() } });
    const toggle = container.querySelector('[data-testid="general-settings-input-multiRootSuppressWarning"]') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(textOf(toggle.closest('label'))).toBe('On');
    await fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    expect(textOf(toggle.closest('label'))).toBe('Off');
    expect(await saveAll(container)).toEqual({ updates: { 'multiRoot.suppressWarning': true } });
  });
});

describe('the privacy section and the spend row read as the mockup writes them', () => {
  function withUsage(lastSweepAt: string | null, lastSweepFailures: number): WorkflowSnapshot {
    return Object.freeze({
      ...buildSnapshot(),
      sessionArtifacts: Object.freeze({
        artifactCount: 4,
        totalBytes: 450 * 1024 * 1024,
        lastSweepAt,
        lastSweepFailures
      })
    }) as WorkflowSnapshot;
  }

  it('names the evidence profile and leads its note with the mockup\x27s sentence, the residuals after it', () => {
    const { getByTestId } = render(GeneralSettingsTab, { props: { snapshot: buildSnapshot() } });
    const row = getByTestId('privacy-profiles');
    expect(textOf(row.querySelector('.lab'))).toBe('Evidence profile');
    const note = textOf(row.querySelector('.desc'));
    expect(note.startsWith('Sets transcript, artifact and capture options together. Ephemeral keeps the least. ')).toBe(true);
    // Spec 163 FR-002a: a profile states what it does not change.
    expect(note).toContain('checkpoint store');
    expect(note).toContain('.gitignore does not stop backup or sync tooling');
  });

  it('says what is stored locally and when it was last cleaned', () => {
    const { getByTestId } = render(GeneralSettingsTab, { props: { snapshot: withUsage('2026-08-01T00:00:00.000Z', 1) } });
    expect(textOf(getByTestId('session-artifact-usage'))).toMatch(
      /^Stored locally: 4 runs, 450\.0 MiB\. Last cleaned [^.]+\. 1 cleanup operation failed; check the Schegent log\. That is 88% of Run artifact space\.$/
    );
  });

  it('says it is waiting for the first cleanup before one has run', () => {
    const { getByTestId } = render(GeneralSettingsTab, { props: { snapshot: withUsage(null, 0) } });
    expect(textOf(getByTestId('session-artifact-usage'))).toBe(
      'Stored locally: 4 runs, 450.0 MiB. Waiting for the first cleanup. That is 88% of Run artifact space.'
    );
  });

  it('names the unit of the spend limit in the row\x27s words', () => {
    const { getByTestId } = render(GeneralSettingsTab, { props: { snapshot: buildSnapshot() } });
    expect(textOf(getByTestId('spend-denomination'))).toBe(
      'Claude reports a cost, so its spend limit per run is set in US dollars.'
    );
  });
});
