/**
 * Feature 107 (FR-029..FR-032) — the warning channel.
 *
 * `warnings` existed on the `malformed` variant alone, so a `warnings.push` on
 * any path that resolved to `clean`, `remaining_issues`, or `open_questions`
 * built a string and threw it away. Three constitution warnings were
 * unreachable that way. A warning that is constructed and discarded is the same
 * defect as a gate that cannot fail, and this feature would have added four more
 * to the same dead array.
 *
 * These tests assert the parser *returns* the warnings. The companion suite,
 * `tests/unit/controller/warning-delivery.test.ts`, asserts they arrive in the
 * persisted audit entry — construction is not delivery.
 */
import { RECORDABLE_PHASE_END_WARNINGS } from '../../../src/audit/audit-payload';
import { describe, it, expect } from 'vitest';
import { parseAuditLogBlock } from '../../../src/parser/audit-log-parser';
import { parseInvocation, type InvocationResult, type ParseInputs } from '../../../src/parser/stdout-parser';
import {
  failClosedOnTruncatedOutput,
  OUTPUT_TRUNCATED_WARNING
} from '../../../src/controller/phase-outcome-mapper';

const OPEN = '=== SCHEGENT AUDIT LOG ===';
const CLOSE = '=== END AUDIT LOG ===';
const TOKEN = '[SCHEGENT_STATUS: CLEAR]';

function block(notes = 'work done'): string[] {
  return [
    OPEN,
    'phase: speckit-implement',
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: []',
    'network_calls: ["none"]',
    'ruleset_switches: ["none"]',
    `notes: ${notes}`,
    CLOSE
  ];
}

/** `rate_limited` is the one variant with no `warnings` field; it returns
 *  before detection runs, so it can never accumulate one. */
function warningsOf(result: InvocationResult): string[] | undefined {
  return 'warnings' in result ? result.warnings : undefined;
}

function parse(stdout: string, overrides: Partial<ParseInputs> = {}): InvocationResult {
  const audit = parseAuditLogBlock(stdout);
  return parseInvocation({
    stdout,
    stderr: '',
    exitCode: 0,
    rateLimit: { matched: false, cause: '' },
    auditEntry: audit.entry,
    auditWarnings: audit.warnings,
    region: audit.region,
    ...overrides
  });
}

describe('the three previously-discarded warnings are returned (FR-030)', () => {
  it('returns "missing audit log" on the no-contract-block path', () => {
    // stdout-parser.ts, the blocksPresent === 0 branch. Returned
    // `remaining_issues`, which had no `warnings` field, so this push was dead.
    const result = parse('the model said nothing structured');

    expect(result.kind).toBe('remaining_issues');
    expect(warningsOf(result)).toContain('[constitution] missing audit log');
  });

  it('returns "multiple contract blocks" when a token and an issues list both appear', () => {
    const stdout = [...block(), TOKEN, 'Remaining issues:', '- [build] one thing'].join('\n');
    const result = parse(stdout);

    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).toContain('[constitution] multiple contract blocks');
  });

  it('returns "missing audit log on clean response" when a token arrives with no block', () => {
    const result = parse(TOKEN);

    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).toContain('[constitution] missing audit log on clean response');
  });
});

describe('audit-parser warnings survive a non-malformed outcome (FR-030)', () => {
  it('carries the multiplicity warning onto a clean result', () => {
    const stdout = [...block('first'), ...block('second'), TOKEN].join('\n');
    const result = parse(stdout);

    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).toContainEqual(expect.stringContaining('multiple audit blocks'));
  });

  it('carries a missing-fields warning onto a clean result', () => {
    const stdout = [OPEN, 'phase: speckit-implement', CLOSE, TOKEN].join('\n');
    const result = parse(stdout);

    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).toContainEqual(expect.stringContaining('audit missing fields'));
  });
});

describe('every non-rate-limited variant carries the field (FR-029)', () => {
  const cases: Array<[string, string, Partial<ParseInputs>]> = [
    ['clean', [...block(), TOKEN].join('\n'), {}],
    ['remaining_issues', 'nothing structured', {}],
    [
      'open_questions',
      [...block(), 'Open questions:', '- which branch?'].join('\n'),
      {}
    ],
    ['transient_error', 'the run failed', { exitCode: 1 }]
  ];

  for (const [kind, stdout, overrides] of cases) {
    it(`returns an array on the ${kind} path`, () => {
      const result = parse(stdout, overrides);

      expect(result.kind).toBe(kind);
      expect(Array.isArray(warningsOf(result))).toBe(true);
    });
  }

  it('reports an out-of-region token on the transient_error path', () => {
    // The highest-value case in the feature: a failing run whose output claims
    // success. Before FR-029 this variant had nowhere to put the finding.
    const stdout = [`I am done: ${TOKEN}`, ...block()].join('\n');
    const result = parse(stdout, { exitCode: 1 });

    expect(result.kind).toBe('transient_error');
    expect(warningsOf(result)).toContainEqual(
      expect.stringContaining('termination token outside audit region')
    );
  });
});

describe('failClosedOnTruncatedOutput preserves warnings (FR-032)', () => {
  it('carries a clean result\'s warnings through the truncation rewrite', () => {
    // The read here was `kind === 'malformed' ? result.warnings : []`, which was
    // exhaustive when only that variant had the field and lossy afterwards.
    const clean = parse([...block(), '```', TOKEN, '```'].join('\n'));
    const rewritten = failClosedOnTruncatedOutput(clean, true);

    expect(rewritten.kind).toBe('malformed');
    expect(warningsOf(rewritten)).toContainEqual(expect.stringContaining('code fence'));
    expect(warningsOf(rewritten)).toContain(OUTPUT_TRUNCATED_WARNING);
  });

  it('carries a transient_error\'s warnings through the truncation rewrite', () => {
    const failing = parse([TOKEN, ...block()].join('\n'), { exitCode: 1 });
    const rewritten = failClosedOnTruncatedOutput(failing, true);

    expect(warningsOf(rewritten)).toContainEqual(
      expect.stringContaining('termination token outside audit region')
    );
    expect(warningsOf(rewritten)).toContain(OUTPUT_TRUNCATED_WARNING);
  });

  it('still returns the result untouched when nothing was truncated', () => {
    const clean = parse([...block(), TOKEN].join('\n'));

    expect(failClosedOnTruncatedOutput(clean, false)).toBe(clean);
  });

  it('does not duplicate the truncation warning on a repeated rewrite', () => {
    const once = failClosedOnTruncatedOutput(parse('nothing'), true);
    const twice = failClosedOnTruncatedOutput(once, true);

    expect(warningsOf(twice)?.filter((w) => w === OUTPUT_TRUNCATED_WARNING)).toHaveLength(1);
  });
});

// FR-R3-086 follow-up (S12) — `evidencePolicy`'s first reader.
//
// The field was validated, persisted, frozen into the plan snapshot, carried
// through the portable exchange format and projected to the UI, and NO code path
// branched on it: all three settings classified a Phase identically. That is what
// `tests/lint/authored-fields-have-readers.test.ts` was built to catch, and what
// it caught.
//
// WHAT IT CAN AND CANNOT DO, and the limit is a fact about the data rather than a
// design preference. `pipeline-snapshot.ts` has always resolved omission to
// `'required'`, so that value is already written into every snapshot ever taken.
// Giving `'required'` teeth would retroactively tighten all of them, including
// runs mid-flight. So the field RELAXES from the default and never tightens: it
// governs how the absence of an audit block is REPORTED, and every branch still
// advances exactly as it did before.
describe('evidencePolicy governs how a missing audit block is reported (S12)', () => {
  const MISSING_ON_CLEAN = '[constitution] missing audit log on clean response';
  const RELAXED_ON_CLEAN = '[evidence] audit log absent on clean response, best-effort';

  it('required — the default, and today’s behaviour unchanged', () => {
    // Asserted against BOTH spellings of the default: an explicit `required` and
    // an omitted field. A change that moved only one of them would be a change to
    // every already-persisted snapshot, and this is what would notice.
    for (const overrides of [{ evidencePolicy: 'required' as const }, {}]) {
      const result = parse(TOKEN, overrides);
      expect(result.kind).toBe('clean');
      expect(warningsOf(result)).toContain(MISSING_ON_CLEAN);
    }
  });

  it('best-effort — recorded as an expectation unmet, not a rule broken', () => {
    const result = parse(TOKEN, { evidencePolicy: 'best-effort' });
    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).toContain(RELAXED_ON_CLEAN);
    expect(warningsOf(result)).not.toContain(MISSING_ON_CLEAN);
  });

  it('none — the Phase declares it produces no audit block, so absence is not news', () => {
    const result = parse(TOKEN, { evidencePolicy: 'none' });
    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).not.toContain(MISSING_ON_CLEAN);
    expect(warningsOf(result)).not.toContain(RELAXED_ON_CLEAN);
  });

  it('advances identically under all three, which is the whole safety property', () => {
    // The field must not change what follows from the absence, only what is said
    // about it. If this ever diverges, a persisted `required` has gained teeth.
    const kinds = (['required', 'best-effort', 'none'] as const).map(
      (evidencePolicy) => parse(TOKEN, { evidencePolicy }).kind
    );
    expect(new Set(kinds).size).toBe(1);
    expect(kinds[0]).toBe('clean');
  });

  it('reports the no-contract-block path at the same three volumes', () => {
    const noBlock = 'the model said nothing structured';
    expect(warningsOf(parse(noBlock, { evidencePolicy: 'required' }))).toContain(
      '[constitution] missing audit log'
    );
    expect(warningsOf(parse(noBlock, { evidencePolicy: 'best-effort' }))).toContain(
      '[evidence] audit log absent, best-effort'
    );
    expect(warningsOf(parse(noBlock, { evidencePolicy: 'none' }))).not.toContain(
      '[constitution] missing audit log'
    );
  });

  it('every warning it can emit is recordable in the audit payload', () => {
    // A warning the payload cannot name degrades to `omittedWarningCount`, and
    // "something was warned about" is precisely the record this round keeps
    // finding too weak to act on.
    for (const warning of [
      MISSING_ON_CLEAN,
      RELAXED_ON_CLEAN,
      '[constitution] missing audit log',
      '[evidence] audit log absent, best-effort'
    ]) {
      expect(RECORDABLE_PHASE_END_WARNINGS.has(warning), warning).toBe(true);
    }
  });
});
