import { describe, expect, it } from 'vitest';
import {
  parseAuditLogLine,
  parseAuditLogLineDetailed
} from '../../../src/parser/audit-log-parser';
import { AUDIT_SCHEMA_VERSION } from '../../../src/contracts/audit-events';

describe('audit-log-parser monitor.* event hydration (US4 / T062)', () => {
  it('preserves monitor-invocation-started entries', () => {
    const line = JSON.stringify({
      id: '1',
      timestamp: new Date().toISOString(),
      runId: 'r1',
      phase: 'speckit-specify',
      iteration: 1,
      eventType: 'monitor-invocation-started',
      payload: { pid: 1234 },
      outcome: 'info'
    });
    const entry = parseAuditLogLine(line);
    expect(entry).not.toBeNull();
    expect(entry?.eventType).toBe('monitor-invocation-started');
  });

  it('preserves monitor-stall and monitor-rate-limited entries', () => {
    for (const eventType of ['monitor-stall', 'monitor-rate-limited']) {
      const line = JSON.stringify({
        id: '1',
        timestamp: new Date().toISOString(),
        runId: 'r1',
        phase: 'speckit-plan',
        iteration: 1,
        eventType,
        payload: { cause: 'test' },
        outcome: 'failure'
      });
      const entry = parseAuditLogLine(line);
      expect(entry?.eventType).toBe(eventType);
    }
  });
});

describe('audit-log-parser schema version handling (US4 / T063)', () => {
  it('warns when persisted schemaVersion exceeds the runtime version, but preserves the entry', () => {
    const futureVersion = AUDIT_SCHEMA_VERSION + 100;
    const line = JSON.stringify({
      id: '1',
      timestamp: new Date().toISOString(),
      runId: 'r1',
      phase: 'speckit-specify',
      iteration: 1,
      eventType: 'cli-invocation',
      payload: {},
      outcome: 'info',
      schemaVersion: futureVersion
    });
    const result = parseAuditLogLineDetailed(line);
    expect(result.entry).not.toBeNull();
    expect(result.warning).toMatch(/schemaVersion/);
  });

  it('warns on unknown eventType but preserves the entry', () => {
    const line = JSON.stringify({
      id: '1',
      timestamp: new Date().toISOString(),
      runId: 'r1',
      phase: 'speckit-specify',
      iteration: 1,
      eventType: 'future.unknown.event',
      payload: {},
      outcome: 'info'
    });
    const result = parseAuditLogLineDetailed(line);
    expect(result.entry).not.toBeNull();
    expect(result.entry?.eventType).toBe('future.unknown.event');
    expect(result.warning).toMatch(/unknown eventType/);
  });
});

describe('audit-log-parser dynamic phase hydration', () => {
  it('preserves valid audit entries for bugfix and custom phase ids', () => {
    for (const phase of ['bugfix-report', 'security-review']) {
      const line = JSON.stringify({
        id: `entry-${phase}`,
        timestamp: new Date().toISOString(),
        runId: 'r1',
        phase,
        iteration: 1,
        eventType: 'phase-start',
        payload: { phaseId: phase },
        outcome: 'info'
      });
      const entry = parseAuditLogLine(line);
      expect(entry).not.toBeNull();
      expect(entry?.phase).toBe(phase);
    }
  });
});

describe('audit-log-parser correlationId hydration (US4 / T066)', () => {
  it('reads an explicit correlationId field when present', () => {
    const line = JSON.stringify({
      id: '1',
      timestamp: new Date().toISOString(),
      runId: 'r-runId',
      phase: 'speckit-specify',
      iteration: 1,
      eventType: 'cli-invocation',
      payload: {},
      outcome: 'info',
      correlationId: 'corr-abc'
    });
    const entry = parseAuditLogLine(line);
    expect(entry?.correlationId).toBe('corr-abc');
  });
});
