import { describe, expect, it } from 'vitest';
import {
  AUDIT_PAYLOAD_MAX_ARRAY_LENGTH,
  AUDIT_PAYLOAD_MAX_STRING_LENGTH,
  projectAuditPayload
} from '../../../src/audit/audit-payload';

describe('audit payload schema v3', () => {
  it('projects CLI invocations to bounded execution metadata', () => {
    expect(projectAuditPayload('cli-invocation', {
      runner: 'codex',
      operation: 'phase',
      command: '/usr/local/bin/codex exec --model secret',
      isContinue: true,
      sessionReuse: true,
      resumeSessionId: 'conversation-1',
      model: 'gpt-5.6',
      effort: 'high',
      diagnosticsEnabled: true
    })).toEqual({
      runner: 'codex',
      operation: 'phase',
      permissionMode: 'workspace-write',
      continued: true,
      sessionReused: true,
      modelId: 'gpt-5.6',
      effortId: 'high',
      diagnosticsEnabled: true
    });
  });

  it('turns model-reported file and command lists into counts only', () => {
    expect(projectAuditPayload('phase-end', {
      outcome: 'clean',
      exitCode: 0,
      terminationReason: 'token',
      files_created: ['/private/workspace/secret.ts'],
      files_modified: ['src/app.ts', 'src/api.ts'],
      files_deleted: [],
      commands_executed: ['npm test'],
      durationMs: 12,
      metrics: { checks_passing: 4 }
    })).toEqual({
      outcome: 'clean',
      exitCode: 0,
      terminationReason: 'token',
      metrics: { checks_passing: 4, durationMs: 12 },
      fileChangeCounts: { created: 1, modified: 2, deleted: 0 },
      toolCategoryCounts: {},
      omittedFileEvidenceCount: 3,
      omittedToolEvidenceCount: 1
    });
  });

  it('rejects path-bearing residual strings', () => {
    expect(() => projectAuditPayload('warning', {
      reasonCode: 'invalid-config',
      detail: '/Users/operator/private/project'
    })).toThrowError(/path-or-endpoint-detected/);
    expect(() => projectAuditPayload('cli-invocation', {
      runner: 'codex',
      operation: 'phase',
      modelId: '/Users/operator/private/model'
    })).toThrowError(/path-or-endpoint-detected/);
    expect(() => projectAuditPayload('phase-end', {
      outcome: 'failed',
      terminationReason: 'failure at /private/workspace/secret.ts'
    })).toThrowError(/path-or-endpoint-detected/);
  });

  it('rejects oversized strings and arrays', () => {
    expect(() => projectAuditPayload('warning', {
      detail: 'x'.repeat(AUDIT_PAYLOAD_MAX_STRING_LENGTH + 1)
    })).toThrowError(/string-too-long/);
    expect(() => projectAuditPayload('warning', {
      values: Array.from({ length: AUDIT_PAYLOAD_MAX_ARRAY_LENGTH + 1 }, () => true)
    })).toThrowError(/array-too-long/);
  });

  it('rejects non-finite numeric evidence', () => {
    expect(() => projectAuditPayload('phase-end', {
      outcome: 'clean',
      metrics: { cost: Number.POSITIVE_INFINITY }
    })).toThrowError(/invalid-metric-value/);
  });

  it('retains only the bounded ephemeral identifier for metrics adoption', () => {
    expect(projectAuditPayload('metrics-view-opened', {
      sessionId: 'metrics-session-123',
      workspaceRoot: '/private/workspace/secret'
    })).toEqual({ sessionId: 'metrics-session-123' });
  });
});
