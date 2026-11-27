// Feature 195 (T046, FR-011, SC-009) — this feature adds a per-queue failure
// *policy* and a derived *halt verdict*, neither of which is a `QueueLifecycle`
// value. The halt is reported through `QueueStartFailure`, the same channel an
// admission refusal already used; it does not touch the lifecycle projection.
//
// This gate re-derives the union's member count from its own declaration
// rather than trusting a comment, so a fifth value added anywhere — by this
// feature or a later one that forgets the invariant — fails here instead of
// only in the narrower literal-allowlist gates.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const VOCABULARY_FILE = resolve(REPO_ROOT, 'src/contracts/snapshot-vocabulary.ts');

/** The string-literal members of the `export type QueueLifecycle = ...;` union. */
function queueLifecycleMembers(source: string): readonly string[] {
  const declaration = /export type QueueLifecycle =\s*([\s\S]*?);/.exec(source);
  if (declaration === null) return [];
  return [...declaration[1]!.matchAll(/'([a-z-]+)'/g)].map((match) => match[1]!);
}

describe('QueueLifecycle stays a four-value projection after feature 195', () => {
  const members = queueLifecycleMembers(readFileSync(VOCABULARY_FILE, 'utf8'));

  it('the declaration is still found', () => {
    expect(
      members.length,
      `${VOCABULARY_FILE} no longer declares QueueLifecycle as a plain string-literal union this ` +
        'gate can parse. If the declaration changed shape, update this gate in the same change.'
    ).toBeGreaterThan(0);
  });

  it('carries exactly four values', () => {
    expect(members).toEqual(['running', 'operator-paused', 'idle-pending', 'active-empty']);
  });

  it('the two feature-195 policy values are not among them', () => {
    // The failure-policy vocabulary and the lifecycle vocabulary are
    // deliberately distinct sets (research.md D1): a queue's failure policy
    // is operator intent, a lifecycle value is a derived projection.
    expect(members).not.toContain('halt-on-failure');
    expect(members).not.toContain('continue');
    expect(members).not.toContain('halted');
  });
});
