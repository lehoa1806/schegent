// Feature 010 — fixture payloads used by the retry-condition integration
// test (T025) and any other consumer that wants canned SCHEGENT AUDIT LOG
// blocks with varying metric shapes. FR-016: no live LLM is invoked in the
// test suite — every scenario here is a hand-rolled deterministic string.

export interface AuditLogFixture {
  readonly name: string;
  readonly description: string;
  readonly stdout: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

function block(phase: string, body: readonly string[]): string {
  return [
    '=== SCHEGENT AUDIT LOG ===',
    `phase: ${phase}`,
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: ["audit"]',
    'network_calls: ["none"]',
    'ruleset_switches: ["none"]',
    'notes: ok',
    ...body,
    '=== END AUDIT LOG ==='
  ].join('\n');
}

export const FIXTURE_CLEAN_CLEAR_WITH_METRICS: AuditLogFixture = {
  name: 'clean+CLEAR+metrics',
  description:
    'Successful invocation: CLEAR token present, audit block carries finite-integer metrics. Expected outcome: clean.',
  stdout: ['[SCHEGENT_STATUS: CLEAR]', block('security-audit', ['open_questions: 0', 'resolved_questions: 3'])].join(
    '\n'
  ),
  exitCode: 0
};

export const FIXTURE_OPEN_QUESTIONS_WITH_METRICS: AuditLogFixture = {
  name: 'open-questions+metrics',
  description:
    'Open Questions block + non-zero open_questions metric. Drives loop semantics under retryCondition `open_questions > 0`.',
  stdout: [
    'Open questions:',
    '- still need decision on credential storage',
    block('security-audit', ['open_questions: 2', 'resolved_questions: 1'])
  ].join('\n'),
  exitCode: 0
};

export const FIXTURE_REMAINING_ISSUES_WITH_METRICS: AuditLogFixture = {
  name: 'remaining-issues+metrics',
  description:
    'Remaining issues block + non-zero issues_remaining metric. Drives loop for analyze-style phases.',
  stdout: [
    'Remaining issues:',
    '- CRITICAL: undefined symbol',
    block('analyze-deep', ['open_questions: 0', 'issues_remaining: 4'])
  ].join('\n'),
  exitCode: 0
};

export const FIXTURE_MISSING_METRIC: AuditLogFixture = {
  name: 'missing-metric',
  description:
    'CLEAR token present, audit block has no metric lines. Tests FR-012 (missing identifier → 0, advance, warning).',
  stdout: ['[SCHEGENT_STATUS: CLEAR]', block('security-audit', [])].join('\n'),
  exitCode: 0
};

export const FIXTURE_RESERVED_KEY_COLLISION: AuditLogFixture = {
  name: 'reserved-key-collision',
  description:
    'Operator emitted a reserved key (`status: 42`) alongside a real metric. Reserved key dropped with a one-shot warning; the rest of the metrics survive.',
  stdout: [
    '[SCHEGENT_STATUS: CLEAR]',
    block('security-audit', ['status: 42', 'open_questions: 1'])
  ].join('\n'),
  exitCode: 0
};

export const FIXTURE_NON_FINITE_VALUE: AuditLogFixture = {
  name: 'non-finite-value',
  description:
    'NaN / Infinity / -Infinity tokens. Dropped with a one-shot warning; finite siblings survive (FR-007).',
  stdout: [
    '[SCHEGENT_STATUS: CLEAR]',
    block('security-audit', ['nan_metric: NaN', 'inf_metric: Infinity', 'real: 4'])
  ].join('\n'),
  exitCode: 0
};

export const FIXTURE_NON_NUMERIC_VALUE: AuditLogFixture = {
  name: 'non-numeric-value',
  description:
    'String value for a metric line. Dropped with a one-shot warning; numeric siblings survive.',
  stdout: ['[SCHEGENT_STATUS: CLEAR]', block('security-audit', ['real: 5', 'word: many'])].join('\n'),
  exitCode: 0
};

export const FIXTURE_LAST_OCCURRENCE_WINS: AuditLogFixture = {
  name: 'last-occurrence-wins',
  description:
    'Repeated key. Last occurrence wins; earlier values are silently overwritten (FR-007).',
  stdout: [
    '[SCHEGENT_STATUS: CLEAR]',
    block('security-audit', ['open_questions: 1', 'open_questions: 0'])
  ].join('\n'),
  exitCode: 0
};

export const AUDIT_METRIC_FIXTURES: ReadonlyArray<AuditLogFixture> = Object.freeze([
  FIXTURE_CLEAN_CLEAR_WITH_METRICS,
  FIXTURE_OPEN_QUESTIONS_WITH_METRICS,
  FIXTURE_REMAINING_ISSUES_WITH_METRICS,
  FIXTURE_MISSING_METRIC,
  FIXTURE_RESERVED_KEY_COLLISION,
  FIXTURE_NON_FINITE_VALUE,
  FIXTURE_NON_NUMERIC_VALUE,
  FIXTURE_LAST_OCCURRENCE_WINS
]);
