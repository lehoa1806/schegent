// FR-R6-F05 (T044, FR-022) — the lifecycle audit sink writes one system-scoped, metadata-only row per
// mutation, and a failed append is logged by code only and reported to the health latch.
import { describe, expect, it, vi } from 'vitest';
import { classifyAuditEvent } from '../../../src/contracts/audit-events';
import { createLifecycleAuditSink } from '../../../src/services/artifact-lifecycle/lifecycle-audit-sink';

type Appended = Record<string, unknown>;

function writerCollecting(): { writer: { append: (entry: Appended) => Promise<never> }; rows: Appended[] } {
  const rows: Appended[] = [];
  return {
    rows,
    writer: {
      append: (entry: Appended) => {
        rows.push(entry);
        return Promise.resolve({ ...entry, id: 'a1', timestamp: 'now' } as never);
      }
    }
  };
}

describe('createLifecycleAuditSink', () => {
  it('appends one system row carrying only kind, operation id, counts and result', () => {
    const { writer, rows } = writerCollecting();
    const sink = createLifecycleAuditSink({ writer: writer as never, logger: { warn: vi.fn() } });
    sink.recordLifecycleMutation({
      operationKind: 'deletion',
      operationId: 'op-1',
      counts: { deleted: 2, skipped: 1 },
      result: 'partial'
    });
    expect(rows).toEqual([
      {
        runId: 'system',
        phase: 'done',
        iteration: 0,
        eventType: 'artifact-lifecycle-mutation',
        outcome: 'failure',
        payload: { operationKind: 'deletion', operationId: 'op-1', counts: { deleted: 2, skipped: 1 }, result: 'partial' }
      }
    ]);
    expect(classifyAuditEvent('artifact-lifecycle-mutation')).toBe('system');
  });

  it.each([
    ['completed', 'success'],
    ['resumed', 'success'],
    ['refused', 'info']
  ] as const)('maps a %s mutation to outcome %s', (result, outcome) => {
    const { writer, rows } = writerCollecting();
    const sink = createLifecycleAuditSink({ writer: writer as never, logger: { warn: vi.fn() } });
    sink.recordLifecycleMutation({ operationKind: 'archival', operationId: 'op-2', counts: {}, result });
    expect(rows.at(0)?.['outcome']).toBe(outcome);
  });

  it('logs a failed append by code only and trips the health latch', async () => {
    const secret = '/Users/someone/.schegent/audit/audit.jsonl';
    const failure = Object.assign(new Error(`EACCES ${secret}`), { code: 'EACCES' });
    const warnings: string[] = [];
    const onAppendFailed = vi.fn();
    const sink = createLifecycleAuditSink({
      writer: { append: () => Promise.reject(failure) } as never,
      logger: { warn: (message: string) => warnings.push(message) },
      onAppendFailed
    });
    sink.recordLifecycleMutation({ operationKind: 'deletion', operationId: 'op-3', counts: {}, result: 'completed' });
    await vi.waitFor(() => expect(onAppendFailed).toHaveBeenCalledTimes(1));
    expect(warnings).toHaveLength(1);
    expect(warnings.join('')).not.toContain(secret);
  });
});
