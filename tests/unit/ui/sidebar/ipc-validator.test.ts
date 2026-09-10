import { describe, expect, it } from 'vitest';
import { validateInboundMessage } from '../../../../src/ui/sidebar/ipc-validator';

describe('validateInboundMessage', () => {
  it('accepts a valid CMD_START', () => {
    const result = validateInboundMessage({
      type: 'CMD_START',
      correlationId: 'a',
      payload: { description: '  hello world  ' }
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.type).toBe('CMD_START');
      expect((result.command as { payload: { description: string } }).payload.description).toBe('hello world');
    }
  });

  it.each(['CMD_OPEN_AUDIT_LOG'])('accepts no-payload command %s', (type) => {
    const result = validateInboundMessage({ type, correlationId: 'cid' });
    expect(result.ok).toBe(true);
  });

  it('accepts CMD_CANCEL with a non-empty taskId payload (BUG-001)', () => {
    const ok = validateInboundMessage({
      type: 'CMD_CANCEL',
      correlationId: 'cid',
      payload: { taskId: 'task-1' }
    });
    expect(ok.ok).toBe(true);
  });

  it('rejects CMD_CANCEL with no payload (BUG-001)', () => {
    expect(validateInboundMessage({ type: 'CMD_CANCEL', correlationId: 'cid' }).ok).toBe(false);
  });

  it('rejects CMD_CANCEL with empty taskId (BUG-001)', () => {
    expect(
      validateInboundMessage({
        type: 'CMD_CANCEL',
        correlationId: 'cid',
        payload: { taskId: '' }
      }).ok
    ).toBe(false);
  });

  it('accepts CMD_RESTART_CANCELED_TASK with a non-empty taskId payload (BUG-001)', () => {
    expect(
      validateInboundMessage({
        type: 'CMD_RESTART_CANCELED_TASK',
        correlationId: 'cid',
        payload: { taskId: 'task-1' }
      }).ok
    ).toBe(true);
  });

  it('rejects CMD_RESTART_CANCELED_TASK with empty taskId (BUG-001)', () => {
    expect(
      validateInboundMessage({
        type: 'CMD_RESTART_CANCELED_TASK',
        correlationId: 'cid',
        payload: { taskId: '' }
      }).ok
    ).toBe(false);
  });

  // `CMD_RESET` held the confirmation-gate assertion here until the lifecycle
  // round-check of 2026-08-30 (finding D) deleted it — no webview had sent it
  // since FR-R3-140 removed `ControlPanel.svelte`, and reset survives as the
  // palette command `schegent.reset` with its own host-side prompt. The
  // property it proved does not leave with it: the `confirmed: false` case
  // below is the half `CMD_RESET` was carrying that `CMD_REMOVE_QUEUE_ITEM`
  // was not, moved rather than dropped, because "an explicit refusal is not a
  // confirmation" is the rule and not a fact about one command.
  it('accepts CMD_REMOVE_QUEUE_ITEM with non-empty id, only when confirmed=true', () => {
    expect(
      validateInboundMessage({ type: 'CMD_REMOVE_QUEUE_ITEM', correlationId: 'c', payload: { id: 'q1', confirmed: true } }).ok
    ).toBe(true);
    expect(
      validateInboundMessage({ type: 'CMD_REMOVE_QUEUE_ITEM', correlationId: 'c', payload: { id: '', confirmed: true } }).ok
    ).toBe(false);
    expect(
      validateInboundMessage({ type: 'CMD_REMOVE_QUEUE_ITEM', correlationId: 'c', payload: { id: 'q1', confirmed: false } }).ok
    ).toBe(false);
    expect(
      validateInboundMessage({ type: 'CMD_REMOVE_QUEUE_ITEM', correlationId: 'c', payload: { id: 'q1' } }).ok
    ).toBe(false);
  });

  it('rejects missing or non-string type', () => {
    expect(validateInboundMessage({ correlationId: 'c' }).ok).toBe(false);
    expect(validateInboundMessage({ type: 42, correlationId: 'c' }).ok).toBe(false);
  });

  it('rejects missing or oversized correlationId', () => {
    expect(validateInboundMessage({ type: 'CMD_CANCEL' }).ok).toBe(false);
    expect(validateInboundMessage({ type: 'CMD_CANCEL', correlationId: '' }).ok).toBe(false);
    expect(validateInboundMessage({ type: 'CMD_CANCEL', correlationId: 'x'.repeat(65) }).ok).toBe(false);
  });

  it('rejects empty / oversized description', () => {
    expect(
      validateInboundMessage({
        type: 'CMD_START',
        correlationId: 'c',
        payload: { description: '' }
      }).ok
    ).toBe(false);
    expect(
      validateInboundMessage({
        type: 'CMD_START',
        correlationId: 'c',
        payload: { description: '   ' }
      }).ok
    ).toBe(false);
    expect(
      validateInboundMessage({
        type: 'CMD_START',
        correlationId: 'c',
        payload: { description: 'x'.repeat(4097) }
      }).ok
    ).toBe(false);
  });

  it('rejects unknown command type', () => {
    expect(validateInboundMessage({ type: 'CMD_NUKE', correlationId: 'c' }).ok).toBe(false);
  });

  it('rejects extra payload fields', () => {
    expect(
      validateInboundMessage({
        type: 'CMD_START',
        correlationId: 'c',
        payload: { description: 'ok', extra: 'no' }
      }).ok
    ).toBe(false);
  });

  it('rejects non-object inputs', () => {
    expect(validateInboundMessage(null).ok).toBe(false);
    expect(validateInboundMessage('string').ok).toBe(false);
    expect(validateInboundMessage(42).ok).toBe(false);
  });

  // `CMD_OPEN_QUEUE_ITEM_DETAILS` left this list in the lifecycle round-check of
  // 2026-08-30 (finding D). The four that remain assert the same id rule.
  it.each([
    'CMD_RETRY_QUEUE_ITEM',
    'CMD_MOVE_QUEUE_ITEM_UP',
    'CMD_MOVE_QUEUE_ITEM_DOWN',
    'CMD_OPEN_HISTORY_ITEM_DETAILS'
  ])('%s requires a non-empty id', (type) => {
    expect(validateInboundMessage({ type, correlationId: 'c', payload: { id: 'q1' } }).ok).toBe(true);
    expect(validateInboundMessage({ type, correlationId: 'c', payload: { id: '' } }).ok).toBe(false);
    expect(validateInboundMessage({ type, correlationId: 'c', payload: { id: 42 } }).ok).toBe(false);
    expect(validateInboundMessage({ type, correlationId: 'c', payload: {} }).ok).toBe(false);
  });

  it('CMD_RERUN_FROM_HISTORY requires a non-empty runId', () => {
    const type = 'CMD_RERUN_FROM_HISTORY';
    expect(
      validateInboundMessage({ type, correlationId: 'c', payload: { runId: 'r1' } }).ok
    ).toBe(true);
    expect(
      validateInboundMessage({ type, correlationId: 'c', payload: { runId: '' } }).ok
    ).toBe(false);
    expect(validateInboundMessage({ type, correlationId: 'c', payload: {} }).ok).toBe(false);
  });

  // `CMD_CLEAR_FAILED` and `CMD_RETRY_ACTIVE_RUN` left this list in the lifecycle
  // round-check of 2026-08-30 (finding D). Both capabilities survive as palette
  // commands (`schegent.clearFailed`, `schegent.retryActiveRun`); what went was
  // the IPC surface no webview had sent to since FR-R3-140.
  it.each([
    'CMD_PAUSE_QUEUE',
    'CMD_RESUME_QUEUE',
    'CMD_OPEN_DASHBOARD'
  ])('%s accepts no payload', (type) => {
    expect(validateInboundMessage({ type, correlationId: 'c' }).ok).toBe(true);
  });

  // FR-R3-150 (T1621a) — `CMD_CLEAR_COMPLETED` now requires a non-empty
  // `queueId` and no other payload field; a missing/blank/oversized id or
  // an absent payload is refused at this boundary before it ever reaches
  // `QueueManager`.
  it.each(['CMD_CLEAR_COMPLETED'])(
    '%s requires a non-empty queueId and nothing else',
    (type) => {
      expect(
        validateInboundMessage({ type, correlationId: 'c', payload: { queueId: 'q-1' } }).ok
      ).toBe(true);
      expect(validateInboundMessage({ type, correlationId: 'c' }).ok).toBe(false);
      expect(validateInboundMessage({ type, correlationId: 'c', payload: {} }).ok).toBe(false);
      expect(
        validateInboundMessage({ type, correlationId: 'c', payload: { queueId: '' } }).ok
      ).toBe(false);
      expect(
        validateInboundMessage({ type, correlationId: 'c', payload: { queueId: 42 } }).ok
      ).toBe(false);
      expect(
        validateInboundMessage({
          type,
          correlationId: 'c',
          payload: { queueId: 'q-1', extra: true }
        }).ok
      ).toBe(false);
    }
  );

  // The mirror of the four above, and the reason this file can shrink safely: a
  // deleted command must become UNKNOWN, not merely untested. Without this, the
  // removals above would read as coverage quietly withdrawn.
  it.each([
    'CMD_RESUME',
    'CMD_RESET',
    'CMD_CLEAR_FAILED',
    'CMD_RETRY_ACTIVE_RUN',
    'CMD_OPEN_QUEUE_ITEM_DETAILS'
  ])('%s was deleted by the lifecycle round-check and no longer validates', (type) => {
    expect(validateInboundMessage({ type, correlationId: 'c' }).ok).toBe(false);
    expect(validateInboundMessage({ type, correlationId: 'c', payload: { confirmed: true } }).ok).toBe(false);
    expect(validateInboundMessage({ type, correlationId: 'c', payload: { id: 'q1' } }).ok).toBe(false);
  });

  // Feature 100 (T509) — the revisioned complete-layer envelopes for
  // `CMD_SAVE_PIPELINES` and `CMD_SAVE_WORKFLOWS` were asserted here, and both
  // commands are gone with the whole-array save they carried. The ingress
  // coverage moved rather than ended: tests/contract/catalog-lifecycle-ipc.test.ts
  // runs the same gate against the six lifecycle commands — the exact envelope,
  // every missing key, an undeclared key, and the pre-099 `scope` and the layer
  // era's `mutation`/`expectedRevision` as refusals. Leaving the old blocks here
  // would have kept a row of green rejection tests that now pass because the
  // command name is unknown, which is coverage in name only.

  // Feature 195 (T064, FR-025) — the attested completion's ingress.
  //
  // `confirmed: true` is required on the wire, the same shape
  // `CMD_REMOVE_QUEUE_ITEM` has carried since it gained a consent step. It is
  // not decoration: FR-025 says the operator must assert the outcome
  // explicitly and the system must not infer it, so the assertion is a fact
  // the message carries and this gate is where its absence is refused. A UI
  // that forgets the confirmation therefore cannot attest, rather than
  // attesting silently.
  describe('CMD_ATTEST_TASK_COMPLETED (feature 195, T064, FR-025)', () => {
    const type = 'CMD_ATTEST_TASK_COMPLETED';

    it('accepts a confirmed attestation for one task', () => {
      const result = validateInboundMessage({
        type,
        correlationId: 'c',
        payload: { taskId: 'task-7', confirmed: true }
      });
      expect(result.ok).toBe(true);
    });

    it('refuses an unconfirmed attestation', () => {
      expect(
        validateInboundMessage({ type, correlationId: 'c', payload: { taskId: 'task-7' } }).ok
      ).toBe(false);
      expect(
        validateInboundMessage({
          type,
          correlationId: 'c',
          payload: { taskId: 'task-7', confirmed: false }
        }).ok
      ).toBe(false);
      // Truthy is not `true`. An assertion inferred from a coercion is exactly
      // what FR-025 forbids.
      expect(
        validateInboundMessage({
          type,
          correlationId: 'c',
          payload: { taskId: 'task-7', confirmed: 'yes' }
        }).ok
      ).toBe(false);
    });

    it('refuses a missing, empty or non-string taskId', () => {
      expect(validateInboundMessage({ type, correlationId: 'c' }).ok).toBe(false);
      expect(
        validateInboundMessage({ type, correlationId: 'c', payload: { confirmed: true } }).ok
      ).toBe(false);
      expect(
        validateInboundMessage({ type, correlationId: 'c', payload: { taskId: '', confirmed: true } }).ok
      ).toBe(false);
      expect(
        validateInboundMessage({ type, correlationId: 'c', payload: { taskId: 42, confirmed: true } }).ok
      ).toBe(false);
    });

    it('refuses an undeclared payload field', () => {
      expect(
        validateInboundMessage({
          type,
          correlationId: 'c',
          payload: { taskId: 'task-7', confirmed: true, status: 'completed' }
        }).ok
      ).toBe(false);
    });
  });
});
