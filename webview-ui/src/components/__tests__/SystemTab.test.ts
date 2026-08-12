import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import SystemTab from '../SystemTab.svelte';
import { snapshotStore } from '../../lib/snapshot-store.svelte';
import type { AuditTailEntry, DebugLogEntry, WorkflowSnapshot } from '../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../lib/snapshot-types';
import { foldLegacyRun } from '../../lib/__tests__/queue-runtime-fixture';

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'corr-test' }))
}));

afterEach(() => cleanup());

function buildSnapshot(overrides: {
  auditTail?: readonly AuditTailEntry[];
  debugLogTail?: readonly DebugLogEntry[];
} = {}): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: 4,
    isPrimary: true,
    // Feature 092 — the v3 root run singulars now hang off the queue that owns
    // the Run. This fixture describes an idle default queue, which is what the
    // v3 root fields it used to spell described.
    queues: foldLegacyRun(),
    queue: Object.freeze({
      orderedItems: Object.freeze([]),
      inFlight: null,
      pending: Object.freeze([]),
      recent: Object.freeze([]),
      paused: false
    }),
    auditTail: overrides.auditTail ?? Object.freeze([]),
    debugLogTail: overrides.debugLogTail ?? Object.freeze([]),
    monitor: null,
    history: Object.freeze([]),
    producedAt: '2026-08-02T00:00:00.000Z',
    availablePipelines: Object.freeze([]),
    availablePhases: Object.freeze([]),
    availableModels: Object.freeze({ claude: [], codex: [], agy: [] }),
    availableBackends: Object.freeze(['claude']),
    generalSettings: IDLE_GENERAL_SETTINGS
  }) as unknown as WorkflowSnapshot;
}

function applySnapshot(snapshot: WorkflowSnapshot): void {
  snapshotStore.apply({ type: 'STATE_SNAPSHOT', payload: snapshot } as never);
}

describe('SystemTab', () => {
  it('defaults to the current Debug log view', () => {
    applySnapshot(buildSnapshot({
      debugLogTail: [
        { id: 1, timestamp: '2026-08-02T00:00:00.000Z', level: 'INFO', message: 'ready' }
      ]
    }));

    const { getByTestId, queryByTestId } = render(SystemTab);

    expect(getByTestId('system-tab').getAttribute('aria-label')).toBe('System logs');
    expect(getByTestId('system-view-debug').getAttribute('aria-selected')).toBe('true');
    expect(getByTestId('system-panel-debug').getAttribute('role')).toBe('tabpanel');
    expect(getByTestId('system-entry-1').textContent).toContain('ready');
    expect(queryByTestId('system-panel-audit')).toBeNull();
  });

  it('switches to structured audit events without mounting both lists', async () => {
    applySnapshot(buildSnapshot({
      debugLogTail: [
        { id: 1, timestamp: '2026-08-02T00:00:00.000Z', level: 'INFO', message: 'ready' }
      ],
      auditTail: [
        {
          id: 'audit-1',
          timestamp: '2026-08-02T00:00:01.000Z',
          phase: null,
          category: 'system',
          summary: 'queue hydrated',
          runId: 'run-1',
          scope: 'system'
        }
      ]
    }));

    const { getByTestId, queryByTestId } = render(SystemTab);
    await fireEvent.click(getByTestId('system-view-audit'));
    await tick();

    expect(getByTestId('system-view-audit').getAttribute('aria-selected')).toBe('true');
    expect(getByTestId('system-panel-audit').getAttribute('aria-labelledby')).toBe('system-tab-audit');
    expect(getByTestId('system-entry-audit-1').textContent).toContain('queue hydrated');
    expect(queryByTestId('system-panel-debug')).toBeNull();
  });

  it('supports Home, End, and arrow-key tab navigation', async () => {
    applySnapshot(buildSnapshot());
    const { getByTestId } = render(SystemTab);
    const debug = getByTestId('system-view-debug');

    await fireEvent.keyDown(debug, { key: 'End' });
    await tick();
    expect(getByTestId('system-view-audit').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(getByTestId('system-view-audit'));

    await fireEvent.keyDown(getByTestId('system-view-audit'), { key: 'ArrowRight' });
    await tick();
    expect(getByTestId('system-view-debug').getAttribute('aria-selected')).toBe('true');

    await fireEvent.keyDown(getByTestId('system-view-debug'), { key: 'Home' });
    await tick();
    expect(getByTestId('system-view-debug').getAttribute('aria-selected')).toBe('true');
  });
});
