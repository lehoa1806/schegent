// What a Workflow's Retry does to the failed rows it answers: the row leaves the queue, and the
// removal is recorded the way the failed-row census reads it.

import { describe, expect, it, vi } from 'vitest';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { createWorkflowFailureRetirement } from '../../../src/controller/task-deletion';
import type { QueueMutationDetail } from '../../../src/queue/queue-manager';
import type { ConnectedWorkflowRun } from '../../../src/state/connected-workflow-run';

const QUEUE = 'q-main';

describe('createWorkflowFailureRetirement', () => {
  const RETRIED_RUN = {
    connectedRunId: 'crun',
    nodes: {},
    invocations: {
      root: {
        attemptsByNodeId: {
          draft: [
            { nodeKind: 'phase', status: 'failed', queueItemId: 'row-failed' },
            { nodeKind: 'phase', status: 'in-flight', queueItemId: 'row-of-the-retry' }
          ],
          nested: [{ nodeKind: 'call', status: 'failed', queueItemId: 'row-of-a-call' }],
          unstarted: [{ nodeKind: 'phase', status: 'failed' }]
        }
      },
      child: {
        attemptsByNodeId: {
          verify: [{ nodeKind: 'phase', status: 'failed', queueItemId: 'row-failed-in-child' }]
        }
      }
    }
  } as unknown as ConnectedWorkflowRun;

  function makeRetirement(rowStatus: (id: string) => string | null = () => 'failed') {
    const removeTask = vi.fn((taskId: string) =>
      Promise.resolve<QueueMutationDetail>({
        ok: true,
        taskId,
        queueId: QUEUE,
        priorStatus: 'failed',
        runId: `run-of-${taskId}`,
        completionProvenance: null
      })
    );
    const append = vi.fn((_entry: Parameters<AuditLogWriter['append']>[0]) => Promise.resolve());
    const warn = vi.fn();
    const retire = createWorkflowFailureRetirement({
      queue: {
        findById: (id: string) => {
          const status = rowStatus(id);
          return status === null ? null : ({ id, status } as never);
        },
        removeTask
      },
      audit: { append } as unknown as Pick<AuditLogWriter, 'append'>,
      logger: { warn }
    });
    return { retire, removeTask, append, warn };
  }

  it('takes the row of every failed Phase attempt off the queue, on every frame', async () => {
    const { retire, removeTask } = makeRetirement();

    await retire(RETRIED_RUN);

    expect(removeTask.mock.calls.map((call) => call.at(0))).toEqual([
      'row-failed',
      'row-failed-in-child'
    ]);
  });

  it('records each removal as the census reads it, naming the Retry as the cause', async () => {
    const { retire, append } = makeRetirement((id) => (id === 'row-failed' ? 'failed' : null));

    await retire(RETRIED_RUN);

    expect(append).toHaveBeenCalledTimes(1);
    const entry = append.mock.calls.at(0)?.at(0);
    expect(entry).toMatchObject({
      runId: `queue:${QUEUE}`,
      phase: 'queue',
      iteration: 0,
      eventType: 'task-removed',
      outcome: 'info',
      payload: {
        taskId: 'row-failed',
        queueId: QUEUE,
        priorStatus: 'failed',
        completionProvenance: null,
        runId: 'run-of-row-failed',
        cause: 'workflow-retry',
        sessionCleaned: false,
        sessionCleanupRefusal: null,
        stateTransition: { reasonCode: 'task-removed' }
      }
    });
  });

  it('leaves a row the operator has already attested, and one already gone', async () => {
    const { retire, removeTask, append } = makeRetirement((id) =>
      id === 'row-failed' ? 'completed' : null
    );

    await retire(RETRIED_RUN);

    expect(removeTask).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('warns about a refused removal, records nothing for it and goes on to the next row', async () => {
    const { retire, removeTask, append, warn } = makeRetirement();
    removeTask.mockResolvedValueOnce({ ok: false, reason: 'task-not-found' });

    await retire(RETRIED_RUN);

    expect(removeTask).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls.at(0)?.at(0))).toContain('task-not-found');
  });

  it('never throws at a command that has already committed', async () => {
    const { retire, removeTask, append, warn } = makeRetirement();
    removeTask.mockRejectedValueOnce(new Error('store refused'));
    append.mockRejectedValueOnce(new Error('audit refused'));

    await expect(retire(RETRIED_RUN)).resolves.toBeUndefined();

    expect(warn.mock.calls.map((call) => String(call.at(0)))).toEqual([
      expect.stringContaining('store refused'),
      expect.stringContaining('audit refused')
    ]);
  });
});
