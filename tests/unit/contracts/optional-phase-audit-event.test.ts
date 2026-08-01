import { describe, expect, it } from 'vitest';
import {
  classifyAuditEvent,
  isKnownAuditEventType,
  type OptionalPhaseFailureContinuedPayload
} from '../../../src/contracts/audit-events';

describe('phase-optional-failure-continued audit contract (076)', () => {
  it('is known, task-scoped, bounded, and paths-free', () => {
    const payload: OptionalPhaseFailureContinuedPayload = {
      runId: 'run-076',
      pipelineId: 'custom',
      phaseId: 'optional-audit',
      runner: 'agy',
      iteration: 2,
      terminationReason: 'timeout'
    };

    expect(isKnownAuditEventType('phase-optional-failure-continued')).toBe(true);
    expect(classifyAuditEvent('phase-optional-failure-continued')).toBe('task');
    expect(Object.keys(payload).sort()).toEqual([
      'iteration',
      'phaseId',
      'pipelineId',
      'runId',
      'runner',
      'terminationReason'
    ]);
    expect(Object.keys(payload).join(' ')).not.toMatch(
      /path|environment|stdout|stderr|instruction|stack/i
    );
  });
});
