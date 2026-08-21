import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import MonitorPill from '../MonitorPill.svelte';
import QueueGlobalActions from '../QueueGlobalActions.svelte';
import QueueItemActions from '../QueueItemActions.svelte';
import HistorySection from '../HistorySection.svelte';
import QueueDetailRows from '../drilldown/QueueDetailRows.svelte';
import { buildQueueRuntime } from '../../lib/__tests__/queue-runtime-fixture';
import { IDLE_GENERAL_SETTINGS } from '../../lib/snapshot-types';
import type { HistoryRow } from '../../lib/history-rows';
import type {
  CliMonitorState,
  QueueItem,
  QueueSummary,
  WorkflowSnapshot
} from '../../lib/snapshot-types';

afterEach(() => cleanup());

function buildMonitor(): CliMonitorState {
  return Object.freeze({
    runId: 'r',
    phase: 'speckit-plan',
    status: 'running',
    pid: 1,
    startedAt: '2026-05-10T00:00:00.000Z',
    lastStdoutAt: null,
    lastStderrAt: null,
    lastProgressAt: null,
    stdoutLines: 0,
    stderrLines: 0,
    exitCode: null,
    signal: null,
    detectedIssues: Object.freeze([]),
    msSinceLastStdout: 100,
    msSinceLastStderr: null
  });
}

function buildQueueItem(): QueueItem {
  return Object.freeze({
    id: 'q-a',
    label: 'first',
    enqueuedAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    status: 'pending',
    retryCount: 0,
    lastErrorSummary: null,
    pausedReason: null,
    currentPhase: null,
    position: 0
  });
}

function buildQueueSummary(id: string, name: string, position: number): QueueSummary {
  return {
    id,
    name,
    position,
    state: 'active',
    pauseSource: null,
    schedule: null,
    taskCount: 0
  };
}

/** A snapshot with one queue and a second, empty queue — the second gives a
 * pending Task somewhere to move to, so `QueueDetailRows` renders the move
 * `<select>` alongside the row buttons. */
function buildRowsSnapshot(tasks: readonly QueueItem[]): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: 4,
    isPrimary: true,
    queues: Object.freeze([buildQueueRuntime({ queueId: 'q1', name: 'Queue one', tasks })]),
    queue: Object.freeze({
      inFlight: null,
      pending: Object.freeze([]),
      recent: Object.freeze([]),
      orderedItems: Object.freeze(tasks),
      queues: Object.freeze([
        buildQueueSummary('q1', 'Queue one', 0),
        buildQueueSummary('q2', 'Queue two', 1)
      ]),
      paused: false
    }),
    auditTail: Object.freeze([]),
    monitor: null,
    history: Object.freeze([]),
    producedAt: '2026-08-18T00:00:00.000Z',
    availablePipelines: Object.freeze([
      Object.freeze({ id: 'standard', name: 'Standard', phases: Object.freeze(['speckit-specify']) })
    ]),
    availablePhases: Object.freeze([]),
    availableModels: Object.freeze({ claude: [], codex: [], agy: [] }),
    availableBackends: Object.freeze(['claude']),
    generalSettings: IDLE_GENERAL_SETTINGS
  }) as unknown as WorkflowSnapshot;
}

// Feature 103 (T017) — HistorySection renders composed `HistoryRow`s now, not
// durable `HistoryEntry`s, because the list holds runs still going as well as
// finished ones. The a11y property under test is unchanged.
function buildHistoryRow(overrides: Partial<HistoryRow> = {}): HistoryRow {
  return Object.freeze({
    runId: 'rh-1',
    queueId: 'default',
    queueName: 'Default',
    source: 'recorded',
    status: 'completed',
    definitionId: null,
    catalogVersion: null,
    origin: null,
    descriptionPreview: 'history feature one',
    descriptionLength: null,
    orderingKey: '2026-05-09T10:01:00.000Z',
    startedAt: '2026-05-09T10:00:00.000Z',
    completedAt: '2026-05-09T10:01:00.000Z',
    durationMs: 60_000,
    ...overrides
  });
}

describe('Accessibility verification (T070 / FR-022)', () => {
  it('all interactive buttons in QueueGlobalActions expose aria-label', () => {
    const { container } = render(QueueGlobalActions, {
      props: { paused: false, isPrimary: true, completedCount: 1, failedCount: 1, pendingCount: 0, hasInFlight: true }
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      const hasLabel = !!b.getAttribute('aria-label') || !!b.textContent?.trim();
      expect(hasLabel, `button without label: ${b.outerHTML}`).toBe(true);
    }
  });

  it('all action buttons in QueueItemActions are keyboard-focusable and labeled', () => {
    const { container } = render(QueueItemActions, {
      props: { item: { ...buildQueueItem(), status: 'failed' }, isPrimary: true }
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b.getAttribute('aria-label')).toBeTruthy();
      // Explicit type=button keeps Enter from accidentally submitting any
      // ancestor form when sidebar is mounted in a webview
      expect(b.getAttribute('type')).toBe('button');
      // Default tabindex is 0 (focusable) — make sure nothing went tabindex=-1
      expect(b.getAttribute('tabindex')).not.toBe('-1');
    }
  });

  it('MonitorPill exposes data-status + aria-label for SR announcement', () => {
    const { container } = render(MonitorPill, { props: { monitor: buildMonitor() } });
    const pill = container.querySelector('[data-testid="monitor-pill"]') as HTMLElement;
    expect(pill).not.toBeNull();
    expect(pill.getAttribute('data-status')).toBeTruthy();
    expect(pill.getAttribute('aria-label')).toBeTruthy();
  });

  it('HistorySection keeps rows structural and exposes explicit selection buttons', () => {
    const onTaskSelect = vi.fn();
    const { container } = render(HistorySection, {
      props: {
        rows: [
          buildHistoryRow({ status: 'completed' }),
          buildHistoryRow({ runId: 'rh-2', status: 'failed' })
        ] as readonly HistoryRow[],
        isPrimary: true,
        onTaskSelect
      }
    });
    const rows = container.querySelectorAll('[data-history-row]');
    expect(rows.length).toBe(2);
    for (const row of Array.from(rows)) {
      expect(row.getAttribute('role')).toBeNull();
      expect(row.getAttribute('tabindex')).toBeNull();
      const selection = row.querySelector('[data-testid^="history-item-select-"]');
      expect(selection?.tagName).toBe('BUTTON');
      expect(selection?.getAttribute('type')).toBe('button');
      expect(selection?.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('QueueDetailRows renders interactive rows as real buttons, not ARIA-faked containers (BUG-003)', () => {
    // BUG-003 originally guarded Dashboard's `<li>` queue rows: the row itself
    // had no role/tabindex, and a nested `<button>` carried the interactive
    // semantics. Feature 097 deleted Dashboard; QueueDetailRows (the surviving
    // renderer of queue rows) took a different, equally-valid shape — the row
    // itself IS the `<button>` — so the property worth guarding here is the
    // same one restated for that shape: the structural list container stays
    // inert, and every element an operator can act on is a real button with a
    // label, not a div/li wearing ARIA as a costume.
    const pending = { ...buildQueueItem(), id: 'row-a', label: 'first task' };
    const running = {
      ...buildQueueItem(),
      id: 'row-b',
      label: 'second task',
      status: 'in-flight' as const
    };
    const { container } = render(QueueDetailRows, {
      props: { snapshot: buildRowsSnapshot([pending, running]), queueId: 'q1', isPrimary: true }
    });

    const list = container.querySelector('[data-testid="queue-detail-rows"]');
    expect(list?.getAttribute('role')).toBeNull();
    expect(list?.getAttribute('tabindex')).toBeNull();

    const rows = container.querySelectorAll(
      '[data-testid^="queue-task-row-"], [data-testid^="queue-run-row-"]'
    );
    expect(rows.length).toBe(2);
    for (const row of Array.from(rows)) {
      expect(row.tagName).toBe('BUTTON');
      expect(row.getAttribute('type')).toBe('button');
      expect(row.getAttribute('aria-label')).toBeTruthy();
    }

    const moveSelect = container.querySelector('[data-testid^="queue-task-move-"]');
    expect(moveSelect?.getAttribute('aria-label')).toBeTruthy();
  });

  it('rendered DOM does not embed inline animation/transition CSS that could bypass prefers-reduced-motion', () => {
    const renders = [
      render(MonitorPill, { props: { monitor: { ...buildMonitor(), status: 'stalled' } } }),
      render(QueueGlobalActions, {
        props: { paused: false, isPrimary: true, completedCount: 0, failedCount: 0, pendingCount: 0, hasInFlight: false }
      })
    ];
    for (const r of renders) {
      const all = r.container.querySelectorAll('*');
      for (const el of Array.from(all)) {
        const inline = el.getAttribute('style') ?? '';
        expect(inline).not.toMatch(/animation\s*:/i);
        expect(inline).not.toMatch(/transition\s*:/i);
      }
    }
  });
});

const COMPONENTS_DIR = resolve(__dirname, '..');
const SVELTE_FILES: string[] = (function collect() {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name.endsWith('.svelte')) out.push(full);
    }
  }
  walk(COMPONENTS_DIR);
  return out;
})();

const HEX_COLOR_RE = /(?:^|[^\w-])#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?(?![0-9a-fA-F])/;
const RGB_RE = /\brgba?\(/;
// A named color must appear as a property *value* — preceded by `:` and any
// whitespace (no leading hyphen, which would mark it as part of a property
// name like `white-space` or a custom-property name like `--vscode-charts-blue`)
// and followed by end-of-value: whitespace+`!important`, `;`, `}`, or EOL.
const NAMED_COLOR_RE = /:\s*(?:red|blue|green|yellow|purple|pink|orange|black|white|gray|grey|aqua|lime|maroon|navy|olive|silver|teal|fuchsia|cyan|magenta)(?:\s*!important)?\s*[;}]/i;

function extractStyleBlock(src: string): string {
  const m = src.match(/<style[^>]*>([\s\S]*?)<\/style>/);
  return m ? m[1] : '';
}

describe('Theme verification (T071 / FR-021)', () => {
  it('every webview .svelte component uses VS Code theme variables only — no hardcoded hex/rgb/named colors', () => {
    expect(SVELTE_FILES.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of SVELTE_FILES) {
      const src = readFileSync(file, 'utf8');
      const style = extractStyleBlock(src);
      if (!style) continue;
      // Strip CSS comments to avoid false positives
      const stripped = style.replace(/\/\*[\s\S]*?\*\//g, '');
      if (HEX_COLOR_RE.test(stripped)) {
        offenders.push(`${file}: contains hex color`);
      }
      if (RGB_RE.test(stripped)) {
        offenders.push(`${file}: contains rgb()/rgba()`);
      }
      if (NAMED_COLOR_RE.test(stripped)) {
        offenders.push(`${file}: contains named CSS color`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('every webview .svelte component references at least one --schegent-* or --vscode-* variable', () => {
    // Components without any color-bearing style block are OK; we only check
    // components whose style block actually sets background/color.
    const missing: string[] = [];
    for (const file of SVELTE_FILES) {
      const src = readFileSync(file, 'utf8');
      const style = extractStyleBlock(src);
      if (!style) continue;
      const stripped = style.replace(/\/\*[\s\S]*?\*\//g, '');
      const hasColorProp = /(?:^|[^a-z-])(?:background|color|border)\b/.test(stripped);
      if (!hasColorProp) continue;
      const hasThemeVar = /var\(--(?:schegent|vscode)-[a-z0-9-]+/i.test(stripped);
      if (!hasThemeVar) missing.push(file);
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });
});
