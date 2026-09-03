// Feature 195 (T036, FR-018, FR-019) — `runSetQueueFailurePolicyCommand`
// translates `QueueManager.setFailurePolicy`'s three-way answer into the
// four-word `CommandOutcome` vocabulary: a committed write is `accepted`
// only, the idempotent reject reason is `no-op`, every other decline is
// `refused` with its reason, and a throw is `failed`.

import { describe, it, expect } from 'vitest';
import {
  runSetQueueFailurePolicyCommand,
  type SetQueueFailurePolicyCommandDeps
} from '../../../src/commands/set-queue-failure-policy';
import type { QueueManager } from '../../../src/queue/queue-manager';

function depsWith(
  setFailurePolicy: QueueManager['setFailurePolicy']
): SetQueueFailurePolicyCommandDeps {
  return {
    queue: { setFailurePolicy } as unknown as SetQueueFailurePolicyCommandDeps['queue'],
    logger: { error: () => {} }
  };
}

describe('runSetQueueFailurePolicyCommand', () => {
  it('acknowledges accepted only on a committed write', async () => {
    const deps = depsWith(async () => ({ ok: true, queueId: 'q-1' }));
    const outcome = await runSetQueueFailurePolicyCommand(
      { queueId: 'q-1', policy: 'halt-on-failure' },
      deps
    );
    expect(outcome).toEqual({ outcome: 'accepted' });
  });

  it('reads the idempotent reject reason as no-op, not refused', async () => {
    const deps = depsWith(async () => ({
      ok: false,
      reason: 'failure-policy-unchanged',
      queueId: 'q-1'
    }));
    const outcome = await runSetQueueFailurePolicyCommand(
      { queueId: 'q-1', policy: null },
      deps
    );
    expect(outcome).toEqual({ outcome: 'no-op', reason: 'failure-policy-unchanged' });
  });

  it('reads every other decline as a refusal carrying the reason verbatim', async () => {
    const deps = depsWith(async () => ({ ok: false, reason: 'unknown-queue-id' }));
    const outcome = await runSetQueueFailurePolicyCommand(
      { queueId: 'q-ghost', policy: 'continue' },
      deps
    );
    expect(outcome).toEqual({ outcome: 'refused', reason: 'unknown-queue-id' });
  });

  it('reports a thrown error as failed, with a code rather than the message', async () => {
    const deps = depsWith(async () => {
      throw new Error('EACCES: /Users/someone/ws/.schegent/state.json');
    });
    const outcome = await runSetQueueFailurePolicyCommand(
      { queueId: 'q-1', policy: 'continue' },
      deps
    );
    expect(outcome).toEqual({ outcome: 'failed', reason: 'set-queue-failure-policy-failed' });
  });
});
