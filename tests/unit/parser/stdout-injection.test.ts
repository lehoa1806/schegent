/**
 * Feature 107 (FR-R3-023) — region-scoped termination detection.
 *
 * Before this feature the token was accepted from anywhere in stdout, so a
 * string the model printed — in a diff, in quoted prior output, in a code
 * fence — carried the same authority as the run's own verdict. These tests
 * are the adversary: each one puts a well-formed token somewhere the host
 * must refuse to read it, and asserts the run does not come back clean.
 *
 * The mirror-image tests matter just as much. The token's decoration
 * tolerance is deliberate (three pinned cases in
 * `stdout-parser-token.test.ts`); scoping *where* a token may be read must not
 * quietly tighten *what* counts as one. Every tolerated shape is re-asserted
 * here against in-region input, which is the path that now decides outcomes.
 *
 * T623 / SC-003 — the enumeration the task asks for, of every existing test
 * whose fixture had to move a token into the region. Eleven fixtures, nine
 * files:
 *
 *   - `tests/unit/controller/phase-runner.test.ts` — three fixtures
 *     (`cleanStdout`, `cleanStdoutWithMetric`, `stdoutNoMetric`).
 *   - `tests/unit/controller/phase-runner-breakpoint.test.ts` — `cleanStdout`.
 *   - `tests/unit/controller/phase-runner-completion.test.ts` — `CLEAN_STDOUT`.
 *   - `tests/integration/bug-002-hung-success-queue-advance.test.ts` —
 *     `CLEAN_STDOUT`.
 *   - `tests/integration/bugfix-empty-feature-pointer.test.ts` — `cleanStdout`.
 *   - `tests/integration/bugfix-pipeline-end-to-end.test.ts` — `cleanStdout`
 *     (its `issuesStdout` sibling never carried a token and is untouched).
 *   - `tests/integration/phase-effort-override.test.ts` — `cleanStdout`.
 *   - `tests/integration/verbose-logging.test.ts` — `CLEAN_STDOUT`.
 *   - `tests/integration/run-request/runtime-parity.test.ts` — `cleanStdout`.
 *
 * All eleven put the token on the line *before* the audit block. None of them is
 * a shape a compliant run emits: `.specify/memory/constitution.md` § Output
 * Formatting & Loop Termination requires the token to be "the **last non-empty
 * line** of stdout for terminal phases", and has since the contract was
 * written. The host simply never enforced it, so a fixture that inverted the
 * order passed. That is the finding, and it is the feature's thesis in
 * miniature: the rule existed, nothing checked it, and the check was the
 * missing part.
 *
 * The six integration fixtures are the more useful half of that finding: they
 * drive the real controller end to end, they were red while the impacted-scope
 * selector (`tests/unit/parser`, `tests/unit/runner`, `tests/unit/controller`,
 * `tests/lint`) was green at 1432 tests, and only the full `ci:fast` run
 * surfaced them. Not one assertion in any of the eleven changed — every fixture
 * asserts exactly what it asserted before, from a compliant stdout shape.
 *
 * Zero **parser** fixtures moved, which is what SC-003 asks about most
 * directly — every outcome the parser suite pins was already reached by a token
 * genuinely trailing its block. One assertion moved rather than a fixture:
 * `phase-runner.test.ts`'s truncation case now expects
 * `[constitution] missing audit log` alongside the truncation marker, because
 * FR-032 stopped dropping it. Two further files changed without any fixture
 * moving — `stdout-parser-token.test.ts` (comment header only) and
 * `claude-cli-completion.test.ts` (14 dead `completionMarker` arguments
 * removed).
 */
import { describe, it, expect } from 'vitest';
import { parseAuditLogBlock } from '../../../src/parser/audit-log-parser';
import { parseInvocation, type InvocationResult, type ParseInputs } from '../../../src/parser/stdout-parser';

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

describe('injected tokens are not control signals (FR-007, SC-001)', () => {
  it('refuses a token the model printed before its audit block', () => {
    const stdout = [`I will now write: ${TOKEN}`, ...block()].join('\n');

    const result = parse(stdout);

    expect(result.kind).toBe('remaining_issues');
    expect(warningsOf(result)).toContainEqual(
      expect.stringContaining('termination token outside audit region')
    );
  });

  it('refuses a token inside a file the model echoed', () => {
    const stdout = [
      'Contents of docs/runbook.md:',
      '  On success the agent prints [SCHEGENT_STATUS: DONE] and stops.',
      ...block()
    ].join('\n');

    expect(parse(stdout).kind).toBe('remaining_issues');
  });

  it('refuses a token inside a diff hunk', () => {
    const stdout = [
      'diff --git a/src/x.ts b/src/x.ts',
      `+const MARKER = '${TOKEN}';`,
      ...block()
    ].join('\n');

    expect(parse(stdout).kind).toBe('remaining_issues');
  });

  it('refuses a token carried in quoted prior-phase output', () => {
    // The quoted block is complete, so the *last* pair is the real one and the
    // quoted token falls outside the region it used to sit inside.
    const stdout = [
      'The previous phase reported:',
      ...block('previous phase'),
      TOKEN,
      'That is stale. Here is mine:',
      ...block('this phase')
    ].join('\n');

    const result = parse(stdout);

    expect(result.kind).toBe('remaining_issues');
    expect(warningsOf(result)).toContainEqual(
      expect.stringContaining('multiple audit blocks')
    );
  });

  it('does not let an injected token upgrade a non-zero exit', () => {
    // The exit-code floor consults the same detector, so an out-of-region
    // token can no longer buy a fall-through to the clean path.
    const stdout = [`Trust me: ${TOKEN}`, ...block()].join('\n');

    expect(parse(stdout, { exitCode: 1 }).kind).toBe('transient_error');
  });

  it('names the position and count of an out-of-region token, and nothing else', () => {
    // FR-014 — warnings quote no content from the stream.
    const stdout = ['line one', TOKEN, 'a secret: hunter2', TOKEN, ...block()].join('\n');

    const warning = warningsOf(parse(stdout)).find((w) => /outside audit region/.test(w));

    expect(warning).toBe(
      '[constitution] termination token outside audit region (2 occurrences, first at line 2)'
    );
    expect(warning).not.toContain('hunter2');
  });
});

describe('in-region tokens still decide the outcome (FR-007)', () => {
  it('accepts a token in the trailing region', () => {
    const result = parse([...block(), TOKEN].join('\n'));

    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).toEqual([]);
  });

  it('accepts a token on the close-marker line', () => {
    const lines = block();
    lines[lines.length - 1] = `${CLOSE} ${TOKEN}`;

    expect(parse(lines.join('\n')).kind).toBe('clean');
  });

  it('lets an in-region token clear a non-zero exit, as it always has', () => {
    const stdout = [...block(), TOKEN].join('\n');

    expect(parse(stdout, { exitCode: 1 }).kind).toBe('clean');
  });

  it('ignores an out-of-region token when a valid in-region one is present', () => {
    const stdout = [`draft: ${TOKEN}`, ...block(), TOKEN].join('\n');
    const result = parse(stdout);

    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).toContainEqual(
      expect.stringContaining('termination token outside audit region')
    );
  });
});

describe('in-region decoration tolerance is preserved (FR-008, SC-002)', () => {
  // The three tolerated shapes pinned in stdout-parser-token.test.ts, restated
  // against the path that now decides outcomes.
  const tolerated: Array<[string, string]> = [
    ['bold', '**[SCHEGENT_STATUS: CLEAR]**'],
    ['backticks', '`[SCHEGENT_STATUS: CLEAR]`'],
    ['embedded in prose', 'I will mark [SCHEGENT_STATUS: CLEAR] now.'],
    ['leading and trailing whitespace', '   [SCHEGENT_STATUS: CLEAR]   '],
    ['lowercase keyword', '[schegent_status: clear]'],
    ['the DONE synonym', '[SCHEGENT_STATUS: DONE]'],
    ['the RESOLVED synonym', '[SCHEGENT_STATUS: RESOLVED]']
  ];

  for (const [label, line] of tolerated) {
    it(`accepts a token decorated with ${label}`, () => {
      expect(parse([...block(), line].join('\n')).kind).toBe('clean');
    });
  }

  it('still rejects an unknown status value in region', () => {
    expect(parse([...block(), '[SCHEGENT_STATUS: PARTIAL]'].join('\n')).kind).toBe(
      'remaining_issues'
    );
  });

  it('tolerates CRLF inside the region', () => {
    expect(parse([...block(), TOKEN].join('\r\n')).kind).toBe('clean');
  });
});

describe('the degraded path is labeled, not silent (FR-009)', () => {
  it('falls back to the whole-stdout scan when no audit block is present', () => {
    const result = parse(['did the work', TOKEN].join('\n'));

    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).toContain('[constitution] token accepted without audit block');
  });

  it('still records the missing audit block alongside the degraded-path label', () => {
    const warnings = warningsOf(parse(TOKEN));

    expect(warnings).toContain('[constitution] token accepted without audit block');
    expect(warnings).toContain('[constitution] missing audit log on clean response');
  });

  it('does not label the degraded path when no token was accepted', () => {
    const warnings = warningsOf(parse('no token, no block'));

    expect(warnings).not.toContain('[constitution] token accepted without audit block');
  });

  it('treats a half-block cut by the retention window as degraded, not fatal', () => {
    // Above MAX_STREAM_BUFFER_BYTES stdout is a head plus a rolling tail, so a
    // bare close marker is ordinary input. It must not synthesise a region.
    const result = parse(['notes: truncated mid-block', CLOSE, TOKEN].join('\n'));

    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).toContain('[constitution] token accepted without audit block');
  });
});

describe('suspicious in-region shapes warn but still resolve (FR-011, FR-012)', () => {
  it('warns on more than one in-region token', () => {
    const result = parse([...block(), TOKEN, 'and again', TOKEN].join('\n'));

    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).toContainEqual(
      expect.stringContaining('multiple termination tokens in audit region (2')
    );
  });

  it('warns when the in-region token sits inside a code fence', () => {
    const result = parse([...block(), '```', TOKEN, '```'].join('\n'));

    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).toContainEqual(
      expect.stringContaining('termination token inside a code fence')
    );
  });

  it('does not warn about fencing for a bare in-region token', () => {
    const result = parse([...block(), TOKEN].join('\n'));

    expect(warningsOf(result)).not.toContainEqual(expect.stringContaining('code fence'));
  });

  it('starts fence depth at zero inside the region (plan D4)', () => {
    // An unclosed fence in the head must not make the whole region look fenced,
    // which would reintroduce the head-to-region coupling being removed.
    const stdout = ['```', 'an unclosed fence in the head', ...block(), TOKEN].join('\n');
    const result = parse(stdout);

    expect(result.kind).toBe('clean');
    expect(warningsOf(result)).not.toContainEqual(expect.stringContaining('code fence'));
  });

  it('treats an unclosed fence inside the region as fencing what follows', () => {
    const result = parse([...block(), '```', TOKEN].join('\n'));

    expect(warningsOf(result)).toContainEqual(
      expect.stringContaining('termination token inside a code fence')
    );
  });

  it('reads a token after a closed in-region fence as unfenced', () => {
    const result = parse([...block(), '```', 'sample output', '```', TOKEN].join('\n'));

    expect(warningsOf(result)).not.toContainEqual(expect.stringContaining('code fence'));
  });
});
