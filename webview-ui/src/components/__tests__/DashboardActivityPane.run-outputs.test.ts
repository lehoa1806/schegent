// Feature 091 (T015, US1 — FR-013) — recorded outputs reach the operator once
// the data flows.
//
// `RunOutputs.test.ts` already pins the leaf component: given records, it lists
// them, unresolved ones included. What it cannot pin is the level above — that
// the pane which owns Run details actually derives `snapshot.runOutputs` and
// renders that component with them. Until this slice, the question was moot:
// nothing wrote `WorkflowRun.runOutputs`, so `projectRunOutputs` always
// projected nothing and the pane's guard was never once true in a shipped
// build. FR-013 asks for that confirmed rather than assumed, which is a
// statement about the pane, not about the leaf.
//
// The unresolved-only case is the one that matters. A pane that quietly
// filtered to resolved records would satisfy every leaf test and still hide the
// exact thing an operator needs — a declared output the Phases never produced —
// and it would do so most completely on the Run where nothing resolved at all.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import DashboardActivityPane from '../DashboardActivityPane.svelte';
import { createPhaseLogStore } from '../../lib/phase-log-store.svelte';
import type {
  PhaseTile,
  RunOutputRecord,
  WorkflowSnapshot
} from '../../lib/snapshot-types';
import { foldLegacyRun } from '../../lib/__tests__/queue-runtime-fixture';

// The pane hosts the activity feed, which reaches for the phase-log IPC on
// mount. Neither the feed nor its transport is under test here; these stubs
// keep the mount from touching a host that does not exist in jsdom.
vi.mock('../../lib/phase-log-ipc', () => ({
  readPhaseLog: vi.fn().mockResolvedValue({
    outcome: 'success',
    manifest: {
      iterations: [1],
      selectedIteration: 1,
      entries: Object.freeze([]),
      skippedLines: 0,
      truncatedCount: 0,
      verboseDiagnosticsState: { kind: 'enabled-with-sessions' },
      isInFlight: false
    }
  }),
  startPhaseLogTail: vi.fn().mockResolvedValue({
    outcome: 'success',
    sessionId: 'pane-test-tail',
    mechanism: 'poll'
  }),
  stopPhaseLogTail: vi
    .fn()
    .mockResolvedValue({ outcome: 'success', sessionId: 'pane-test-tail' }),
  openVerboseSetting: vi.fn(),
  subscribePhaseLogPush: vi.fn(() => () => {})
}));

afterEach(() => cleanup());

const RESOLVED: RunOutputRecord = {
  name: 'report',
  status: 'resolved',
  reference: 'out/report.md'
};
const UNRESOLVED: RunOutputRecord = { name: 'summary', status: 'unresolved' };

const PHASES: readonly PhaseTile[] = Object.freeze([
  Object.freeze({
    name: 'compose',
    order: 1,
    state: 'completed' as const,
    iteration: 1,
    lastResult: null,
    elapsedMs: 0,
    subProgress: null
  })
]);

function buildSnapshot(runOutputs?: readonly RunOutputRecord[]): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: 4,
    isPrimary: true,
    // Feature 092 — the v3 root run singulars now hang off the queue that owns
    // the Run. `foldLegacyRun` performs that fold, so the call sites below keep
    // their v3 wording.
    queues: foldLegacyRun({
      status: 'completed',
      activeFeature: null,
      phases: PHASES,
      liveActivity: null,
      workflowElapsedMs: 1_000,
      runOutputs
    }),
    queue: Object.freeze({
      orderedItems: Object.freeze([]),
      inFlight: null,
      pending: Object.freeze([]),
      recent: Object.freeze([]),
      paused: false
    }),
    auditTail: Object.freeze([]),
    monitor: null,
    history: Object.freeze([]),
    producedAt: '2026-08-01T00:00:00.000Z',
    availablePipelines: Object.freeze([]),
    availablePhases: Object.freeze([]),
    availableModels: Object.freeze({ claude: [], codex: [], agy: [] }),
    availableBackends: Object.freeze(['claude'])
  }) as unknown as WorkflowSnapshot;
}

function renderPane(runOutputs?: readonly RunOutputRecord[]) {
  return render(DashboardActivityPane, {
    snapshot: buildSnapshot(runOutputs),
    phases: PHASES,
    activeTaskId: null,
    selectedPhaseId: null,
    store: createPhaseLogStore(),
    onSelectQueue: () => {},
    onSelectTask: () => {},
    onSelectPhase: () => {},
    onJumpToCurrent: () => {}
  });
}

describe('recorded outputs in the pane that owns Run details (FR-013)', () => {
  it('renders what the projection carried, resolved and unresolved alike', () => {
    const { getByTestId } = renderPane([RESOLVED, UNRESOLVED]);
    expect(getByTestId('run-outputs')).toBeTruthy();
    expect(getByTestId('run-output-record-report').textContent).toContain('report');
    expect(getByTestId('run-output-record-summary').textContent).toContain('summary');
  });

  it('shows an unresolved output as present rather than omitting it', () => {
    // Everything unresolved — the shape a pane that filtered by status would
    // render as an empty Run, and the shape most worth being loud about.
    const { getByTestId, queryByTestId } = renderPane([UNRESOLVED]);
    expect(getByTestId('run-outputs')).toBeTruthy();
    expect(getByTestId('run-output-status-summary').textContent).toContain('unresolved');
    expect(queryByTestId('run-output-reference-summary')).toBeNull();
  });

  it('keeps the declared order the Run recorded', () => {
    const { getByTestId } = renderPane([UNRESOLVED, RESOLVED]);
    const names = Array.from(
      getByTestId('run-outputs').querySelectorAll('[data-output-name]')
    ).map((element) => element.textContent?.trim());
    expect(names).toEqual(['summary', 'report']);
  });

  it('renders no outputs surface for a Run that recorded none', () => {
    // A pre-feature Run, and every Run of a Pipeline that declares no outputs.
    // The absence is the correct render; an empty "Run Outputs" heading would
    // suggest a Run that produced nothing rather than one that promised nothing.
    const { queryByTestId } = renderPane();
    expect(queryByTestId('run-outputs')).toBeNull();
    expect(queryByTestId('run-outputs-panel')).toBeNull();
  });
});
