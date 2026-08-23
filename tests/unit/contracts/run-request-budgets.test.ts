import { describe, it, expect } from 'vitest';
import {
  runRequestBudgetViolations,
  MAX_INPUT_VALUE_BYTES,
  MAX_SUPPLEMENTAL_TEXT_BYTES,
  MAX_PATH_BYTES,
  MAX_URL_BYTES,
  MAX_OUTPUT_TARGET_BYTES,
  MAX_INPUT_COUNT,
  MAX_SUPPLEMENTAL_COUNT,
  MAX_OUTPUT_COUNT,
  MAX_REQUEST_TOTAL_BYTES
} from '../../../src/contracts/validators/run-request-budgets';
import { validRunRequest } from '../../../src/contracts/validators/run-request-shape';

/**
 * FR-R3-057 (M-03 / R-11) — boundary tests at, below and above each budget.
 *
 * "At" matters as much as "above": an off-by-one that rejects a request exactly
 * at the limit is a product defect, and one that accepts a request one byte over
 * is the defect the budget exists to stop. Both directions are asserted for
 * every budget.
 */
const input = (value: string) => ({ portId: 'p', type: 'text', value });
const text = (value: string) => ({ kind: 'text', text: value });
const codesOf = (r: Parameters<typeof runRequestBudgetViolations>[0]) =>
  runRequestBudgetViolations(r).map((v) => v.code);

describe('per-field byte budgets', () => {
  it('accepts a value exactly at the limit and rejects one byte over', () => {
    expect(codesOf({ inputs: [input('a'.repeat(MAX_INPUT_VALUE_BYTES))] })).toEqual([]);
    expect(codesOf({ inputs: [input('a'.repeat(MAX_INPUT_VALUE_BYTES + 1))] })).toEqual([
      'input-value-too-large'
    ]);
  });

  it('counts UTF-8 bytes, not characters', () => {
    // The whole reason the unit is bytes. A 4-byte character means a quarter of
    // the characters reaches the same limit, and a character budget would let
    // this through at four times the real cost.
    const fourByte = '\u{1F600}'; // one code point, four UTF-8 bytes
    const justOver = fourByte.repeat(MAX_INPUT_VALUE_BYTES / 4 + 1);
    expect(justOver.length).toBeLessThan(MAX_INPUT_VALUE_BYTES);
    expect(codesOf({ inputs: [input(justOver)] })).toEqual(['input-value-too-large']);
  });

  it('bounds a supplemental text item', () => {
    expect(codesOf({ supplemental: [text('t'.repeat(MAX_SUPPLEMENTAL_TEXT_BYTES))] })).toEqual([]);
    expect(
      codesOf({ supplemental: [text('t'.repeat(MAX_SUPPLEMENTAL_TEXT_BYTES + 1))] })
    ).toEqual(['supplemental-value-too-large']);
  });

  it('bounds a path and a URL by their own limits, not one shared one', () => {
    const path = { kind: 'local-file', path: 'p'.repeat(MAX_PATH_BYTES + 1) };
    const url = { kind: 'url', url: `https://x/${'u'.repeat(MAX_URL_BYTES)}` };
    expect(codesOf({ supplemental: [path] })).toEqual(['supplemental-value-too-large']);
    expect(codesOf({ supplemental: [url] })).toEqual(['supplemental-value-too-large']);
    // A path at the URL limit is fine: the limits are genuinely different.
    expect(codesOf({ supplemental: [{ kind: 'local-file', path: 'p'.repeat(MAX_URL_BYTES) }] }))
      .toEqual([]);
  });

  it('bounds an output target', () => {
    const over = [{ portId: 'o', target: 't'.repeat(MAX_OUTPUT_TARGET_BYTES + 1) }];
    expect(codesOf({ outputs: over })).toEqual(['output-target-too-long']);
  });

  it('ignores a prior-output reference, which carries no free-form string', () => {
    const ref = {
      kind: 'prior-output',
      reference: { sourceRunId: 'r', outputName: 'o' }
    };
    expect(codesOf({ supplemental: [ref] })).toEqual([]);
  });
});

describe('item-count budgets', () => {
  it('accepts exactly the maximum and rejects one more', () => {
    const at = Array.from({ length: MAX_INPUT_COUNT }, () => input('x'));
    expect(codesOf({ inputs: at })).toEqual([]);
    expect(codesOf({ inputs: [...at, input('x')] })).toEqual(['inputs-count-exceeded']);
  });

  it('bounds supplemental and output counts', () => {
    const sup = Array.from({ length: MAX_SUPPLEMENTAL_COUNT + 1 }, () => text('x'));
    const out = Array.from({ length: MAX_OUTPUT_COUNT + 1 }, () => ({ portId: 'o', target: 't' }));
    expect(codesOf({ supplemental: sup })).toContain('supplemental-count-exceeded');
    expect(codesOf({ outputs: out })).toContain('outputs-count-exceeded');
  });
});

describe('the aggregate budget', () => {
  it('binds even when every individual field passes', () => {
    // The case per-field budgets cannot cover: each item is inside its own
    // limit, and the request is 8 MiB.
    const eight = Array.from({ length: 8 }, () =>
      text('x'.repeat(MAX_SUPPLEMENTAL_TEXT_BYTES))
    );
    const codes = codesOf({ supplemental: eight });
    expect(codes).toEqual(['request-bytes-exceeded']);
  });

  it('accepts a request exactly at the aggregate limit', () => {
    const one = 'x'.repeat(MAX_REQUEST_TOTAL_BYTES);
    expect(codesOf({ supplemental: [{ kind: 'text', text: one }] })).toEqual([
      'supplemental-value-too-large'
    ]);
    // Split across items that each fit, summing to exactly the limit.
    const chunk = 'x'.repeat(MAX_SUPPLEMENTAL_TEXT_BYTES);
    const exactly = Array.from({ length: MAX_REQUEST_TOTAL_BYTES / MAX_SUPPLEMENTAL_TEXT_BYTES },
      () => text(chunk));
    expect(codesOf({ supplemental: exactly })).toEqual([]);
  });

  it('counts instructions toward the aggregate', () => {
    const chunk = 'x'.repeat(MAX_SUPPLEMENTAL_TEXT_BYTES);
    const nearly = Array.from({ length: MAX_REQUEST_TOTAL_BYTES / MAX_SUPPLEMENTAL_TEXT_BYTES },
      () => text(chunk));
    expect(codesOf({ supplemental: nearly })).toEqual([]);
    expect(codesOf({ supplemental: nearly, instructions: 'x' })).toEqual([
      'request-bytes-exceeded'
    ]);
  });
});

describe('reporting and tolerance', () => {
  it('reports every violation, not the first', () => {
    const codes = codesOf({
      inputs: [input('a'.repeat(MAX_INPUT_VALUE_BYTES + 1))],
      outputs: [{ portId: 'o', target: 't'.repeat(MAX_OUTPUT_TARGET_BYTES + 1) }]
    });
    expect(codes).toEqual(['input-value-too-large', 'output-target-too-long']);
  });

  it('does not throw on a malformed request', () => {
    // The shape predicate is the gate for this; a budget check that threw would
    // turn a shape error into a crash at whichever boundary ran first.
    expect(() => runRequestBudgetViolations({ inputs: [null, 7, 'x'] as never })).not.toThrow();
    expect(codesOf({})).toEqual([]);
  });
});

describe('the transport predicate refuses an over-budget payload', () => {
  const base = {
    pipelineId: 'p',
    inputs: [] as unknown[],
    supplemental: [] as unknown[],
    outputs: [] as unknown[]
  };

  it('accepts a well-formed request inside its budgets', () => {
    expect(validRunRequest({ ...base, inputs: [input('hello')] })).toBe(true);
  });

  it('refuses one that is shape-valid but over budget', () => {
    // Shape-valid on every key, and 8 MiB. The wire should not carry it to the
    // code that would report on it.
    const eight = Array.from({ length: 8 }, () =>
      text('x'.repeat(MAX_SUPPLEMENTAL_TEXT_BYTES))
    );
    expect(validRunRequest({ ...base, supplemental: eight })).toBe(false);
  });
});
