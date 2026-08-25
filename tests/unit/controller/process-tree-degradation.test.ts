import { describe, expect, it, vi } from 'vitest';
import { ProcessTreeDegradationRecorder } from '../../../src/controller/process-tree-degradation-recorder';
import type { AuditEntry } from '../../../src/audit/audit-entry';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * FR-R3-083 / FR-R3-054 §5 (T1163) — the degraded terminal state, in evidence.
 *
 * `FR-R3-054` shipped a `logger.warn` and recorded that as the half that shipped:
 * its acceptance asks for the degraded path to be "visibly recorded in evidence",
 * and a runtime-log line is not the audit record. An operator reconstructing why a
 * later phase saw foreign writes had nothing to read.
 *
 * ABSENCE IS THE SIGNAL. The recorder is only called when the tree could not be
 * proven gone, so a Run with no such entry is one whose descendants were accounted
 * for. That is asserted here by asserting the recorder is not a no-op AND that
 * nothing else emits.
 */
function harness(): {
  readonly appended: Omit<AuditEntry, 'id' | 'timestamp'>[];
  readonly recorder: ProcessTreeDegradationRecorder;
} {
  const appended: Omit<AuditEntry, 'id' | 'timestamp'>[] = [];
  const recorder = new ProcessTreeDegradationRecorder(async (entry) => {
    appended.push(entry);
    return { ...entry, id: 'x', timestamp: '2026-08-25T00:00:00.000Z' } as AuditEntry;
  });
  return { appended, recorder };
}

const EVENT = {
  runId: 'run-1',
  phase: 'implement',
  iteration: 2,
  pid: 4242,
  runner: 'claude-cli',
  escalation: 'sigterm-then-sigkill'
} as const;

describe('process-tree degradation recorder (FR-R3-083)', () => {
  it('records exactly one entry for an unconfirmed tree', async () => {
    const h = harness();
    await h.recorder.record(EVENT);
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0].eventType).toBe('process-tree-unconfirmed');
    expect(h.appended[0].runId).toBe('run-1');
    expect(h.appended[0].phase).toBe('implement');
    expect(h.appended[0].iteration).toBe(2);
  });

  it('carries identifiers and a bounded class, and nothing else', async () => {
    // FR-032. No path, no argv, no operator-authored content, no message. The
    // payload has nowhere to put a secret, which is what makes it safe without
    // redaction -- the same discipline BackendPostureAdmittedPayload states.
    const h = harness();
    await h.recorder.record(EVENT);
    const payload = h.appended[0].payload;
    expect(Object.keys(payload).sort()).toEqual(['escalation', 'pid', 'runner']);
    expect(payload.escalation).toBe('sigterm-then-sigkill');
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/[/\\]/);
  });

  it('records info, not failure, because the phase itself is not failed', async () => {
    // `AuditOutcome` is the closed union success | failure | info. The phase may
    // well have succeeded; what is degraded is the claim that the work stopped.
    // `failure` would make a Run that completed read as one that did not.
    const h = harness();
    await h.recorder.record(EVENT);
    expect(h.appended[0].outcome).toBe('info');
  });

  it('carries the escalation the runner reported, rather than stamping one', async () => {
    // The recorder must not invent this. Today the union has one member, because
    // the ladder escalates on the GROUP and so a report is only reachable after a
    // delivered SIGKILL -- but the value travels from the runner, so a second rung
    // added later reaches the audit record without touching this file.
    const h = harness();
    await h.recorder.record({ ...EVENT, escalation: 'sigterm-then-sigkill' });
    expect(h.appended[0].payload.escalation).toBe('sigterm-then-sigkill');
  });

  it('drops an unattributable event rather than guessing a Run', async () => {
    // With more than one Run in a window, attributing this to whichever Run is
    // enumerated first records a surviving process against a Run that never spawned
    // it. A missing entry is a gap; a wrong one is a false lead.
    const h = harness();
    await h.recorder.record({ ...EVENT, runId: null });
    expect(h.appended).toEqual([]);
  });

  it('survives a writer disposed by deactivation', async () => {
    // T1159a. `deactivate()` disposes context.subscriptions, the audit writer among
    // them, and this fires on an unref'd timer AFTER the tree was killed -- which is
    // often killed BECAUSE the extension is going away. An append into a disposed
    // writer is the expected case here, not an edge one.
    const disposed = new ProcessTreeDegradationRecorder(() => {
      throw new Error('audit writer disposed');
    });
    await expect(disposed.record(EVENT)).resolves.toBeUndefined();
  });

  it('survives a rejected append', async () => {
    const rejecting = new ProcessTreeDegradationRecorder(() =>
      Promise.reject(new Error('append failed'))
    );
    await expect(rejecting.record(EVENT)).resolves.toBeUndefined();
  });

  it('is not a no-op, so the assertions above are not vacuous', async () => {
    const append = vi.fn(async (entry: Omit<AuditEntry, 'id' | 'timestamp'>) => entry as AuditEntry);
    await new ProcessTreeDegradationRecorder(append).record(EVENT);
    expect(append).toHaveBeenCalledTimes(1);
  });
});

describe('the degraded path adds no state-schema change (FR-036, SC-010)', () => {
  it('leaves TerminationReason untouched', () => {
    // FR-R3-054 §5 named the union's closure and its migration story as the reason
    // a new member did not ship. The audit event is the shape that does not need
    // one, so this asserts the thing that would have been the cost.
    const source = readFileSync(
      resolve(__dirname, '..', '..', '..', 'src', 'state', 'workflow-run.ts'),
      'utf8'
    );
    const union = source.slice(
      source.indexOf('export type TerminationReason'),
      source.indexOf("| 'cancel';") + "| 'cancel';".length
    );
    expect(union).not.toContain('degraded');
    expect(union).not.toContain('tree');
  });
});
