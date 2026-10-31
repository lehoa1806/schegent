import { describe, expect, it } from 'vitest';

import { TRANSPORT_DRAIN_GRACE_MS } from '../../../src/monitor/cli-transport-sink';
import { HOST_DEACTIVATE_ALLOWANCE_MS, TEARDOWN_BOUND_MS } from '../../../src/runner/process-tree';

/**
 * FR-R4-F06 (FR-024; T26; contract S, S8; research R29) -- the teardown bound fits inside the
 * time the editor gives an extension to deactivate.
 *
 * VS Code and Antigravity IDE end the extension host after `Promise.race([timeout(5e3),
 * deactivateAll()])`. Shutdown spends the teardown bound waiting for the backend trees, then the
 * transport flush's grace, and only then releases leases and primacy. If the first two exceeded
 * the allowance, the host would be ended before ownership was released, which is the failure this
 * feature exists to remove. So the relation lives in code, not in two literals that a later edit
 * can move apart (hard rule 20's form).
 *
 * The numbers are asserted too: a bound changed on purpose must change here on purpose, with the
 * derivation in `process-tree.ts` updated beside it.
 */
describe('the teardown bound fits the host allowance (T26)', () => {
  it('is the ladder\'s two delays plus 250 ms of slack: 2,750 ms', () => {
    expect(TEARDOWN_BOUND_MS).toBe(2_750);
    expect(TEARDOWN_BOUND_MS).toBe(2_000 + 500 + 250);
  });

  it('leaves room for the transport flush inside the allowance the editor gives', () => {
    expect(HOST_DEACTIVATE_ALLOWANCE_MS).toBe(5_000);
    expect(TEARDOWN_BOUND_MS + TRANSPORT_DRAIN_GRACE_MS).toBeLessThan(HOST_DEACTIVATE_ALLOWANCE_MS);
  });

  it('leaves room for the lease and lock writes that follow (TA15)', () => {
    const remaining = HOST_DEACTIVATE_ALLOWANCE_MS - (TEARDOWN_BOUND_MS + TRANSPORT_DRAIN_GRACE_MS);
    expect(remaining).toBe(250);
    expect(remaining).toBeGreaterThan(0);
  });
});
