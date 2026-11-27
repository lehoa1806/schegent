// The phase-log audit events filed a bare task id in the `runId` field.
//
// The read itself resolves correctly — `phase-log-service.ts` maps taskId -> runId before
// loading the manifest — so this was never a wrong read. It is a wrong record, and wrong in
// the way that costs a reader the most: an unmarked task id in `runId` is indistinguishable
// from a run id, so every `phase-log-read` event appears to be filed against a run that
// never existed. In the workspace this was found in, all of them named the task id while
// the live run carried a different id entirely.
//
// `appendPhaseAudit`, sixty lines above it in the same file, already had the convention.

import { describe, expect, it, vi } from 'vitest';
import { appendPhaseLogAudit } from '../../../../../src/ui/sidebar/commands/handler-helpers';
import type { HandlerContext } from '../../../../../src/ui/sidebar/commands/handler-contract';
import type { AuditEntry } from '../../../../../src/audit/audit-entry';

const SELECTION = {
  queueId: 'default',
  taskId: '5b9939f7-48c3-4da9-b994-bb2c962df550',
  pipelineId: 'speckit-new-feature',
  phaseId: 'speckit-review',
  iterationN: 1
} as const;

function makeCtx(): { ctx: HandlerContext; entries: Array<Partial<AuditEntry>> } {
  const entries: Array<Partial<AuditEntry>> = [];
  const ctx = {
    deps: {
      audit: {
        append: async (entry: Partial<AuditEntry>): Promise<AuditEntry> => {
          entries.push(entry);
          return entry as AuditEntry;
        }
      },
      logger: { warn: vi.fn(), sanitize: (s: string) => s }
    },
    postAck: vi.fn(),
    correlationId: 'corr-1'
  } as unknown as HandlerContext;
  return { ctx, entries };
}

const FAILED_READ = { outcome: 'failure', reason: 'unknown-tuple' } as const;

describe('phase-log audit attribution', () => {
  it('marks a task id so it cannot be read as a run id', async () => {
    const { ctx, entries } = makeCtx();
    await appendPhaseLogAudit(ctx, 'phase-log-read', {
      selection: SELECTION,
      response: FAILED_READ
    });
    expect(entries.map((e) => e.runId)).toEqual([`task:${SELECTION.taskId}`]);
  });

  it('uses the same marker its sibling uses, for every phase-log event type', async () => {
    const { ctx, entries } = makeCtx();
    for (const eventType of [
      'phase-log-read',
      'phase-log-tail-started',
      'phase-log-tail-stopped'
    ] as const) {
      await appendPhaseLogAudit(ctx, eventType, {
        selection: SELECTION,
        response: FAILED_READ
      });
    }
    expect(entries.map((e) => e.eventType)).toEqual([
      'phase-log-read',
      'phase-log-tail-started',
      'phase-log-tail-stopped'
    ]);
    expect(entries.every((e) => e.runId === `task:${SELECTION.taskId}`)).toBe(true);
  });

  // The task id keeps its own field. The marker exists so `runId` stops lying, not to hide
  // which task was read.
  it('still records the task id in the payload', async () => {
    const { ctx, entries } = makeCtx();
    await appendPhaseLogAudit(ctx, 'phase-log-read', {
      selection: SELECTION,
      response: FAILED_READ
    });
    expect(entries).toMatchObject([
      {
        phase: SELECTION.phaseId,
        iteration: SELECTION.iterationN,
        payload: {
          taskId: SELECTION.taskId,
          phaseId: SELECTION.phaseId,
          queueId: SELECTION.queueId
        }
      }
    ]);
  });
});
