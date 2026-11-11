// FR-R6-F15 T008 — the opt-in policy: absent means no handoff, a newer version is preserved
// and refused, and every invalid shape is refused with a fixed code (FR-001, FR-020).
import { describe, expect, it } from 'vitest';

import type { ContextSelector, HandoffPolicy } from '../../../src/contracts/phase-context/context-policy';
import { parseHandoffPolicy } from '../../../src/services/phase-context/policy';
import { policy, selector } from '../../fixtures/phase-context/builders';

function digestOfPolicy(value: unknown): string {
  const parsed = parseHandoffPolicy(value);
  if (parsed.kind !== 'valid') throw new Error(`expected a valid policy, got ${parsed.kind}`);
  return parsed.digestHex;
}

/** A policy of two selectors; the overrides change the policy and its first selector. */
function twoSelectors(overrides: Partial<HandoffPolicy> = {}, first: Partial<ContextSelector> = {}): HandoffPolicy {
  return policy({ selectors: [selector(first), selector({ selectorId: 'sel-b', sourceNodePath: 'b' })], ...overrides });
}

describe('parseHandoffPolicy', () => {
  it.each([
    ['undefined', undefined],
    ['null', null]
  ])('reads %s as no policy', (_label, value) => {
    expect(parseHandoffPolicy(value)).toEqual({ kind: 'absent' });
  });

  it('returns a valid policy rebuilt field by field', () => {
    const input = policy({
      approval: 'manual',
      session: 'reuse-when-qualified',
      selectors: [selector(), selector({ selectorId: 'sel-notes', sourceNodePath: 'notes', required: false, priority: 40 })]
    });
    const parsed = parseHandoffPolicy(input);
    expect(parsed.kind).toBe('valid');
    if (parsed.kind !== 'valid') return;
    expect(parsed.policy).toEqual(input);
    expect(parsed.policy).not.toBe(input);
    expect(parsed.digestHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts a policy with no selector', () => {
    expect(parseHandoffPolicy(policy({ selectors: [] })).kind).toBe('valid');
  });

  it('accepts 32 selectors and the priorities 0 and 99', () => {
    const selectors = Array.from({ length: 32 }, (_unused, index) =>
      selector({ selectorId: `sel-${String(index)}`, sourceNodePath: `node-${String(index)}`, priority: index === 0 ? 0 : 99 })
    );
    expect(parseHandoffPolicy(policy({ selectors })).kind).toBe('valid');
  });

  it('preserves and refuses a newer version', () => {
    const newer = { version: 2, approval: 'automatic', session: 'fresh', selectors: [], extra: { kept: true } };
    const parsed = parseHandoffPolicy(newer);
    expect(parsed).toEqual({ kind: 'unsupported-version', preserved: newer });
    if (parsed.kind === 'unsupported-version') expect(parsed.preserved).toBe(newer);
  });

  it.each<[string, unknown, string]>([
    ['text', 'policy', 'policy-shape'],
    ['an array', [policy()], 'policy-shape'],
    ['a class instance', new Date(0), 'policy-shape'],
    ['version 0', { ...policy(), version: 0 }, 'policy-version'],
    ['version 1.5', { ...policy(), version: 1.5 }, 'policy-version'],
    ['a text version', { ...policy(), version: '1' }, 'policy-version'],
    ['a missing version', { approval: 'automatic', session: 'fresh', selectors: [] }, 'policy-version'],
    ['an unknown key', { ...policy(), note: 'x' }, 'policy-shape'],
    ['a missing key', { version: 1, approval: 'automatic', selectors: [] }, 'policy-shape'],
    ['an unknown approval', { ...policy(), approval: 'never' }, 'approval'],
    ['an unknown session', { ...policy(), session: 'reuse' }, 'session'],
    ['selectors that are not a list', { ...policy(), selectors: {} }, 'selector-count'],
    [
      '33 selectors',
      {
        ...policy(),
        selectors: Array.from({ length: 33 }, (_unused, index) => selector({ selectorId: `sel-${String(index)}` }))
      },
      'selector-count'
    ],
    ['a selector that is not an object', { ...policy(), selectors: ['plan'] }, 'selector-shape'],
    ['a selector with an unknown key', { ...policy(), selectors: [{ ...selector(), note: 'x' }] }, 'selector-shape'],
    ['a bad selector identity', { ...policy(), selectors: [selector({ selectorId: 'has space' })] }, 'selector-id'],
    ['a bad node path', { ...policy(), selectors: [selector({ sourceNodePath: '../plan' })] }, 'selector-node-path'],
    ['a required flag that is not a boolean', { ...policy(), selectors: [{ ...selector(), required: 'yes' }] }, 'selector-required'],
    ['priority 100', { ...policy(), selectors: [selector({ priority: 100 })] }, 'selector-priority'],
    ['priority -1', { ...policy(), selectors: [selector({ priority: -1 })] }, 'selector-priority'],
    ['priority 1.5', { ...policy(), selectors: [selector({ priority: 1.5 })] }, 'selector-priority'],
    [
      'a duplicate selector identity',
      { ...policy(), selectors: [selector(), selector({ sourceNodePath: 'notes' })] },
      'selector-duplicate'
    ]
  ])('refuses %s', (_label, value, detail) => {
    expect(parseHandoffPolicy(value)).toEqual({ kind: 'invalid', detail });
  });

  it('refuses a policy whose field is read through an accessor', () => {
    const value = { ...policy() };
    Object.defineProperty(value, 'approval', { enumerable: true, get: () => 'automatic' });
    expect(parseHandoffPolicy(value)).toEqual({ kind: 'invalid', detail: 'policy-shape' });
  });

  it('gives equal policies one digest, whatever the key order', () => {
    const reordered = { selectors: [{ priority: 0, required: true, sourceNodePath: 'plan', selectorId: 'sel-plan' }], session: 'fresh', approval: 'automatic', version: 1 };
    expect(digestOfPolicy(reordered)).toBe(digestOfPolicy(policy()));
  });

  it.each<[string, unknown]>([
    ['the approval mode', twoSelectors({ approval: 'manual' })],
    ['the session policy', twoSelectors({ session: 'reuse-when-qualified' })],
    ['a selector identity', twoSelectors({}, { selectorId: 'sel-other' })],
    ['a source node path', twoSelectors({}, { sourceNodePath: 'other' })],
    ['a required flag', twoSelectors({}, { required: false })],
    ['a priority', twoSelectors({}, { priority: 1 })],
    ['the selector order', policy({ selectors: [...twoSelectors().selectors].reverse() })],
    ['the selector count', policy({ selectors: twoSelectors().selectors.slice(0, 1) })]
  ])('changes the digest with %s', (_label, changed) => {
    expect(digestOfPolicy(changed)).not.toBe(digestOfPolicy(twoSelectors()));
  });
});
