import { describe, expect, it } from 'vitest';
import {
  AUDIT_PAYLOAD_MAX_ARRAY_LENGTH,
  AUDIT_PAYLOAD_MAX_STRING_LENGTH,
  AUDIT_PAYLOAD_TRUNCATION_MARKER,
  PHASE_END_OUTCOMES,
  RECORDABLE_PHASE_END_WARNINGS,
  projectAuditPayload
} from '../../../src/audit/audit-payload';
import type { PhaseOutcome } from '../../../src/controller/phase';

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
      // FR-R3-086 follow-up (S12). The `best-effort` spelling of the two
      // missing-audit warnings above. Recordable for the same reason they are: a
      // warning this payload cannot name degrades to `omittedWarningCount`, and
      // "something was warned about" is exactly the record this round keeps
      // finding too weak to act on. The `none` policy emits nothing, so it adds
      // no member — an absence declared in advance is not an event.
      '[evidence] audit log absent on clean response, best-effort',
      '[evidence] audit log absent, best-effort',
      // FR-R3-080 (T1076). Five code-resident literals, one per evidence sink,
      // composed by `pathRefusedWarning` from a closed sink-name union — never
      // by splicing a path or an errno onto a prefix. Enumerated as a set rather
      // than added when each sink first refuses: discovering the gap from a
      // silent decline is the failure this item removes.
      'evidence-path-refused:audit',
      'evidence-path-refused:historyPointer',
      'evidence-path-refused:metricsRollup',
      'evidence-path-refused:rawTranscript',
      'evidence-path-refused:runtimeLog',
      // FR-R3-058 (M-07). A code-resident literal, like every member here.
      'host-verification-failed',
      'output-truncated-unclassifiable',
      // FR-R3-047 (H-04). A code-resident literal, like every member here.
      'stdin-delivery-failed'
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

describe('phase-end outcome vocabulary', () => {
  // This projection runs on the WRITE path (`audit-log-writer.ts`), so a value it does not
  // recognize is not merely displayed wrongly — it never reaches the log at all. The
  // allowlist held five members while the producers emitted eight, and the six-way
  // mismatch below is what put `outcome: malformed` on 7 of 11 phase-end records in the
  // workspace this was found in, including a phase that finished 109 of 109 tasks with
  // 398 unit tests passing.
  const producerVocabulary = [
    'clean',
    'issues_remain',
    'failed',
    'rate_limited',
    'timeout',
    'transient_error',
    'skipped',
    'paused-at-breakpoint',
    // Not a `PhaseOutcome` member: `phase-runner.ts` writes it directly on the
    // deadline-exceeded arm, so the projection has to carry it too.
    'deadline'
  ] as const;

  for (const outcome of producerVocabulary) {
    it(`records '${outcome}' as written`, () => {
      expect(projectAuditPayload('phase-end', {
        outcome,
        exitCode: 0,
        terminationReason: 'token'
      })).toMatchObject({ outcome });
    });
  }

  // Both are unreachable from any producer — `mapOutcome` never returns 'malformed', and
  // nothing anywhere emits the hyphenated spelling — but a log written before this change
  // is full of the first and may carry the second, and it still has to read.
  it('still accepts the legacy spellings on an existing log', () => {
    expect(projectAuditPayload('phase-end', {
      outcome: 'rate-limited',
      exitCode: null,
      terminationReason: 'rate_limit'
    })).toMatchObject({ outcome: 'rate-limited' });
    expect(projectAuditPayload('phase-end', {
      outcome: 'malformed',
      exitCode: 1,
      terminationReason: 'error'
    })).toMatchObject({ outcome: 'malformed' });
  });

  it('still resolves a genuinely foreign value to malformed', () => {
    expect(projectAuditPayload('phase-end', {
      outcome: 'nonsense-from-somewhere',
      exitCode: 0,
      terminationReason: 'token'
    })).toMatchObject({ outcome: 'malformed' });
    expect(projectAuditPayload('phase-end', {
      exitCode: 0,
      terminationReason: 'token'
    })).toMatchObject({ outcome: 'malformed' });
  });

  // `terminationReason` falls back to the outcome when the payload carries none, and the
  // fallback reads the RESOLVED value. A rate-limited phase with no reason recorded said
  // 'malformed' twice over.
  it('falls back to the resolved outcome for a missing termination reason', () => {
    expect(projectAuditPayload('phase-end', {
      outcome: 'rate_limited',
      exitCode: null
    })).toMatchObject({ outcome: 'rate_limited', terminationReason: 'rate_limited' });
  });

  // The audit vocabulary is deliberately a SUPERSET, not a copy: it carries `deadline` and
  // the two legacy spellings, none of which are `PhaseOutcome` members. What must never
  // recur is the other direction — a controller outcome the write path cannot record. This
  // is the gate that would have caught the original defect, and it is the reason the union
  // is not simply derived from `PhaseOutcome`.
  it('accepts every PhaseOutcome the controller can produce', () => {
    const controllerOutcomes: readonly PhaseOutcome[] = [
      'clean',
      'issues_remain',
      'failed',
      'rate_limited',
      'timeout',
      'transient_error',
      'skipped',
      'paused-at-breakpoint'
    ];
    for (const outcome of controllerOutcomes) {
      expect(PHASE_END_OUTCOMES).toContain(outcome);
    }
  });

  it('pins the recorded vocabulary', () => {
    expect([...PHASE_END_OUTCOMES].sort()).toEqual([
      'clean',
      'deadline',
      'failed',
      'issues_remain',
      'malformed',
      'paused-at-breakpoint',
      'rate-limited',
      'rate_limited',
      'skipped',
      'timeout',
      'transient_error'
    ]);
  });
});
