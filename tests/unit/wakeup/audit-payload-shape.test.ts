// Feature 031 T007 — unit tests for the `wakeup-runner-invocation`
// audit event payload composer. Mirrors the contract diff at
// specs/031-advanced-wakeup-logs-models/contracts/wakeup-runner-invocation-audit.diff.md.
//
// The composer ingests an `InvocationRecord` (from the JSONL log)
// and projects a flat audit payload. The 031 delta adds three scalar
// fields:
//   - correlationId
//   - requestedModel
//   - actualModel
//
// And explicitly does NOT add:
//   - sessionLogBytesAppended   (byte counter; JSONL only)
//   - sessionLogTrimmed         (retention boolean; JSONL only)
//   - any path (workspace, session-log file, mirror)
//
// Coverage:
//   (a) Composer carries correlationId / requestedModel / actualModel
//       when present on the source record.
//   (b) Composer omits the byte counters (sessionLogBytesAppended,
//       sessionLogTrimmed).
//   (c) Composer carries no path-shaped fields.
//   (d) Composer tolerates legacy records (014/024) and omits the
//       new fields when absent on the source.

import { describe, it, expect } from 'vitest';
import { composeWakeupRunnerInvocationAudit } from '../../../src/wakeup/audit-composer';
import type { InvocationRecord } from '../../../src/wakeup/invocation-log';

function recordWithAllFields(): InvocationRecord {
  return {
    timestamp: '2026-05-16T04:00:00.000Z',
    platform: 'darwin',
    pid: 4321,
    lockAcquired: true,
    ephemeralCwd: '/tmp/schegent-primer-session/def',
    cwdInsideWorkspace: false,
    envScrubbed: true,
    claudeExitCode: 0,
    durationMs: 2500,
    triggerSource: 'scheduled',
    status: 'succeeded',
    correlationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    requestedModel: 'claude-sonnet-4-6',
    actualModel: 'claude-sonnet-4-6',
    sessionLogBytesAppended: 4096,
    sessionLogTrimmed: false
  };
}

function legacyRecord(): InvocationRecord {
  return {
    timestamp: '2026-05-16T01:00:00.000Z',
    platform: 'darwin',
    pid: 1111,
    lockAcquired: true,
    ephemeralCwd: '/tmp/schegent-primer-session/legacy',
    cwdInsideWorkspace: false,
    envScrubbed: true,
    claudeExitCode: 0,
    durationMs: 800
  };
}

// Path-shaped keys we MUST NOT include in the audit payload.
const FORBIDDEN_PATH_KEYS = [
  'path',
  'workspace',
  'workspaceRoot',
  'workspaceRoots',
  'sessionLogPath',
  'mirror',
  'mirrorPath',
  'cwd',
  'ephemeralCwd',
  'home',
  'homeDir',
  'roots',
  'paths'
];

describe('Feature 031 — wakeup-runner-invocation audit payload composer', () => {
  it('carries correlationId when present on the source record', () => {
    const audit = composeWakeupRunnerInvocationAudit(recordWithAllFields());
    expect(audit.correlationId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });

  it('carries requestedModel when present on the source record', () => {
    const audit = composeWakeupRunnerInvocationAudit(recordWithAllFields());
    expect(audit.requestedModel).toBe('claude-sonnet-4-6');
  });

  it('carries actualModel when present on the source record', () => {
    const audit = composeWakeupRunnerInvocationAudit(recordWithAllFields());
    expect(audit.actualModel).toBe('claude-sonnet-4-6');
  });

  it('omits the byte counters — sessionLogBytesAppended', () => {
    const audit = composeWakeupRunnerInvocationAudit(recordWithAllFields());
    expect(Object.prototype.hasOwnProperty.call(audit, 'sessionLogBytesAppended'))
      .toBe(false);
  });

  it('omits the retention marker — sessionLogTrimmed', () => {
    const audit = composeWakeupRunnerInvocationAudit(recordWithAllFields());
    expect(Object.prototype.hasOwnProperty.call(audit, 'sessionLogTrimmed'))
      .toBe(false);
  });

  it('omits every path-shaped key', () => {
    const audit = composeWakeupRunnerInvocationAudit(recordWithAllFields());
    const auditAsRecord = audit as unknown as Readonly<Record<string, unknown>>;
    for (const forbidden of FORBIDDEN_PATH_KEYS) {
      expect(
        Object.prototype.hasOwnProperty.call(auditAsRecord, forbidden),
        `audit payload should not contain key '${forbidden}'`
      ).toBe(false);
    }
  });

  it('tolerates a legacy record and omits the new fields when absent on source', () => {
    const audit = composeWakeupRunnerInvocationAudit(legacyRecord());
    expect(Object.prototype.hasOwnProperty.call(audit, 'correlationId')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(audit, 'requestedModel')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(audit, 'actualModel')).toBe(false);
  });

  it('preserves the fallback case: requestedModel != actualModel', () => {
    const rec: InvocationRecord = {
      ...legacyRecord(),
      correlationId: '11111111-2222-4333-8444-555555555555',
      requestedModel: 'claude-bogus-9000',
      actualModel: 'runner-default'
    };
    const audit = composeWakeupRunnerInvocationAudit(rec);
    expect(audit.requestedModel).toBe('claude-bogus-9000');
    expect(audit.actualModel).toBe('runner-default');
  });

  it('event type literal is wakeup-runner-invocation', () => {
    const audit = composeWakeupRunnerInvocationAudit(recordWithAllFields());
    expect(audit.eventType).toBe('wakeup-runner-invocation');
  });
});
