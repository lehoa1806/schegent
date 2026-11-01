/**
 * FR-R4-F12 (FR-R4-004 / S-05; contract CP2 to CP4, CP8, CP9; SC-001; tests-and-gates T1) -- a
 * completion token with no complete audit block before it never advances a Phase.
 *
 * WHY IT EXISTS. Before this feature the parser, finding no trailing region, fell back to a
 * whole-stdout scan and accepted a token printed anywhere, labelling the acceptance as degraded.
 * A model that merely quoted the token mid-prose, or echoed it from a file it read, advanced the
 * Phase. These tests put a well-formed token where the host must refuse it and assert the turn is
 * not clean, then check every precedence arm still reaches the outcome it reached before.
 *
 * THE ORACLE. A "token removed" parse of the same output. A no-region token must leave the
 * outcome exactly where the output would have landed had the token never been printed, with the
 * host issue naming why the token was ignored in place of `no contract block detected`.
 *
 * THE ONE EXCEPTION kept (FR-003). A Phase whose author declared `best-effort` or `none` may
 * complete on the last non-empty line, labelled as a degraded read.
 *
 * Fixtures are synthetic. No warning asserted here contains a byte of model text (FR-008).
 */
import { describe, it, expect } from 'vitest';
import { parseAuditLogBlock } from '../../../src/parser/audit-log-parser';
import { parseInvocation, type InvocationResult, type ParseInputs } from '../../../src/parser/stdout-parser';
import { failClosedOnTruncatedOutput, mapOutcome } from '../../../src/controller/phase-outcome-mapper';
import { containsTerminationToken } from '../../../src/contracts/phase-output-contract';

const OPEN = '=== SCHEGENT AUDIT LOG ===';
const CLOSE = '=== END AUDIT LOG ===';
const TOKEN = '[SCHEGENT_STATUS: CLEAR]';

const W_DEGRADED = '[constitution] token accepted without audit block';
const W_NOREGION_PREFIX = '[constitution] termination token without audit block, not accepted';
const W_OUTSIDE_PREFIX = '[constitution] termination token outside audit region';
const NO_BLOCK_ISSUE = 'no contract block detected';
const NOREGION_ISSUE =
  'a completion token was printed without a complete audit block before it; print the audit block, then the token as the last line';
const SETTLED = { killed: false, completedAwaitingExit: true } as const;

interface PolicyShape {
  readonly name: string;
  readonly inputs: Pick<ParseInputs, 'evidencePolicy' | 'evidencePolicyDeclaredAt'>;
  readonly relaxed: boolean;
}

/** TA14: the six policy shapes, named once. */
const SHAPES: readonly PolicyShape[] = [
  { name: 'evidencePolicy absent', inputs: {}, relaxed: false },
  { name: 'required, origin absent', inputs: { evidencePolicy: 'required' }, relaxed: false },
  {
    name: 'required, origin default',
    inputs: { evidencePolicy: 'required', evidencePolicyDeclaredAt: 'default' },
    relaxed: false
  },
  {
    name: 'required, origin phase-definition',
    inputs: { evidencePolicy: 'required', evidencePolicyDeclaredAt: 'phase-definition' },
    relaxed: false
  },
  { name: 'best-effort', inputs: { evidencePolicy: 'best-effort' }, relaxed: true },
  { name: 'none', inputs: { evidencePolicy: 'none' }, relaxed: true }
];
const NOT_RELAXED = SHAPES.filter((shape) => !shape.relaxed);
const RELAXED = SHAPES.filter((shape) => shape.relaxed);
const DEFAULTED = SHAPES.slice(0, 3);

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

/** Mirrors the production call site: both control reads consume one string. */
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

function warningsOf(result: InvocationResult): string[] {
  return 'warnings' in result && result.warnings ? result.warnings : [];
}

function issuesOf(result: InvocationResult): ReadonlyArray<{ tag?: string; summary: string; source?: string }> | undefined {
  return 'issues' in result ? result.issues : undefined;
}

function questionsOf(result: InvocationResult): readonly string[] | undefined {
  return 'questions' in result ? result.questions : undefined;
}

/** The output with every line that carries a token removed. */
function withoutTokenLines(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .filter((line) => !containsTerminationToken(line))
    .join('\n');
}

/** What the token-removed parse would have said, with the FR-002 issue swapped in. */
function projectOracle(result: InvocationResult, ignoredIssue: string) {
  const issues = issuesOf(result);
  return {
    kind: result.kind,
    issues:
      issues === undefined
        ? undefined
        : issues.map((issue) =>
            issue.summary === NO_BLOCK_ISSUE ? { ...issue, summary: ignoredIssue } : issue
          ),
    questions: questionsOf(result),
    cause: 'cause' in result ? result.cause : undefined
  };
}

function project(result: InvocationResult) {
  return {
    kind: result.kind,
    issues: issuesOf(result),
    questions: questionsOf(result),
    cause: 'cause' in result ? result.cause : undefined
  };
}

const MID_PROSE = [
  'I reviewed the change.',
  `The completion line will read ${TOKEN} once everything is done.`,
  'Still working through the remaining items.'
].join('\n');

describe('FR-R4-004 / S-05 -- the SC-001 matrix: a no-block mid-prose token is never clean', () => {
  const cells: Array<{ shape: PolicyShape; exitCode: number; settled: boolean }> = [];
  for (const shape of SHAPES) {
    for (const exitCode of [0, 1]) {
      for (const settled of [false, true]) cells.push({ shape, exitCode, settled });
    }
  }

  it('covers 24 cells: 6 policy shapes x 2 exits x settled and unsettled', () => {
    expect(cells).toHaveLength(24);
  });

  it.each(cells)('$shape.name, exit $exitCode, settled $settled: not clean', ({ shape, exitCode, settled }) => {
    const overrides: Partial<ParseInputs> = {
      ...shape.inputs,
      exitCode,
      ...(settled ? { turnEnd: SETTLED } : {})
    };

    const result = parse(MID_PROSE, overrides);

    expect(result.kind).not.toBe('clean');
    expect(mapOutcome(result, exitCode)).not.toBe('clean');
  });

  it.each(cells)(
    'oracle -- $shape.name, exit $exitCode, settled $settled: equals the token-removed parse',
    ({ shape, exitCode, settled }) => {
      const overrides: Partial<ParseInputs> = {
        ...shape.inputs,
        exitCode,
        ...(settled ? { turnEnd: SETTLED } : {})
      };

      const actual = project(parse(MID_PROSE, overrides));
      const expected = projectOracle(parse(withoutTokenLines(MID_PROSE), overrides), NOREGION_ISSUE);

      expect(actual).toEqual(expected);
    }
  );
});

describe('FR-R4-004 / S-05 -- W-NOREGION is exact, and the degraded label is absent (CP3)', () => {
  const ONE_TOKEN = ['intro line', 'a second line', `printed early ${TOKEN} here`, 'a closing line'].join('\n');
  const TWO_TOKENS = ['intro line', `first ${TOKEN}`, 'middle line', `second ${TOKEN}`].join('\n');

  it.each(NOT_RELAXED)('$name: one token reports one occurrence at line 3', (shape) => {
    const warnings = warningsOf(parse(ONE_TOKEN, shape.inputs));

    expect(warnings).toContain(`${W_NOREGION_PREFIX} (1 occurrence, first at line 3)`);
    expect(warnings).not.toContain(W_DEGRADED);
  });

  it.each(NOT_RELAXED)('$name: two tokens report two occurrences, first at line 2', (shape) => {
    const warnings = warningsOf(parse(TWO_TOKENS, shape.inputs));

    expect(warnings).toContain(`${W_NOREGION_PREFIX} (2 occurrences, first at line 2)`);
    expect(warnings).not.toContain(W_DEGRADED);
  });

  it.each(RELAXED)('$name: a non-final token reports W-NOREGION and is not accepted', (shape) => {
    const result = parse(ONE_TOKEN, shape.inputs);

    expect(result.kind).toBe('remaining_issues');
    expect(warningsOf(result)).toContain(`${W_NOREGION_PREFIX} (1 occurrence, first at line 3)`);
    expect(warningsOf(result)).not.toContain(W_DEGRADED);
  });

  it('the warning holds counts and line numbers only, never a byte of the line (FR-008)', () => {
    const stdout = ['intro', 'SECRET-CANARY-7731 [SCHEGENT_STATUS: CLEAR] SECRET-CANARY-7731'].join('\n');

    const warnings = warningsOf(parse(stdout));

    expect(warnings.some((warning) => warning.includes('SECRET-CANARY-7731'))).toBe(false);
    expect(warnings.some((warning) => warning.startsWith(W_NOREGION_PREFIX))).toBe(true);
  });
});

describe('FR-R4-004 / S-05 -- the final-line fallback belongs to the relaxed policies only (FR-003, CP4)', () => {
  const FINAL_LINE = ['working notes', 'a summary line', TOKEN, '', '   ', ''].join('\n');
  const EARLIER_AND_FINAL = [`earlier mention ${TOKEN}`, 'a middle line', TOKEN].join('\n');

  it.each(RELAXED)('$name: a token on the final non-empty line is clean and labelled degraded', (shape) => {
    const result = parse(FINAL_LINE, shape.inputs);

    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).toContain(W_DEGRADED);
    expect(warningsOf(result).some((warning) => warning.startsWith(W_NOREGION_PREFIX))).toBe(false);
  });

  it.each(NOT_RELAXED)('$name: the same output is not clean and reports W-NOREGION', (shape) => {
    const result = parse(FINAL_LINE, shape.inputs);

    expect(result.kind).toBe('remaining_issues');
    expect(mapOutcome(result, 0)).toBe('issues_remain');
    expect(warningsOf(result)).toContain(`${W_NOREGION_PREFIX} (1 occurrence, first at line 3)`);
    expect(warningsOf(result)).not.toContain(W_DEGRADED);
  });

  it.each(RELAXED)('$name: an earlier token beside a final one is reported, and only the earlier one', (shape) => {
    const result = parse(EARLIER_AND_FINAL, shape.inputs);

    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).toContain(W_DEGRADED);
    expect(warningsOf(result)).toContain(`${W_NOREGION_PREFIX} (1 occurrence, first at line 1)`);
  });
});

describe('FR-R4-004 / S-05 -- the trailing region is unchanged (CP2)', () => {
  it('a block then a token on its own line is clean', () => {
    const result = parse([...block(), TOKEN].join('\n'));

    expect(result.kind).toBe('clean');
    expect(warningsOf(result).some((warning) => warning.startsWith(W_NOREGION_PREFIX))).toBe(false);
  });

  it('a token appended to the close-marker line is clean', () => {
    const lines = block();
    lines[lines.length - 1] = `${CLOSE} ${TOKEN}`;

    expect(parse(lines.join('\n')).kind).toBe('clean');
  });

  it('a token after an earlier complete block only is outside the region, warned and not clean', () => {
    const result = parse([...block('first'), TOKEN, ...block('second')].join('\n'));

    expect(result.kind).toBe('remaining_issues');
    expect(warningsOf(result).some((warning) => warning.startsWith(W_OUTSIDE_PREFIX))).toBe(true);
  });

  it('a token inside the block body only is outside the region, warned and not clean', () => {
    const result = parse(block(`done ${TOKEN}`).join('\n'));

    expect(result.kind).toBe('remaining_issues');
    expect(warningsOf(result).some((warning) => warning.startsWith(W_OUTSIDE_PREFIX))).toBe(true);
  });

  it('a fenced token in the region warns and is clean', () => {
    const result = parse([...block(), '```', TOKEN, '```'].join('\n'));

    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).toContainEqual(
      expect.stringContaining('termination token inside a code fence')
    );
  });

  it('a region token beside a Remaining issues block warns and is clean', () => {
    const result = parse([...block(), 'Remaining issues:', '- [tests] one failing', TOKEN].join('\n'));

    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).toContain('[constitution] multiple contract blocks');
  });
});

describe('FR-R4-004 / S-05 -- shapes with no region (CP3, scenario 5)', () => {
  const UNTERMINATED = [OPEN, 'phase: speckit-implement', 'notes: cut off', TOKEN].join('\n');
  const CLOSE_ONLY = ['some earlier output', CLOSE, TOKEN].join('\n');

  it.each(DEFAULTED.flatMap((shape) => [
    { shape, label: 'an unterminated block then a token', stdout: UNTERMINATED },
    { shape, label: 'a close marker with no opener then a token', stdout: CLOSE_ONLY }
  ]))('$shape.name, $label: not clean, W-NOREGION reported', ({ shape, stdout }) => {
    const result = parse(stdout, shape.inputs);

    expect(result.kind).not.toBe('clean');
    expect(warningsOf(result).some((warning) => warning.startsWith(W_NOREGION_PREFIX))).toBe(true);
  });
});

describe('FR-R4-004 / S-05 -- exit status and settled turns (scenarios 7 and 8)', () => {
  it.each(SHAPES)('$name: exit 1 with a mid-prose token is transient_error (scenario 7)', (shape) => {
    const result = parse(MID_PROSE, { ...shape.inputs, exitCode: 1 });

    expect(result).toMatchObject({ kind: 'transient_error', exitCode: 1 });
  });

  it.each(SHAPES)(
    '$name: a settled turn whose only signal is a mid-prose token is incomplete_turn (scenario 8)',
    (shape) => {
      const result = parse(MID_PROSE, { ...shape.inputs, exitCode: 143, turnEnd: SETTLED });

      expect(result).toMatchObject({ kind: 'incomplete_turn', cause: 'no-contract-block' });
      expect(mapOutcome(result, 143)).toBe('incomplete_turn');
    }
  );
});

describe('FR-R4-004 / S-05 -- every precedence arm keeps its outcome (CP9, scenario 9, parser half)', () => {
  const REGION_STREAM = [...block(), TOKEN].join('\n');
  const FATAL = 'Autocompact is thrashing';

  interface Arm {
    readonly name: string;
    readonly overrides: Partial<ParseInputs>;
    readonly prefix?: string;
    readonly expectedKind: string;
  }
  const ARMS: readonly Arm[] = [
    { name: 'fatal signature', overrides: {}, prefix: FATAL, expectedKind: 'malformed' },
    {
      name: 'rate limit',
      overrides: { exitCode: 1, rateLimit: { matched: true, cause: 'rate-limit' } },
      expectedKind: 'rate_limited'
    },
    {
      name: 'credit failure',
      overrides: { exitCode: 1, rateLimit: { matched: true, cause: 'out-of-usage' } },
      expectedKind: 'rate_limited'
    },
    {
      name: 'API error',
      overrides: { apiError: { isError: true, terminalReason: 'overloaded' } },
      expectedKind: 'malformed'
    }
  ];

  it.each(ARMS)('$name: a region token keeps today\'s outcome', (arm) => {
    const stdout = arm.prefix === undefined ? REGION_STREAM : `${arm.prefix}\n${REGION_STREAM}`;

    expect(parse(stdout, arm.overrides).kind).toBe(arm.expectedKind);
  });

  it.each(ARMS)('$name: a no-region token reaches the token-removed outcome', (arm) => {
    const stdout = arm.prefix === undefined ? MID_PROSE : `${arm.prefix}\n${MID_PROSE}`;

    const actual = project(parse(stdout, arm.overrides));
    const expected = project(parse(withoutTokenLines(stdout), arm.overrides));

    expect(actual).toEqual(expected);
    expect(actual.kind).toBe(arm.expectedKind);
  });

  describe('an authored required policy', () => {
    const AUTHORED = { evidencePolicy: 'required', evidencePolicyDeclaredAt: 'phase-definition' } as const;
    // A complete pair missing every required field: a region, and a null entry.
    const EMPTY_PAIR = [OPEN, 'phase: speckit-implement', CLOSE, TOKEN].join('\n');

    it('a region token with no parseable entry still withholds, as before', () => {
      const result = parse(EMPTY_PAIR, AUTHORED);

      expect(result.kind).toBe('remaining_issues');
      expect((issuesOf(result) ?? []).map((issue) => issue.summary)).toEqual([
        'this Phase declares evidencePolicy required and produced no audit block'
      ]);
    });

    it('a no-region token reaches the token-removed outcome, with W-NOREGION and the host issue', () => {
      const result = parse(MID_PROSE, AUTHORED);
      const expected = projectOracle(parse(withoutTokenLines(MID_PROSE), AUTHORED), NOREGION_ISSUE);

      expect(project(result)).toEqual(expected);
      expect(warningsOf(result).some((warning) => warning.startsWith(W_NOREGION_PREFIX))).toBe(true);
      expect((issuesOf(result) ?? []).map((issue) => issue.summary)).toEqual([NOREGION_ISSUE]);
    });
  });

  describe('truncation through failClosedOnTruncatedOutput', () => {
    it('a region token and a no-region token both fail closed, with the truncation warning', () => {
      const withRegion = failClosedOnTruncatedOutput(parse(REGION_STREAM), true);
      const withoutRegion = failClosedOnTruncatedOutput(parse(MID_PROSE), true);
      const tokenRemoved = failClosedOnTruncatedOutput(parse(withoutTokenLines(MID_PROSE)), true);

      expect(withRegion.kind).toBe('malformed');
      expect(withoutRegion.kind).toBe(tokenRemoved.kind);
      expect(warningsOf(withoutRegion)).toContain('output-truncated-unclassifiable');
      expect(warningsOf(withoutRegion).some((warning) => warning.startsWith(W_NOREGION_PREFIX))).toBe(true);
      expect(mapOutcome(withoutRegion, 0)).toBe(mapOutcome(tokenRemoved, 0));
    });
  });
});

describe('FR-R4-004 / S-05 -- a no-region token beside an issues block (FR-004, scenario 9)', () => {
  const WITH_ISSUES = [
    'Working notes.',
    `An early mention of ${TOKEN} in prose.`,
    '',
    'Remaining issues:',
    '- [tests] one failing',
    '- [docs] one missing'
  ].join('\n');
  const WITH_QUESTIONS = [
    'Working notes.',
    `An early mention of ${TOKEN} in prose.`,
    '',
    'Open questions:',
    '- Which branch should the fix target?',
    '- Which flag name is wanted?'
  ].join('\n');

  it.each(SHAPES.filter((shape) => !shape.relaxed))(
    '$name: a Remaining issues block decides, with exactly its two bullets',
    (shape) => {
      const result = parse(WITH_ISSUES, shape.inputs);

      expect(result.kind).toBe('remaining_issues');
      expect(issuesOf(result)).toHaveLength(2);
      expect(mapOutcome(result, 0)).toBe('issues_remain');
      expect(warningsOf(result).some((warning) => warning.startsWith(W_NOREGION_PREFIX))).toBe(true);
      expect(project(result)).toEqual(
        projectOracle(parse(withoutTokenLines(WITH_ISSUES), shape.inputs), NOREGION_ISSUE)
      );
    }
  );

  it.each(SHAPES.filter((shape) => !shape.relaxed))(
    '$name: an Open questions block decides, with its two bullets',
    (shape) => {
      const result = parse(WITH_QUESTIONS, shape.inputs);

      expect(result.kind).toBe('open_questions');
      expect(questionsOf(result)).toHaveLength(2);
      expect(warningsOf(result).some((warning) => warning.startsWith(W_NOREGION_PREFIX))).toBe(true);
      expect(project(result)).toEqual(
        projectOracle(parse(withoutTokenLines(WITH_QUESTIONS), shape.inputs), NOREGION_ISSUE)
      );
    }
  );

  it.each(RELAXED)(
    '$name: an issues block then the token as the final line keeps today\'s precedence (FR-003 pin)',
    (shape) => {
      const stdout = ['Remaining issues:', '- [tests] one failing', '', TOKEN].join('\n');

      const result = parse(stdout, shape.inputs);

      expect(result.kind).toBe('clean');
      expect(warningsOf(result)).toContain('[constitution] multiple contract blocks');
      expect(warningsOf(result)).toContain(W_DEGRADED);
    }
  );
});
