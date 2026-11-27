// Feature 063 / FR-R3-150 (T1618) — type-guard coverage for CMD_CLEAR_QUEUE
// and CMD_SET_CONFIRM_SUPPRESSION. The drift guard
// (`sidebar-ipc-drift.test.ts`) already asserts every COMMAND_TYPES
// literal has a registered guard; this file pins the deeper payload
// validation that those guards perform.
import { describe, expect, it } from 'vitest';
import {
  CMD_CLEAR_QUEUE,
  CMD_SET_CONFIRM_SUPPRESSION,
  isCmdClearQueue,
  isCmdSetConfirmSuppression
} from '../../../src/contracts/sidebar-ipc';

// FR-R3-150 (T1618) — `isCmdClearQueue` is a shallow discriminator-only
// check, matching `isCmdClearCompleted`: deep `queueId` validation lives in
// `validateQueueCleanupPayload` (`src/contracts/validators/queue-cleanup.ts`),
// which is architecturally the only layer that checks payload shape for
// this command (this file's own header comment). These cases pin that this
// guard accepts any object-shaped payload and only checks the discriminator.
describe('FR-R3-150 (T1618) — isCmdClearQueue', () => {
  it('accepts a well-formed payload', () => {
    expect(
      isCmdClearQueue({
        type: CMD_CLEAR_QUEUE,
        correlationId: 'c-1',
        payload: { queueId: 'q-beta' }
      })
    ).toBe(true);
  });

  it('accepts a missing payload too — shape/registry validation lives one layer down', () => {
    expect(isCmdClearQueue({ type: CMD_CLEAR_QUEUE, correlationId: 'c-1' })).toBe(true);
  });

  it('rejects foreign discriminators', () => {
    expect(
      isCmdClearQueue({
        type: 'CMD_CLEAR_COMPLETED',
        correlationId: 'c-1',
        payload: { queueId: 'q-beta' }
      })
    ).toBe(false);
  });

  it('rejects null, undefined, primitives, and arrays', () => {
    expect(isCmdClearQueue(null)).toBe(false);
    expect(isCmdClearQueue(undefined)).toBe(false);
    expect(isCmdClearQueue('CMD_CLEAR_QUEUE')).toBe(false);
    expect(isCmdClearQueue([])).toBe(false);
  });
});

describe('Feature 063 — isCmdSetConfirmSuppression', () => {
  it('accepts a well-formed payload', () => {
    expect(
      isCmdSetConfirmSuppression({
        type: CMD_SET_CONFIRM_SUPPRESSION,
        correlationId: 'c-1',
        payload: { actionKey: 'queue.clean-all', suppressed: true }
      })
    ).toBe(true);
  });

  it('rejects missing payload', () => {
    expect(
      isCmdSetConfirmSuppression({
        type: CMD_SET_CONFIRM_SUPPRESSION,
        correlationId: 'c-1'
      })
    ).toBe(false);
  });

  it('rejects empty actionKey strings', () => {
    expect(
      isCmdSetConfirmSuppression({
        type: CMD_SET_CONFIRM_SUPPRESSION,
        correlationId: 'c-1',
        payload: { actionKey: '', suppressed: true }
      })
    ).toBe(false);
  });

  it('rejects non-boolean suppressed values', () => {
    expect(
      isCmdSetConfirmSuppression({
        type: CMD_SET_CONFIRM_SUPPRESSION,
        correlationId: 'c-1',
        payload: { actionKey: 'queue.clean-all', suppressed: 'true' }
      })
    ).toBe(false);
    expect(
      isCmdSetConfirmSuppression({
        type: CMD_SET_CONFIRM_SUPPRESSION,
        correlationId: 'c-1',
        payload: { actionKey: 'queue.clean-all', suppressed: 1 }
      })
    ).toBe(false);
  });

  it('rejects non-string actionKey values', () => {
    expect(
      isCmdSetConfirmSuppression({
        type: CMD_SET_CONFIRM_SUPPRESSION,
        correlationId: 'c-1',
        payload: { actionKey: 42, suppressed: true }
      })
    ).toBe(false);
  });

  it('rejects array payload', () => {
    expect(
      isCmdSetConfirmSuppression({
        type: CMD_SET_CONFIRM_SUPPRESSION,
        correlationId: 'c-1',
        payload: ['queue.clean-all', true]
      })
    ).toBe(false);
  });

  it('rejects foreign discriminators', () => {
    expect(
      isCmdSetConfirmSuppression({
        type: 'CMD_SAVE_GENERAL_SETTINGS',
        correlationId: 'c-1',
        payload: { actionKey: 'queue.clean-all', suppressed: true }
      })
    ).toBe(false);
  });
});
