// FR-R6-F15 T010 — the identity of one handoff: lineage values only, and one digest whatever
// the order the source attempts arrive in (FR-002).
import { describe, expect, it } from 'vitest';

import type { HandoffIdentity } from '../../../src/contracts/phase-context/context-policy';
import { compareProducers, handoffIdOf, parseHandoffIdentity } from '../../../src/services/phase-context/identity';
import { identity, producer } from '../../fixtures/phase-context/builders';

const THREE = [producer('review', 'occ-2', 'att-9'), producer('plan', 'occ-1', 'att-1'), producer('plan', 'occ-1', 'att-0')];

function idOf(value: unknown): string {
  const parsed = parseHandoffIdentity(value);
  if (!parsed.ok) throw new Error(`expected a valid identity, got ${parsed.detail}`);
  return parsed.handoffId;
}

describe('parseHandoffIdentity', () => {
  it('returns the identity with its source attempts sorted and its digest', () => {
    const parsed = parseHandoffIdentity(identity({ sourceAttempts: THREE }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.identity.sourceAttempts).toEqual([
      producer('plan', 'occ-1', 'att-0'),
      producer('plan', 'occ-1', 'att-1'),
      producer('review', 'occ-2', 'att-9')
    ]);
    expect(parsed.handoffId).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.handoffId).toBe(handoffIdOf(parsed.identity));
  });

  it('gives one identity whatever the order of the source attempts', () => {
    const reversed = [...THREE].reverse();
    expect(idOf(identity({ sourceAttempts: reversed }))).toBe(idOf(identity({ sourceAttempts: THREE })));
  });

  it.each<[string, Partial<HandoffIdentity>]>([
    ['the workspace', { workspaceId: 'workspace-2' }],
    ['the root execution', { rootExecutionId: 'root-2' }],
    ['the source invocation', { sourceInvocationId: 'frame-2' }],
    ['the target node path', { targetNodePath: 'implement/2' }],
    ['the target occurrence', { targetOccurrenceId: 'occ-2' }],
    ['the input revision', { inputEnvelopeRevision: 2 }],
    ['a source attempt', { sourceAttempts: [producer('plan', 'occ-1', 'att-other')] }],
    ['a source occurrence', { sourceAttempts: [producer('plan', 'occ-9', 'att-plan')] }],
    ['a source node path', { sourceAttempts: [producer('plan2', 'occ-1', 'att-plan')] }],
    ['one more source attempt', { sourceAttempts: [producer('plan', 'occ-1', 'att-plan'), producer('notes')] }]
  ])('changes with %s', (_label, overrides) => {
    expect(idOf(identity(overrides))).not.toBe(idOf(identity()));
  });

  it('does not let two fields trade a separator', () => {
    const left = identity({ workspaceId: 'a', rootExecutionId: 'b-c' });
    const right = identity({ workspaceId: 'a-b', rootExecutionId: 'c' });
    expect(idOf(left)).not.toBe(idOf(right));
  });

  it('accepts 32 source attempts', () => {
    const sourceAttempts = Array.from({ length: 32 }, (_unused, index) => producer(`node-${String(index)}`));
    expect(parseHandoffIdentity(identity({ sourceAttempts })).ok).toBe(true);
  });

  it.each<[string, unknown, string]>([
    ['text', 'identity', 'identity-shape'],
    ['an unknown key', { ...identity(), name: 'x' }, 'identity-shape'],
    ['a missing key', { workspaceId: 'workspace-1' }, 'identity-shape'],
    ['a bad workspace identity', identity({ workspaceId: 'has space' }), 'identity-field'],
    ['an empty root execution', identity({ rootExecutionId: '' }), 'identity-field'],
    ['a source invocation of 129 characters', identity({ sourceInvocationId: 'a'.repeat(129) }), 'identity-field'],
    ['a bad target node path', identity({ targetNodePath: '/implement' }), 'identity-field'],
    ['a bad target occurrence', identity({ targetOccurrenceId: 'occ/1' }), 'identity-field'],
    ['input revision 0', identity({ inputEnvelopeRevision: 0 }), 'identity-field'],
    ['a fractional input revision', identity({ inputEnvelopeRevision: 1.5 }), 'identity-field'],
    ['no source attempt', identity({ sourceAttempts: [] }), 'source-attempt-count'],
    [
      '33 source attempts',
      identity({ sourceAttempts: Array.from({ length: 33 }, (_unused, index) => producer(`node-${String(index)}`)) }),
      'source-attempt-count'
    ],
    ['source attempts that are not a list', { ...identity(), sourceAttempts: 'plan' }, 'source-attempt-count'],
    ['a source attempt with a bad attempt identity', identity({ sourceAttempts: [producer('plan', 'occ-1', 'att 1')] }), 'source-attempt'],
    ['a source attempt with an unknown key', { ...identity(), sourceAttempts: [{ ...producer(), extra: 1 }] }, 'source-attempt'],
    ['a duplicate source attempt', identity({ sourceAttempts: [producer(), producer()] }), 'source-attempt-duplicate']
  ])('refuses %s as an invalid source', (_label, value, detail) => {
    expect(parseHandoffIdentity(value)).toEqual({ ok: false, failure: 'invalid-source', detail });
  });
});

describe('compareProducers', () => {
  it('orders by node path, then occurrence, then attempt, by code unit', () => {
    const sorted = [...THREE, producer('Plan', 'occ-1', 'att-1')].sort(compareProducers);
    expect(sorted.map((entry) => `${entry.nodePath}/${entry.occurrenceId}/${entry.attemptId}`)).toEqual([
      'Plan/occ-1/att-1',
      'plan/occ-1/att-0',
      'plan/occ-1/att-1',
      'review/occ-2/att-9'
    ]);
  });

  it('is zero for equal producers', () => {
    expect(compareProducers(producer(), producer())).toBe(0);
  });
});
