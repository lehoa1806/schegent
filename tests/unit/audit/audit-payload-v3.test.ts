import { describe, expect, it } from 'vitest';
import {
  AUDIT_PAYLOAD_MAX_ARRAY_LENGTH,
  AUDIT_PAYLOAD_MAX_STRING_LENGTH,
  AUDIT_PAYLOAD_TRUNCATION_MARKER,
  RECORDABLE_PHASE_END_WARNINGS,
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

  it('truncates oversized strings instead of dropping the entry', () => {
    // Refusing an over-long string discarded the whole record, so the only
    // `monitor-stdout-line` entries that survived were the short ones.
    const projected = projectAuditPayload('warning', {
      detail: 'x'.repeat(AUDIT_PAYLOAD_MAX_STRING_LENGTH + 500)
    }) as { detail: string };
    expect(projected.detail).toHaveLength(AUDIT_PAYLOAD_MAX_STRING_LENGTH);
    expect(projected.detail.endsWith(AUDIT_PAYLOAD_TRUNCATION_MARKER)).toBe(true);
  });

  it('leaves a string at exactly the bound unmarked', () => {
    const exact = 'x'.repeat(AUDIT_PAYLOAD_MAX_STRING_LENGTH);
    const projected = projectAuditPayload('warning', { detail: exact }) as { detail: string };
    expect(projected.detail).toBe(exact);
    expect(projected.detail.endsWith(AUDIT_PAYLOAD_TRUNCATION_MARKER)).toBe(false);
  });

  it('still refuses a path that survives truncation', () => {
    // The no-paths rule is tested against the bounded value, so shortening
    // must not become a way to smuggle one past the check.
    expect(() => projectAuditPayload('warning', {
      detail: `/Users/operator/secret.ts ${'x'.repeat(AUDIT_PAYLOAD_MAX_STRING_LENGTH)}`
    })).toThrowError(/path-or-endpoint-detected/);
  });

  it('rejects oversized arrays', () => {
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

describe('phase-end warning vocabulary', () => {
  // Pinned deliberately. Every member must be a code-resident literal with
  // no interpolated content; adding one that splices in model output, a CLI
  // message, or an operator-authored fatal signature is the failure this
  // set exists to prevent, and it would be invisible without this test.
  it('is the recorded closed set', () => {
    expect([...RECORDABLE_PHASE_END_WARNINGS].sort()).toEqual([
      '[constitution] missing audit log',
      '[constitution] missing audit log on clean response',
      '[constitution] multiple contract blocks',
      '[constitution] unterminated audit log',
      'output-truncated-unclassifiable'
    ]);
  });

  it('records a recognized code so the outcome explains itself', () => {
    const projected = projectAuditPayload('phase-end', {
      outcome: 'malformed',
      exitCode: 0,
      terminationReason: 'error',
      warnings: ['output-truncated-unclassifiable']
    });
    expect(projected).toMatchObject({ warnings: ['output-truncated-unclassifiable'] });
    expect(projected).not.toHaveProperty('omittedWarningCount');
  });

  it('counts an unrecognized warning instead of recording it', () => {
    // A matched fatal signature and a parser message carrying model output
    // are the two shapes that must never reach the log.
    const projected = projectAuditPayload('phase-end', {
      outcome: 'failed',
      exitCode: 1,
      terminationReason: 'error',
      warnings: [
        'error: unknown option',
        '[constitution] malformed audit field: files_created: /Users/me/secret',
        'output-truncated-unclassifiable'
      ]
    });
    expect(projected).toMatchObject({
      warnings: ['output-truncated-unclassifiable'],
      omittedWarningCount: 2
    });
    expect(JSON.stringify(projected)).not.toContain('error: unknown option');
    expect(JSON.stringify(projected)).not.toContain('/Users/me/secret');
  });

  it('omits both fields when there are no warnings', () => {
    const projected = projectAuditPayload('phase-end', {
      outcome: 'clean',
      exitCode: 0,
      terminationReason: 'token'
    });
    expect(projected).not.toHaveProperty('warnings');
    expect(projected).not.toHaveProperty('omittedWarningCount');
  });

  it('de-duplicates a repeated code without inflating the omitted count', () => {
    expect(projectAuditPayload('phase-end', {
      outcome: 'malformed',
      exitCode: 0,
      terminationReason: 'error',
      warnings: ['output-truncated-unclassifiable', 'output-truncated-unclassifiable']
    })).toMatchObject({ warnings: ['output-truncated-unclassifiable'] });
  });
});
