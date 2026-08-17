// Feature 027 — SC-007 perf invariant. `extractResetTimestamp` MUST
// complete in <100ms on adversarial 1MB / 10MB buffers (no
// rate_limit_event lines + many `{...}` JSON-parse failures).
// Asserts the strict anti-backtracking discipline in the regex and the
// fast-fail shape check on stream-json lines.

import { describe, it, expect } from 'vitest';
import { extractResetTimestamp } from '../../src/parser/rate-limit-reset-extractor';

const ONE_MB_BUDGET_MS = 100;
const TEN_MB_BUDGET_MS = 100;

/**
 * Elapsed time of the fastest of several samples, after a warmup call.
 *
 * A single cold sample also pays V8 JIT warmup and regex compilation, and
 * vitest runs this file in a worker alongside the rest of the suite, so it
 * measures machine load as much as the algorithm: on 2026-08-17 the 10MB
 * case was observed at 102ms and 119ms against this 100ms budget on a host
 * whose steady-state cost for the same call is ~14ms.
 *
 * The minimum is the standard robust statistic for "how fast can this go" —
 * scheduler preemption and GC can only ever make a sample slower, never
 * faster. It does not weaken the assertion: catastrophic backtracking, the
 * property under test, is super-linear and orders of magnitude slower than
 * these budgets, so it cannot hide behind the minimum of a few samples.
 */
function bestElapsedMs(work: () => void, samples = 3): number {
  work();
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    work();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

// Adversarial line shapes:
//   - `{...}` that fails JSON.parse
//   - `{...}` that parses but lacks `type === 'rate_limit_event'`
//   - long token strings that COULD trigger catastrophic backtracking
//     on a sloppy plain-text regex
function buildAdversarialBuffer(targetBytes: number): string {
  const fragments = [
    '{this-is-not-valid-json-but-looks-like-it-could-be}',
    '{"type":"text","content":"all clear, no reset info here"}',
    '{"type":"system","subtype":"init","session_id":"abc","model":"claude-sonnet-4-5"}',
    'plain text line with no markers at all and reasonably long content',
    '· resets · resets · resets · resets · resets · resets · resets · resets',
    'You ran out of bandwidth (not usage)',
    '   1:10am (Asia/Saigon)   — incomplete pattern, no leading dot',
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allow","resetsAt":1000}}'
  ];
  const lines: string[] = [];
  let bytes = 0;
  let i = 0;
  while (bytes < targetBytes) {
    const frag = fragments[i % fragments.length];
    lines.push(frag);
    bytes += frag.length + 1; // +1 for the newline
    i++;
  }
  return lines.join('\n');
}

describe('extractResetTimestamp — perf invariant (Feature 027 SC-007)', () => {
  it('completes in <100ms on a 1MB adversarial buffer', () => {
    const stdout = buildAdversarialBuffer(1_000_000);
    const now = Date.now();
    const result = extractResetTimestamp(stdout, '', now);
    const elapsed = bestElapsedMs(() => extractResetTimestamp(stdout, '', now));
    expect(elapsed).toBeLessThan(ONE_MB_BUDGET_MS);
    // The fixtures DO contain a single `allow`-status rate_limit_event;
    // per the algorithm this MUST be skipped, and no other parseable
    // reset exists, so the result is null.
    expect(result.resetsAtMs).toBeNull();
  });

  it('completes in <100ms on a 10MB adversarial buffer (no catastrophic backtracking)', () => {
    const stdout = buildAdversarialBuffer(10_000_000);
    const now = Date.now();
    const result = extractResetTimestamp(stdout, '', now);
    const elapsed = bestElapsedMs(() => extractResetTimestamp(stdout, '', now));
    expect(elapsed).toBeLessThan(TEN_MB_BUDGET_MS);
    expect(result.resetsAtMs).toBeNull();
  });

  it('never throws on adversarial input (hard invariant)', () => {
    // Half-quoted JSON, lone surrogates, deeply nested but unterminated
    // braces, very long single-line content.
    const corrupt = [
      '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":',
      '{"type":"rate_limit_event","rate_limit_info":',
      '{{{{{{',
      '}}}}}}',
      '"unterminated',
      '\u{D800}',
      'x'.repeat(50_000)
    ].join('\n');
    expect(() => extractResetTimestamp(corrupt, '', Date.now())).not.toThrow();
    expect(() => extractResetTimestamp('', corrupt, Date.now())).not.toThrow();
  });
});
