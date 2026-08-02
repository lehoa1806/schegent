import { describe, expect, it } from 'vitest';
import { phaseLayerRevision } from '../../src/config/process-catalog';
import { validateInboundMessage } from '../../src/contracts/runtime-validators';
import { CMD_SAVE_PHASES } from '../../src/contracts/sidebar-ipc';

const valid = {
  type: CMD_SAVE_PHASES,
  correlationId: 'scoped-save',
  payload: {
    scope: 'user',
    expectedRevision: phaseLayerRevision([]),
    mutation: { kind: 'create', phaseId: 'custom-phase' },
    phases: [{ id: 'custom-phase', name: 'Custom', version: 1, skill: 'skill-a' }]
  }
};

describe('scoped Phase save IPC contract', () => {
  it('accepts an exact revisioned mutation envelope', () => {
    expect(validateInboundMessage(valid)).toMatchObject({ ok: true, command: valid });
  });

  it.each(['scope', 'expectedRevision', 'mutation', 'phases'])(
    'rejects an envelope missing %s',
    (key) => {
      const payload = { ...valid.payload } as Record<string, unknown>;
      delete payload[key];
      expect(validateInboundMessage({ ...valid, payload })).toMatchObject({
        ok: false,
        reason: 'invalid-payload'
      });
    }
  );

  it('rejects undeclared payload keys', () => {
    expect(validateInboundMessage({
      ...valid,
      payload: { ...valid.payload, instruction: 'must not be echoed at envelope level' }
    })).toMatchObject({ ok: false, reason: 'invalid-payload' });
  });
});
