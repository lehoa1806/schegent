// Feature 073 (Phase 2 Foundational, T002) — pins the audit-log scanning,
// join-key grouping, and Phase Record outcome-precedence contract for
// `readMetrics(workspaceRoot)` ahead of implementation (T009).
//
// Scope (per specs/073-metrics-dashboard/tasks.md T009): direct
// task-execution-started/-ended pairing only. The phase-grouping
// reconstruction fallback for task boundaries with no direct pair is a
// separate, later task (T013/T015) and is NOT covered here.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEntry } from '../../../src/audit/audit-entry';
import { readMetrics } from '../../../src/metrics/metrics-service';

function baseEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 'e-default',
    timestamp: '2026-05-23T12:00:00.000Z',
    runId: 'run-abc',
    phase: 'speckit-plan',
    iteration: 1,
    eventType: 'phase-start',
    payload: {},
    outcome: 'info',
    ...overrides
  };
}

function line(overrides: Partial<AuditEntry> = {}): string {
  return JSON.stringify(baseEntry(overrides));
}

function taskStarted(o: {
  id: string;
  timestamp: string;
  runId: string;
  taskId?: string;
}): string {
  return line({
    id: o.id,
    timestamp: o.timestamp,
    runId: o.runId,
    phase: 'speckit-specify',
    iteration: 0,
    eventType: 'task-execution-started',
    outcome: 'info',
    payload: {
      taskId: o.taskId ?? o.runId,
      runId: o.runId,
      queueId: 'default',
      pipelineId: 'default',
      isResume: false
    }
  });
}

function taskEnded(o: {
  id: string;
  timestamp: string;
  runId: string;
  terminalStatus: 'completed' | 'failed' | 'canceled';
  durationMs: number;
  phasesTotal: number;
  phasesCompleted: number;
  phasesSkipped: number;
  taskId?: string;
}): string {
  return line({
    id: o.id,
    timestamp: o.timestamp,
    runId: o.runId,
    phase: 'done',
    iteration: 0,
    eventType: 'task-execution-ended',
    outcome: o.terminalStatus === 'completed' ? 'success' : 'failure',
    payload: {
      taskId: o.taskId ?? o.runId,
      runId: o.runId,
      terminalStatus: o.terminalStatus,
      durationMs: o.durationMs,
      phasesTotal: o.phasesTotal,
      phasesCompleted: o.phasesCompleted,
      phasesSkipped: o.phasesSkipped
    }
  });
}

function phaseStart(o: {
  id: string;
  timestamp: string;
  runId: string;
  phase: string;
  iteration: number;
}): string {
  return line({
    id: o.id,
    timestamp: o.timestamp,
    runId: o.runId,
    phase: o.phase,
    iteration: o.iteration,
    eventType: 'phase-start',
    outcome: 'info',
    payload: { pipelineId: 'default', phaseId: o.phase }
  });
}

function phaseEnd(o: {
  id: string;
  timestamp: string;
  runId: string;
  phase: string;
  iteration: number;
  outcome?: 'clean' | 'issues_remain' | 'failed' | 'rate_limited' | 'transient_error' | 'skipped';
  reason?: 'timeout';
  totalCostUsd?: number;
}): string {
  const payload: Record<string, unknown> = { pipelineId: 'default', phaseId: o.phase };
  if (o.reason) payload.reason = o.reason;
  if (o.outcome) payload.outcome = o.outcome;
  if (o.totalCostUsd !== undefined) payload.totalCostUsd = o.totalCostUsd;
  return line({
    id: o.id,
    timestamp: o.timestamp,
    runId: o.runId,
    phase: o.phase,
    iteration: o.iteration,
    eventType: 'phase-end',
    outcome: o.reason === 'timeout' ? 'failure' : o.outcome === 'clean' ? 'success' : o.outcome === 'skipped' ? 'info' : 'failure',
    payload
  });
}

function phaseJumped(o: {
  id: string;
  timestamp: string;
  runId: string;
  phase: string;
  iterationN: number;
  durationMs: number;
}): string {
  return line({
    id: o.id,
    timestamp: o.timestamp,
    runId: o.runId,
    phase: o.phase,
    iteration: 0,
    eventType: 'phase-jumped',
    outcome: 'info',
    payload: {
      phaseId: o.phase,
      runId: o.runId,
      pipelineId: 'default',
      durationMs: o.durationMs,
      iterationN: o.iterationN,
      reason: 'operator-jump'
    }
  });
}

function phaseBreakpointFired(o: {
  id: string;
  timestamp: string;
  runId: string;
  phase: string;
  iterationN: number;
}): string {
  return line({
    id: o.id,
    timestamp: o.timestamp,
    runId: o.runId,
    phase: o.phase,
    iteration: 0,
    eventType: 'phase-breakpoint-fired',
    outcome: 'info',
    payload: {
      runId: o.runId,
      phaseId: o.phase,
      pipelineId: 'default',
      iterationN: o.iterationN
    }
  });
}

function cliInvocation(o: {
  id: string;
  timestamp: string;
  runId: string;
  phase: string;
  iteration: number;
}): string {
  return line({
    id: o.id,
    timestamp: o.timestamp,
    runId: o.runId,
    phase: o.phase,
    iteration: o.iteration,
    eventType: 'cli-invocation',
    outcome: 'info',
    payload: { pipelineId: 'default', phaseId: o.phase, command: 'claude --print' }
  });
}

describe('readMetrics (Feature 073 Phase 2 Foundational)', () => {
  let workspaceRoot: string;
  let auditDir: string;
  let auditLog: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'schegent-metrics-'));
    auditDir = join(workspaceRoot, '.schegent');
    auditLog = join(auditDir, 'audit.log');
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('returns an empty response when .schegent/ directory is missing', async () => {
    const result = await readMetrics(workspaceRoot);
    expect(result.tasks).toEqual([]);
    expect(result.phaseTypeAggregates).toEqual([]);
    expect(result.costTimeline).toEqual([]);
    expect(result.meta.totalScannedEntries).toBe(0);
    expect(result.meta.parseWarnings).toBe(0);
    expect(result.meta.includesArchives).toBe(false);
    expect(result.oldestIncludedTimestamp).toBeUndefined();
  });

  it('returns an empty response for an empty audit.log', async () => {
    await mkdir(auditDir, { recursive: true });
    await writeFile(auditLog, '', 'utf8');
    const result = await readMetrics(workspaceRoot);
    expect(result.tasks).toEqual([]);
    expect(result.meta.totalScannedEntries).toBe(0);
  });

  it('tallies malformed JSON lines into parseWarnings without dropping surrounding valid entries', async () => {
    await mkdir(auditDir, { recursive: true });
    const lines = [
      taskStarted({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-1' }),
      '{not valid JSON',
      taskEnded({
        id: 'e-2',
        timestamp: '2026-05-23T12:05:00.000Z',
        runId: 'run-1',
        terminalStatus: 'completed',
        durationMs: 300000,
        phasesTotal: 1,
        phasesCompleted: 1,
        phasesSkipped: 0
      })
    ];
    await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

    const result = await readMetrics(workspaceRoot);

    expect(result.meta.parseWarnings).toBe(1);
    expect(result.meta.totalScannedEntries).toBe(3);
    expect(result.tasks.length).toBe(1);
    expect(result.tasks[0]!.runId).toBe('run-1');
  });

  it('preserves unknown eventType entries (never dropped) and tallies them as parseWarnings', async () => {
    await mkdir(auditDir, { recursive: true });
    const lines = [
      taskStarted({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-1' }),
      JSON.stringify({
        ...baseEntry({ id: 'e-2', runId: 'run-1', timestamp: '2026-05-23T12:01:00.000Z' }),
        eventType: 'totally-new-event-type'
      })
    ];
    await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

    const result = await readMetrics(workspaceRoot);

    expect(result.meta.parseWarnings).toBe(1);
    expect(result.meta.totalScannedEntries).toBe(2);
  });

  it('derives a completed Task Record from a direct task-execution-started/-ended pair', async () => {
    await mkdir(auditDir, { recursive: true });
    const lines = [
      taskStarted({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-1', taskId: 'task-1' }),
      phaseStart({ id: 'e-2', timestamp: '2026-05-23T12:00:01.000Z', runId: 'run-1', phase: 'speckit-plan', iteration: 1 }),
      phaseEnd({
        id: 'e-3',
        timestamp: '2026-05-23T12:04:00.000Z',
        runId: 'run-1',
        phase: 'speckit-plan',
        iteration: 1,
        outcome: 'clean',
        totalCostUsd: 0.42
      }),
      taskEnded({
        id: 'e-4',
        timestamp: '2026-05-23T12:04:01.000Z',
        runId: 'run-1',
        taskId: 'task-1',
        terminalStatus: 'completed',
        durationMs: 240000,
        phasesTotal: 1,
        phasesCompleted: 1,
        phasesSkipped: 0
      })
    ];
    await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

    const result = await readMetrics(workspaceRoot);

    expect(result.tasks.length).toBe(1);
    const task = result.tasks[0]!;
    expect(task.runId).toBe('run-1');
    expect(task.taskId).toBe('task-1');
    expect(task.source).toBe('task-lifecycle');
    expect(task.status).toBe('completed');
    expect(task.isRunning).toBe(false);
    expect(task.durationMs).toBe(240000);
    expect(task.phasesTotal).toBe(1);
    expect(task.phasesCompleted).toBe(1);
    expect(task.phasesSkipped).toBe(0);
    expect(task.totalCostUsd).toBeCloseTo(0.42);
    expect(task.phases.length).toBe(1);
    expect(task.phases[0]!.outcome).toBe('completed');
  });

  it('marks a task with a started but no ended event as running, with no status', async () => {
    await mkdir(auditDir, { recursive: true });
    const lines = [
      taskStarted({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-1' })
    ];
    await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

    const result = await readMetrics(workspaceRoot);

    expect(result.tasks.length).toBe(1);
    const task = result.tasks[0]!;
    expect(task.isRunning).toBe(true);
    expect(task.status).toBeUndefined();
    expect(task.endTime).toBeUndefined();
    // Task Record durationMs is non-optional (unlike Phase Record's), so a
    // running task reports elapsed-so-far rather than leaving it undefined
    // (data-model.md §1).
    expect(typeof task.durationMs).toBe('number');
    expect(task.durationMs).toBeGreaterThanOrEqual(0);
  });

  describe('Phase Record outcome-precedence (research.md §6)', () => {
    it('derives "completed" from phase-end payload.outcome === "clean"', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        taskStarted({ id: 'e-0', timestamp: '2026-05-23T11:59:00.000Z', runId: 'run-1' }),
        phaseStart({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-1', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({ id: 'e-2', timestamp: '2026-05-23T12:01:00.000Z', runId: 'run-1', phase: 'speckit-plan', iteration: 1, outcome: 'clean' })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');
      const result = await readMetrics(workspaceRoot);
      const phase = findPhase(result, 'run-1', 'speckit-plan', 1);
      expect(phase.outcome).toBe('completed');
      expect(phase.durationMs).toBe(60000);
    });

    it('derives "failed" from phase-end payload.outcome === "failed"', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        taskStarted({ id: 'e-0', timestamp: '2026-05-23T11:59:00.000Z', runId: 'run-1' }),
        phaseStart({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-1', phase: 'speckit-implement', iteration: 1 }),
        phaseEnd({ id: 'e-2', timestamp: '2026-05-23T12:01:00.000Z', runId: 'run-1', phase: 'speckit-implement', iteration: 1, outcome: 'failed' })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');
      const result = await readMetrics(workspaceRoot);
      const phase = findPhase(result, 'run-1', 'speckit-implement', 1);
      expect(phase.outcome).toBe('failed');
    });

    it('derives "skipped" from phase-end payload.outcome === "skipped"', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        taskStarted({ id: 'e-0', timestamp: '2026-05-23T11:59:00.000Z', runId: 'run-1' }),
        phaseStart({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-1', phase: 'speckit-checklist', iteration: 1 }),
        phaseEnd({ id: 'e-2', timestamp: '2026-05-23T12:01:00.000Z', runId: 'run-1', phase: 'speckit-checklist', iteration: 1, outcome: 'skipped' })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');
      const result = await readMetrics(workspaceRoot);
      const phase = findPhase(result, 'run-1', 'speckit-checklist', 1);
      expect(phase.outcome).toBe('skipped');
    });

    it('collapses issues_remain/rate_limited/transient_error into "failed" while retaining rawOutcome', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        taskStarted({ id: 'e-0', timestamp: '2026-05-23T11:59:00.000Z', runId: 'run-1' }),
        phaseStart({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-1', phase: 'speckit-analyze', iteration: 1 }),
        phaseEnd({ id: 'e-2', timestamp: '2026-05-23T12:01:00.000Z', runId: 'run-1', phase: 'speckit-analyze', iteration: 1, outcome: 'rate_limited' })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');
      const result = await readMetrics(workspaceRoot);
      const phase = findPhase(result, 'run-1', 'speckit-analyze', 1);
      expect(phase.outcome).toBe('failed');
      expect(phase.rawOutcome).toBe('rate_limited');
    });

    it('derives "failed" from a timeout phase-end (reason field, no outcome field)', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        taskStarted({ id: 'e-0', timestamp: '2026-05-23T11:59:00.000Z', runId: 'run-1' }),
        phaseStart({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-1', phase: 'speckit-tasks', iteration: 1 }),
        phaseEnd({ id: 'e-2', timestamp: '2026-05-23T12:10:00.000Z', runId: 'run-1', phase: 'speckit-tasks', iteration: 1, reason: 'timeout' })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');
      const result = await readMetrics(workspaceRoot);
      const phase = findPhase(result, 'run-1', 'speckit-tasks', 1);
      expect(phase.outcome).toBe('failed');
      expect(phase.rawOutcome).toBe('timeout');
    });

    it('derives "jumped" from phase-jumped, using payload.iterationN and payload.durationMs (shape asymmetry)', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        taskStarted({ id: 'e-0', timestamp: '2026-05-23T11:59:00.000Z', runId: 'run-1' }),
        phaseStart({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-1', phase: 'speckit-clarify', iteration: 3 }),
        phaseJumped({
          id: 'e-2',
          timestamp: '2026-05-23T12:02:00.000Z',
          runId: 'run-1',
          phase: 'speckit-clarify',
          iterationN: 3,
          durationMs: 120000
        })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');
      const result = await readMetrics(workspaceRoot);
      const phase = findPhase(result, 'run-1', 'speckit-clarify', 3);
      expect(phase.outcome).toBe('jumped');
      expect(phase.durationMs).toBe(120000);
    });

    it('derives "paused-at-breakpoint" from phase-breakpoint-fired with no preceding phase-start (halted before any CLI spawn)', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        taskStarted({ id: 'e-0', timestamp: '2026-05-23T11:59:00.000Z', runId: 'run-1' }),
        phaseBreakpointFired({
          id: 'e-1',
          timestamp: '2026-05-23T12:00:00.000Z',
          runId: 'run-1',
          phase: 'speckit-review',
          iterationN: 1
        })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');
      const result = await readMetrics(workspaceRoot);
      const phase = findPhase(result, 'run-1', 'speckit-review', 1);
      expect(phase.outcome).toBe('paused-at-breakpoint');
      // No phase-start exists (the breakpoint halts before invocation), so
      // startTime falls back to the breakpoint event's own timestamp —
      // a zero-width duration rather than a fabricated elapsed time.
      expect(phase.startTime).toBe('2026-05-23T12:00:00.000Z');
      expect(phase.endTime).toBe('2026-05-23T12:00:00.000Z');
      expect(phase.durationMs).toBe(0);
    });

    it('leaves outcome undefined (still running) when a phase has no terminal event yet', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        taskStarted({ id: 'e-0', timestamp: '2026-05-23T11:59:00.000Z', runId: 'run-1' }),
        phaseStart({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-1', phase: 'speckit-plan', iteration: 1 })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');
      const result = await readMetrics(workspaceRoot);
      const phase = findPhase(result, 'run-1', 'speckit-plan', 1);
      expect(phase.outcome).toBeUndefined();
      expect(phase.endTime).toBeUndefined();
      expect(phase.durationMs).toBeUndefined();
    });

    it('leaves costUsd undefined (not zero) when phase-end carries no totalCostUsd', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        taskStarted({ id: 'e-0', timestamp: '2026-05-23T11:59:00.000Z', runId: 'run-1' }),
        phaseStart({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-1', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({ id: 'e-2', timestamp: '2026-05-23T12:01:00.000Z', runId: 'run-1', phase: 'speckit-plan', iteration: 1, outcome: 'clean' })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');
      const result = await readMetrics(workspaceRoot);
      const phase = findPhase(result, 'run-1', 'speckit-plan', 1);
      expect(phase.costUsd).toBeUndefined();
    });

    it('counts cli-invocation entries sharing the same (runId, phase, iteration) as backendInvocations', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        taskStarted({ id: 'e-0', timestamp: '2026-05-23T11:59:00.000Z', runId: 'run-1' }),
        phaseStart({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-1', phase: 'speckit-plan', iteration: 1 }),
        cliInvocation({ id: 'e-2', timestamp: '2026-05-23T12:00:30.000Z', runId: 'run-1', phase: 'speckit-plan', iteration: 1 }),
        cliInvocation({ id: 'e-3', timestamp: '2026-05-23T12:00:45.000Z', runId: 'run-1', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({ id: 'e-4', timestamp: '2026-05-23T12:01:00.000Z', runId: 'run-1', phase: 'speckit-plan', iteration: 1, outcome: 'clean' })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');
      const result = await readMetrics(workspaceRoot);
      const phase = findPhase(result, 'run-1', 'speckit-plan', 1);
      expect(phase.backendInvocations).toBe(2);
    });

    it('normalizes (runId, phase, iteration) join keys so distinct iterations of the same phase do not collide', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        taskStarted({ id: 'e-0', timestamp: '2026-05-23T11:59:00.000Z', runId: 'run-1' }),
        phaseStart({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-1', phase: 'speckit-clarify', iteration: 1 }),
        phaseEnd({ id: 'e-2', timestamp: '2026-05-23T12:01:00.000Z', runId: 'run-1', phase: 'speckit-clarify', iteration: 1, outcome: 'issues_remain' }),
        phaseStart({ id: 'e-3', timestamp: '2026-05-23T12:01:01.000Z', runId: 'run-1', phase: 'speckit-clarify', iteration: 2 }),
        phaseEnd({ id: 'e-4', timestamp: '2026-05-23T12:02:00.000Z', runId: 'run-1', phase: 'speckit-clarify', iteration: 2, outcome: 'clean' })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');
      const result = await readMetrics(workspaceRoot);
      expect(findPhase(result, 'run-1', 'speckit-clarify', 1).outcome).toBe('failed');
      expect(findPhase(result, 'run-1', 'speckit-clarify', 2).outcome).toBe('completed');
    });
  });

  // Feature 073 US1 (T013) — phase-grouping reconstruction fallback
  // (data-model.md §1) for runIds with no direct task-execution-started/
  // -ended pair. Implemented by T015.
  describe('Task Record reconstruction fallback (Feature 073 US1, T013)', () => {
    it('derives a phase-reconstruction Task Record when no task-execution pair exists for a runId', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        phaseStart({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-recon-1', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({ id: 'e-2', timestamp: '2026-05-23T12:05:00.000Z', runId: 'run-recon-1', phase: 'speckit-plan', iteration: 1, outcome: 'clean' })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      expect(result.tasks.length).toBe(1);
      const task = result.tasks[0]!;
      expect(task.runId).toBe('run-recon-1');
      expect(task.source).toBe('phase-reconstruction');
      expect(task.taskId).toBeUndefined();
      expect(task.description).toBe('run-recon-1');
      expect(task.startTime).toBe('2026-05-23T12:00:00.000Z');
      expect(task.endTime).toBe('2026-05-23T12:05:00.000Z');
      expect(task.durationMs).toBe(300000);
      expect(task.status).toBe('completed');
      expect(task.isRunning).toBe(false);
      expect(task.phasesTotal).toBe(1);
      expect(task.phasesCompleted).toBe(1);
      expect(task.phasesSkipped).toBe(0);
    });

    it('marks a reconstructed task "failed" when any constituent phase outcome is failed', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        phaseStart({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-recon-2', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({ id: 'e-2', timestamp: '2026-05-23T12:01:00.000Z', runId: 'run-recon-2', phase: 'speckit-plan', iteration: 1, outcome: 'clean' }),
        phaseStart({ id: 'e-3', timestamp: '2026-05-23T12:01:01.000Z', runId: 'run-recon-2', phase: 'speckit-implement', iteration: 1 }),
        phaseEnd({ id: 'e-4', timestamp: '2026-05-23T12:03:00.000Z', runId: 'run-recon-2', phase: 'speckit-implement', iteration: 1, outcome: 'failed' })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      const task = result.tasks.find((t) => t.runId === 'run-recon-2')!;
      expect(task.source).toBe('phase-reconstruction');
      expect(task.status).toBe('failed');
      expect(task.isRunning).toBe(false);
      expect(task.phasesTotal).toBe(2);
      expect(task.phasesCompleted).toBe(1);
    });

    it('leaves a reconstructed task running (no status) while any constituent phase has not reached a terminal state', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        phaseStart({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-recon-3', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({ id: 'e-2', timestamp: '2026-05-23T12:01:00.000Z', runId: 'run-recon-3', phase: 'speckit-plan', iteration: 1, outcome: 'clean' }),
        phaseStart({ id: 'e-3', timestamp: '2026-05-23T12:01:01.000Z', runId: 'run-recon-3', phase: 'speckit-implement', iteration: 1 })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      const task = result.tasks.find((t) => t.runId === 'run-recon-3')!;
      expect(task.source).toBe('phase-reconstruction');
      expect(task.status).toBeUndefined();
      expect(task.isRunning).toBe(true);
      expect(task.endTime).toBeUndefined();
      expect(typeof task.durationMs).toBe('number');
      expect(task.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('derives startTime/endTime from the earliest phase-start and latest terminal phase event across all constituent phases', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        phaseStart({ id: 'e-1', timestamp: '2026-05-23T12:02:00.000Z', runId: 'run-recon-4', phase: 'speckit-implement', iteration: 1 }),
        phaseEnd({ id: 'e-2', timestamp: '2026-05-23T12:06:00.000Z', runId: 'run-recon-4', phase: 'speckit-implement', iteration: 1, outcome: 'clean' }),
        phaseStart({ id: 'e-3', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-recon-4', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({ id: 'e-4', timestamp: '2026-05-23T12:01:00.000Z', runId: 'run-recon-4', phase: 'speckit-plan', iteration: 1, outcome: 'clean' })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      const task = result.tasks.find((t) => t.runId === 'run-recon-4')!;
      expect(task.startTime).toBe('2026-05-23T12:00:00.000Z');
      expect(task.endTime).toBe('2026-05-23T12:06:00.000Z');
      expect(task.durationMs).toBe(6 * 60 * 1000);
    });

    it('counts phasesTotal/phasesCompleted/phasesSkipped from constituent Phase Records for a reconstructed task', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        phaseStart({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-recon-5', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({ id: 'e-2', timestamp: '2026-05-23T12:01:00.000Z', runId: 'run-recon-5', phase: 'speckit-plan', iteration: 1, outcome: 'clean' }),
        phaseStart({ id: 'e-3', timestamp: '2026-05-23T12:01:01.000Z', runId: 'run-recon-5', phase: 'speckit-checklist', iteration: 1 }),
        phaseEnd({ id: 'e-4', timestamp: '2026-05-23T12:02:00.000Z', runId: 'run-recon-5', phase: 'speckit-checklist', iteration: 1, outcome: 'skipped' }),
        phaseStart({ id: 'e-5', timestamp: '2026-05-23T12:02:01.000Z', runId: 'run-recon-5', phase: 'speckit-implement', iteration: 1 }),
        phaseEnd({ id: 'e-6', timestamp: '2026-05-23T12:04:00.000Z', runId: 'run-recon-5', phase: 'speckit-implement', iteration: 1, outcome: 'failed' })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      const task = result.tasks.find((t) => t.runId === 'run-recon-5')!;
      expect(task.phasesTotal).toBe(3);
      expect(task.phasesCompleted).toBe(1);
      expect(task.phasesSkipped).toBe(1);
      expect(task.status).toBe('failed');
    });

    it('sums totalCostUsd and totalBackendInvocations across constituent phases for a reconstructed task', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        phaseStart({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-recon-6', phase: 'speckit-plan', iteration: 1 }),
        cliInvocation({ id: 'e-2', timestamp: '2026-05-23T12:00:30.000Z', runId: 'run-recon-6', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({ id: 'e-3', timestamp: '2026-05-23T12:01:00.000Z', runId: 'run-recon-6', phase: 'speckit-plan', iteration: 1, outcome: 'clean', totalCostUsd: 0.1 }),
        phaseStart({ id: 'e-4', timestamp: '2026-05-23T12:01:01.000Z', runId: 'run-recon-6', phase: 'speckit-implement', iteration: 1 }),
        cliInvocation({ id: 'e-5', timestamp: '2026-05-23T12:01:30.000Z', runId: 'run-recon-6', phase: 'speckit-implement', iteration: 1 }),
        cliInvocation({ id: 'e-6', timestamp: '2026-05-23T12:01:45.000Z', runId: 'run-recon-6', phase: 'speckit-implement', iteration: 1 }),
        phaseEnd({ id: 'e-7', timestamp: '2026-05-23T12:03:00.000Z', runId: 'run-recon-6', phase: 'speckit-implement', iteration: 1, outcome: 'clean', totalCostUsd: 0.25 })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      const task = result.tasks.find((t) => t.runId === 'run-recon-6')!;
      expect(task.totalCostUsd).toBeCloseTo(0.35);
      expect(task.totalBackendInvocations).toBe(3);
    });

    it('treats a terminal but non-failed outcome (e.g. jumped) as sufficient for an overall "completed" reconstructed status', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        phaseStart({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-recon-7', phase: 'speckit-clarify', iteration: 1 }),
        phaseJumped({ id: 'e-2', timestamp: '2026-05-23T12:02:00.000Z', runId: 'run-recon-7', phase: 'speckit-clarify', iterationN: 1, durationMs: 120000 })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      const task = result.tasks.find((t) => t.runId === 'run-recon-7')!;
      expect(task.source).toBe('phase-reconstruction');
      const phase = task.phases.find((p) => p.phaseType === 'speckit-clarify' && p.iteration === 1)!;
      expect(phase.outcome).toBe('jumped');
      expect(task.status).toBe('completed');
      expect(task.isRunning).toBe(false);
    });

    it('does not duplicate Task Records when one runId has a direct task-execution pair and another has phase-only activity in the same scan', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        taskStarted({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-direct', taskId: 'task-direct' }),
        phaseStart({ id: 'e-2', timestamp: '2026-05-23T12:00:01.000Z', runId: 'run-direct', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({ id: 'e-3', timestamp: '2026-05-23T12:01:00.000Z', runId: 'run-direct', phase: 'speckit-plan', iteration: 1, outcome: 'clean' }),
        taskEnded({
          id: 'e-4',
          timestamp: '2026-05-23T12:01:01.000Z',
          runId: 'run-direct',
          taskId: 'task-direct',
          terminalStatus: 'completed',
          durationMs: 61000,
          phasesTotal: 1,
          phasesCompleted: 1,
          phasesSkipped: 0
        }),
        phaseStart({ id: 'e-5', timestamp: '2026-05-23T13:00:00.000Z', runId: 'run-recon-8', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({ id: 'e-6', timestamp: '2026-05-23T13:01:00.000Z', runId: 'run-recon-8', phase: 'speckit-plan', iteration: 1, outcome: 'clean' })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      expect(result.tasks.length).toBe(2);
      const direct = result.tasks.find((t) => t.runId === 'run-direct')!;
      const reconstructed = result.tasks.find((t) => t.runId === 'run-recon-8')!;
      expect(direct.source).toBe('task-lifecycle');
      expect(reconstructed.source).toBe('phase-reconstruction');
    });
  });

  it('computes oldestIncludedTimestamp as the earliest valid entry timestamp scanned', async () => {
    await mkdir(auditDir, { recursive: true });
    const lines = [
      taskStarted({ id: 'e-1', timestamp: '2026-05-20T09:00:00.000Z', runId: 'run-1' }),
      taskStarted({ id: 'e-2', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-2' })
    ];
    await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');
    const result = await readMetrics(workspaceRoot);
    expect(result.oldestIncludedTimestamp).toBe('2026-05-20T09:00:00.000Z');
  });

  it('does not scan archived files when includeArchived is false (default)', async () => {
    await mkdir(auditDir, { recursive: true });
    await writeFile(auditLog, taskStarted({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-1' }) + '\n', 'utf8');
    await writeFile(
      join(auditDir, 'audit.log.20260101-000000'),
      taskStarted({ id: 'e-old', timestamp: '2026-01-01T00:00:00.000Z', runId: 'run-old' }) + '\n',
      'utf8'
    );

    const result = await readMetrics(workspaceRoot);

    expect(result.meta.includesArchives).toBe(false);
    expect(result.tasks.find((t) => t.runId === 'run-old')).toBeUndefined();
  });

  it('scans timestamped audit archives when includeArchived is true', async () => {
    await mkdir(auditDir, { recursive: true });
    await writeFile(auditLog, taskStarted({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-1' }) + '\n', 'utf8');
    await writeFile(
      join(auditDir, 'audit.log.20260101-000000'),
      taskStarted({ id: 'e-old', timestamp: '2026-01-01T00:00:00.000Z', runId: 'run-old' }) + '\n',
      'utf8'
    );
    // Non-matching filename must be ignored (mirrors audit-log-writer.ts's own convention).
    await writeFile(join(auditDir, 'audit.log.bak'), taskStarted({ id: 'e-bak', timestamp: '2026-01-02T00:00:00.000Z', runId: 'run-bak' }) + '\n', 'utf8');

    const result = await readMetrics(workspaceRoot, { includeArchives: true });

    expect(result.meta.includesArchives).toBe(true);
    expect(result.tasks.find((t) => t.runId === 'run-old')).toBeDefined();
    expect(result.tasks.find((t) => t.runId === 'run-bak')).toBeUndefined();
    expect(result.oldestIncludedTimestamp).toBe('2026-01-01T00:00:00.000Z');
  });

  // Feature 073 US3 (T025) — Phase Type Aggregate derivation (data-model.md
  // §3). Rolled-up statistics per phase type across ALL scanned Phase
  // Records (not scoped to a single Task Record). Implemented by T026.
  describe('Phase Type Aggregate derivation (Feature 073 US3, T025)', () => {
    it('computes executionCount, totalDurationMs, and avgDurationMs across multiple runs of the same phase type', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        phaseStart({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-a', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({ id: 'e-2', timestamp: '2026-05-23T12:01:00.000Z', runId: 'run-a', phase: 'speckit-plan', iteration: 1, outcome: 'clean' }),
        phaseStart({ id: 'e-3', timestamp: '2026-05-23T13:00:00.000Z', runId: 'run-b', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({ id: 'e-4', timestamp: '2026-05-23T13:02:00.000Z', runId: 'run-b', phase: 'speckit-plan', iteration: 1, outcome: 'clean' }),
        phaseStart({ id: 'e-5', timestamp: '2026-05-23T14:00:00.000Z', runId: 'run-c', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({ id: 'e-6', timestamp: '2026-05-23T14:03:00.000Z', runId: 'run-c', phase: 'speckit-plan', iteration: 1, outcome: 'clean' })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      const agg = result.phaseTypeAggregates.find((a) => a.phaseType === 'speckit-plan')!;
      expect(agg).toBeDefined();
      expect(agg.executionCount).toBe(3);
      expect(agg.totalDurationMs).toBe(60000 + 120000 + 180000);
      expect(agg.avgDurationMs).toBe((60000 + 120000 + 180000) / 3);
    });

    it('computes p50/p90/p99 and longest/shortest via nearest-rank on the sorted duration array', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines: string[] = [];
      for (let i = 1; i <= 10; i++) {
        const runId = `run-p-${i}`;
        lines.push(
          phaseStart({ id: `s-${i}`, timestamp: '2026-05-23T10:00:00.000Z', runId, phase: 'speckit-implement', iteration: 1 }),
          phaseEnd({
            id: `e-${i}`,
            timestamp: `2026-05-23T10:00:${String(i).padStart(2, '0')}.000Z`,
            runId,
            phase: 'speckit-implement',
            iteration: 1,
            outcome: 'clean'
          })
        );
      }
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      const agg = result.phaseTypeAggregates.find((a) => a.phaseType === 'speckit-implement')!;
      expect(agg.p50DurationMs).toBe(5000);
      expect(agg.p90DurationMs).toBe(9000);
      expect(agg.p99DurationMs).toBe(10000);
      expect(agg.longestDurationMs).toBe(10000);
      expect(agg.shortestDurationMs).toBe(1000);
    });

    it('excludes still-running phases from executionCount/duration stats and omits a phase type entirely when none of its phases have terminated', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        phaseStart({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-x', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({ id: 'e-2', timestamp: '2026-05-23T12:01:00.000Z', runId: 'run-x', phase: 'speckit-plan', iteration: 1, outcome: 'clean' }),
        phaseStart({ id: 'e-3', timestamp: '2026-05-23T12:05:00.000Z', runId: 'run-y', phase: 'speckit-plan', iteration: 1 }),
        phaseStart({ id: 'e-4', timestamp: '2026-05-23T12:10:00.000Z', runId: 'run-z', phase: 'speckit-tasks', iteration: 1 })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      const plan = result.phaseTypeAggregates.find((a) => a.phaseType === 'speckit-plan')!;
      expect(plan.executionCount).toBe(1);
      expect(plan.totalDurationMs).toBe(60000);
      expect(result.phaseTypeAggregates.find((a) => a.phaseType === 'speckit-tasks')).toBeUndefined();
    });

    it('sums totalBackendInvocations across all constituent phases of a type, including a still-running one', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        phaseStart({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-x', phase: 'speckit-plan', iteration: 1 }),
        cliInvocation({ id: 'e-2', timestamp: '2026-05-23T12:00:10.000Z', runId: 'run-x', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({ id: 'e-3', timestamp: '2026-05-23T12:01:00.000Z', runId: 'run-x', phase: 'speckit-plan', iteration: 1, outcome: 'clean' }),
        phaseStart({ id: 'e-4', timestamp: '2026-05-23T12:05:00.000Z', runId: 'run-y', phase: 'speckit-plan', iteration: 1 }),
        cliInvocation({ id: 'e-5', timestamp: '2026-05-23T12:05:10.000Z', runId: 'run-y', phase: 'speckit-plan', iteration: 1 }),
        cliInvocation({ id: 'e-6', timestamp: '2026-05-23T12:05:20.000Z', runId: 'run-y', phase: 'speckit-plan', iteration: 1 })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      const agg = result.phaseTypeAggregates.find((a) => a.phaseType === 'speckit-plan')!;
      expect(agg.totalBackendInvocations).toBe(3);
      expect(agg.executionCount).toBe(1);
    });

    it('sums totalCostUsd across constituent phases of a type, zero-filling missing cost', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        phaseStart({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-x', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({ id: 'e-2', timestamp: '2026-05-23T12:01:00.000Z', runId: 'run-x', phase: 'speckit-plan', iteration: 1, outcome: 'clean', totalCostUsd: 0.5 }),
        phaseStart({ id: 'e-3', timestamp: '2026-05-23T12:05:00.000Z', runId: 'run-y', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({ id: 'e-4', timestamp: '2026-05-23T12:06:00.000Z', runId: 'run-y', phase: 'speckit-plan', iteration: 1, outcome: 'clean' })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      const agg = result.phaseTypeAggregates.find((a) => a.phaseType === 'speckit-plan')!;
      expect(agg.totalCostUsd).toBeCloseTo(0.5);
    });

    it('leaves totalCostUsd undefined for a phase type when no constituent phase has any recorded cost', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        phaseStart({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-x', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({ id: 'e-2', timestamp: '2026-05-23T12:01:00.000Z', runId: 'run-x', phase: 'speckit-plan', iteration: 1, outcome: 'clean' })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      const agg = result.phaseTypeAggregates.find((a) => a.phaseType === 'speckit-plan')!;
      expect(agg.totalCostUsd).toBeUndefined();
    });

    it('produces one aggregate entry per distinct phase type without mixing stats', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        phaseStart({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-x', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({ id: 'e-2', timestamp: '2026-05-23T12:01:00.000Z', runId: 'run-x', phase: 'speckit-plan', iteration: 1, outcome: 'clean' }),
        phaseStart({ id: 'e-3', timestamp: '2026-05-23T12:01:01.000Z', runId: 'run-x', phase: 'speckit-implement', iteration: 1 }),
        phaseEnd({ id: 'e-4', timestamp: '2026-05-23T12:05:01.000Z', runId: 'run-x', phase: 'speckit-implement', iteration: 1, outcome: 'clean' })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      expect(result.phaseTypeAggregates.length).toBe(2);
      const plan = result.phaseTypeAggregates.find((a) => a.phaseType === 'speckit-plan')!;
      const impl = result.phaseTypeAggregates.find((a) => a.phaseType === 'speckit-implement')!;
      expect(plan.totalDurationMs).toBe(60000);
      expect(impl.totalDurationMs).toBe(240000);
    });
  });

  // Feature 073 US4 (T030) — Cost Timeline Point derivation (data-model.md
  // §4). Buckets `phase-end` entries by host-local calendar day.
  // Implemented by T031.
  describe('Cost Timeline Point derivation (Feature 073 US4, T030)', () => {
    it('buckets phase-end cost by calendar day, zero-filling missing cost within a day', async () => {
      await mkdir(auditDir, { recursive: true });
      // Both phases end at the exact same instant (rather than merely "the
      // same UTC calendar day") so the test is agnostic to the local
      // timezone the suite runs under — a fixed few-hours-apart offset can
      // straddle a local day boundary depending on the runner's TZ.
      const day1 = '2026-05-23T12:00:00.000Z';
      const lines = [
        phaseStart({ id: 'e-1', timestamp: day1, runId: 'run-x', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({ id: 'e-2', timestamp: day1, runId: 'run-x', phase: 'speckit-plan', iteration: 1, outcome: 'clean', totalCostUsd: 1.5 }),
        phaseStart({ id: 'e-3', timestamp: day1, runId: 'run-y', phase: 'speckit-implement', iteration: 1 }),
        phaseEnd({ id: 'e-4', timestamp: day1, runId: 'run-y', phase: 'speckit-implement', iteration: 1, outcome: 'clean' })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      expect(result.costTimeline.length).toBe(1);
      const point = result.costTimeline[0]!;
      expect(point.date).toBe(localDateKey(day1));
      expect(point.dailyCostUsd).toBeCloseTo(1.5);
      expect(point.cumulativeCostUsd).toBeCloseTo(1.5);
    });

    it('computes cumulativeCostUsd as a running sum across ascending sorted days', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        phaseStart({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-1', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({ id: 'e-2', timestamp: '2026-05-23T12:01:00.000Z', runId: 'run-1', phase: 'speckit-plan', iteration: 1, outcome: 'clean', totalCostUsd: 1 }),
        phaseStart({ id: 'e-3', timestamp: '2026-05-21T12:00:00.000Z', runId: 'run-2', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({ id: 'e-4', timestamp: '2026-05-21T12:01:00.000Z', runId: 'run-2', phase: 'speckit-plan', iteration: 1, outcome: 'clean', totalCostUsd: 2 }),
        phaseStart({ id: 'e-5', timestamp: '2026-05-22T12:00:00.000Z', runId: 'run-3', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({ id: 'e-6', timestamp: '2026-05-22T12:01:00.000Z', runId: 'run-3', phase: 'speckit-plan', iteration: 1, outcome: 'clean', totalCostUsd: 3 })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      expect(result.costTimeline.length).toBe(3);
      const [first, second, third] = result.costTimeline;
      expect(first!.date < second!.date).toBe(true);
      expect(second!.date < third!.date).toBe(true);
      expect(first!.dailyCostUsd).toBeCloseTo(2);
      expect(second!.dailyCostUsd).toBeCloseTo(3);
      expect(third!.dailyCostUsd).toBeCloseTo(1);
      expect(first!.cumulativeCostUsd).toBeCloseTo(2);
      expect(second!.cumulativeCostUsd).toBeCloseTo(5);
      expect(third!.cumulativeCostUsd).toBeCloseTo(6);
    });

    it('returns an empty series when zero phase-end entries have any recorded cost', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        phaseStart({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-1', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({ id: 'e-2', timestamp: '2026-05-23T12:01:00.000Z', runId: 'run-1', phase: 'speckit-plan', iteration: 1, outcome: 'clean' })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      expect(result.costTimeline).toEqual([]);
    });

    it('excludes jumped and paused-at-breakpoint phase timestamps from the cost timeline entirely', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        phaseStart({ id: 'e-1', timestamp: '2026-05-20T12:00:00.000Z', runId: 'run-1', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({ id: 'e-2', timestamp: '2026-05-20T12:01:00.000Z', runId: 'run-1', phase: 'speckit-plan', iteration: 1, outcome: 'clean', totalCostUsd: 1 }),
        phaseStart({ id: 'e-3', timestamp: '2026-05-25T09:00:00.000Z', runId: 'run-2', phase: 'speckit-clarify', iteration: 1 }),
        phaseJumped({ id: 'e-4', timestamp: '2026-05-25T09:02:00.000Z', runId: 'run-2', phase: 'speckit-clarify', iterationN: 1, durationMs: 120000 }),
        phaseBreakpointFired({ id: 'e-5', timestamp: '2026-05-26T09:00:00.000Z', runId: 'run-3', phase: 'speckit-review', iterationN: 1 })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      expect(result.costTimeline.length).toBe(1);
      expect(result.costTimeline[0]!.date).toBe(localDateKey('2026-05-20T12:00:00.000Z'));
    });
  });

  describe('Code-review regression fixes (Feature 073 speckit-review)', () => {
    it('sums cost across multiple phase-end entries for the same (runId, phase, iteration) instead of dropping earlier cost on cap-exhaustion', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        taskStarted({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-cap' }),
        phaseStart({
          id: 'e-2',
          timestamp: '2026-05-23T12:00:01.000Z',
          runId: 'run-cap',
          phase: 'speckit-implement',
          iteration: 1
        }),
        // Normal phase-end carrying real cost.
        phaseEnd({
          id: 'e-3',
          timestamp: '2026-05-23T12:05:00.000Z',
          runId: 'run-cap',
          phase: 'speckit-implement',
          iteration: 1,
          outcome: 'issues_remain',
          totalCostUsd: 0.42
        }),
        // Cap-exhaustion appends a second phase-end for the SAME join key
        // with no cost data (phase-runner.ts's appendCapExhaustedPhaseEnd).
        phaseEnd({
          id: 'e-4',
          timestamp: '2026-05-23T12:05:01.000Z',
          runId: 'run-cap',
          phase: 'speckit-implement',
          iteration: 1,
          outcome: 'failed'
        }),
        taskEnded({
          id: 'e-5',
          timestamp: '2026-05-23T12:05:02.000Z',
          runId: 'run-cap',
          terminalStatus: 'failed',
          durationMs: 302000,
          phasesTotal: 1,
          phasesCompleted: 0,
          phasesSkipped: 0
        })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      const phase = findPhase(result, 'run-cap', 'speckit-implement', 1);
      expect(phase.costUsd).toBe(0.42);
    });

    it('does not silently drop a task whose task-execution-ended entry survived with no matching started entry or phase activity', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        taskEnded({
          id: 'e-1',
          timestamp: '2026-05-23T12:05:00.000Z',
          runId: 'run-orphan-end',
          terminalStatus: 'completed',
          durationMs: 300000,
          phasesTotal: 2,
          phasesCompleted: 2,
          phasesSkipped: 0
        })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      expect(result.tasks.length).toBe(1);
      const task = result.tasks[0]!;
      expect(task.runId).toBe('run-orphan-end');
      expect(task.isRunning).toBe(false);
      expect(task.status).toBe('completed');
      expect(task.endTime).toBe('2026-05-23T12:05:00.000Z');
      expect(task.durationMs).toBe(300000);
      expect(task.startTime).toBe('2026-05-23T12:00:00.000Z');
      expect(task.source).toBe('task-lifecycle');
    });

    it('reports isRunning: false (not true) for an orphaned task-execution-ended entry whose runId also has non-terminal phase activity', async () => {
      // Boundary gap found by code-review: a runId with BOTH an orphaned
      // ended entry AND some phase activity (e.g. a phase-start with no
      // matching phase-end, as when a task is canceled mid-phase) used to
      // fall through to buildReconstructedTaskRecord, which ignores the
      // ended entry and infers isRunning from phase terminality alone —
      // reporting a definitively-terminated task as running forever.
      await mkdir(auditDir, { recursive: true });
      const lines = [
        phaseStart({
          id: 'e-1',
          timestamp: '2026-05-24T09:00:00.000Z',
          runId: 'run-orphan-partial',
          phase: 'speckit-plan',
          iteration: 1
        }),
        taskEnded({
          id: 'e-2',
          timestamp: '2026-05-24T09:10:00.000Z',
          runId: 'run-orphan-partial',
          terminalStatus: 'canceled',
          durationMs: 600000,
          phasesTotal: 1,
          phasesCompleted: 0,
          phasesSkipped: 0
        })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      expect(result.tasks.length).toBe(1);
      const task = result.tasks[0]!;
      expect(task.runId).toBe('run-orphan-partial');
      expect(task.isRunning).toBe(false);
      expect(task.status).toBe('canceled');
      expect(task.endTime).toBe('2026-05-24T09:10:00.000Z');
      expect(task.durationMs).toBe(600000);
      expect(task.startTime).toBe('2026-05-24T09:00:00.000Z');
      expect(task.source).toBe('task-lifecycle');
      expect(task.phases.length).toBe(1);
    });

    it('reports isRunning: false (not true) when a terminated task has an unrecognized terminalStatus value', async () => {
      await mkdir(auditDir, { recursive: true });
      const lines = [
        taskStarted({ id: 'e-1', timestamp: '2026-05-23T12:00:00.000Z', runId: 'run-weird-status' }),
        line({
          id: 'e-2',
          timestamp: '2026-05-23T12:05:00.000Z',
          runId: 'run-weird-status',
          phase: 'done',
          iteration: 0,
          eventType: 'task-execution-ended',
          outcome: 'failure',
          payload: {
            taskId: 'run-weird-status',
            runId: 'run-weird-status',
            terminalStatus: 'aborted',
            durationMs: 300000,
            phasesTotal: 1,
            phasesCompleted: 0,
            phasesSkipped: 0
          }
        })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      expect(result.tasks.length).toBe(1);
      const task = result.tasks[0]!;
      expect(task.status).toBeUndefined();
      expect(task.isRunning).toBe(false);
      expect(task.endTime).toBe('2026-05-23T12:05:00.000Z');
    });

    it('reports includesArchived: false (without throwing) when listing archived logs fails for a reason other than ENOENT', async () => {
      // `.schegent` exists as a plain file instead of a directory, so
      // readdir() fails with ENOTDIR rather than the routine "doesn't exist
      // yet" ENOENT.
      await writeFile(auditDir, 'not a directory', 'utf8');

      const result = await readMetrics(workspaceRoot, { includeArchives: true });

      expect(result.meta.includesArchives).toBe(false);
      expect(result.tasks).toEqual([]);
    });

    it('truncates description to 300 chars (FR-017) when a hand-edited audit entry carries an oversized taskId', async () => {
      await mkdir(auditDir, { recursive: true });
      const oversizedTaskId = 'x'.repeat(500);
      const lines = [
        taskStarted({ id: 'e-1', timestamp: '2026-05-24T10:00:00.000Z', runId: 'run-long', taskId: oversizedTaskId }),
        taskEnded({
          id: 'e-2',
          timestamp: '2026-05-24T10:01:00.000Z',
          runId: 'run-long',
          taskId: oversizedTaskId,
          terminalStatus: 'completed',
          durationMs: 60000,
          phasesTotal: 0,
          phasesCompleted: 0,
          phasesSkipped: 0
        })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      expect(result.tasks.length).toBe(1);
      const task = result.tasks[0]!;
      expect(task.description.length).toBe(300);
      expect(task.description.endsWith('...')).toBe(true);
      expect(task.description).toBe(`${oversizedTaskId.slice(0, 297)}...`);
    });

    it('truncates description to 300 chars (FR-017) on the phase-reconstruction fallback, which falls back to the runId itself', async () => {
      // buildReconstructedTaskRecord (no task-execution pair for this runId,
      // so it falls back to phase-only reconstruction) sets description to
      // the runId directly — a separate code path from readDescription
      // above, so it needs its own truncation call and its own regression
      // coverage.
      await mkdir(auditDir, { recursive: true });
      const oversizedRunId = `run-${'x'.repeat(500)}`;
      const lines = [
        phaseStart({ id: 'e-1', timestamp: '2026-05-24T12:00:00.000Z', runId: oversizedRunId, phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({
          id: 'e-2',
          timestamp: '2026-05-24T12:01:00.000Z',
          runId: oversizedRunId,
          phase: 'speckit-plan',
          iteration: 1,
          outcome: 'clean'
        })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      expect(result.tasks.length).toBe(1);
      const task = result.tasks[0]!;
      expect(task.source).toBe('phase-reconstruction');
      expect(task.description.length).toBe(300);
      expect(task.description.endsWith('...')).toBe(true);
      expect(task.description).toBe(`${oversizedRunId.slice(0, 297)}...`);
    });

    it('backs off one code unit instead of splitting a surrogate pair when truncation would cut through an astral character', async () => {
      // U+1F600 is a 2-code-unit UTF-16 surrogate pair. Placed at code-unit
      // index 296-297, a naive slice(0, 297) would keep only its high
      // surrogate, producing a lone/unpaired surrogate that renders as
      // mojibake — truncateForDisplay must drop the whole character instead.
      await mkdir(auditDir, { recursive: true });
      const oversizedTaskId = `${'x'.repeat(296)}\u{1F600}${'y'.repeat(200)}`;
      const lines = [
        taskStarted({ id: 'e-1', timestamp: '2026-05-24T13:00:00.000Z', runId: 'run-surrogate', taskId: oversizedTaskId }),
        taskEnded({
          id: 'e-2',
          timestamp: '2026-05-24T13:01:00.000Z',
          runId: 'run-surrogate',
          taskId: oversizedTaskId,
          terminalStatus: 'completed',
          durationMs: 60000,
          phasesTotal: 0,
          phasesCompleted: 0,
          phasesSkipped: 0
        })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      expect(result.tasks.length).toBe(1);
      const task = result.tasks[0]!;
      expect(task.description).toBe(`${'x'.repeat(296)}...`);
      expect(task.description.length).toBe(299);
    });

    it('truncates phaseType to 300 chars (FR-017) when a hand-edited audit entry carries an oversized phase name, without colliding two phases of the same run/iteration', async () => {
      await mkdir(auditDir, { recursive: true });
      // Same runId AND iteration for both phases — the only fields left to
      // distinguish the two PhaseGroup join keys are the raw phaseType
      // strings. Identical for their first 500 chars (far past the 297-char
      // truncation point), differing only in the final 2 chars: if
      // getOrCreatePhaseGroup ever keyed on the truncated (rather than raw)
      // phaseType, both phase-start/phase-end pairs would land in the same
      // group and this run would incorrectly collapse from 2 phases to 1.
      const oversizedPhaseA = `${'x'.repeat(500)}-A`;
      const oversizedPhaseB = `${'x'.repeat(500)}-B`;
      const lines = [
        phaseStart({ id: 'e-1', timestamp: '2026-05-24T11:00:00.000Z', runId: 'run-collision', phase: oversizedPhaseA, iteration: 1 }),
        phaseEnd({
          id: 'e-2',
          timestamp: '2026-05-24T11:01:00.000Z',
          runId: 'run-collision',
          phase: oversizedPhaseA,
          iteration: 1,
          outcome: 'clean'
        }),
        phaseStart({ id: 'e-3', timestamp: '2026-05-24T11:01:01.000Z', runId: 'run-collision', phase: oversizedPhaseB, iteration: 1 }),
        phaseEnd({
          id: 'e-4',
          timestamp: '2026-05-24T11:02:00.000Z',
          runId: 'run-collision',
          phase: oversizedPhaseB,
          iteration: 1,
          outcome: 'failed'
        })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      expect(result.tasks.length).toBe(1);
      const task = result.tasks[0]!;
      // Two separate PhaseRecords survive — a truncate-before-key bug would
      // merge both start/end pairs into a single group (earliest start,
      // latest end), collapsing this to length 1 with a blended duration.
      expect(task.phases.length).toBe(2);
      const truncated = `${'x'.repeat(297)}...`;
      expect(task.phases[0]!.phaseType).toBe(truncated);
      expect(task.phases[0]!.phaseType.length).toBe(300);
      expect(task.phases[0]!.outcome).toBe('completed');
      expect(task.phases[0]!.startTime).toBe('2026-05-24T11:00:00.000Z');
      expect(task.phases[1]!.phaseType).toBe(truncated);
      expect(task.phases[1]!.outcome).toBe('failed');
      expect(task.phases[1]!.startTime).toBe('2026-05-24T11:01:01.000Z');

      // The display-level phaseType aggregate legitimately rolls up by the
      // (truncated) label across runs/phases — both phases here share one
      // truncated label, so they correctly land in a single aggregate
      // bucket with executionCount 2, not the per-PhaseGroup join key.
      expect(result.phaseTypeAggregates.length).toBe(1);
      expect(result.phaseTypeAggregates[0]!.phaseType).toBe(truncated);
      expect(result.phaseTypeAggregates[0]!.executionCount).toBe(2);
    });

    it('truncates startTime/endTime to 300 chars (FR-017) on both TaskRecord and PhaseRecord when a hand-edited audit entry carries an oversized timestamp', async () => {
      // TaskRecord/PhaseRecord.startTime/endTime are assigned directly from
      // audit-entry `timestamp` values — the same class of audit-payload-
      // derived text FR-017 already bounds for description/phaseType, just
      // on a sibling field pair that the original fix missed.
      await mkdir(auditDir, { recursive: true });
      const oversizedTimestamp = 'x'.repeat(500);
      const lines = [
        taskStarted({ id: 'e-1', timestamp: oversizedTimestamp, runId: 'run-long-ts' }),
        phaseStart({ id: 'e-2', timestamp: oversizedTimestamp, runId: 'run-long-ts', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({
          id: 'e-3',
          timestamp: oversizedTimestamp,
          runId: 'run-long-ts',
          phase: 'speckit-plan',
          iteration: 1,
          outcome: 'clean'
        }),
        taskEnded({
          id: 'e-4',
          timestamp: oversizedTimestamp,
          runId: 'run-long-ts',
          terminalStatus: 'completed',
          durationMs: 60000,
          phasesTotal: 1,
          phasesCompleted: 1,
          phasesSkipped: 0
        })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      expect(result.tasks.length).toBe(1);
      const task = result.tasks[0]!;
      const truncated = `${oversizedTimestamp.slice(0, 297)}...`;
      expect(task.startTime).toBe(truncated);
      expect(task.startTime.length).toBe(300);
      expect(task.endTime).toBe(truncated);
      expect(task.phases.length).toBe(1);
      expect(task.phases[0]!.startTime).toBe(truncated);
      expect(task.phases[0]!.endTime).toBe(truncated);
      // safeDurationMs guards Date.parse failure on the (unparseable, purely
      // adversarial) garbage timestamp by returning 0 rather than NaN or
      // throwing — pinning that guard holds for this same oversized input.
      expect(task.phases[0]!.durationMs).toBe(0);
    });

    it('truncates startTime/endTime to 300 chars (FR-017) on the phase-reconstruction fallback', async () => {
      // buildReconstructedTaskRecord derives TaskRecord.startTime/endTime
      // from earliestPhaseStart/latestPhaseEnd over already-built
      // PhaseRecords — its own truncateForDisplay call is what keeps this
      // path safe independent of the PhaseRecord-level fix, mirroring the
      // description/runId fix for this same fallback function.
      await mkdir(auditDir, { recursive: true });
      const oversizedTimestamp = 'y'.repeat(500);
      const lines = [
        phaseStart({ id: 'e-1', timestamp: oversizedTimestamp, runId: 'run-recon-ts', phase: 'speckit-plan', iteration: 1 }),
        phaseEnd({
          id: 'e-2',
          timestamp: oversizedTimestamp,
          runId: 'run-recon-ts',
          phase: 'speckit-plan',
          iteration: 1,
          outcome: 'clean'
        })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      expect(result.tasks.length).toBe(1);
      const task = result.tasks[0]!;
      expect(task.source).toBe('phase-reconstruction');
      const truncated = `${oversizedTimestamp.slice(0, 297)}...`;
      expect(task.startTime).toBe(truncated);
      expect(task.startTime.length).toBe(300);
      expect(task.endTime).toBe(truncated);
    });

    it('truncates startTime/endTime to 300 chars (FR-017) on the paused-at-breakpoint PhaseRecord branch', async () => {
      // buildPhaseRecord's breakpoint branch is a separate return site from
      // the phase-end branch already covered above — it falls back to the
      // breakpoint event's own timestamp for both bounds, so it needs its
      // own truncation coverage.
      await mkdir(auditDir, { recursive: true });
      const oversizedTimestamp = 'b'.repeat(500);
      const lines = [
        taskStarted({ id: 'e-0', timestamp: '2026-05-24T15:00:00.000Z', runId: 'run-breakpoint-ts' }),
        phaseBreakpointFired({
          id: 'e-1',
          timestamp: oversizedTimestamp,
          runId: 'run-breakpoint-ts',
          phase: 'speckit-review',
          iterationN: 1
        })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      const phase = findPhase(result, 'run-breakpoint-ts', 'speckit-review', 1);
      expect(phase.outcome).toBe('paused-at-breakpoint');
      const truncated = `${oversizedTimestamp.slice(0, 297)}...`;
      expect(phase.startTime).toBe(truncated);
      expect(phase.endTime).toBe(truncated);
    });

    it('truncates startTime/endTime to 300 chars (FR-017) on the jumped PhaseRecord branch', async () => {
      // buildPhaseRecord's jump branch pairs a phase-start with a
      // phase-jumped event instead of a phase-end — a separate return site
      // from both the breakpoint and phase-end branches.
      await mkdir(auditDir, { recursive: true });
      const oversizedStart = 's'.repeat(500);
      const oversizedJump = 'j'.repeat(500);
      const lines = [
        taskStarted({ id: 'e-0', timestamp: '2026-05-24T16:00:00.000Z', runId: 'run-jump-ts' }),
        phaseStart({ id: 'e-1', timestamp: oversizedStart, runId: 'run-jump-ts', phase: 'speckit-clarify', iteration: 1 }),
        phaseJumped({
          id: 'e-2',
          timestamp: oversizedJump,
          runId: 'run-jump-ts',
          phase: 'speckit-clarify',
          iterationN: 1,
          durationMs: 120000
        })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      const phase = findPhase(result, 'run-jump-ts', 'speckit-clarify', 1);
      expect(phase.outcome).toBe('jumped');
      expect(phase.startTime).toBe(`${oversizedStart.slice(0, 297)}...`);
      expect(phase.endTime).toBe(`${oversizedJump.slice(0, 297)}...`);
      expect(phase.durationMs).toBe(120000);
    });

    it('truncates startTime to 300 chars (FR-017) on a still-running PhaseRecord (no end) and the endTime of an orphaned task-execution-ended entry that reconstructs its startTime from it', async () => {
      // Covers two remaining return sites in one fixture: buildPhaseRecord's
      // no-end/"still running" branch (phase-start with no matching end,
      // jump, or breakpoint), and buildTaskRecords' orphaned-end-only branch
      // (a task-execution-ended entry with no matching started entry), whose
      // startTime is sourced via earliestPhaseStart over the still-running
      // phase above rather than a fresh timestamp of its own.
      await mkdir(auditDir, { recursive: true });
      const oversizedPhaseTimestamp = 'p'.repeat(500);
      const oversizedEndTimestamp = 'e'.repeat(500);
      const lines = [
        phaseStart({
          id: 'e-1',
          timestamp: oversizedPhaseTimestamp,
          runId: 'run-orphan-ts',
          phase: 'speckit-plan',
          iteration: 1
        }),
        taskEnded({
          id: 'e-2',
          timestamp: oversizedEndTimestamp,
          runId: 'run-orphan-ts',
          terminalStatus: 'canceled',
          durationMs: 600000,
          phasesTotal: 1,
          phasesCompleted: 0,
          phasesSkipped: 0
        })
      ];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      expect(result.tasks.length).toBe(1);
      const task = result.tasks[0]!;
      const truncatedPhase = `${oversizedPhaseTimestamp.slice(0, 297)}...`;
      const truncatedEnd = `${oversizedEndTimestamp.slice(0, 297)}...`;
      expect(task.phases.length).toBe(1);
      expect(task.phases[0]!.startTime).toBe(truncatedPhase);
      expect(task.phases[0]!.endTime).toBeUndefined();
      expect(task.startTime).toBe(truncatedPhase);
      expect(task.endTime).toBe(truncatedEnd);
    });

    it('truncates startTime to 300 chars (FR-017) on a task-lifecycle TaskRecord that has not reached a terminal event yet', async () => {
      // buildTaskRecords' "running" branch (task-execution-started with no
      // matching ended entry) is the third and last remaining return site.
      await mkdir(auditDir, { recursive: true });
      const oversizedTimestamp = 'r'.repeat(500);
      const lines = [taskStarted({ id: 'e-1', timestamp: oversizedTimestamp, runId: 'run-still-running-ts' })];
      await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

      const result = await readMetrics(workspaceRoot);

      expect(result.tasks.length).toBe(1);
      const task = result.tasks[0]!;
      expect(task.isRunning).toBe(true);
      expect(task.startTime).toBe(`${oversizedTimestamp.slice(0, 297)}...`);
      expect(task.endTime).toBeUndefined();
    });
  });
});

function localDateKey(iso: string): string {
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function findPhase(
  result: Awaited<ReturnType<typeof readMetrics>>,
  runId: string,
  phase: string,
  iteration: number
) {
  const task = result.tasks.find((t) => t.runId === runId);
  if (!task) throw new Error(`no task record found for runId ${runId}`);
  const found = task.phases.find((p) => p.phaseType === phase && p.iteration === iteration);
  if (!found) throw new Error(`no phase record found for (${runId}, ${phase}, ${iteration})`);
  return found;
}
