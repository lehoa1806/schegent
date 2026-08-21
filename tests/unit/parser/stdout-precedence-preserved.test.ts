/**
 * Feature 107 (T625, FR-015..FR-018, SC-014, US7) — what this feature must NOT
 * have changed.
 *
 * Region-scoping the token narrows one thing: what "a token is present" means.
 * Everything ordered around that answer keeps its place. That is easy to say
 * and easy to break, because the change touched the exact function where the
 * ordering lives — detection moved *above* the exit-code floor so its warnings
 * accumulate once, which reorders the source without reordering the outcomes.
 *
 * Analyze flagged these five properties as stated in the spec and covered
 * nowhere, which is the same posture as a warning that is constructed and
 * discarded: an invariant with no test is an intention. Each one below is a
 * property a plausible future edit would break silently.
 */
import { describe, it, expect } from 'vitest';
import { parseAuditLogBlock } from '../../../src/parser/audit-log-parser';
import { parseInvocation, type InvocationResult, type ParseInputs } from '../../../src/parser/stdout-parser';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const OPEN = '=== SCHEGENT AUDIT LOG ===';
const CLOSE = '=== END AUDIT LOG ===';
const TOKEN = '[SCHEGENT_STATUS: CLEAR]';

function block(): string[] {
  return [
    OPEN,
    'phase: speckit-implement',
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: []',
    'network_calls: ["none"]',
    'ruleset_switches: ["none"]',
    'notes: work done',
    CLOSE
  ];
}

/** A stream whose token is genuinely in region — the strongest possible claim to clean. */
function cleanStream(): string {
  return [...block(), TOKEN].join('\n');
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

describe('fatal classification still outranks a valid token (FR-015, FR-016)', () => {
  // The precedence claim that matters most: a token in region is the strongest
  // "I finished" the protocol allows, and a registered fatal signature still
  // beats it. If region-scoping had been wired below the fatal gate, a run that
  // hit a fatal signature *and* reported clean would resolve clean.
  // The one built-in signature scanned on stdout. `error: unknown option` is
  // STDERR_ONLY, so it would not exercise the stdout content path.
  const FATAL = 'Autocompact is thrashing';

  it('a registered signature in stdout wins over an in-region token', () => {
    const result = parse([FATAL, ...block(), TOKEN].join('\n'));
    expect(result.kind).toBe('malformed');
  });

  it('a caller-supplied streamFatalMatch wins over an in-region token', () => {
    const result = parse(cleanStream(), {
      streamFatalMatch: {
        matched: true,
        signature: 'stream-detected',
        stream: 'stdout',
        source: 'operator-defined'
      }
    });
    expect(result.kind).toBe('malformed');
  });

  it('streamFatalMatch is additive: it cannot suppress a content classification', () => {
    // FR-016's documented property. A caller passing `matched: false` must not
    // be able to turn off `classifyFatal` — the code falls through to the
    // content scan rather than trusting the negative.
    const result = parse([FATAL, ...block(), TOKEN].join('\n'), {
      streamFatalMatch: { matched: false }
    });
    expect(result.kind).toBe('malformed');
  });
});

describe('rate-limit still outranks the token and the exit-code floor (FR-015)', () => {
  it('a rate-limited non-zero exit resolves rate_limited despite an in-region token', () => {
    const result = parse(cleanStream(), {
      exitCode: 1,
      rateLimit: { matched: true, cause: 'usage limit' }
    });
    expect(result.kind).toBe('rate_limited');
  });

  it('a rate-limit flag on a zero exit does not route to rate_limited', () => {
    // BUG-008's defensive guard, unchanged: a successful completion is not a
    // rate-limit failure whatever the payload says.
    const result = parse(cleanStream(), { rateLimit: { matched: true, cause: 'usage limit' } });
    expect(result.kind).toBe('clean');
  });

  it('api_error outranks the exit-code floor but not rate-limit', () => {
    const rateLimited = parse(cleanStream(), {
      exitCode: 1,
      rateLimit: { matched: true, cause: 'usage limit' },
      apiError: { isError: true, terminalReason: 'overloaded' }
    });
    expect(rateLimited.kind).toBe('rate_limited');

    const apiFailed = parse(cleanStream(), {
      exitCode: 1,
      apiError: { isError: true, terminalReason: 'overloaded' }
    });
    expect(apiFailed.kind).toBe('malformed');
  });
});

describe('issue and question extraction keep whole-stdout scope (FR-017)', () => {
  // The tempting over-reach: the token is region-scoped, so scope these too.
  // They must not be. A model reports remaining issues *while working*, before
  // any audit block exists, and narrowing them would silently drop the content
  // the operator most needs on a run that did not finish.

  it('extracts issues stated before the audit block', () => {
    const result = parse(
      ['REMAINING ISSUES:', '- [db] migration not written', ...block()].join('\n')
    );
    expect(result.kind).toBe('remaining_issues');
    expect(result.kind === 'remaining_issues' && result.issues.length).toBeGreaterThan(0);
  });

  it('extracts open questions stated before the audit block', () => {
    const result = parse(['OPEN QUESTIONS:', '- which store owns this?', ...block()].join('\n'));
    expect(result.kind).toBe('open_questions');
  });

  it('extracts issues from a stream with no audit block at all', () => {
    // The degraded path: no region exists, and the issues are still the run's
    // report. Losing them here would be the worst case — a failing run whose
    // reason went missing.
    const result = parse(['REMAINING ISSUES:', '- [db] migration not written'].join('\n'));
    expect(result.kind).toBe('remaining_issues');
    expect(result.kind === 'remaining_issues' && result.issues.length).toBeGreaterThan(0);
  });

  it('extraction is unbounded: a long list is not truncated', () => {
    const issues = Array.from({ length: 40 }, (_, i) => `- [scope${i}] issue number ${i}`);
    const result = parse(['REMAINING ISSUES:', ...issues].join('\n'));
    expect(result.kind).toBe('remaining_issues');
    expect(result.kind === 'remaining_issues' && result.issues).toHaveLength(40);
  });
});

describe('the runner bounds keep their values and stay bounds (FR-018)', () => {
  // These two are timers, not deciders: a settle window and a replay window.
  // The distinction is the whole point of the arming boundary — if either ever
  // became the thing that *decides* a run finished, content would be back in
  // control of a process signal. Pinning the values makes an accidental change
  // visible; pinning the surrounding text makes a change of *role* visible.
  const cliSource = readFileSync(join(REPO_ROOT, 'src', 'runner', 'claude-cli.ts'), 'utf8');

  it('COMPLETION_SETTLE_MS is 15_000', () => {
    expect(cliSource).toContain('const COMPLETION_SETTLE_MS = 15_000;');
  });

  it('RESUME_HISTORY_REPLAY_MS is 60_000', () => {
    expect(cliSource).toContain('const RESUME_HISTORY_REPLAY_MS = 60_000;');
  });

  it('the settle window is documented as starting from the result envelope', () => {
    // Not from a marker found in content. This comment was wrong for five
    // months and is the reason FR-R3-023 went looking for a reader that no
    // longer existed; it is pinned so it cannot rot back.
    const settleIdx = cliSource.indexOf('const COMPLETION_SETTLE_MS');
    const preamble = cliSource.slice(Math.max(0, settleIdx - 1600), settleIdx);
    expect(preamble).toContain('"type":"result"');
  });
});
