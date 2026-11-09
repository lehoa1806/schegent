import { describe, expect, it } from 'vitest';

import {
  COMMON_BOUND_IDS,
  COMMON_QUEUE_BOUNDS
} from '../../../src/contracts/runtime-resource-budgets/common-bounds.js';
import {
  COMMON_BOUND_CONFORMANCE_FIXTURES,
  createReferenceAdapter,
  runAllReferenceBoundConformance,
  runCommonBoundConformance
} from '../../../src/services/runtime-resource-budgets/common-bound-conformance.js';
import { PendingUsageIngestionQueue } from '../../../src/services/runtime-resource-budgets/common-bound-references.js';

describe('common-bound-conformance (F03-AC-05, FR-008..FR-010, FR-015, SC-008)', () => {
  it('defines at least one limit and one limit-plus-one fixture for every FR-015 common bound', () => {
    expect(COMMON_BOUND_IDS).toHaveLength(9);
    for (const boundId of COMMON_BOUND_IDS) {
      const fixtures = COMMON_BOUND_CONFORMANCE_FIXTURES.filter((f) => f.boundId === boundId);
      expect(fixtures.some((f) => f.kind === 'limit')).toBe(true);
      expect(fixtures.some((f) => f.kind === 'limit-plus-one')).toBe(true);
    }
  });

  it('passes 100% of limit and limit-plus-one fixtures across all 9 FR-015 common bounds', () => {
    const results = runAllReferenceBoundConformance();
    expect(results).toHaveLength(18);
    for (const result of results) {
      expect(result.passed, `${result.fixtureId}: ${result.detail}`).toBe(true);
    }
  });

  it('supports running conformance per bound adapter individually', () => {
    for (const bound of COMMON_QUEUE_BOUNDS) {
      const adapter = createReferenceAdapter(bound.id);
      const res = runCommonBoundConformance(adapter);
      expect(res.length).toBeGreaterThanOrEqual(2);
      expect(res.every((r) => r.passed)).toBe(true);
    }
  });

  it('keeps optional usage ingestion synchronous and non-blocking during a simulated runner control-parse loop (FR-008)', () => {
    const queue = new PendingUsageIngestionQueue({ maxItems: 8, maxBytes: 800 });
    let controlRecordsParsed = 0;

    for (let step = 0; step < 32; step += 1) {
      // Simulate runner control record parse followed by synchronous usage offer
      controlRecordsParsed += 1;
      const outcome = queue.offer({
        key: step % 2 === 0 ? 'provisional-stream' : `unique-${step}`,
        tokens: 15,
        bytes: 100,
        provisional: step % 2 === 0
      });
      expect(['accepted', 'coalesced', 'refused-coverage-gap']).toContain(outcome.status);
    }

    expect(controlRecordsParsed).toBe(32);
    expect(queue.state.items).toBe(8);
    expect(queue.state.coalescedCount).toBeGreaterThan(0);
    expect(queue.state.coverageGapCount).toBeGreaterThan(0);
  });
});

