import { describe, expect, it } from 'vitest';
import corpusJson from './fixtures/backend-outcomes.json';
import { parseAuditLogBlock } from '../../src/parser/audit-log-parser';
import { detectCreditError } from '../../src/parser/credit-error-detector';
import { parseInvocation, type InvocationResult } from '../../src/parser/stdout-parser';
import {
  failClosedOnTruncatedOutput,
  mapOutcome,
  mapTerminationReason
} from '../../src/controller/phase-outcome-mapper';
import {
  resolveSessionDispatch,
  type SessionDispatchInputs
} from '../../src/services/session-dispatch-policy';
import type { PhaseOutcome } from '../../src/controller/phase';
import type { TerminationReason } from '../../src/state/workflow-run';

type AuditFixture = 'valid' | 'missing-notes' | 'none';

interface EvalCase {
  readonly id: string;
  readonly description: string;
  readonly output: {
    readonly stdoutLines: readonly string[];
    readonly stderrLines: readonly string[];
    readonly exitCode: number | null;
    readonly auditBlock: AuditFixture;
    readonly truncated: boolean;
  };
  readonly session?: SessionDispatchInputs;
  readonly expected: {
    readonly parserKind: InvocationResult['kind'];
    readonly phaseOutcome: PhaseOutcome;
    readonly terminationReason: TerminationReason;
    readonly auditEntryPresent: boolean;
    readonly auditWarningIncludes?: string;
    readonly resultWarningIncludes?: string;
    readonly mayAdvance: boolean;
    readonly session?: ReturnType<typeof resolveSessionDispatch>;
  };
}

interface EvalCorpus {
  readonly schemaVersion: number;
  readonly cases: readonly EvalCase[];
}

const corpus = corpusJson as EvalCorpus;

function auditBlock(kind: AuditFixture): string {
  if (kind === 'none') return '';
  const lines = [
    '=== SCHEGENT AUDIT LOG ===',
    'phase: speckit-specify',
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: []',
    'network_calls: []',
    'ruleset_switches: []'
  ];
  if (kind === 'valid') lines.push('notes: deterministic evaluation fixture');
  lines.push('=== END AUDIT LOG ===');
  return lines.join('\n');
}

function evaluate(testCase: EvalCase): {
  readonly result: InvocationResult;
  readonly phaseOutcome: PhaseOutcome;
  readonly terminationReason: TerminationReason;
  readonly auditEntryPresent: boolean;
  readonly auditWarnings: readonly string[];
} {
  const stdout = [...testCase.output.stdoutLines, auditBlock(testCase.output.auditBlock)]
    .filter((line) => line.length > 0)
    .join('\n');
  const stderr = testCase.output.stderrLines.join('\n');
  const audit = parseAuditLogBlock(stdout);
  const parsed = parseInvocation({
    stdout,
    stderr,
    exitCode: testCase.output.exitCode,
    rateLimit: detectCreditError(stdout, stderr, testCase.output.exitCode),
    auditEntry: audit.entry,
    auditWarnings: audit.warnings
  });
  const result = failClosedOnTruncatedOutput(parsed, testCase.output.truncated);
  return {
    result,
    phaseOutcome: mapOutcome(result, testCase.output.exitCode),
    terminationReason: mapTerminationReason(result, testCase.output.exitCode),
    auditEntryPresent: audit.entry !== null,
    auditWarnings: audit.warnings
  };
}

describe('backend-neutral outcome evaluation corpus', () => {
  it('is versioned, uniquely keyed, and covers every required scenario', () => {
    expect(corpus.schemaVersion).toBe(1);
    const ids = corpus.cases.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'clean-completion',
      'clarification-loop',
      'remaining-issues',
      'malformed-audit-block',
      'fatal-signature',
      'rate-limit',
      'truncated-output',
      'session-continuation',
      'runner-switch'
    ]);
  });

  for (const testCase of corpus.cases) {
    it(`${testCase.id}: ${testCase.description}`, () => {
      const actual = evaluate(testCase);
      expect(actual.result.kind).toBe(testCase.expected.parserKind);
      expect(actual.phaseOutcome).toBe(testCase.expected.phaseOutcome);
      expect(actual.terminationReason).toBe(testCase.expected.terminationReason);
      expect(actual.auditEntryPresent).toBe(testCase.expected.auditEntryPresent);
      expect(actual.phaseOutcome === 'clean').toBe(testCase.expected.mayAdvance);

      if (testCase.expected.auditWarningIncludes) {
        expect(actual.auditWarnings.join('\n')).toContain(testCase.expected.auditWarningIncludes);
      }
      if (testCase.expected.resultWarningIncludes) {
        expect(actual.result.kind).toBe('malformed');
        if (actual.result.kind === 'malformed') {
          expect(actual.result.warnings).toContain(testCase.expected.resultWarningIncludes);
        }
      }
      if (testCase.session && testCase.expected.session) {
        expect(resolveSessionDispatch(testCase.session)).toEqual(testCase.expected.session);
      }
    });
  }
});
