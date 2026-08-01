import { describe, it, expect } from 'vitest';
import { TASK_EXECUTION_EVENT_TYPES, ALL_AUDIT_EVENT_TYPES } from '../../src/contracts/audit-events';

describe('Task Execution Event Types Parity (Feature 072)', () => {
  it('ensures all task execution event types are registered in ALL_AUDIT_EVENT_TYPES', () => {
    for (const eventType of TASK_EXECUTION_EVENT_TYPES) {
      expect(ALL_AUDIT_EVENT_TYPES).toContain(eventType);
    }
  });

  it('ensures exactly the 4 required event types are present', () => {
    expect(TASK_EXECUTION_EVENT_TYPES).toHaveLength(4);
    expect(TASK_EXECUTION_EVENT_TYPES).toEqual(
      expect.arrayContaining([
        'task-execution-started',
        'task-execution-ended',
        'task-execution-paused',
        'phase-jumped'
      ])
    );
  });
});
