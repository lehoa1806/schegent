import { describe, expect, it } from 'vitest';
import {
  AUDIT_PAYLOAD_MAX_ARRAY_LENGTH,
  AUDIT_PAYLOAD_MAX_STRING_LENGTH,
  AUDIT_PAYLOAD_TRUNCATION_MARKER,
  CAP_EXHAUSTED_CAUSE,
  PHASE_END_OUTCOMES,
  PRE_SPAWN_REFUSAL_CAUSE,
  RECORDABLE_PHASE_END_WARNINGS,
  projectAuditPayload
} from '../../../src/audit/audit-payload';
import { AUDIT_SCHEMA_VERSION } from '../../../src/contracts/audit-events';
import { FAILURE_CAUSES } from '../../../src/contracts/failure-cause';
import type { PhaseOutcome } from '../../../src/controller/phase';
import { createStateTransitionAuditEnvelope } from '../../../src/lib/audit-event-envelope';

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

describe('phase-end payload.cause redaction (feature 194, FR-001–FR-004)', () => {
  // projectPhaseEnd() gates `cause` with `payload.cause === 'cap_exhausted' ?
  // 'cap_exhausted' : undefined` specifically so CLI-derived fatal-signature
  // text (the vocabulary's other, free-form member) never reaches the
  // persisted record — see that function's own docblock in
  // src/audit/audit-payload.ts. Every other `cause`-adjacent test in this
  // suite exercises the field being absent to begin with; this is the one
  // that proves a PRESENT, non-'cap_exhausted' value is actively stripped
  // rather than passed through.
  it('keeps the literal cap_exhausted cause', () => {
    expect(projectAuditPayload('phase-end', {
      outcome: 'failed',
      exitCode: null,
      terminationReason: 'cap-exhausted',
      cause: 'cap_exhausted'
    })).toMatchObject({ cause: 'cap_exhausted' });
  });

  it('strips a truthy, non-cap_exhausted cause (redacted fatal-signature text) instead of passing it through', () => {
    const projected = projectAuditPayload('phase-end', {
      outcome: 'failed',
      exitCode: 1,
      terminationReason: 'error',
      cause: 'operator-configured-fatal-signature: leaked secret pattern'
    });
    expect(projected).not.toHaveProperty('cause');
    expect(JSON.stringify(projected)).not.toContain('leaked secret pattern');
  });

  it('does not re-admit the stripped cause through terminationReason when the payload supplies none', () => {
    // The assertion above used to hold partly because its record supplied its
    // own `terminationReason`: the fallback chain read `payload.cause` raw, so
    // the text stripped from `cause` reappeared under `terminationReason` for
    // any payload that omitted it. Unreachable from the current emitters (all
    // of which write both fields together) and therefore easy to leave, but it
    // made the redaction conditional on the caller, and this function is the
    // last gate before disk. The chain now reads the PROJECTED value.
    const projected = projectAuditPayload('phase-end', {
      outcome: 'failed',
      exitCode: 1,
      cause: 'operator-configured-fatal-signature: leaked secret pattern'
    });
    expect(projected).not.toHaveProperty('cause');
    expect(JSON.stringify(projected)).not.toContain('leaked secret pattern');
    // Falls back to the outcome, as it does for any payload with no reason.
    expect(projected).toMatchObject({ terminationReason: 'failed' });
  });

  it('never spells a cap exhaustion into terminationReason (2026-09-04 review)', () => {
    // This test previously asserted `terminationReason: 'cap_exhausted'` here,
    // pinning a defect. `cause`'s literal is the UNDERSCORE form; the
    // `terminationReason` vocabulary spells the same classification
    // `cap-exhausted` (`phase-runner.ts`'s `appendCapExhaustedPhaseEnd()` writes
    // it). So the `?? cause` fallback arm could only ever put a second spelling
    // of one classification on the record, splitting the bucket for any consumer
    // grouping on it — and it was unreachable for every live emitter, all of
    // which write `terminationReason` unconditionally beside `cause`. The arm is
    // gone; a payload that states only a cause falls back to the outcome, which
    // is what the field already means when nothing stated a reason.
    const projected = projectAuditPayload('phase-end', {
      outcome: 'failed',
      exitCode: null,
      cause: 'cap_exhausted'
    });
    expect(projected).toMatchObject({ cause: 'cap_exhausted', terminationReason: 'failed' });
    // The load-bearing half: neither spelling arrives by way of the fallback.
    expect(projected).not.toMatchObject({ terminationReason: 'cap_exhausted' });
    expect(projected).not.toMatchObject({ terminationReason: 'cap-exhausted' });
  });

  it('keeps an explicit terminationReason beside the surviving cause', () => {
    // The pairing every live emitter writes: both fields, each in its own
    // vocabulary, neither derived from the other.
    expect(projectAuditPayload('phase-end', {
      outcome: 'failed',
      exitCode: null,
      cause: 'cap_exhausted',
      terminationReason: 'cap-exhausted'
    })).toMatchObject({ cause: 'cap_exhausted', terminationReason: 'cap-exhausted' });
  });

  // C1.1: "the exact literal `cap_exhausted`. Underscored." The gate is
  // `payload.cause === CAP_EXHAUSTED_CAUSE`, and the two tests above cannot
  // tell strict equality from a loosened one — their reject case fails any
  // plausible matcher. These pin the boundary, so a later
  // `String(payload.cause).trim().toLowerCase()`-style "robustness" edit fails
  // here instead of silently widening a vocabulary the contract closes.
  for (const near of ['CAP_EXHAUSTED', 'Cap_Exhausted', 'cap-exhausted', ' cap_exhausted', 'cap_exhausted ']) {
    it(`strips a near-miss cause ${JSON.stringify(near)} rather than normalising it`, () => {
      expect(projectAuditPayload('phase-end', {
        outcome: 'failed',
        exitCode: 1,
        terminationReason: 'error',
        cause: near
      })).not.toHaveProperty('cause');
    });
  }
});

describe('phase.retry_evaluated payload.stalled (feature 194, FR-006–FR-011)', () => {
  // `phase.retry_evaluated` has NO bespoke branch in projectAuditPayload, so
  // `stalled` reaches disk through the generic recursive projection — it
  // survives only because the name is absent from OMITTED_KEYS. Nothing else
  // pinned that: every other test in the feature asserts the RAW payload handed
  // to `auditWriter.append()`, upstream of this function, so adding `stalled`
  // to that set (it reads like a diagnostic, and the sibling `expression` on
  // this very event type IS in it) would strip the field from disk with the
  // whole feature still green. The same class of gap as the `cause` drop this
  // feature exists to fix, one event type over.
  it('survives the generic projection, while the sibling expression is stripped', () => {
    const projected = projectAuditPayload('phase.retry_evaluated', {
      expression: 'issues > 0',
      decision: true,
      stalled: 3
    });
    expect(projected).toMatchObject({ decision: true, stalled: 3 });
    // The second half of this test's own name (2026-09-04 review). It asserted
    // only the first: `toMatchObject` ignores unlisted keys, so the sibling it
    // exists to contrast against was never checked, and this test would have
    // passed just as green with the operator-authored expression on disk.
    // `expression` is in OMITTED_KEYS because it is operator-authored text that
    // AGENTS.md rule 15 keeps out of every sink; `stalled` is an integer this
    // code computed. Pinning the pair is what says the difference is deliberate.
    expect(projected).not.toHaveProperty('expression');
  });

  it('keeps an absent stalled absent — absence and zero mean different things (C2.1)', () => {
    const projected = projectAuditPayload('phase.retry_evaluated', {
      decision: true,
      missingKeys: ['issues']
    });
    expect(projected).not.toHaveProperty('stalled');
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
      // FR-R3-198 (T1877). Two code-resident literals, one per cause of an
      // unfinished turn, composed from a closed cause union, never from output.
      'incomplete-turn:background-work-open',
      'incomplete-turn:no-contract-block',
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
      'incomplete_turn',
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

// FR-R3-198 (T1877, M2) — an unfinished turn's `phase-end` names its outcome,
// its reason and its cause. The cause travels as a warning code, so the
// allowlist is what lets it reach the record.
describe('phase-end incomplete_turn FR-R3-198 (T1877)', () => {
  for (const cause of ['background-work-open', 'no-contract-block'] as const) {
    it(`keeps the outcome, the reason and incomplete-turn:${cause}`, () => {
      const projected = projectAuditPayload('phase-end', {
        outcome: 'incomplete_turn',
        exitCode: 143,
        terminationReason: 'incomplete_turn',
        warnings: [`incomplete-turn:${cause}`]
      });
      expect(projected).toMatchObject({
        outcome: 'incomplete_turn',
        terminationReason: 'incomplete_turn',
        warnings: [`incomplete-turn:${cause}`]
      });
      expect(projected).not.toHaveProperty('omittedWarningCount');
    });
  }
});

/**
 * Feature 212 (FR-002, FR-004, FR-005, FR-008, FR-009, FR-014) — the new facts
 * on a terminal record, asserted at the one layer that reaches disk.
 *
 * `project()` calls `projectAuditPayload` and reads the RETURNED record, never
 * the object handed to it. That is the whole point of the helper: a test that
 * inspects the payload it just built asserts what the emitter intended and would
 * still pass with the projection deleted. T013 deletes a line to prove these do
 * not. The template is `phase-end-verdict-basis.test.ts`.
 *
 * Absence is asserted with `'field' in record` rather than `toBeUndefined()`,
 * because the two are not the same claim: FR-014 says a missing field means
 * UNKNOWN permanently, and a field present with the value `undefined` is a
 * different record shape that `toBeUndefined()` would accept.
 */
describe('phase-end attempt pairing and envelope presence (feature 212)', () => {
  const project = (payload: Record<string, unknown>): Record<string, unknown> =>
    projectAuditPayload('phase-end', payload) as unknown as Record<string, unknown>;

  const ATTEMPT_ID = '3f2a5c18-9b47-4e60-a1d2-7c8e5f0b6d93';

  /**
   * An audit block that WAS parsed and reported nothing: four arrays, all empty.
   * This is the shape that separates FR-008 from FR-009 — the counts here are
   * measured zeros and must be recorded, while the same zeros derived from an
   * absent block must not be.
   */
  const parsedEmptyBlock = {
    files_created: [],
    files_modified: [],
    files_deleted: [],
    commands_executed: []
  };

  it('carries the attempt identifier (FR-002)', () => {
    expect(project({ outcome: 'failed', attemptId: ATTEMPT_ID }).attemptId).toBe(ATTEMPT_ID);
  });

  it('omits the attempt identifier rather than defaulting it when absent', () => {
    expect('attemptId' in project({ outcome: 'failed' })).toBe(false);
  });

  it('omits an attempt identifier that is not a bounded string', () => {
    expect('attemptId' in project({ outcome: 'failed', attemptId: 42 })).toBe(false);
    expect('attemptId' in project({ outcome: 'failed', attemptId: '' })).toBe(false);
    expect('attemptId' in project({ outcome: 'failed', attemptId: 'x'.repeat(65) })).toBe(false);
  });

  /**
   * `projectPhaseEnd` builds its result field by field, so the residual-string
   * pass that rejects paths elsewhere in the projection never sees this field.
   * A length bound alone would put any of these on disk (AGENTS.md rule 22);
   * the shape check is what keeps them off it.
   */
  it('omits an attempt identifier that is a well-formed string of the wrong shape', () => {
    const wrongShape = [
      '/Users/someone/workspace/schegent/.schegent/audit.log',
      'C:\\Users\\someone\\audit.log',
      'https://example.invalid/attempts/1',
      'attempt 3f2a5c18 failed while writing',
      `${ATTEMPT_ID} `,
      ATTEMPT_ID.replace(/-/g, '')
    ];
    for (const attemptId of wrongShape) {
      expect('attemptId' in project({ outcome: 'failed', attemptId })).toBe(false);
    }
  });

  it('carries a received result envelope (FR-005)', () => {
    expect(project({ outcome: 'failed', resultEnvelope: 'received' }).resultEnvelope).toBe('received');
  });

  it('carries an absent result envelope (FR-005)', () => {
    expect(project({ outcome: 'failed', resultEnvelope: 'absent' }).resultEnvelope).toBe('absent');
  });

  it('omits the envelope fact rather than defaulting it when unknown (FR-014)', () => {
    // The permanent reading, not a migration window. No reader may infer that a
    // record lacking this field had an envelope, so the projection must not
    // manufacture one either.
    //
    // Both forms, deliberately. The `in` check is the stronger one — it fails an
    // implementation that writes the key with an explicit `undefined`, which
    // serialises to a MISSING field in JSON but is a present key in memory, and
    // that difference decides whether a census sees two populations or three.
    // The value check is what a reader of the record actually performs.
    expect('resultEnvelope' in project({ outcome: 'failed' })).toBe(false);
    expect(project({ outcome: 'failed' }).resultEnvelope).toBeUndefined(); // 2026-09-13 deliberate: the projected phase-end record, the exact object written to audit.log
  });

  it('omits a value outside the closed two-member set', () => {
    expect('resultEnvelope' in project({ outcome: 'failed', resultEnvelope: 'maybe' })).toBe(false);
  });

  it('carries the pre-spawn refusal cause (FR-004)', () => {
    expect(project({ outcome: 'failed', cause: PRE_SPAWN_REFUSAL_CAUSE }).cause)
      .toBe(PRE_SPAWN_REFUSAL_CAUSE);
  });

  it('still carries the cap-exhausted cause', () => {
    // The widening added a member; it did not replace one. Feature 194's own
    // record depends on this value continuing to survive the projection.
    expect(project({ outcome: 'failed', cause: CAP_EXHAUSTED_CAUSE }).cause).toBe(CAP_EXHAUSTED_CAUSE);
  });

  it('omits a cause outside the vocabulary rather than passing it through', () => {
    // Hard rule 23. The match is by identity against the exported constants, so
    // redacted fatal-signature text cannot reach disk under this key.
    expect('cause' in project({ outcome: 'failed', cause: 'Error: /Users/someone/secret.ts:12' }))
      .toBe(false);
  });

  it('omits all three counts together when the audit block was not parsed (FR-009)', () => {
    // All three, not just the file half. `omittedToolEvidenceCount` is the
    // command count, and a zero there reads as "demonstrably ran no commands" —
    // the same false statement the file counts make.
    const record = project({ outcome: 'failed', terminationReason: 'deadline' });

    expect('fileChangeCounts' in record).toBe(false);
    expect('omittedFileEvidenceCount' in record).toBe(false);
    expect('omittedToolEvidenceCount' in record).toBe(false);

    // The `in` form above is the assertion that matters — it separates "absent"
    // from "present and undefined", and only the first is a record that says
    // nothing. These three say the weaker thing, and carry the dated note the
    // census asks for so a later reader knows which receiver was meant.
    expect(record.fileChangeCounts).toBeUndefined(); // 2026-09-13 deliberate: the projected phase-end record, the exact object written to audit.log
    expect(record.omittedFileEvidenceCount).toBeUndefined(); // 2026-09-13 deliberate: same record; a number here would be a count nobody took
    expect(record.omittedToolEvidenceCount).toBeUndefined(); // 2026-09-13 deliberate: same record; a number here would be a command count nobody took
  });

  it('records measured zeros when the audit block was parsed and empty (FR-008)', () => {
    // The contrast that makes the rule above meaningful rather than a blanket
    // ban on zero: here the phase demonstrably changed nothing, and that is a
    // finding worth recording.
    const record = project({ outcome: 'clean', ...parsedEmptyBlock });

    expect(record.fileChangeCounts).toEqual({ created: 0, modified: 0, deleted: 0 });
    expect(record.omittedFileEvidenceCount).toBe(0);
    expect(record.omittedToolEvidenceCount).toBe(0);

    // Stated as presence too, mirroring the FR-009 test above. The value
    // assertions already imply it — `undefined` is not `0` — but the pair reads
    // as one decision when both halves are phrased in the same terms.
    expect('fileChangeCounts' in record).toBe(true);
    expect('omittedFileEvidenceCount' in record).toBe(true);
    expect('omittedToolEvidenceCount' in record).toBe(true);
  });

  it('reads the shape the writer ACTUALLY emits as parsed (FR-008)', () => {
    // FR-R3-171 CLOSED THE OMISSION THIS BLOCK WAS WRITTEN AROUND.
    //
    // It used to read: no writer in this tree emits four keys, because
    // `PhaseRunner.auditEvidenceFields()` forwarded `files_created`,
    // `files_modified` and `commands_executed` and had never forwarded
    // `files_deleted`. That was true from before feature 212 until FR-R3-171,
    // and it made `deleted: 0` a structural artefact on every `phase-end` row
    // the product wrote — a count of a list nobody forwarded, indistinguishable
    // from a phase that looked and found nothing.
    //
    // The forward now carries all four, so this fixture is four-keyed and the
    // deletion count below is a real measurement. What has NOT changed is why
    // the block exists: it is the writer's shape, and it exists to fail when
    // the predicate stops admitting it. Tightening `auditBlockParsed` from
    // `.some()` to `.every()` — a reading the projection's own comment invites,
    // since it calls a parsed block one that "yields ARRAYS" — must still be
    // caught here.
    const record = project({
      outcome: 'deadline',
      terminationReason: 'deadline',
      files_created: ['specs/001-mock/spec.md'],
      files_modified: ['README.md'],
      files_deleted: ['specs/001-mock/stale-plan.md'],
      commands_executed: ['npm test']
    });

    expect('fileChangeCounts' in record).toBe(true);
    expect('omittedFileEvidenceCount' in record).toBe(true);
    expect('omittedToolEvidenceCount' in record).toBe(true);
    expect(record.fileChangeCounts).toEqual({ created: 1, modified: 1, deleted: 1 });

    // AND the partial shape, which is what now carries the `.every()` kill.
    //
    // Before FR-R3-171 the writer's own three-keyed payload was the counter-
    // example: `.every()` could not be satisfied in production, so tightening
    // the predicate stripped the counts from every row and this fixture caught
    // it. Now that the writer emits four, the fixture above satisfies `.every()`
    // too — so on its own it would let that mutant through, and the assertion
    // meant to pin the predicate would have quietly stopped pinning anything.
    //
    // The argument for `.some()` never rested on the writer's key count. It
    // rests on there being no middle state: a parsed block yields arrays and an
    // unparsed one yields none, so ANY array is sufficient evidence. A payload
    // carrying fewer than four — an older audit record, a hand-built one, any
    // future writer that forwards a subset — was read, and must keep its counts.
    const partial = project({
      outcome: 'deadline',
      terminationReason: 'deadline',
      files_created: ['specs/001-mock/spec.md']
    });

    expect('fileChangeCounts' in partial).toBe(true);
    expect(partial.fileChangeCounts).toEqual({ created: 1, modified: 0, deleted: 0 });
  });

  it('leaves toolCategoryCounts alone in both cases', () => {
    // An empty map, not a counted zero: `projectMetrics` of an absent value
    // returns `{}`, which claims nothing about how many tools ran.
    expect(project({ outcome: 'failed' }).toolCategoryCounts).toEqual({});
    expect(project({ outcome: 'clean', ...parsedEmptyBlock }).toolCategoryCounts).toEqual({});
  });

  it('does not bump AUDIT_SCHEMA_VERSION — every new field is additive', () => {
    // The 028 / 030 / 031 / 032 / FR-R3-117 precedent. New optional fields on an
    // existing event break no reader, and FR-009's omission is a narrowing of
    // what gets written rather than a shape a v3 reader cannot parse.
    expect(AUDIT_SCHEMA_VERSION).toBe(3);
  });
});

// FR-R4-F14 (spec 242, contract E3.2, FR-023) — `task-execution-ended` carries a `failureCause`, and the
// projection admits it by identity against the closed vocabulary. A value that is not a member is
// dropped as a field, never rewritten, and nothing a fatal signature or an agent wrote can reach disk
// through it. `phase-end` keeps its own two causes and is projected exactly as before (clarification Q1).
describe('task-execution-ended failureCause projection (FR-R4-F14)', () => {
  const ended = {
    taskId: 'task-1',
    runId: 'run-1',
    terminalStatus: 'failed',
    durationMs: 1234,
    phasesTotal: 3,
    phasesCompleted: 1,
    phasesSkipped: 0
  };

  it.each(FAILURE_CAUSES)('keeps the member %s', (cause) => {
    const projected = projectAuditPayload('task-execution-ended', { ...ended, failureCause: cause });
    expect(projected.failureCause).toBe(cause);
    const { failureCause: _kept, ...rest } = projected;
    expect(rest).toEqual(projectAuditPayload('task-execution-ended', ended));
  });

  it.each([
    ['a trailing space', 'cap_exhausted '],
    ['the wrong case', 'CAP_EXHAUSTED'],
    ['a phase-end cause', PRE_SPAWN_REFUSAL_CAUSE],
    ['a number', 42],
    ['null', null],
    ['an object', { cause: 'cap_exhausted' }]
  ])('drops %s and projects the rest as the generic projection does', (_name, value) => {
    const projected = projectAuditPayload('task-execution-ended', { ...ended, failureCause: value });
    expect('failureCause' in projected).toBe(false);
    expect(projected).toEqual(projectAuditPayload('task-execution-ended', ended));
  });

  it('drops a secret-bearing fatal signature and leaves the sentinel nowhere in the record (FR-023)', () => {
    const projected = projectAuditPayload('task-execution-ended', {
      ...ended,
      failureCause: 'fatal: token=sk-ant-SENTINEL'
    });
    expect('failureCause' in projected).toBe(false);
    expect(JSON.stringify(projected)).not.toContain('SENTINEL');
  });

  it('projects a payload written before the feature, with no key, as the generic projection does', () => {
    const projected = projectAuditPayload('task-execution-ended', ended);
    expect('failureCause' in projected).toBe(false);
    expect(projected).toEqual(ended);
  });

  it('keeps every other key byte-identical, and still drops lastErrorSummary', () => {
    const projected = projectAuditPayload('task-execution-ended', {
      ...ended,
      failureCause: 'phase_failed',
      lastErrorSummary: 'a message that must not reach disk'
    });
    expect(projected).toEqual({ ...ended, failureCause: 'phase_failed' });
  });

  it('does not let a failureCause key reach disk on a phase-end payload', () => {
    const phaseEnd = {
      outcome: 'failed',
      exitCode: 1,
      terminationReason: 'error',
      metrics: {},
      durationMs: 12
    };
    const projected = projectAuditPayload('phase-end', { ...phaseEnd, failureCause: 'cap_exhausted' });
    expect('failureCause' in projected).toBe(false);
    expect(projected).toEqual(projectAuditPayload('phase-end', phaseEnd));
  });
});

// FR-R4-F16 (spec 244, contract P3, P5.2, FR-003) — `task-removed` carries `completionProvenance`, and
// the projection admits it by identity in BOTH copies the handler writes: the payload's own key and
// `stateTransition.newState`. A value that is not a member is dropped as a field, never rewritten, and
// never costs the entry. Each copy is judged on its own value. Every other event type takes the arm it
// took before.
describe('task-removed completionProvenance projection (FR-R4-F16)', () => {
  const removed = {
    taskId: 'task-1',
    queueId: 'default',
    priorStatus: 'completed',
    runId: 'run-1',
    cause: 'operator',
    sessionCleaned: true,
    sessionCleanupRefusal: null
  };
  const NOW = new Date('2026-10-29T10:00:00.000Z');
  // Built from pieces so the secret scanner does not flag this file (standing rule 14).
  const SECRET_SENTINEL = ['sk', 'ant', 'api03', 'SENTINELSENTINELSENTINEL'].join('-');

  /** The payload as `appendQueueAudit` writes it: the fields, and the same fields again as `newState`. */
  function written(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const fields = { ...removed, ...extra };
    return {
      ...fields,
      stateTransition: createStateTransitionAuditEnvelope({
        correlationId: 'corr-1',
        reasonCode: 'task-removed',
        newState: fields,
        now: NOW
      })
    };
  }

  function newStateOf(projected: Record<string, unknown>): Record<string, unknown> {
    return (projected.stateTransition as { newState: Record<string, unknown> }).newState;
  }

  function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) deepFreeze(child);
      Object.freeze(value);
    }
    return value;
  }

  it.each([
    ['operator-attested', 'operator-attested'],
    ['null', null]
  ])('keeps %s in the payload and in newState', (_name, value) => {
    const projected = projectAuditPayload('task-removed', written({ completionProvenance: value }));
    expect(projected.completionProvenance).toBe(value);
    expect(newStateOf(projected).completionProvenance).toBe(value);
    expect(projected).toEqual(written({ completionProvenance: value }));
  });

  it.each([
    ['a member of no vocabulary', 'host-verified'],
    ['the wrong case', 'Operator-Attested'],
    ['a number', 1],
    ['an object', {}],
    ['a path-like string', '/Users/someone/.ssh/id_rsa'],
    ['a secret-shaped string', SECRET_SENTINEL]
  ])('drops %s from both copies and projects the rest as without the key', (_name, value) => {
    const projected = projectAuditPayload('task-removed', written({ completionProvenance: value }));
    expect('completionProvenance' in projected).toBe(false);
    expect('completionProvenance' in newStateOf(projected)).toBe(false);
    expect(projected).toEqual(projectAuditPayload('task-removed', written()));
    expect(JSON.stringify(projected)).not.toContain(SECRET_SENTINEL);
  });

  it('projects a payload with no key byte-identically to the generic projection', () => {
    const payload = written();
    const projected = projectAuditPayload('task-removed', payload);
    expect('completionProvenance' in projected).toBe(false);
    // `queue-deleted` has no arm of its own, so it is the generic projection of the same payload.
    expect(JSON.stringify(projected)).toBe(JSON.stringify(projectAuditPayload('queue-deleted', payload)));
  });

  it('judges each copy on its own value', () => {
    const top = projectAuditPayload(
      'task-removed',
      { ...written({ completionProvenance: 'host-verified' }), completionProvenance: 'operator-attested' }
    );
    expect(top.completionProvenance).toBe('operator-attested');
    expect('completionProvenance' in newStateOf(top)).toBe(false);

    const nested = projectAuditPayload('task-removed', {
      ...written({ completionProvenance: 'operator-attested' }),
      completionProvenance: 'host-verified'
    });
    expect('completionProvenance' in nested).toBe(false);
    expect(newStateOf(nested).completionProvenance).toBe('operator-attested');
  });

  it('keeps a top-level value when there is no stateTransition, and tolerates a null newState', () => {
    expect(projectAuditPayload('task-removed', { ...removed, completionProvenance: null })).toEqual({
      ...removed,
      completionProvenance: null
    });
    const nullState = {
      ...removed,
      completionProvenance: 'operator-attested',
      stateTransition: { reasonCode: 'task-removed', newState: null }
    };
    expect(projectAuditPayload('task-removed', nullState)).toEqual(nullState);
  });

  it('takes the key out before projecting, so a hostile string never refuses the entry', () => {
    expect(() =>
      projectAuditPayload('task-removed', written({ completionProvenance: 'C:\\Users\\someone\\secret.txt' }))
    ).not.toThrow();
  });

  it('leaves every other event type on the arm it took before', () => {
    // The generic arm validates nothing about the key; the guard belongs to `task-removed` alone.
    expect(projectAuditPayload('queue-deleted', { queueId: 'q', completionProvenance: 'host-verified' })).toEqual({
      queueId: 'q',
      completionProvenance: 'host-verified'
    });
    const phaseEnd = { outcome: 'failed', exitCode: 1, terminationReason: 'error', metrics: {}, durationMs: 12 };
    const projected = projectAuditPayload('phase-end', { ...phaseEnd, completionProvenance: 'operator-attested' });
    expect('completionProvenance' in projected).toBe(false);
    expect(projected).toEqual(projectAuditPayload('phase-end', phaseEnd));
  });

  it('never mutates the caller payload or its nested envelope', () => {
    const payload = deepFreeze(written({ completionProvenance: 'host-verified' }));
    const before = JSON.stringify(payload);
    expect(() => projectAuditPayload('task-removed', payload)).not.toThrow();
    expect(JSON.stringify(payload)).toBe(before);
  });

  it('does not bump AUDIT_SCHEMA_VERSION', () => {
    expect(AUDIT_SCHEMA_VERSION).toBe(3);
  });
});
