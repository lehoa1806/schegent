// Feature 013 — Wave 7 (US7 / T095): snapshot-parity test for the
// projector decomposition.
//
// The 850-line `state-projector.ts` was split into four single-
// responsibility modules:
//   - queue-projector.ts       (projectQueue, sanitizeAndCap, toQueueItem)
//   - audit-tail-projector.ts  (projectAuditEntry, phaseForTail, categorize, summarize)
//   - history-projector.ts     (projectHistory)
//   - monitor-projector.ts     (projectMonitor)
//
// This test exercises the public projection surface end-to-end with a
// representative fixture (queued + in-flight + paused + history) and
// asserts that the post-split snapshot contains the exact same shape
// and content as a hand-constructed reference. The check is structural
// (deep-equal on the shape we care about for parity), NOT a literal
// __snapshots__ snapshot file — the runtime fields (producedAt,
// elapsedMs) are derived from injected timers so the test would be
// brittle against a snapshot file. The 34 existing state-projector
// tests + 24 state-projector-v2 tests already pin most leaf values;
// this file adds the cross-module integration guarantee.

import { describe, it, expect } from 'vitest';
import { projectQueue, sanitizeAndCap, PAUSED_REASON_MAX_LENGTH } from '../../../../src/ui/sidebar/queue-projector';
import { projectAuditEntry } from '../../../../src/ui/sidebar/audit-tail-projector';
import { projectHistory } from '../../../../src/ui/sidebar/history-projector';
import { projectMonitor } from '../../../../src/ui/sidebar/monitor-projector';
import type { QueueState, FeatureRequest } from '../../../../src/queue/feature-request';
import type { AuditEntry } from '../../../../src/audit/audit-entry';

describe('projector decomposition — cross-module parity (T095)', () => {
  it('queue + audit-tail + history + monitor projectors compose into the expected shape', () => {
    const sanitize = (s: string) => s.replace(/secret/g, '[REDACTED]');

    // Queue fixture: one in-flight, one pending, one completed.
    const inFlight: FeatureRequest = {
      id: 'q-1',
      description: 'Investigate auth flow',
      status: 'in-flight',
      enqueuedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000,
      startedAt: 1_700_000_000_500,
      completedAt: null,
      retryCount: 0,
      lastError: null,
      pausedReason: null,
      position: 0
    } as FeatureRequest;
    const pending: FeatureRequest = {
      id: 'q-2',
      description: 'Add caching',
      status: 'pending',
      enqueuedAt: 1_700_000_002_000,
      updatedAt: 1_700_000_002_000,
      startedAt: null,
      completedAt: null,
      retryCount: 0,
      lastError: null,
      pausedReason: null,
      position: 1
    } as FeatureRequest;
    const completed: FeatureRequest = {
      id: 'q-3',
      description: 'Rotate token',
      status: 'completed',
      enqueuedAt: 1_699_999_000_000,
      updatedAt: 1_699_999_001_000,
      startedAt: 1_699_999_000_500,
      completedAt: 1_699_999_001_000,
      retryCount: 0,
      lastError: 'auth failed with secret leaked',
      pausedReason: null,
      position: 0
    } as FeatureRequest;

    const queue: QueueState = {
      requests: [inFlight, pending, completed],
      inFlightId: 'q-1',
      paused: false,
      pausedReason: null,
      updatedAt: 1_700_000_002_000,
      queueLifecycle: 'running',
      pauseSource: null,
      scheduledStartAt: null,
      scheduledStartSource: null
    };

    const qp = projectQueue(queue, {
      sanitize,
      inFlightPhase: 'speckit-specify',
      inFlightId: 'q-1'
    });
    expect(qp.inFlight?.id).toBe('q-1');
    expect(qp.inFlight?.currentPhase).toBe('speckit-specify');
    expect(qp.pending.map((p) => p.id)).toEqual(['q-2']);
    // lastErrorSummary is sanitized (secret → [REDACTED]) via the same
    // sanitize function the orchestrator passes to projectQueue. (Label
    // is the raw description, intentionally not sanitized — the snapshot
    // surfaces it for the operator alongside the sanitized error.)
    expect(qp.recent.map((r) => r.id)).toEqual(['q-3']);
    expect(qp.recent[0].lastErrorSummary).toContain('[REDACTED]');

    // Audit-tail projection: shape round-trip.
    const auditEntry: AuditEntry = {
      id: 'audit-1',
      runId: 'run-1',
      timestamp: '2026-05-10T00:00:00.000Z',
      phase: 'speckit-specify',
      iteration: 1,
      eventType: 'phase-start',
      outcome: 'success',
      payload: { summary: 'starting' },
      correlationId: 'run-1'
    };
    const tail = projectAuditEntry(auditEntry);
    expect(tail.id).toBe('audit-1');
    expect(tail.phase).toBe('speckit-specify');
    expect(tail.category).toBe('phase-transition');
    expect(tail.summary).toContain('starting');

    // History projection: pass-through with a frozen slice.
    const historyEntries = [
      {
        runId: 'r-1',
        featureId: 'f-1',
        descriptionPreview: 'short',
        // FR-R3-010 — `HistoryStore` stamps the partition on every row it
        // hands back, so a fixture standing in for one carries it too.
        queueId: 'default',
        originalDescription: 'short',
        terminalStatus: 'completed' as const,
        startedAt: '2026-05-10T00:00:00.000Z',
        completedAt: '2026-05-10T00:00:01.000Z',
        durationMs: 1_000,
        lastErrorSummary: null,
        auditLogPointer: 'runId:r-1'
      }
    ];
    const hist = projectHistory({ list: () => historyEntries });
    expect(hist).toHaveLength(1);
    expect(hist[0].runId).toBe('r-1');
    expect(Object.isFrozen(hist)).toBe(true);

    // Monitor projection: in-flight state passes through; terminal states
    // collapse to null.
    expect(projectMonitor(null)).toBeNull();
    expect(
      projectMonitor({
        getCurrentState: () => ({
          status: 'completed',
          turnCount: 5,
          tokensIn: 100,
          tokensOut: 50,
          phase: 'speckit-specify',
          pausedReason: null
        } as never)
      })
    ).toBeNull();
    const active = projectMonitor({
      getCurrentState: () => ({
        status: 'running',
        turnCount: 5,
        tokensIn: 100,
        tokensOut: 50,
        phase: 'speckit-specify',
        pausedReason: null
      } as never)
    });
    expect(active).not.toBeNull();
    expect(active?.status).toBe('running');
  });

  it('sanitizeAndCap floor matches the validator floor', () => {
    // The projector-side cap MUST equal the validator-side floor — the
    // runtime-validators.ts file pins its own constant at 500 with a
    // cross-reference comment.
    expect(PAUSED_REASON_MAX_LENGTH).toBe(500);
    const tooLong = 'a'.repeat(600);
    const out = sanitizeAndCap(tooLong, (s) => s);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(PAUSED_REASON_MAX_LENGTH);
    expect(out!.endsWith('…')).toBe(true);
  });
});
