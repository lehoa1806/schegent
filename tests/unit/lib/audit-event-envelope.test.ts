import { describe, expect, it } from 'vitest';
import {
  createStateTransitionAuditEnvelope,
  operatorAuditActor,
  systemAuditActor
} from '../../../src/lib/audit-event-envelope';

describe('audit-event-envelope (017, T021)', () => {
  it('creates a deterministic state-transition envelope with an explicit actor', () => {
    const envelope = createStateTransitionAuditEnvelope({
      actor: operatorAuditActor('alice'),
      correlationId: 'corr-1',
      reasonCode: 'queue-paused',
      priorState: { state: 'active' },
      newState: { state: 'manually-paused' },
      now: new Date('2026-05-13T00:00:00.000Z')
    });

    expect(envelope).toEqual({
      timestamp: '2026-05-13T00:00:00.000Z',
      correlationId: 'corr-1',
      actor: { kind: 'operator', id: 'alice' },
      reasonCode: 'queue-paused',
      priorState: { state: 'active' },
      newState: { state: 'manually-paused' }
    });
  });

  it('supports system actors and null defaults', () => {
    const envelope = createStateTransitionAuditEnvelope({
      actor: systemAuditActor('migration'),
      reasonCode: 'queue-state-migrated',
      now: new Date('2026-05-13T00:00:00.000Z')
    });

    expect(envelope.correlationId).toBeNull();
    expect(envelope.priorState).toBeNull();
    expect(envelope.newState).toBeNull();
    expect(envelope.actor).toEqual({ kind: 'system', id: 'migration' });
  });
});
