// Feature 195 (T047, FR-023, SC-014) — this feature adds no audit event type
// and does not alter the audit event vocabulary. The halt reaches the operator
// through the queue's own surface (`QueueStartFailure`'s `halted` variant),
// recomputed on every drain pass; a per-pass audit event would record the same
// unchanged fact repeatedly, and an episode-scoped one would need the stored
// halt state FR-003 forbids (see plan.md "The omission").
//
// Two directions:
//   1. No member of `ALL_AUDIT_EVENT_TYPES` names the halt or the failure
//      policy — a straightforward absence check on the composed vocabulary.
//   2. The drain's step 2a (the halt gate this feature added) never calls the
//      audit writer — scoped to that step's own source range, not the whole
//      file, because the coordinator's *other* steps legitimately do audit an
//      unrelated event (the feature-092 overlap audit) and a whole-file
//      assertion would either miss the point or fail on work this feature
//      did not touch.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ALL_AUDIT_EVENT_TYPES } from '../../src/contracts/audit-events';

const REPO_ROOT = resolve(__dirname, '..', '..');
const COORDINATOR_FILE = resolve(REPO_ROOT, 'src/services/auto-drain-coordinator.ts');

const HALT_VOCABULARY_FRAGMENTS = ['halt', 'queue-failure-policy', 'failurepolicy'];

/** The step 2a comment-and-code block, from its own marker to the next step's. */
function step2aSource(coordinator: string): string {
  const start = coordinator.indexOf('// Step 2a —');
  const end = coordinator.indexOf('// Step 3 —', start);
  if (start === -1 || end === -1) {
    throw new Error(
      `${COORDINATOR_FILE} no longer marks "Step 2a —"/"Step 3 —" the way this gate expects. ` +
        'If the drain steps were renumbered or reworded, update this gate in the same change.'
    );
  }
  return coordinator.slice(start, end);
}

describe('feature 195 introduces no audit event type', () => {
  it('no audit event type name mentions the halt or the failure policy', () => {
    const offending = ALL_AUDIT_EVENT_TYPES.filter((eventType) =>
      HALT_VOCABULARY_FRAGMENTS.some((fragment) => eventType.toLowerCase().includes(fragment))
    );
    expect(
      offending,
      'FR-023 forbids a new audit event type for this feature. The halt is reported through the ' +
        'queue surface, not the audit log.'
    ).toEqual([]);
  });

  it('the vocabulary is non-empty, so the check above is not vacuous', () => {
    expect(ALL_AUDIT_EVENT_TYPES.length).toBeGreaterThan(50);
  });
});

describe('the halt gate (drain step 2a) never writes an audit entry', () => {
  const step2a = step2aSource(readFileSync(COORDINATOR_FILE, 'utf8'));

  it('calls no audit writer', () => {
    expect(/auditWriter|appendOverlapAudit|\.append\(/.test(step2a)).toBe(false);
  });

  it('the scoped slice is the halt step, not an empty or mismatched range', () => {
    expect(step2a).toContain('evaluateQueueHalt');
  });
});
