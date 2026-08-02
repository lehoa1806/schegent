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

  it.each(['CMD_RESUME', 'CMD_OPEN_AUDIT_LOG'])('accepts no-payload command %s', (type) => {
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

  it('accepts CMD_RESET only when confirmed=true', () => {
    expect(validateInboundMessage({ type: 'CMD_RESET', correlationId: 'c', payload: { confirmed: true } }).ok).toBe(true);
    expect(validateInboundMessage({ type: 'CMD_RESET', correlationId: 'c', payload: { confirmed: false } }).ok).toBe(false);
    expect(validateInboundMessage({ type: 'CMD_RESET', correlationId: 'c', payload: {} }).ok).toBe(false);
  });

  it('accepts CMD_REMOVE_QUEUE_ITEM with non-empty id', () => {
    expect(
      validateInboundMessage({ type: 'CMD_REMOVE_QUEUE_ITEM', correlationId: 'c', payload: { id: 'q1', confirmed: true } }).ok
    ).toBe(true);
    expect(
      validateInboundMessage({ type: 'CMD_REMOVE_QUEUE_ITEM', correlationId: 'c', payload: { id: '', confirmed: true } }).ok
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

  it.each([
    'CMD_RETRY_QUEUE_ITEM',
    'CMD_MOVE_QUEUE_ITEM_UP',
    'CMD_MOVE_QUEUE_ITEM_DOWN',
    'CMD_OPEN_QUEUE_ITEM_DETAILS',
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

  it.each([
    'CMD_PAUSE_QUEUE',
    'CMD_RESUME_QUEUE',
    'CMD_CLEAR_COMPLETED',
    'CMD_CLEAR_FAILED',
    'CMD_OPEN_DASHBOARD',
    'CMD_RETRY_ACTIVE_RUN'
  ])('%s accepts no payload', (type) => {
    expect(validateInboundMessage({ type, correlationId: 'c' }).ok).toBe(true);
  });

  it('accepts wake-up session-log read and reveal commands at the runtime ingress gate', () => {
    const read = validateInboundMessage({
      type: 'CMD_READ_WAKEUP_SESSION_LOG',
      correlationId: 'c',
      payload: { correlationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }
    });
    expect(read.ok).toBe(true);

    const reveal = validateInboundMessage({
      type: 'CMD_REVEAL_WAKEUP_SESSION_LOG',
      correlationId: 'c',
      payload: {}
    });
    expect(reveal.ok).toBe(true);
  });

  // Feature 082 (US1, T019) — CMD_SAVE_PIPELINES carries the same scoped,
  // revisioned envelope as CMD_SAVE_PHASES. The ingress gate is the only place
  // the pre-082 unscoped `{ pipelines }` payload can be turned away, so the
  // rejection is pinned here rather than in the handler.
  const scopedPipelineSave = {
    type: 'CMD_SAVE_PIPELINES',
    correlationId: 'c',
    payload: {
      scope: 'user',
      expectedRevision: 'a'.repeat(64),
      mutation: { kind: 'create', pipelineId: 'custom-flow' },
      pipelines: [{ id: 'custom-flow', name: 'Custom Flow', version: 1, phases: ['done'] }]
    }
  };

  it('accepts the scoped CMD_SAVE_PIPELINES envelope', () => {
    expect(validateInboundMessage(scopedPipelineSave).ok).toBe(true);
  });

  it.each(['scope', 'expectedRevision', 'mutation', 'pipelines'])(
    'rejects a CMD_SAVE_PIPELINES envelope missing %s',
    (key) => {
      const payload = { ...scopedPipelineSave.payload } as Record<string, unknown>;
      delete payload[key];
      expect(validateInboundMessage({ ...scopedPipelineSave, payload }).ok).toBe(false);
    }
  );

  it('rejects the pre-082 unscoped CMD_SAVE_PIPELINES payload', () => {
    expect(
      validateInboundMessage({
        type: 'CMD_SAVE_PIPELINES',
        correlationId: 'c',
        payload: { pipelines: [] }
      }).ok
    ).toBe(false);
  });

  it.each([
    ['a non-writable scope', { scope: 'built-in' }],
    ['a non-string revision', { expectedRevision: 7 }],
    ['a non-array pipelines value', { pipelines: {} }],
    ['an unknown mutation kind', { mutation: { kind: 'promote', pipelineId: 'a' } }],
    ['a create without a pipelineId', { mutation: { kind: 'create' } }],
    ['a duplicate without a source', { mutation: { kind: 'duplicate', pipelineId: 'copy' } }],
    ['a reset carrying a pipelineId', { mutation: { kind: 'reset', pipelineId: 'a' } }]
  ])('rejects a CMD_SAVE_PIPELINES envelope with %s', (_label, override) => {
    expect(
      validateInboundMessage({
        ...scopedPipelineSave,
        payload: { ...scopedPipelineSave.payload, ...override }
      }).ok
    ).toBe(false);
  });

  it('rejects undeclared keys on the CMD_SAVE_PIPELINES payload', () => {
    expect(
      validateInboundMessage({
        ...scopedPipelineSave,
        payload: { ...scopedPipelineSave.payload, phases: [] }
      }).ok
    ).toBe(false);
  });

  it('rejects unsafe wake-up session-log payload shapes before router dispatch', () => {
    expect(
      validateInboundMessage({
        type: 'CMD_READ_WAKEUP_SESSION_LOG',
        correlationId: 'c',
        payload: {}
      }).ok
    ).toBe(false);
    expect(
      validateInboundMessage({
        type: 'CMD_READ_WAKEUP_SESSION_LOG',
        correlationId: 'c',
        payload: { correlationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', path: '/tmp/session.log' }
      }).ok
    ).toBe(false);
    expect(
      validateInboundMessage({
        type: 'CMD_REVEAL_WAKEUP_SESSION_LOG',
        correlationId: 'c',
        payload: { path: '/tmp/session.log' }
      }).ok
    ).toBe(false);
  });
});
