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

  // Feature 082 (US1, T019) — CMD_SAVE_PIPELINES carries the same revisioned
  // envelope as CMD_SAVE_PHASES. The ingress gate is the only place a payload
  // from an older webview bundle can be turned away, so those rejections are
  // pinned here rather than in the handler.
  //
  // Feature 099 (T496f, FR-043) — the envelope carried a `scope` naming which of
  // `user`/`workspace` the complete layer belonged to. One catalog leaves it
  // nothing to name. It is not merely optional now: the payload declares its keys
  // and an undeclared one is refused, so a pre-099 bundle is turned away at this
  // gate rather than silently writing to the one catalog that exists.
  const pipelineSave = {
    type: 'CMD_SAVE_PIPELINES',
    correlationId: 'c',
    payload: {
      expectedRevision: 'a'.repeat(64),
      mutation: { kind: 'create', pipelineId: 'custom-flow' },
      pipelines: [{ id: 'custom-flow', name: 'Custom Flow', version: 1, phases: ['done'] }]
    }
  };

  it('accepts the revisioned CMD_SAVE_PIPELINES envelope', () => {
    expect(validateInboundMessage(pipelineSave).ok).toBe(true);
  });

  it.each(['expectedRevision', 'mutation', 'pipelines'])(
    'rejects a CMD_SAVE_PIPELINES envelope missing %s',
    (key) => {
      const payload = { ...pipelineSave.payload } as Record<string, unknown>;
      delete payload[key];
      expect(validateInboundMessage({ ...pipelineSave, payload }).ok).toBe(false);
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
    ['a pre-099 scope field', { scope: 'user' }],
    ['a non-string revision', { expectedRevision: 7 }],
    ['a non-array pipelines value', { pipelines: {} }],
    ['an unknown mutation kind', { mutation: { kind: 'promote', pipelineId: 'a' } }],
    ['a create without a pipelineId', { mutation: { kind: 'create' } }],
    ['a duplicate without a source', { mutation: { kind: 'duplicate', pipelineId: 'copy' } }],
    ['a reset carrying a pipelineId', { mutation: { kind: 'reset', pipelineId: 'a' } }]
  ])('rejects a CMD_SAVE_PIPELINES envelope with %s', (_label, override) => {
    expect(
      validateInboundMessage({
        ...pipelineSave,
        payload: { ...pipelineSave.payload, ...override }
      }).ok
    ).toBe(false);
  });

  it('rejects undeclared keys on the CMD_SAVE_PIPELINES payload', () => {
    expect(
      validateInboundMessage({
        ...pipelineSave,
        payload: { ...pipelineSave.payload, phases: [] }
      }).ok
    ).toBe(false);
  });

  // Feature 083 (US1, T026) — CMD_SAVE_WORKFLOWS reuses the same envelope. The
  // rows themselves stay `unknown` here; the host validator owns graph shape.
  const workflowSave = {
    type: 'CMD_SAVE_WORKFLOWS',
    correlationId: 'c',
    payload: {
      expectedRevision: 'a'.repeat(64),
      mutation: { kind: 'create', workflowId: 'design-then-build' },
      workflows: [
        {
          id: 'design-then-build',
          name: 'Design then Build',
          version: 1,
          nodes: [{ nodeId: 'design', pipelineId: 'design-review' }],
          connections: [],
          startNodeIds: ['design']
        }
      ]
    }
  };

  it('accepts the revisioned CMD_SAVE_WORKFLOWS envelope', () => {
    expect(validateInboundMessage(workflowSave).ok).toBe(true);
  });

  it.each(['expectedRevision', 'mutation', 'workflows'])(
    'rejects a CMD_SAVE_WORKFLOWS envelope missing %s',
    (key) => {
      const payload = { ...workflowSave.payload } as Record<string, unknown>;
      delete payload[key];
      expect(validateInboundMessage({ ...workflowSave, payload }).ok).toBe(false);
    }
  );

  it.each([
    ['a pre-099 scope field', { scope: 'user' }],
    ['a non-string revision', { expectedRevision: 7 }],
    ['an over-long revision', { expectedRevision: 'a'.repeat(129) }],
    ['a non-array workflows value', { workflows: {} }],
    ['an unknown mutation kind', { mutation: { kind: 'promote', workflowId: 'a' } }],
    ['a create without a workflowId', { mutation: { kind: 'create' } }],
    ['a duplicate without a source', { mutation: { kind: 'duplicate', workflowId: 'copy' } }],
    ['a reset carrying a workflowId', { mutation: { kind: 'reset', workflowId: 'a' } }],
    ['an over-long workflowId', { mutation: { kind: 'edit', workflowId: 'a'.repeat(65) } }]
  ])('rejects a CMD_SAVE_WORKFLOWS envelope with %s', (_label, override) => {
    expect(
      validateInboundMessage({
        ...workflowSave,
        payload: { ...workflowSave.payload, ...override }
      }).ok
    ).toBe(false);
  });

  it('rejects undeclared keys on the CMD_SAVE_WORKFLOWS payload', () => {
    expect(
      validateInboundMessage({
        ...workflowSave,
        payload: { ...workflowSave.payload, pipelines: [] }
      }).ok
    ).toBe(false);
  });
});
