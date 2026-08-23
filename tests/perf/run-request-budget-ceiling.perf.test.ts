import { describe, it, expect } from 'vitest';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import {
  MAX_REQUEST_TOTAL_BYTES,
  MAX_SUPPLEMENTAL_TEXT_BYTES,
  runRequestBudgetViolations
} from '../../src/contracts/validators/run-request-budgets';
import type { ExecutionEnvelope } from '../../src/contracts/run-request';

/**
 * FR-R3-057 — what a MAXIMAL ACCEPTED request costs the prompt builder.
 *
 * The acceptance criterion asks for this number to be measured and recorded, not
 * asserted loosely, because it is an input to FR-R3-052's aggregate-memory
 * arithmetic: the accepted-request ceiling times the concurrency cap is the
 * bound on how much request text one host can be holding.
 *
 * Constructed at exactly the aggregate limit, so it is the largest request that
 * validation admits -- one byte more and it is refused.
 */
describe('the maximal accepted request, measured', () => {
  it('builds a prompt whose size is bounded by the request budget', () => {
    const chunk = 'x'.repeat(MAX_SUPPLEMENTAL_TEXT_BYTES);
    const count = MAX_REQUEST_TOTAL_BYTES / MAX_SUPPLEMENTAL_TEXT_BYTES;
    // Two shapes, deliberately. The budget runs at VALIDATION, on the request
    // shape, where a text item's payload is `text`. The prompt builder consumes
    // the FROZEN shape, where every kind's payload is the single field `value`.
    // Feeding a frozen item to the request-shaped checker measures zero bytes and
    // the whole ceiling assertion becomes vacuous -- which is what the first
    // version of this test did.
    const requestShaped = Array.from({ length: count }, () => ({
      kind: 'text' as const,
      text: chunk
    }));
    const frozenShaped = Array.from({ length: count }, () => ({
      kind: 'text' as const,
      value: chunk
    }));

    // Confirm this really is at the ceiling: accepted, and rejected one byte up.
    expect(runRequestBudgetViolations({ supplemental: requestShaped })).toEqual([]);
    expect(
      runRequestBudgetViolations({ supplemental: requestShaped, instructions: 'x' })
        .map((v) => v.code)
    ).toEqual(['request-bytes-exceeded']);

    const envelope = {
      pipeline: { id: 'p', name: 'p', phases: [] },
      inputs: [],
      supplemental: frozenShaped,
      outputs: [],
      frozenAt: 0
    } as unknown as ExecutionEnvelope;

    const prompt = new PromptBuilder().build({ envelope } as never);
    const bytes = Buffer.byteLength(prompt, 'utf8');

    // RECORDED: the prompt is the request text plus a bounded amount of framing
    // (labels, headings, one line per item). Asserting a ratio rather than an
    // absolute number, because the framing is allowed to change and the property
    // that matters is that it stays proportional -- a builder that quoted or
    // escaped each item could double it without any budget noticing.
    expect(bytes).toBeGreaterThan(MAX_REQUEST_TOTAL_BYTES);
    expect(bytes).toBeLessThan(MAX_REQUEST_TOTAL_BYTES * 1.05);

    console.log(
      `[FR-R3-057] maximal accepted request: ${MAX_REQUEST_TOTAL_BYTES} bytes in, ` +
        `${bytes} bytes of prompt out (${(bytes / MAX_REQUEST_TOTAL_BYTES).toFixed(4)}x)`
    );
  });
});
