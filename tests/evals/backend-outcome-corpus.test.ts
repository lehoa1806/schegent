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

/**
 * FR-R3-067 — the test count a suite source declares, derived rather than kept.
 *
 * Two kinds of declaration, separated by their title syntax, because counting
 * `it(` alone undercounts badly: most of the tests come from the loop over
 * `corpus.cases`. Measured 2026-08-24, before this assertion existed: 6
 * declarations for 15 reported tests. That is exactly the trap FR-R3-065 hit when
 * it counted `test(` calls in a parameterised visual suite and got 4 for 18.
 *
 *   an `it('…')` or `it("…")` with a QUOTED title is one test;
 *   an `it(`…`)` with a TEMPLATE title is one per corpus case.
 *
 * Both quote styles, because the first draft matched single quotes only and missed
 * its own double-quoted title — reporting 6 standalone where there were 7. It
 * caught itself on the first run, which is the argument for deriving a number
 * rather than restating it.
 *
 * Taken as a parameter rather than reading the file, so the derivation itself is
 * testable against a synthetic source (SC-011).
 */
function deriveTestTally(
  source: string,
  caseCount: number
): {
  readonly standalone: number;
  readonly templated: number;
  readonly unsupported: number;
  readonly total: number;
} {
  const standalone = (source.match(/^\s*it\(["']/gm) ?? []).length;
  const templated = (source.match(/^\s*it\(`/gm) ?? []).length;
  // Declaration forms this derivation cannot account for. Counted rather than
  // ignored, because each of them moves the REPORTED tally without moving the
  // derived one: a `.each` multiplies by a list this function never sees, a
  // `.skip` or `.todo` subtracts from the passing count, and a bare `test(` is a
  // test in a shape the two regexes above do not match. Any of them would leave a
  // green gate standing over a stale README — the failure mode this whole
  // derivation exists to remove — so the assertion that reads this demands zero
  // and the derivation gets extended instead.
  const unsupported = (source.match(/^\s*(?:test\(|(?:it|test|describe)\.[A-Za-z]+\()/gm) ?? [])
    .length;
  return { standalone, templated, unsupported, total: standalone + templated * caseCount };
}

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
      'internal-execution-error',
      'session-continuation',
      'runner-switch',
      // FR-R3-084 §3.4 — the injection-shaped scenario. Fixture-based and in the
      // deterministic corpus by the item's own instruction, so it is exercised on
      // every `npm run ci` rather than only when a live backend is reachable.
      'prompt-injection-in-output'
    ]);
  });

  // The pinned list above stops the corpus shrinking, but it cannot say whether
  // the corpus still *covers* what it claims to. These two assertions do: every
  // arm of the two mappers under evaluation must be reached by some case. Added
  // 2026-08-19 after `transient_error` — the parser kind behind Feature 011's
  // delayed-retry path — turned out to be reachable only as an *outcome* (via a
  // truncated `malformed` parse) and never as a parser *kind*, so both mappers'
  // `case 'transient_error'` arms were unexercised here while this suite
  // reported "covers every required scenario".
  it('reaches every parser kind the outcome mappers switch on', () => {
    const covered = new Set(corpus.cases.map((c) => c.expected.parserKind));
    expect([...covered].sort()).toEqual([
      'clean',
      'malformed',
      'open_questions',
      'rate_limited',
      'remaining_issues',
      'transient_error'
    ]);
  });

  it('reaches every termination reason the parser path can produce', () => {
    // `iteration_cap`, `timeout` and `cancel` are deliberately absent: they are
    // produced by the controller loop, the watchdog and the operator, none of
    // which run through `mapTerminationReason`.
    const covered = new Set(corpus.cases.map((c) => c.expected.terminationReason));
    expect([...covered].sort()).toEqual([
      'error',
      'open_questions',
      'rate_limit',
      'remaining_issues',
      'token'
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

/**
 * FR-R3-061 (M-08 / R-15) — what this corpus is, asserted rather than assumed.
 *
 * A review cited this suite as evidence that backend behaviour was qualified. It
 * is not, and cannot be: every input is a fixture, and nothing here runs a CLI,
 * opens a socket, or authenticates. The scope note lives in `tests/evals/README.md`;
 * these assertions keep it true, because a note nothing checks is a note that
 * drifts.
 */
describe('the corpus measures parser coverage, not behavioural qualification', () => {
  it('has a scope note that says so', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const readme = readFileSync(join(__dirname, 'README.md'), 'utf8');
    expect(readme).toContain('not behavioral qualification');
    // FR-R3-138 — this pinned the string `backend-canary.yml`, so the README could
    // not stop naming a file `FR-R3-099` had deleted without turning this suite
    // red. An assertion that holds a document to a deleted file does not keep the
    // document true; it enforces the falsehood, which is the worse of the two
    // failure modes because nobody re-reads a green test. What the README must
    // still say is how the canary is actually invoked.
    expect(readme).toContain('npm run canary');
    // FR-R3-084 (2026-08-26) — this pinned `skipped-no-live-path` on the premise
    // that "the canary qualifies nothing yet either: a version probe plus an
    // honest skip until a live invocation exists". A live invocation exists now,
    // so that string is gone and pinning it would hold the README to an obsolete
    // claim. What replaces it is what the README must still not omit: the honest
    // skip state the live phase can report, and the fact that nothing schedules
    // the canary — without which a reader would take it for a running one.
    expect(readme).toContain('skipped-not-authenticated');
    expect(readme).toContain('No workflow declares it');
  });

  it("reports the test tally its README states", async () => {
    // FR-R3-067 — the README said 13 while the suite reported 15, because
    // FR-R3-061 added two meta-assertions in the same change that wrote the
    // sentence. A corrected number with nothing behind it is a number that goes
    // stale again, so the tally is DERIVED here rather than restated. See
    // `deriveTestTally` for how, and why the obvious way does not work.
    //
    // Both components are exact: the standalone count from this source, the
    // multiplier from the fixture this file imports. Add a test and both sides of
    // the comparison move together, which is the whole point.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(__dirname, 'backend-outcome-corpus.test.ts'), 'utf8');
    const { standalone, templated, unsupported, total } = deriveTestTally(
      source,
      corpus.cases.length
    );

    // Pinned so a SECOND loop cannot silently change the arithmetic. If someone
    // adds one, this fails loudly and the derivation gets revisited — which is
    // the behaviour to want from a count that must not go stale.
    expect(
      templated,
      'exactly one templated `it(` is expected, generated once per corpus case; a second loop means ' +
        'this derivation no longer describes the suite and must be rewritten rather than adjusted'
    ).toBe(1);

    // Pinned for the same reason, one step out: a declaration shape the derivation
    // cannot count would leave this gate green while the README went stale, which
    // is the whole failure it exists to prevent. Review found the loop pin above
    // guarded only the shape that already existed.
    expect(
      unsupported,
      'this suite gained a declaration this derivation cannot count — a `.each`, `.skip`, `.only`, ' +
        '`.todo`, or a bare `test(`. Each of those moves the reported tally without moving the derived ' +
        'total, so extend `deriveTestTally` to account for the new shape; do not delete this assertion.'
    ).toBe(0);

    const readme = readFileSync(join(__dirname, 'README.md'), 'utf8');
    const stated = /\*\*(\d+) passing tests\*\*/.exec(readme);
    expect(
      stated,
      'README.md no longer states a passing-test tally in the form `**N passing tests**`. Either restore ' +
        'it or delete this assertion deliberately — do not loosen the pattern until it matches something.'
    ).not.toBeNull();
    expect(
      Number(stated?.[1]),
      `README.md says ${stated?.[1]} passing tests; this suite declares ${total} ` +
        `(${standalone} standalone + ${templated} x ${corpus.cases.length} corpus cases). ` +
        'Correct the README, not this derivation.'
    ).toBe(total);
  });

  it('derives a tally that moves with the file, so it needs no maintenance', () => {
    // FR-R3-067 SC-011 — the claim is that adding a test moves BOTH sides of the
    // comparison above, so the number never needs re-blessing by hand. That is
    // asserted by construction here rather than merely stated: the same
    // derivation is applied to a synthetic source that gains a declaration.
    //
    // The declarations are ASSEMBLED rather than written literally, because a line
    // beginning `it(` in this file would be counted by the derivation reading it —
    // a fixture that changed the number it exists to explain.
    const standaloneDecl = (title: string) => `  ${'it'}('${title}', () => {});`;
    const templatedDecl = `  ${'it'}(\`\${c.id}\`, () => {});`;

    const before = [standaloneDecl('one'), standaloneDecl('two'), templatedDecl].join('\n');
    const after = [before, standaloneDecl('three')].join('\n');

    expect(deriveTestTally(before, 10)).toEqual({
      standalone: 2,
      templated: 1,
      unsupported: 0,
      total: 12
    });
    // Adding a declaration moves the derived total with no other edit.
    expect(deriveTestTally(after, 10)).toEqual({
      standalone: 3,
      templated: 1,
      unsupported: 0,
      total: 13
    });
    // And the multiplier is the live case count, never a constant.
    expect(deriveTestTally(before, 4).total).toBe(6);
    // A double-quoted title counts too — the slip the first draft made.
    expect(deriveTestTally(`  ${'it'}("quoted", () => {});`, 10).standalone).toBe(1);

    // And a shape the derivation CANNOT account for is reported rather than
    // silently dropped, so the assertion above can refuse it. Assembled the same
    // way, for the same reason.
    const uncountable = [
      `  ${'it'}.each([1, 2])('%s', () => {});`,
      `  ${'it'}.skip('parked', () => {});`,
      `  ${'test'}('a different declarator', () => {});`
    ].join('\n');
    const withUncountable = deriveTestTally([before, uncountable].join('\n'), 10);
    expect(withUncountable.unsupported).toBe(3);
    // Note the trap this guards: none of the three moved the derived total.
    expect(withUncountable.total).toBe(12);
  });

  it('states the corpus case count its fixture actually holds', async () => {
    // The other number the README states, and the one that carries the
    // substantive claim FR-R3-061 wrote this file to protect.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const readme = readFileSync(join(__dirname, 'README.md'), 'utf8');
    const stated = /\*\*(\d+) cases\*\*/.exec(readme);
    expect(stated, 'README.md no longer states a case count as `**N cases**`').not.toBeNull();
    expect(Number(stated?.[1])).toBe(corpus.cases.length);
  });

  it('reaches no CLI, socket or credential', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(__dirname, 'backend-outcome-corpus.test.ts'), 'utf8');
    // Only the IMPORT lines. Scanning the whole file for these tokens fails on
    // this assertion's own list -- the first version of it did exactly that, which
    // is the same self-reference trap as a lint gate matching its own comment.
    const imports = source
      .split(/\r?\n/)
      .filter((line) => line.startsWith('import ') || line.includes("from '"));
    const live = ['child_' + 'process', 'node:net', 'node:http', 'undici'];
    for (const forbidden of live) {
      expect(
        imports.some((line) => line.includes(forbidden)),
        `the corpus must not import ${forbidden}: a deterministic suite that grew a live call ` +
          'would keep passing while becoming the flaky PR gate the review warned against'
      ).toBe(false);
    }
  });
});
