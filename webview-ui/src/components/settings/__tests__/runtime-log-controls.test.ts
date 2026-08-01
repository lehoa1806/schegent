// Feature 019 T027 — Runtime Debug Log controls in GeneralSettingsTab.
//
// Covers:
//   - Level selector renders 4 options (DEBUG / INFO / WARN / ERROR).
//   - Path text input renders with placeholder "<workspace>/.schegent/syslog".
//   - Saving the level dispatches { 'logging.runtimeLogLevel': '<level>' }.
//   - Saving the path dispatches { 'logging.runtimeLogFilePath': '<path>' }.
//   - Validator-error response surfaces inline on the rejected field.
//   - Reset reverts an unsaved edit back to the projection.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import GeneralSettingsTab from '../GeneralSettingsTab.svelte';
import { CMD_SAVE_GENERAL_SETTINGS } from '../../../lib/messages';
import type { WorkflowSnapshot, GeneralSettings } from '../../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../../lib/snapshot-types';

const postCommandSpy = vi.fn(
  (_cmd: string, _payload: unknown) => ({ correlationId: 'corr-test' })
);
let snapshotAck:
  | ((ack: { status: 'accepted' } | { status: 'rejected'; reason?: string }) => void)
  | null = null;
vi.mock('../../../lib/vscode-api', () => ({
  postCommand: (cmd: string, payload: unknown) => postCommandSpy(cmd, payload)
}));
vi.mock('../../../lib/snapshot-store.svelte', () => ({
  snapshotStore: {
    markPending: vi.fn(),
    onceAck: vi.fn(
      (
        _id: string,
        cb: (ack: { status: 'accepted' } | { status: 'rejected'; reason?: string }) => void
      ) => {
        snapshotAck = cb;
        return () => {
          snapshotAck = null;
        };
      }
    )
  }
}));

beforeEach(() => {
  postCommandSpy.mockClear();
  snapshotAck = null;
});
afterEach(() => cleanup());

function buildGeneralSettings(
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
  filePath: string
): GeneralSettings {
  return Object.freeze({
    ...IDLE_GENERAL_SETTINGS,
    runtimeLogLevel: level,
    runtimeLogFilePath: filePath,
    scopes: Object.freeze({
      ...IDLE_GENERAL_SETTINGS.scopes,
      runtimeLogLevel: level === 'INFO' ? 'default' : 'workspace',
      runtimeLogFilePath: filePath === '' ? 'default' : 'workspace'
    })
  }) as unknown as GeneralSettings;
}

function buildSnapshot(gs: GeneralSettings): WorkflowSnapshot {
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
    producedAt: '2026-05-13T00:00:00.000Z',
    availablePipelines: Object.freeze([]),
    availablePhases: Object.freeze([]),
    availableModels: Object.freeze([]),
    generalSettings: gs
  }) as unknown as unknown as WorkflowSnapshot;
}

describe('Feature 019 — runtime log level selector', () => {
  it('renders a <select> with four levels DEBUG/INFO/WARN/ERROR', () => {
    const snap = buildSnapshot(buildGeneralSettings('INFO', ''));
    const { container } = render(GeneralSettingsTab, { props: { snapshot: snap } });
    const select = container.querySelector(
      '[data-testid="general-settings-input-runtimeLogLevel"]'
    ) as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(select!.tagName).toBe('SELECT');
    const optionValues = Array.from(select!.options).map((o) => o.value);
    expect(optionValues).toEqual(['DEBUG', 'INFO', 'WARN', 'ERROR']);
  });

  it('renders with the projected level pre-selected', () => {
    const snap = buildSnapshot(buildGeneralSettings('WARN', ''));
    const { container } = render(GeneralSettingsTab, { props: { snapshot: snap } });
    const select = container.querySelector(
      '[data-testid="general-settings-input-runtimeLogLevel"]'
    ) as HTMLSelectElement;
    expect(select.value).toBe('WARN');
  });

  it('dispatches { "logging.runtimeLogLevel": "DEBUG" } on save', async () => {
    const snap = buildSnapshot(buildGeneralSettings('INFO', ''));
    const { container } = render(GeneralSettingsTab, { props: { snapshot: snap } });
    const select = container.querySelector(
      '[data-testid="general-settings-input-runtimeLogLevel"]'
    ) as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: 'DEBUG' } });
    const saveBtn = container.querySelector(
      '[data-testid="general-settings-save-runtimeLogLevel"]'
    ) as HTMLButtonElement;
    await fireEvent.click(saveBtn);
    expect(postCommandSpy).toHaveBeenCalledOnce();
    const [cmd, payload] = postCommandSpy.mock.calls[0];
    expect(cmd).toBe(CMD_SAVE_GENERAL_SETTINGS);
    expect(payload).toEqual({ updates: { 'logging.runtimeLogLevel': 'DEBUG' } });
  });
});

describe('Feature 019 — runtime log file path input', () => {
  it('renders a text input with the documented placeholder', () => {
    const snap = buildSnapshot(buildGeneralSettings('INFO', ''));
    const { container } = render(GeneralSettingsTab, { props: { snapshot: snap } });
    const input = container.querySelector(
      '[data-testid="general-settings-input-runtimeLogFilePath"]'
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input!.type).toBe('text');
    expect(input!.placeholder).toBe('<workspace>/.schegent/syslog');
  });

  it('renders with the projected path value', () => {
    const snap = buildSnapshot(buildGeneralSettings('INFO', '/tmp/schegent.log'));
    const { container } = render(GeneralSettingsTab, { props: { snapshot: snap } });
    const input = container.querySelector(
      '[data-testid="general-settings-input-runtimeLogFilePath"]'
    ) as HTMLInputElement;
    expect(input.value).toBe('/tmp/schegent.log');
  });

  it('dispatches { "logging.runtimeLogFilePath": "<new>" } on save', async () => {
    const snap = buildSnapshot(buildGeneralSettings('INFO', ''));
    const { container } = render(GeneralSettingsTab, { props: { snapshot: snap } });
    const input = container.querySelector(
      '[data-testid="general-settings-input-runtimeLogFilePath"]'
    ) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'logs/custom.log' } });
    const saveBtn = container.querySelector(
      '[data-testid="general-settings-save-runtimeLogFilePath"]'
    ) as HTMLButtonElement;
    await fireEvent.click(saveBtn);
    expect(postCommandSpy).toHaveBeenCalledOnce();
    const [, payload] = postCommandSpy.mock.calls[0];
    expect(payload).toEqual({ updates: { 'logging.runtimeLogFilePath': 'logs/custom.log' } });
  });

  it('dispatches an empty string to restore the default path', async () => {
    const snap = buildSnapshot(buildGeneralSettings('INFO', '/tmp/existing.log'));
    const { container } = render(GeneralSettingsTab, { props: { snapshot: snap } });
    const input = container.querySelector(
      '[data-testid="general-settings-input-runtimeLogFilePath"]'
    ) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: '' } });
    const saveBtn = container.querySelector(
      '[data-testid="general-settings-save-runtimeLogFilePath"]'
    ) as HTMLButtonElement;
    await fireEvent.click(saveBtn);
    const [, payload] = postCommandSpy.mock.calls[0];
    expect(payload).toEqual({ updates: { 'logging.runtimeLogFilePath': '' } });
  });
});

describe('Feature 019 — runtime log controls — rejection + reset flows', () => {
  it('surfaces a host validator rejection inline on the path field', async () => {
    const snap = buildSnapshot(buildGeneralSettings('INFO', ''));
    const { container } = render(GeneralSettingsTab, { props: { snapshot: snap } });
    const input = container.querySelector(
      '[data-testid="general-settings-input-runtimeLogFilePath"]'
    ) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: '../escape' } });
    const saveBtn = container.querySelector(
      '[data-testid="general-settings-save-runtimeLogFilePath"]'
    ) as HTMLButtonElement;
    await fireEvent.click(saveBtn);
    // Simulate a host rejection ack — the helper's onceAck handler will
    // surface it on the rejected field's status row.
    expect(snapshotAck).not.toBeNull();
    snapshotAck!({
      status: 'rejected',
      reason: 'relative-traversal: ..'
    });
    await waitFor(() => {
      const el = container.querySelector(
        '[data-testid="general-settings-status-runtimeLogFilePath"]'
      );
      expect(el?.textContent ?? '').toContain('Rejected');
    });
    const statusEl = container.querySelector(
      '[data-testid="general-settings-status-runtimeLogFilePath"]'
    );
    expect(statusEl!.textContent).toContain('relative-traversal');
  });

  it('resets the level field to the projected value on Reset', async () => {
    const snap = buildSnapshot(buildGeneralSettings('INFO', ''));
    const { container } = render(GeneralSettingsTab, { props: { snapshot: snap } });
    const select = container.querySelector(
      '[data-testid="general-settings-input-runtimeLogLevel"]'
    ) as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: 'ERROR' } });
    expect(select.value).toBe('ERROR');
    const resetBtn = container.querySelector(
      '[data-testid="general-settings-reset-runtimeLogLevel"]'
    ) as HTMLButtonElement;
    await fireEvent.click(resetBtn);
    expect(select.value).toBe('INFO');
    expect(postCommandSpy).not.toHaveBeenCalled();
  });
});

describe('session-artifact retention controls', () => {
  it('renders usage and warns when retained bytes reach 80% of budget', () => {
    const base = buildSnapshot(buildGeneralSettings('INFO', ''));
    const snap = Object.freeze({
      ...base,
      sessionArtifacts: Object.freeze({
        artifactCount: 4,
        totalBytes: 450 * 1024 * 1024,
        lastSweepAt: '2026-08-01T00:00:00.000Z',
        lastSweepFailures: 0
      })
    }) as WorkflowSnapshot;

    const { container } = render(GeneralSettingsTab, { props: { snapshot: snap } });
    const usage = container.querySelector('[data-testid="session-artifact-usage"]');

    expect(usage?.textContent).toContain('4 runs');
    expect(usage?.textContent).toContain('450.0 MiB');
    expect(usage?.textContent).toContain('88%');
    expect(usage?.classList.contains('usage-warning')).toBe(true);
  });

  it('saves the age limit through the documented IPC key', async () => {
    const snap = buildSnapshot(buildGeneralSettings('INFO', ''));
    const { container } = render(GeneralSettingsTab, { props: { snapshot: snap } });
    const input = container.querySelector(
      '[data-testid="general-settings-input-sessionRetentionMaxAgeDays"]'
    ) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: '45' } });
    const save = container.querySelector(
      '[data-testid="general-settings-save-sessionRetentionMaxAgeDays"]'
    ) as HTMLButtonElement;
    await fireEvent.click(save);

    expect(postCommandSpy).toHaveBeenCalledOnce();
    expect(postCommandSpy.mock.calls[0][1]).toEqual({
      updates: { 'logging.sessionRetentionMaxAgeDays': 45 }
    });
  });
});
