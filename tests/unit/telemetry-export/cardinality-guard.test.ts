// FR-R6-F14 T010 — the attribute-set limit: 999 ordinary sets per instrument in first-seen
// order, then the overflow set, for one exporter lifetime (FR-006).
import { describe, expect, it } from 'vitest';

import { TELEMETRY_EXPORT_BOUNDS } from '../../../src/contracts/telemetry-export';
import {
  OVERFLOW_ATTRIBUTES,
  attributeSetKey,
  createCardinalityGuard
} from '../../../src/services/telemetry-export/cardinality-guard';
import type { Attribute } from '../../../src/services/telemetry-export/metadata-mapper';

const ORDINARY_SETS = TELEMETRY_EXPORT_BOUNDS.attributeSetsMax - 1;

function setOf(index: number): readonly Attribute[] {
  return [['gen_ai.request.model', `model-${index}`]];
}

describe('attributeSetKey', () => {
  it('is equal for equal sets and differs for different ones', () => {
    expect(attributeSetKey(setOf(1))).toBe(attributeSetKey(setOf(1)));
    expect(attributeSetKey(setOf(1))).not.toBe(attributeSetKey(setOf(2)));
    expect(attributeSetKey([])).not.toBe(attributeSetKey(setOf(1)));
  });

  it('cannot be made to collide by a value that looks like a separator', () => {
    const joined: readonly Attribute[] = [['a', 'x","b":"y']];
    const separate: readonly Attribute[] = [
      ['a', 'x'],
      ['b', 'y']
    ];
    expect(attributeSetKey(joined)).not.toBe(attributeSetKey(separate));
  });
});

describe('attributeSetKey: a list met before', () => {
  it('gives a frozen list the key of an equal list that is not frozen', () => {
    const frozen: readonly Attribute[] = Object.freeze([Object.freeze(['gen_ai.request.model', 'model-1'] as const)]);
    expect(attributeSetKey(frozen)).toBe(attributeSetKey(setOf(1)));
    expect(attributeSetKey(frozen)).toBe(attributeSetKey(setOf(1)));
  });

  it('reads a list again when the list can still change', () => {
    const list: [string, string][] = [['gen_ai.request.model', 'model-1']];
    const before = attributeSetKey(list);
    list.splice(0, 1, ['gen_ai.request.model', 'model-2']);
    expect(attributeSetKey(list)).not.toBe(before);
    expect(attributeSetKey(list)).toBe(attributeSetKey(setOf(2)));
  });

  it('reads a frozen list again when one of its entries can still change', () => {
    const entry: [string, string] = ['gen_ai.request.model', 'model-1'];
    const list: readonly Attribute[] = Object.freeze([entry]);
    const before = attributeSetKey(list);
    entry.splice(1, 1, 'model-2');
    expect(attributeSetKey(list)).not.toBe(before);
    expect(attributeSetKey(list)).toBe(attributeSetKey(setOf(2)));
  });
});

describe('createCardinalityGuard', () => {
  it('admits 999 ordinary sets and folds the next new one into the overflow set', () => {
    const guard = createCardinalityGuard();
    expect(ORDINARY_SETS).toBe(999);
    for (let index = 0; index < ORDINARY_SETS; index += 1) {
      expect(guard.admit('token-usage', setOf(index))).toBe('admitted');
    }
    expect(guard.admit('token-usage', setOf(ORDINARY_SETS))).toBe('overflow');
    expect(guard.admit('token-usage', setOf(ORDINARY_SETS + 1))).toBe('overflow');
    expect(guard.size('token-usage')).toBe(ORDINARY_SETS);
  });

  it('still admits a set seen before the limit was reached', () => {
    const guard = createCardinalityGuard();
    for (let index = 0; index < ORDINARY_SETS; index += 1) guard.admit('cost', setOf(index));
    expect(guard.admit('cost', setOf(ORDINARY_SETS))).toBe('overflow');
    expect(guard.admit('cost', setOf(0))).toBe('admitted');
    expect(guard.admit('cost', setOf(ORDINARY_SETS - 1))).toBe('admitted');
  });

  it('does not remember a set it folded, so the fold is counted every time', () => {
    const guard = createCardinalityGuard();
    for (let index = 0; index < ORDINARY_SETS; index += 1) guard.admit('cost', setOf(index));
    const folded = Array.from({ length: 3 }, () => guard.admit('cost', setOf(5000)));
    expect(folded).toEqual(['overflow', 'overflow', 'overflow']);
  });

  it('keeps one limit per instrument', () => {
    const guard = createCardinalityGuard();
    for (let index = 0; index < ORDINARY_SETS; index += 1) guard.admit('token-usage', setOf(index));
    expect(guard.admit('token-usage', setOf(ORDINARY_SETS))).toBe('overflow');
    expect(guard.admit('operation-duration', setOf(ORDINARY_SETS))).toBe('admitted');
    expect(guard.size('operation-duration')).toBe(1);
    expect(guard.size('cache-tokens')).toBe(0);
  });

  it('counts a repeated set once', () => {
    const guard = createCardinalityGuard();
    for (let repeat = 0; repeat < 50; repeat += 1) expect(guard.admit('cost', setOf(1))).toBe('admitted');
    expect(guard.size('cost')).toBe(1);
  });

  it('takes a smaller limit for a test', () => {
    const guard = createCardinalityGuard(3);
    expect([0, 1, 2, 3].map((index) => guard.admit('cost', setOf(index)))).toEqual(['admitted', 'admitted', 'overflow', 'overflow']);
  });

  it('names the overflow set', () => {
    expect(OVERFLOW_ATTRIBUTES).toEqual([['otel.metric.overflow', true]]);
    expect(Object.isFrozen(OVERFLOW_ATTRIBUTES)).toBe(true);
  });
});
