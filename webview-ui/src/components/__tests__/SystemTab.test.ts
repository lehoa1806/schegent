// Feature 064 — T012 (US2) — System tab contract.
//
// SystemTab.svelte renders only entries that satisfy:
//   `entry.scope === 'system'` (with legacy tolerance: a missing `scope`
//   is treated as `'task'` per FR-013, so it is NOT shown in System).
//
// Ordering is newest-first by snapshot order (reverse of the projection's
// oldest-first array). When the post-filter list is empty, the empty-state
// copy "No system events yet." is rendered.
//
// FR-015 cross-check: a synthetic `queue-cleared-all` projected entry whose
// `runId` matches the snapshot's `activeRunId` MUST appear here even though
// it would otherwise be reachable in the Activity Feed's reference set.
// Because it carries `scope === 'system'`, the Activity Feed filter rejects
// it. AuditTail.filter.test.ts pins the inverse half of this invariant.
//
// Feature 068 (US1/US2/US4) — structured per-entry metadata, CLI command
// block, and outcome visibility. Multi-line / card layout. The widened
// filter per FR-011 cross-lists `cli-invocation` entries even when scope
// is `task`. UI-1..UI-15 below pin those invariants.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, cleanup } from '@testing-library/svelte';
import SystemTab from '../SystemTab.svelte';
import AuditTail from '../AuditTail.svelte';
import { snapshotStore } from '../../lib/snapshot-store.svelte';
import type {
  AuditTailEntry,
  QueueItem,
  QueueProjection,
  WorkflowSnapshot
} from '../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../lib/snapshot-types';

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'corr-test' }))
}));

afterEach(() => cleanup());

function buildEntry(
  overrides: Partial<AuditTailEntry> & { runId: string; scope?: 'task' | 'system' }
): AuditTailEntry {
  const scope = overrides.scope ?? ('system' as const);
  return Object.freeze({
    id: `e-${overrides.runId}-${scope}`,
    timestamp: '2026-05-22T12:00:00.000Z',
    phase: 'speckit-plan',
    category: 'system' as const,
    summary: `summary for ${overrides.runId}`,
    ...overrides,
    scope
  });
}

function buildQueueItem(overrides: Partial<QueueItem> & { id: string }): QueueItem {
  return Object.freeze({
    label: `task ${overrides.id}`,
    enqueuedAt: '2026-05-22T11:00:00.000Z',
    startedAt: null,
    updatedAt: '2026-05-22T11:00:00.000Z',
    completedAt: null,
    status: 'pending',
    retryCount: 0,
    lastErrorSummary: null,
    pausedReason: null,
    currentPhase: null,
    position: 0,
    ...overrides
  } as QueueItem);
}

function buildSnapshot(opts: {
  activeRunId?: string | null;
  inFlightId?: string;
  auditTail: readonly AuditTailEntry[];
}): WorkflowSnapshot {
  const queue: QueueProjection = Object.freeze({ orderedItems: [],
    inFlight: opts.inFlightId ? buildQueueItem({ id: opts.inFlightId, status: 'in-flight' }) : null,
    pending: Object.freeze([]),
    recent: Object.freeze([]),
    paused: false
  });
  return Object.freeze({
    schemaVersion: 3,
    isPrimary: true,
    status: 'idle',
    activeFeature: null,
    phases: Object.freeze([]),
    queue,
    auditTail: opts.auditTail,
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
    producedAt: '2026-05-22T12:00:01.000Z',
    activeRunId: opts.activeRunId ?? null,
    availablePipelines: Object.freeze([]),
    availablePhases: Object.freeze([]),
    availableModels: Object.freeze([]),
    generalSettings: IDLE_GENERAL_SETTINGS
  }) as unknown as unknown as WorkflowSnapshot;
}

function applySnapshot(s: WorkflowSnapshot): void {
  snapshotStore.apply({
    type: 'STATE_SNAPSHOT',
    payload: s
  } as unknown as Parameters<typeof snapshotStore.apply>[0]);
}

describe('SystemTab.svelte — system-scope filter (Feature 064 T012)', () => {
  it("renders entries whose scope === 'system'", () => {
    const tail = [
      buildEntry({ id: 'sys-1', runId: 'run-a', scope: 'system' }),
      buildEntry({ id: 'sys-2', runId: 'run-b', scope: 'system' })
    ];
    applySnapshot(buildSnapshot({ auditTail: tail }));
    const { container } = render(SystemTab);
    expect(container.querySelector('[data-testid="system-entry-sys-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="system-entry-sys-2"]')).not.toBeNull();
  });

  it("does NOT render entries whose scope === 'task', regardless of runId reachability", () => {
    const tail = [
      buildEntry({ id: 'task-active', runId: 'run-active', scope: 'task' }),
      buildEntry({ id: 'task-inflight', runId: 'run-in', scope: 'task' }),
      buildEntry({ id: 'task-orphan', runId: 'run-orphan', scope: 'task' })
    ];
    applySnapshot(
      buildSnapshot({
        activeRunId: 'run-active',
        inFlightId: 'run-in',
        auditTail: tail
      })
    );
    const { container } = render(SystemTab);
    expect(container.querySelector('[data-testid="system-entry-task-active"]')).toBeNull();
    expect(container.querySelector('[data-testid="system-entry-task-inflight"]')).toBeNull();
    expect(container.querySelector('[data-testid="system-entry-task-orphan"]')).toBeNull();
  });

  it('renders newest-first (reverses snapshot order)', () => {
    const tail: AuditTailEntry[] = [
      Object.freeze({
        id: 's-old',
        timestamp: '2026-05-22T12:00:00.000Z',
        phase: 'speckit-plan' as const,
        category: 'system' as const,
        summary: 'old',
        runId: 'run-x',
        scope: 'system' as const
      }),
      Object.freeze({
        id: 's-mid',
        timestamp: '2026-05-22T12:00:30.000Z',
        phase: 'speckit-plan' as const,
        category: 'system' as const,
        summary: 'mid',
        runId: 'run-y',
        scope: 'system' as const
      }),
      Object.freeze({
        id: 's-new',
        timestamp: '2026-05-22T12:01:00.000Z',
        phase: 'speckit-plan' as const,
        category: 'system' as const,
        summary: 'new',
        runId: 'run-z',
        scope: 'system' as const
      })
    ];
    applySnapshot(buildSnapshot({ auditTail: Object.freeze(tail) }));
    const { container } = render(SystemTab);
    const liElements = container.querySelectorAll('ol li');
    expect(liElements.length).toBe(3);
    expect(liElements[0]?.getAttribute('data-testid')).toBe('system-entry-s-new');
    expect(liElements[1]?.getAttribute('data-testid')).toBe('system-entry-s-mid');
    expect(liElements[2]?.getAttribute('data-testid')).toBe('system-entry-s-old');
  });

  it("renders empty-state copy 'No system events yet.' when no system entries exist", () => {
    const tail = [
      buildEntry({ id: 'task-only', runId: 'run-active', scope: 'task' })
    ];
    applySnapshot(buildSnapshot({ activeRunId: 'run-active', auditTail: tail }));
    const { getByTestId } = render(SystemTab);
    const empty = getByTestId('system-empty');
    expect(empty.textContent).toBe('No system events yet.');
  });

  it('FR-015 cross-check: queue-cleared-all (system) appears in System tab and NOT in Activity Feed', () => {
    // The projector classifies `queue-cleared-all` as `scope === 'system'`.
    // Even if its runId is reachable (matches activeRunId), the Activity Feed
    // task-scope filter excludes it, and the System tab includes it.
    const clearedAll = buildEntry({
      id: 'cleared',
      runId: 'run-active',
      scope: 'system',
      summary: 'queue cleared'
    });
    applySnapshot(
      buildSnapshot({
        activeRunId: 'run-active',
        auditTail: Object.freeze([clearedAll])
      })
    );

    const system = render(SystemTab);
    expect(system.container.querySelector('[data-testid="system-entry-cleared"]')).not.toBeNull();
    cleanup();

    const audit = render(AuditTail);
    expect(audit.container.querySelector('[data-testid="audit-entry-cleared"]')).toBeNull();
    // Activity Feed shows the empty-state because the only entry is system-scoped.
    expect(audit.container.querySelector('[data-testid="audit-empty"]')).not.toBeNull();
  });

  it("legacy tolerance complement (FR-013): a non-cli legacy entry whose `scope` is undefined is NOT shown in System", () => {
    // Feature 068 (FR-011) widened the filter to cross-list cli-invocation
    // entries regardless of scope, so we use `phase-transition` here to
    // pin the FR-013 legacy-tolerance invariant on a category that the
    // FR-011 cross-list does NOT capture.
    const legacy: AuditTailEntry = {
      id: 'legacy',
      timestamp: '2026-05-22T12:00:00.000Z',
      phase: 'speckit-plan' as const,
      category: 'phase-transition' as const,
      summary: 'pre-feature-064 entry',
      runId: 'run-active'
      // scope deliberately missing — simulates pre-Feature 064 host.
    } as unknown as AuditTailEntry;
    applySnapshot(buildSnapshot({ auditTail: Object.freeze([legacy]) }));
    const { container } = render(SystemTab);
    expect(container.querySelector('[data-testid="system-entry-legacy"]')).toBeNull();
    expect(container.querySelector('[data-testid="system-empty"]')).not.toBeNull();
  });
});

// Feature 068 — UI-1..UI-15. Structured per-entry metadata, CLI command
// block, widened filter (FR-011), escape contract (FR-014), outcome
// non-text channel (FR-008), and unknown-category fallthrough.
function buildSystemEntry(overrides: Partial<AuditTailEntry> & { id: string }): AuditTailEntry {
  return Object.freeze({
    timestamp: '2026-05-22T12:00:00.000Z',
    phase: 'speckit-plan' as const,
    category: 'system' as const,
    summary: `summary for ${overrides.id}`,
    runId: 'run-default',
    scope: 'system' as const,
    ...overrides
  });
}

describe('SystemTab.svelte — Feature 068 structured rendering', () => {
  // UI-1: covered by the existing empty-state test above; this duplicate
  // pins the Feature 068 specific behavior (no <ol> when empty).
  it('UI-1: empty store renders empty-state paragraph and no <ol>', () => {
    applySnapshot(buildSnapshot({ auditTail: Object.freeze([]) }));
    const { container } = render(SystemTab);
    expect(container.querySelector('[data-testid="system-empty"]')).not.toBeNull();
    expect(container.querySelector('ol')).toBeNull();
  });

  it('UI-2: single fully populated entry renders all three cells correctly', () => {
    const entry = buildSystemEntry({
      id: 'full',
      timestamp: '2026-05-23T14:32:01.000Z',
      taskId: 't-42',
      phaseId: 'speckit-plan',
      outcome: 'success',
      summary: 'this is a structured entry'
    });
    applySnapshot(buildSnapshot({ auditTail: Object.freeze([entry]) }));
    const { container } = render(SystemTab);
    expect(container.querySelector('[data-testid="system-entry-full"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="system-entry-time-full"]')?.textContent
    ).toContain('2026-05-23');
    expect(container.querySelector('[data-testid="system-entry-task-full"]')?.textContent).toContain(
      't-42'
    );
    expect(
      container.querySelector('[data-testid="system-entry-phase-full"]')?.textContent
    ).toContain('speckit-plan');
    expect(
      container.querySelector('[data-testid="system-entry-summary-full"]')?.textContent
    ).toContain('this is a structured entry');
  });

  it('UI-3: entry with missing taskId renders em-dash placeholder', () => {
    const entry = buildSystemEntry({ id: 'no-task', taskId: undefined, phaseId: 'speckit-plan' });
    applySnapshot(buildSnapshot({ auditTail: Object.freeze([entry]) }));
    const { container } = render(SystemTab);
    expect(container.querySelector('[data-testid="system-entry-task-no-task"]')?.textContent).toContain(
      '—'
    );
  });

  it('UI-4: entry with missing phaseId renders em-dash placeholder', () => {
    const entry = buildSystemEntry({ id: 'no-phase', taskId: 't-1', phaseId: undefined });
    applySnapshot(buildSnapshot({ auditTail: Object.freeze([entry]) }));
    const { container } = render(SystemTab);
    expect(container.querySelector('[data-testid="system-entry-phase-no-phase"]')?.textContent).toContain(
      '—'
    );
  });

  it('UI-5: outcome=success applies outcome-success class and aria-label contains "success"', () => {
    const entry = buildSystemEntry({ id: 'ok', outcome: 'success' });
    applySnapshot(buildSnapshot({ auditTail: Object.freeze([entry]) }));
    const { container } = render(SystemTab);
    const li = container.querySelector('[data-testid="system-entry-ok"]');
    expect(li?.classList.contains('outcome-success')).toBe(true);
    expect(li?.getAttribute('aria-label') ?? '').toContain('success');
  });

  it('UI-6: outcome=error applies outcome-error class and aria-label contains "error"', () => {
    const entry = buildSystemEntry({ id: 'bad', outcome: 'error' });
    applySnapshot(buildSnapshot({ auditTail: Object.freeze([entry]) }));
    const { container } = render(SystemTab);
    const li = container.querySelector('[data-testid="system-entry-bad"]');
    expect(li?.classList.contains('outcome-error')).toBe(true);
    expect(li?.getAttribute('aria-label') ?? '').toContain('error');
  });

  it('UI-7: outcome=undefined applies outcome-unknown class and outcome cell renders em-dash', () => {
    const entry = buildSystemEntry({ id: 'unk', outcome: undefined });
    applySnapshot(buildSnapshot({ auditTail: Object.freeze([entry]) }));
    const { container } = render(SystemTab);
    const li = container.querySelector('[data-testid="system-entry-unk"]');
    expect(li?.classList.contains('outcome-unknown')).toBe(true);
    expect(
      container.querySelector('[data-testid="system-entry-outcome-unk"]')?.textContent
    ).toContain('—');
  });

  it('UI-8: cli-invocation with command renders <pre class="cli-command">', () => {
    const entry = buildSystemEntry({
      id: 'cli-1',
      scope: 'task',
      category: 'cli-invocation',
      command: 'claude --print --model claude-opus-4-7 ...'
    });
    applySnapshot(buildSnapshot({ auditTail: Object.freeze([entry]) }));
    const { container } = render(SystemTab);
    const pre = container.querySelector('pre[data-testid="system-entry-command-cli-1"]');
    expect(pre).not.toBeNull();
    expect(pre?.tagName.toLowerCase()).toBe('pre');
    expect(pre?.textContent ?? '').toContain('claude --print --model claude-opus-4-7');
    expect(pre?.classList.contains('cli-command')).toBe(true);
  });

  it('UI-9: cli-invocation with missing command renders the "no command captured" placeholder', () => {
    const entry = buildSystemEntry({
      id: 'cli-empty',
      scope: 'task',
      category: 'cli-invocation',
      command: undefined
    });
    applySnapshot(buildSnapshot({ auditTail: Object.freeze([entry]) }));
    const { container } = render(SystemTab);
    expect(
      container.querySelector('[data-testid="system-entry-command-missing-cli-empty"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="system-entry-command-cli-empty"]')
    ).toBeNull();
  });

  it('UI-10: cli-invocation command containing HTML-like text renders as literal text; no <script> element', () => {
    const entry = buildSystemEntry({
      id: 'cli-xss',
      scope: 'task',
      category: 'cli-invocation',
      command: '<script>alert(1)</script>'
    });
    applySnapshot(buildSnapshot({ auditTail: Object.freeze([entry]) }));
    const { container } = render(SystemTab);
    const pre = container.querySelector('[data-testid="system-entry-command-cli-xss"]');
    expect(pre?.textContent ?? '').toContain('<script>alert(1)</script>');
    expect(container.querySelector('script')).toBeNull();
  });

  it('UI-11: cli-invocation command containing ANSI escape sequences renders without the escape codes', () => {
    const entry = buildSystemEntry({
      id: 'cli-ansi',
      scope: 'task',
      category: 'cli-invocation',
      command: '[31mred[0m [1mbold[0m'
    });
    applySnapshot(buildSnapshot({ auditTail: Object.freeze([entry]) }));
    const { container } = render(SystemTab);
    const text = container.querySelector('[data-testid="system-entry-command-cli-ansi"]')?.textContent ?? '';
    expect(text).toContain('red');
    expect(text).toContain('bold');
    expect(text).not.toContain('[31m');
    expect(text).not.toContain('[0m');
    expect(text).not.toContain('[1m');
  });

  it('UI-12: multi-entry list is ordered newest-first; each <li> has its own data-testid', () => {
    const entries = Object.freeze([
      buildSystemEntry({ id: 'older', timestamp: '2026-05-22T12:00:00.000Z' }),
      buildSystemEntry({ id: 'middle', timestamp: '2026-05-22T12:00:30.000Z' }),
      buildSystemEntry({ id: 'newer', timestamp: '2026-05-22T12:01:00.000Z' })
    ]);
    applySnapshot(buildSnapshot({ auditTail: entries }));
    const { container } = render(SystemTab);
    const lis = container.querySelectorAll('ol li');
    expect(lis.length).toBe(3);
    expect(lis[0]?.getAttribute('data-testid')).toBe('system-entry-newer');
    expect(lis[1]?.getAttribute('data-testid')).toBe('system-entry-middle');
    expect(lis[2]?.getAttribute('data-testid')).toBe('system-entry-older');
  });

  it('UI-13: unknown category falls back to system icon without dropping the entry', () => {
    const entry = {
      ...buildSystemEntry({ id: 'odd' }),
      category: 'totally-unknown-category'
    } as unknown as AuditTailEntry;
    applySnapshot(buildSnapshot({ auditTail: Object.freeze([entry]) }));
    const { container } = render(SystemTab);
    expect(container.querySelector('[data-testid="system-entry-odd"]')).not.toBeNull();
  });

  it('UI-14: source file contains no {@html substring (escape-contract hard rule)', () => {
    const src = readFileSync(join(__dirname, '..', 'SystemTab.svelte'), 'utf8');
    expect(src.includes('{@html')).toBe(false);
  });

  it('UI-15: widened filter (FR-011) — scope=system shown; scope=task non-cli hidden; scope=task cli-invocation shown', () => {
    const sys = buildSystemEntry({ id: 'sys-x', scope: 'system', category: 'system' });
    const taskNonCli = buildSystemEntry({
      id: 'task-x',
      scope: 'task',
      category: 'phase-transition'
    });
    const taskCli = buildSystemEntry({
      id: 'task-cli',
      scope: 'task',
      category: 'cli-invocation',
      command: 'claude --print ...'
    });
    applySnapshot(
      buildSnapshot({
        activeRunId: 'run-default',
        auditTail: Object.freeze([sys, taskNonCli, taskCli])
      })
    );
    const { container } = render(SystemTab);
    expect(container.querySelector('[data-testid="system-entry-sys-x"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="system-entry-task-x"]')).toBeNull();
    expect(container.querySelector('[data-testid="system-entry-task-cli"]')).not.toBeNull();
  });
});
