// Feature 027 — US1: assert `parseInvocation` populates `resetsAtMs` on
// the `rate_limited` variant when extractResetTimestamp finds a parseable
// reset epoch in the captured stdout.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { NO_REGION } from '../../../src/parser/audit-log-parser';
import { detectCreditError } from '../../../src/parser/credit-error-detector';
import { parseInvocation } from '../../../src/parser/stdout-parser';
import { unwrapStreamJson } from '../../../src/parser/stream-json-unwrapper';

describe('parseInvocation — rate_limited.resetsAtMs (Feature 027)', () => {
  it('populates a finite resetsAtMs when stream-json rate_limit_event with rejected status is in stdout', () => {
    const future = Math.floor(Date.now() / 1000) + 600;
    const stdout = `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${future}}}`;
    const result = parseInvocation({
      stdout,
      stderr: 'over rate limit',
      exitCode: 1,
      rateLimit: { matched: true, cause: 'rate-limit' },
      auditEntry: null,
      auditWarnings: [],
      region: NO_REGION
    });
    expect(result.kind).toBe('rate_limited');
    if (result.kind !== 'rate_limited') return;
    expect(result.resetsAtMs).toBe(future * 1000);
  });

  it('sets resetsAtMs to null when no parseable reset is present', () => {
    const result = parseInvocation({
      stdout: 'no rate-limit info in this output',
      stderr: 'over rate limit',
      exitCode: 1,
      rateLimit: { matched: true, cause: 'rate-limit' },
      auditEntry: null,
      auditWarnings: [],
      region: NO_REGION
    });
    expect(result.kind).toBe('rate_limited');
    if (result.kind !== 'rate_limited') return;
    expect(result.resetsAtMs ?? null).toBeNull();
  });

  it('preserves the cause string verbatim on the rate_limited variant', () => {
    const result = parseInvocation({
      stdout: '',
      stderr: "You're out of extra usage",
      exitCode: 1,
      rateLimit: { matched: true, cause: 'out-of-usage' },
      auditEntry: null,
      auditWarnings: [],
      region: NO_REGION
    });
    expect(result.kind).toBe('rate_limited');
    if (result.kind !== 'rate_limited') return;
    expect(result.cause).toBe('out-of-usage');
  });

  it('non-rate-limit paths do not carry a resetsAtMs (variant shape unchanged)', () => {
    const result = parseInvocation({
      stdout: '',
      stderr: 'TypeError',
      exitCode: 1,
      rateLimit: { matched: false, cause: '' },
      auditEntry: null,
      auditWarnings: [],
      region: NO_REGION
    });
    expect(result.kind).toBe('transient_error');
  });

  // Bugfix 2026-05-23 — BUG-008: defensive symmetric check. A successful
  // CLI completion (exitCode === 0) MUST NOT route through the
  // `rate_limited` branch even if a caller constructs a synthetic
  // `rateLimit.matched = true` — the existing detector-layer guard
  // already prevents this in the normal flow, but the parser-level
  // belt-and-suspenders gate covers replay-from-fixture and test-harness
  // callers.
  describe('BUG-008 defensive exitCode !== 0 check', () => {
    it('synthetic matched=true with exitCode 0 does NOT route through rate_limited (with token → clean)', () => {
      const result = parseInvocation({
        stdout: '[SCHEGENT_STATUS: CLEAR]',
        stderr: '',
        exitCode: 0,
        rateLimit: { matched: true, cause: 'rate-limit' },
        auditEntry: { entryRaw: '{}', entryParsed: {} } as never,
        auditWarnings: [],
        region: NO_REGION
      });
      expect(result.kind).not.toBe('rate_limited');
      expect(result.kind).toBe('clean');
    });

    it('synthetic matched=true with exitCode 0 and no contract block falls through to remaining_issues default', () => {
      const result = parseInvocation({
        stdout: 'plain output\n',
        stderr: '',
        exitCode: 0,
        rateLimit: { matched: true, cause: 'rate-limit' },
        auditEntry: null,
        auditWarnings: [],
        region: NO_REGION
      });
      expect(result.kind).not.toBe('rate_limited');
      // No contract block + exit-zero falls through to the default
      // remaining_issues branch (the existing fall-through path).
      expect(result.kind).toBe('remaining_issues');
    });

    it('regression — genuine matched=true with non-zero exitCode still routes through rate_limited', () => {
      const future = Math.floor(Date.now() / 1000) + 600;
      const stdout = `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${future}}}`;
      const result = parseInvocation({
        stdout,
        stderr: '',
        exitCode: 1,
        rateLimit: { matched: true, cause: 'rate-limit' },
        auditEntry: null,
        auditWarnings: [],
        region: NO_REGION
      });
      expect(result.kind).toBe('rate_limited');
      if (result.kind !== 'rate_limited') return;
      expect(result.resetsAtMs).toBe(future * 1000);
    });
  });

  // FR-R3-197 (T1874) — composed as `phase-runner.ts` composes it: the
  // detector reads the raw stdout, the parser reads the unwrapped text.
  it('P1 — run 777491f8 attempt: exit 143 beside an allowed event is a transient_error, not rate_limited', () => {
    const raw = readFileSync(
      resolve(__dirname, '../../fixtures/rate-limit/rate-limit-allowed-observed.txt'),
      'utf8'
    ).trim();
    const rateLimit = detectCreditError(raw, '', 143);
    const unwrapped = unwrapStreamJson(raw);
    const result = parseInvocation({
      stdout: unwrapped.text,
      stderr: '',
      exitCode: 143,
      rateLimit,
      auditEntry: null,
      auditWarnings: [],
      region: NO_REGION,
      apiError: unwrapped.apiError
    });
    expect(result.kind).toBe('transient_error');
  });
});

// FR-R4-F02 (spec 240, US5; contract L3 G8, G9; FR-014) — a settled turn is not overridden by
// rate-limit evidence unless the CLI's own result was an error.
//
// A turn settles when the CLI's result was the last thing seen and the host ended a process that
// had not exited (`completedAwaitingExit`), so its exit status is the host's own SIGTERM. At
// `5d700407` the rate-limited branch ran before that fact was consulted, so evidence anywhere in
// the capture (a quoted event, an old record) turned a completed turn into a multi-hour backoff.
// The branch now requires `rateLimit.matched && exitCode !== 0 && !(settled && no apiError)`.
// Lifecycle facts decide; the clean token and the contract blocks are never inputs to that choice.
describe('parseInvocation — settled-turn precedence (FR-R4-F02, contract L3)', () => {
  const GENUINE = { matched: true, cause: 'rate-limit' } as const;
  const SETTLED = { completedAwaitingExit: true, backgroundWorkOpenAtResult: false, killed: false } as const;
  const KILLED = { completedAwaitingExit: true, backgroundWorkOpenAtResult: false, killed: true } as const;
  const UNSETTLED = { completedAwaitingExit: false, backgroundWorkOpenAtResult: false, killed: false } as const;
  const CLEAN_BLOCK = '[SCHEGENT_STATUS: CLEAR]';
  const IS_ERROR = { isError: true, terminalReason: 'rate_limit' } as const;

  function parse(overrides: Partial<Parameters<typeof parseInvocation>[0]>): ReturnType<typeof parseInvocation> {
    return parseInvocation({
      stdout: 'plain output\n',
      stderr: '',
      exitCode: 143,
      rateLimit: GENUINE,
      auditEntry: null,
      auditWarnings: [],
      region: NO_REGION,
      ...overrides
    });
  }

  it('a settled, non-error turn with genuine evidence and exit 143 is decided by the later branches', () => {
    // No contract block: the unfinished-turn arm decides, as it would with no evidence at all.
    const noBlock = parse({ turnEnd: SETTLED, apiError: null });
    expect(noBlock.kind).toBe('incomplete_turn');
    // A clean block: the block decides, as it would at exit zero.
    const withBlock = parse({
      turnEnd: SETTLED,
      apiError: null,
      stdout: CLEAN_BLOCK,
      auditEntry: { entryRaw: '{}', entryParsed: {} } as never
    });
    expect(withBlock.kind).toBe('clean');
  });

  it('the same inputs without the settled fact stay rate_limited (the control for the two above)', () => {
    expect(parse({ turnEnd: UNSETTLED, apiError: null }).kind).toBe('rate_limited');
    expect(parse({ apiError: null }).kind).toBe('rate_limited');
  });

  it('a killed turn never settled, so genuine evidence stays rate_limited', () => {
    expect(parse({ turnEnd: KILLED, apiError: null }).kind).toBe('rate_limited');
  });

  it('a result with is_error (apiError set) keeps rate_limited on a settled turn', () => {
    expect(parse({ turnEnd: SETTLED, apiError: IS_ERROR }).kind).toBe('rate_limited');
  });

  it('the clean token and a contract block after a genuine failure do not change it', () => {
    const stdout = `${CLEAN_BLOCK}\n`;
    const auditEntry = { entryRaw: '{}', entryParsed: {} } as never;
    expect(parse({ turnEnd: UNSETTLED, apiError: null, stdout, auditEntry }).kind).toBe('rate_limited');
    expect(parse({ turnEnd: KILLED, apiError: null, stdout, auditEntry }).kind).toBe('rate_limited');
    expect(parse({ turnEnd: SETTLED, apiError: IS_ERROR, stdout, auditEntry }).kind).toBe('rate_limited');
  });

  it('exit zero and no evidence are unchanged by the settled fact', () => {
    expect(parse({ turnEnd: SETTLED, exitCode: 0, rateLimit: { matched: false, cause: '' } }).kind).toBe(
      'incomplete_turn'
    );
    expect(parse({ turnEnd: SETTLED, rateLimit: { matched: false, cause: '' } }).kind).toBe('incomplete_turn');
  });

  it('a genuine rate limit keeps its reset time on an unsettled turn', () => {
    const future = Math.floor(Date.now() / 1000) + 600;
    const stdout = `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${future}}}`;
    const result = parse({ turnEnd: UNSETTLED, apiError: null, stdout });
    expect(result.kind).toBe('rate_limited');
    if (result.kind !== 'rate_limited') return;
    expect(result.resetsAtMs).toBe(future * 1000);
  });
});

