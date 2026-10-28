// FR-R4-F14 (spec 242, contract V4, census C10 to C12; D3, P3, P4) — the start-failure handler records
// `start_failed`, and its announcement stays the classification's own.
//
// The handler is the controller's route to a terminal state for a start that threw before or outside the
// drive. Four of its five classifications fail the Run and emit `task-execution-ended` through the shared
// emitter; `lock-held` fails the Run too (P3: the code says why the run ended, and an ended run has a
// reason) but writes no event and calls no `complete()`, because another window owns that Run's
// evidence. A Run that is ALREADY failed is not written again and keeps its own code (P4), and its event
// carries that code, not `start_failed`.
//
// The announcement is the classification's, unchanged (User Story 5 scenario 3). It interpolates the
// classification's sanitized message, which is host error text; what this file pins is that it names no
// action by an inexact title and offers no action known to fail, and that nothing the handler can see
// of a previous failure (the Run's stream summaries and last error) reaches it.
import { describe, expect, it, vi } from 'vitest';

import { projectAuditPayload } from '../../../src/audit/audit-payload';
import { classifyStartFailure } from '../../../src/controller/start-failure-classification';
import {
  reportUnexpectedStartFailure,
  type UnexpectedStartFailureDeps
} from '../../../src/controller/unexpected-start-failure';
import { ConsentWriteFailedError } from '../../../src/controller/uncontained-consent-gate';
import { LockHeldError } from '../../../src/lib/errors';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { FeatureRequest } from '../../../src/queue/feature-request';
import { CapabilityNotEnforceableError } from '../../../src/services/capability-refusal';
import { UncontainedBackendRefusedError } from '../../../src/services/backend-containment-policy';
import { emitTerminalOutcomeAudit } from '../../../src/services/terminal-outcome-audit';
import type { WorkflowRun } from '../../../src/state/workflow-run';

const FEATURE_ID = 'task-start-1';
const SENTINEL = 'SENTINEL-PREVIOUS-AGENT-OUTPUT-sk-ant-' + 'Q'.repeat(24);
const BARE_FRAGMENTS = ['"Schegent: Resume"', 'Retry feature', 'Schegent: Resume Queue', 'Show last error'];

const sanitizer = new SanitizedLogger();
const sanitize = (value: string): string => sanitizer.sanitize(value);

const CLASSIFICATIONS: ReadonlyArray<{ readonly name: string; readonly err: () => unknown }> = [
  { name: 'lock-held', err: () => new LockHeldError('window-7') },
  { name: 'uncontained-backend-refused', err: () => new UncontainedBackendRefusedError('codex', 'refused: add it') },
  { name: 'capability-not-enforceable', err: () => new CapabilityNotEnforceableError('codex', ['network']) },
  { name: 'consent-write-failed', err: () => new ConsentWriteFailedError('codex', 'disk full') },
  { name: 'unexpected', err: () => new Error('something broke') }
];
const FAILING = CLASSIFICATIONS.filter((entry) => entry.name !== 'lock-held');

function runWith(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-start-1',
    featureId: FEATURE_ID,
    featureDir: '',
    status: 'running',
    currentPhase: 'speckit-implement',
    currentIteration: 1,
    startedAt: Date.now() - 1_000,
    lastTransitionAt: Date.now() - 500,
    // The previous attempt's agent text: stream summaries and a last error the handler can read.
    phasesCompleted: [{ phase: 'speckit-plan', iteration: 1, stdoutSummary: SENTINEL, stderrSummary: SENTINEL }],
    lastError: { code: 'invocation-failed', message: SENTINEL, phase: 'speckit-plan', iteration: 1, at: 1 },
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    ...overrides
  } as unknown as WorkflowRun;
}

function harness(activeRun: WorkflowRun) {
  const events: Array<Record<string, unknown>> = [];
  const sink = {
    emitTaskLifecycle: async (_type: 'task-execution-ended', _run: WorkflowRun, payload: Record<string, unknown>) => {
      events.push(payload);
    }
  };
  const persist = vi.fn(async (_prev: WorkflowRun, next: WorkflowRun) => next);
  const complete = vi.fn(async () => undefined);
  const notifierWarn = vi.fn();
  const statusBarUpdate = vi.fn();
  const logger = new SanitizedLogger();
  const deps = {
    logger,
    store: { getRun: vi.fn(() => activeRun) },
    queue: { queueIdForTask: vi.fn(() => 'default'), finish: vi.fn(async () => ({ ok: true })) },
    statusBar: { update: statusBarUpdate },
    notifier: { warn: notifierWarn },
    historyRecorder: { record: vi.fn(async () => undefined) },
    lifecycleAuditor: {
      emitRunEndedBreakpoints: vi.fn(async () => undefined),
      // The real auditor is this call with itself as the sink (`workflow-lifecycle-auditor.ts`).
      emitTaskExecutionEnded: async (run: WorkflowRun, status: 'completed' | 'failed', summary?: string) =>
        emitTerminalOutcomeAudit(sink, logger, run, status, summary === undefined ? {} : { lastErrorSummary: summary })
    },
    terminalTransitions: { begin: vi.fn(), complete },
    sessions: { disposeIfEnded: vi.fn() },
    persist,
    releaseExecutionLeaseForRun: vi.fn(async () => undefined),
    scheduleAutoDrain: vi.fn()
  } as unknown as UnexpectedStartFailureDeps;

  async function report(err: unknown, run: WorkflowRun | null = activeRun): Promise<void> {
    await reportUnexpectedStartFailure(deps, {
      feature: { id: FEATURE_ID } as unknown as FeatureRequest,
      startedRun: run,
      description: 'Add the export button',
      err
    });
  }
  return { report, events, persist, complete, notifierWarn, statusBarUpdate };
}

describe('reportUnexpectedStartFailure — start_failed (census C10 to C12)', () => {
  it.each(FAILING)('$name: persists start_failed and emits the terminal event carrying it', async ({ err }) => {
    const h = harness(runWith());
    await h.report(err());

    expect(h.persist).toHaveBeenCalledTimes(1);
    const written = h.persist.mock.calls[0][1];
    expect(written.status).toBe('failed');
    expect(written.failureCause).toBe('start_failed');

    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ terminalStatus: 'failed', failureCause: 'start_failed' });
    expect(projectAuditPayload('task-execution-ended', h.events[0] ?? {}).failureCause).toBe('start_failed');
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it('lock-held: persists start_failed on an active Run, and writes no event and no complete() (P3)', async () => {
    const h = harness(runWith());
    await h.report(new LockHeldError('window-7'));

    expect(h.persist.mock.calls[0]?.[1]?.failureCause).toBe('start_failed');
    expect(h.events).toEqual([]);
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('writes the cause on a paused Run too, in the same write that fails it', async () => {
    const h = harness(runWith({ status: 'paused', manualPauseAt: 1, manualPauseCause: 'operator-paused' }));
    await h.report(new Error('boom'));

    const written = h.persist.mock.calls[0][1];
    expect(written.status).toBe('failed');
    expect(written.failureCause).toBe('start_failed');
    expect(written.manualPauseAt).toBeNull();
  });

  it('an already-failed Run is not written again, keeps its cause, and its event carries that cause (P4)', async () => {
    const h = harness(runWith({ status: 'failed', failureCause: 'cap_exhausted' }));
    await h.report(new Error('a later throw'));

    expect(h.persist).not.toHaveBeenCalled();
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ terminalStatus: 'failed', failureCause: 'cap_exhausted' });
  });

  it('a start that failed before any Run existed writes no Run and no event', async () => {
    const h = harness(runWith());
    await h.report(new Error('before the Run'), null);

    expect(h.persist).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
    expect(h.notifierWarn).toHaveBeenCalledTimes(1);
  });
});

describe('reportUnexpectedStartFailure — the announcement stays the classification\'s (User Story 5 scenario 3)', () => {
  it.each(CLASSIFICATIONS)('$name: shows the classification announcement unchanged, naming no inexact action', async ({ err }) => {
    const h = harness(runWith());
    const thrown = err();
    await h.report(thrown);

    const report = classifyStartFailure(thrown, FEATURE_ID, sanitize);
    expect(h.notifierWarn).toHaveBeenCalledTimes(1);
    expect(h.notifierWarn).toHaveBeenCalledWith(report.announcement);
    for (const fragment of BARE_FRAGMENTS) {
      expect(report.announcement.includes(fragment), fragment).toBe(false);
    }
    expect(h.statusBarUpdate).toHaveBeenLastCalledWith(expect.any(String), {
      kind: 'failed',
      phase: 'speckit-implement',
      detail: report.statusDetail
    });
  });

  it.each(CLASSIFICATIONS)(
    '$name: nothing a previous attempt\'s agent wrote reaches the announcement, status detail or event (SC-002)',
    async ({ err }) => {
      const h = harness(runWith());
      await h.report(err());

      const surfaces = [
        JSON.stringify(h.notifierWarn.mock.calls),
        JSON.stringify(h.statusBarUpdate.mock.calls),
        JSON.stringify(h.events.map((event) => projectAuditPayload('task-execution-ended', event)))
      ];
      for (const surface of surfaces) expect(surface).not.toContain('SENTINEL');
    }
  );
});
