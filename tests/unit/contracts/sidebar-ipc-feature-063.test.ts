// Feature 063 — T005 — type-guard coverage for CMD_CLEAR_ALL and
// CMD_SET_CONFIRM_SUPPRESSION. The drift guard
// (`sidebar-ipc-drift.test.ts`) already asserts every COMMAND_TYPES
// literal has a registered guard; this file pins the deeper payload
// validation that those guards perform.
import { describe, expect, it } from 'vitest';
import {
  CMD_CLEAR_ALL,
  CMD_SET_CONFIRM_SUPPRESSION,
  isCmdClearAll,
  isCmdSetConfirmSuppression
} from '../../../src/contracts/sidebar-ipc';

describe('Feature 063 — isCmdClearAll', () => {
  it('accepts a minimal command with no payload', () => {
    expect(isCmdClearAll({ type: CMD_CLEAR_ALL, correlationId: 'c-1' })).toBe(true);
  });

  it('accepts an empty payload object', () => {
    expect(
      isCmdClearAll({ type: CMD_CLEAR_ALL, correlationId: 'c-1', payload: {} })
    ).toBe(true);
  });

  it('rejects payload arrays', () => {
    expect(
      isCmdClearAll({ type: CMD_CLEAR_ALL, correlationId: 'c-1', payload: [] })
    ).toBe(false);
  });

  it('rejects non-empty payloads (CMD_CLEAR_ALL takes no operator input)', () => {
    expect(
      isCmdClearAll({
        type: CMD_CLEAR_ALL,
        correlationId: 'c-1',
        payload: { confirmed: true }
      })
    ).toBe(false);
  });

  it('rejects foreign discriminators', () => {
    expect(isCmdClearAll({ type: 'CMD_RESET', correlationId: 'c-1' })).toBe(false);
  });

  it('rejects null, undefined, primitives, and arrays', () => {
    expect(isCmdClearAll(null)).toBe(false);
    expect(isCmdClearAll(undefined)).toBe(false);
    expect(isCmdClearAll('CMD_CLEAR_ALL')).toBe(false);
    expect(isCmdClearAll([])).toBe(false);
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
