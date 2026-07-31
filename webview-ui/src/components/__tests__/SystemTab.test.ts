// SystemTab.svelte — debug log stream tests.
//
// The System tab renders entries from `snapshotStore.debugLogTail`
// (SanitizedLogger ring buffer). Each entry has: id, timestamp, level,
// message. Entries are displayed newest-first in a terminal-style layout.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, cleanup } from '@testing-library/svelte';
import SystemTab from '../SystemTab.svelte';
import { snapshotStore } from '../../lib/snapshot-store.svelte';
import type {
  DebugLogEntry,
  WorkflowSnapshot
} from '../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../lib/snapshot-types';

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'corr-test' }))
}));

afterEach(() => cleanup());

function buildDebugEntry(overrides: Partial<DebugLogEntry> & { id: number }): DebugLogEntry {
  return Object.freeze({
    timestamp: '2026-07-31T02:00:00.000Z',
    level: 'DEBUG' as const,
    message: `test message ${overrides.id}`,
    ...overrides
  });
}

function buildSnapshot(opts: {
  debugLogTail?: readonly DebugLogEntry[];
}): WorkflowSnapshot {
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
    debugLogTail: opts.debugLogTail ?? Object.freeze([]),
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
    producedAt: '2026-07-31T02:00:01.000Z',
    activeRunId: null,
    availablePipelines: Object.freeze([]),
    availablePhases: Object.freeze([]),
    availableModels: Object.freeze([]),
    generalSettings: IDLE_GENERAL_SETTINGS
  }) as unknown as WorkflowSnapshot;
}

function applySnapshot(s: WorkflowSnapshot): void {
  snapshotStore.apply({
    type: 'STATE_SNAPSHOT',
    payload: s
  } as unknown as Parameters<typeof snapshotStore.apply>[0]);
}

describe('SystemTab.svelte — debug log stream', () => {
  it('renders empty-state when no debug log entries exist', () => {
    applySnapshot(buildSnapshot({}));
    const { container } = render(SystemTab);
    expect(container.querySelector('[data-testid="system-empty"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="system-empty"]')?.textContent).toBe(
      'No debug log entries yet.'
    );
    expect(container.querySelector('ol')).toBeNull();
  });

  it('renders debug entries from debugLogTail', () => {
    const tail = [
      buildDebugEntry({ id: 1, level: 'INFO', message: 'phase-start speckit-plan' }),
      buildDebugEntry({ id: 2, level: 'DEBUG', message: 'router: inbound' })
    ];
    applySnapshot(buildSnapshot({ debugLogTail: tail }));
    const { container } = render(SystemTab);
    expect(container.querySelector('[data-testid="system-entry-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="system-entry-2"]')).not.toBeNull();
  });

  it('renders newest-first (reverses snapshot order)', () => {
    const tail = [
      buildDebugEntry({ id: 1, timestamp: '2026-07-31T01:00:00.000Z' }),
      buildDebugEntry({ id: 2, timestamp: '2026-07-31T02:00:00.000Z' }),
      buildDebugEntry({ id: 3, timestamp: '2026-07-31T03:00:00.000Z' })
    ];
    applySnapshot(buildSnapshot({ debugLogTail: tail }));
    const { container } = render(SystemTab);
    const lis = container.querySelectorAll('ol li');
    expect(lis.length).toBe(3);
    expect(lis[0]?.getAttribute('data-testid')).toBe('system-entry-3');
    expect(lis[1]?.getAttribute('data-testid')).toBe('system-entry-2');
    expect(lis[2]?.getAttribute('data-testid')).toBe('system-entry-1');
  });

  it('renders timestamp for each entry', () => {
    const tail = [
      buildDebugEntry({ id: 10, timestamp: '2026-07-31T09:15:42.000Z', message: 'hello' })
    ];
    applySnapshot(buildSnapshot({ debugLogTail: tail }));
    const { container } = render(SystemTab);
    const time = container.querySelector('[data-testid="system-entry-time-10"]');
    expect(time).not.toBeNull();
    expect(time?.textContent).toContain('2026-07-31');
  });

  it('renders level badge for each entry', () => {
    const tail = [
      buildDebugEntry({ id: 20, level: 'WARN', message: 'something' })
    ];
    applySnapshot(buildSnapshot({ debugLogTail: tail }));
    const { container } = render(SystemTab);
    const badge = container.querySelector('[data-testid="system-entry-level-20"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain('WARN');
  });

  it('renders message for each entry', () => {
    const tail = [
      buildDebugEntry({ id: 30, message: 'phase-runner.lock-acquired' })
    ];
    applySnapshot(buildSnapshot({ debugLogTail: tail }));
    const { container } = render(SystemTab);
    const msg = container.querySelector('[data-testid="system-entry-message-30"]');
    expect(msg).not.toBeNull();
    expect(msg?.textContent).toContain('phase-runner.lock-acquired');
  });

  it('applies level-specific CSS class for DEBUG', () => {
    const tail = [buildDebugEntry({ id: 40, level: 'DEBUG' })];
    applySnapshot(buildSnapshot({ debugLogTail: tail }));
    const { container } = render(SystemTab);
    const li = container.querySelector('[data-testid="system-entry-40"]');
    expect(li?.classList.contains('level-debug')).toBe(true);
  });

  it('applies level-specific CSS class for INFO', () => {
    const tail = [buildDebugEntry({ id: 41, level: 'INFO' })];
    applySnapshot(buildSnapshot({ debugLogTail: tail }));
    const { container } = render(SystemTab);
    const li = container.querySelector('[data-testid="system-entry-41"]');
    expect(li?.classList.contains('level-info')).toBe(true);
  });

  it('applies level-specific CSS class for WARN', () => {
    const tail = [buildDebugEntry({ id: 42, level: 'WARN' })];
    applySnapshot(buildSnapshot({ debugLogTail: tail }));
    const { container } = render(SystemTab);
    const li = container.querySelector('[data-testid="system-entry-42"]');
    expect(li?.classList.contains('level-warn')).toBe(true);
  });

  it('applies level-specific CSS class for ERROR', () => {
    const tail = [buildDebugEntry({ id: 43, level: 'ERROR' })];
    applySnapshot(buildSnapshot({ debugLogTail: tail }));
    const { container } = render(SystemTab);
    const li = container.querySelector('[data-testid="system-entry-43"]');
    expect(li?.classList.contains('level-error')).toBe(true);
  });

  it('renders aria-label with level on each entry', () => {
    const tail = [buildDebugEntry({ id: 50, level: 'ERROR' })];
    applySnapshot(buildSnapshot({ debugLogTail: tail }));
    const { container } = render(SystemTab);
    const li = container.querySelector('[data-testid="system-entry-50"]');
    expect(li?.getAttribute('aria-label')).toBe('ERROR');
  });

  it('HTML-like content in message renders as literal text', () => {
    const tail = [
      buildDebugEntry({ id: 60, message: '<script>alert(1)</script>' })
    ];
    applySnapshot(buildSnapshot({ debugLogTail: tail }));
    const { container } = render(SystemTab);
    const msg = container.querySelector('[data-testid="system-entry-message-60"]');
    expect(msg?.textContent ?? '').toContain('<script>alert(1)</script>');
    expect(container.querySelector('script')).toBeNull();
  });

  it('source file contains no {@html substring (escape-contract hard rule)', () => {
    const src = readFileSync(join(__dirname, '..', 'SystemTab.svelte'), 'utf8');
    expect(src.includes('{@html')).toBe(false);
  });

  it('section has data-testid="system-tab"', () => {
    applySnapshot(buildSnapshot({}));
    const { container } = render(SystemTab);
    expect(container.querySelector('[data-testid="system-tab"]')).not.toBeNull();
  });

  it('section has aria-label "Debug log"', () => {
    applySnapshot(buildSnapshot({}));
    const { container } = render(SystemTab);
    const section = container.querySelector('[data-testid="system-tab"]');
    expect(section?.getAttribute('aria-label')).toBe('Debug log');
  });

  it('header reads "Debug log"', () => {
    applySnapshot(buildSnapshot({}));
    const { container } = render(SystemTab);
    const header = container.querySelector('.title');
    expect(header?.textContent).toBe('Debug log');
  });

  it('handles missing debugLogTail gracefully (legacy tolerance)', () => {
    // Simulate a snapshot that doesn't have debugLogTail (pre-feature host)
    const snap = buildSnapshot({});
    const legacySnap = { ...snap } as Record<string, unknown>;
    delete legacySnap['debugLogTail'];
    applySnapshot(legacySnap as unknown as WorkflowSnapshot);
    const { container } = render(SystemTab);
    expect(container.querySelector('[data-testid="system-empty"]')).not.toBeNull();
  });
});
