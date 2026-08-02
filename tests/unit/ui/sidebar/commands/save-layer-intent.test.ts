import { describe, expect, it } from 'vitest';
import {
  authoredEqual,
  definitionMap,
  identityRepairTarget,
  LAYER_ID_PATTERN,
  layerDiff,
  layerIdentities,
  layerShapeMatches,
  mutationMatches,
  stableAuthoredJson,
  withHostVersions,
  type LayerIntentAdapter,
  type LayerMutationIntent
} from '../../../../../src/ui/sidebar/commands/save-layer-intent';

interface Toy {
  readonly id: string;
  readonly name: string;
  readonly version: number;
}

const adapter: LayerIntentAdapter<Toy> = {
  sourceIdentity: (row, index) => {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      const value = row as Record<string, unknown>;
      const id = typeof value.id === 'string' ? value.id.trim() : '';
      if (id) return id;
    }
    return `?invalid-${index + 1}`;
  },
  identityOf: (definition) => definition.id,
  // Mirrors the real validators: a row whose id violates the shared pattern does
  // not parse, so it never enters the definition map. That is what makes an
  // identity repair (renaming an unaddressable row) observable as a pure
  // addition rather than a remove + add pair.
  parse: (row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const value = row as Record<string, unknown>;
    if (typeof value.id !== 'string' || typeof value.name !== 'string') return null;
    if (!LAYER_ID_PATTERN.test(value.id)) return null;
    const version =
      Number.isSafeInteger(value.version) && (value.version as number) > 0
        ? (value.version as number)
        : 1;
    return { id: value.id, name: value.name, version };
  }
};

const row = (id: string, name = id, version = 1) => ({ id, name, version });
const toy = (id: string, name = id, version = 1): Toy => ({ id, name, version });

const intent = (
  kind: LayerMutationIntent['kind'],
  targetId: string | null = null
): LayerMutationIntent => ({ kind, targetId });

const identitiesOf = (rows: readonly unknown[]) => layerIdentities(rows, adapter);

describe('stableAuthoredJson / authoredEqual', () => {
  it('is stable across key order and ignores undefined values', () => {
    expect(stableAuthoredJson({ a: 1, b: 2, c: undefined })).toBe(
      stableAuthoredJson({ b: 2, a: 1 })
    );
  });

  it('excludes version so a version bump alone is not an authored change', () => {
    expect(authoredEqual(toy('a', 'A', 1), toy('a', 'A', 9))).toBe(true);
    expect(authoredEqual(toy('a', 'A', 1), toy('a', 'B', 1))).toBe(false);
  });

  it('compares nested structures element-wise', () => {
    expect(stableAuthoredJson({ list: [1, { z: 1, a: 2 }] })).toBe(
      stableAuthoredJson({ list: [1, { a: 2, z: 1 }] })
    );
    expect(stableAuthoredJson({ list: [1, 2] })).not.toBe(stableAuthoredJson({ list: [2, 1] }));
  });
});

describe('layerIdentities', () => {
  it('counts each identity and collects its declared versions', () => {
    const identities = identitiesOf([row('a', 'A', 1), row('a', 'A2', 3), row('b')]);
    expect(identities.counts.get('a')).toBe(2);
    expect(identities.counts.get('b')).toBe(1);
    expect([...(identities.versions.get('a') ?? [])].sort()).toEqual([1, 3]);
  });

  it('defaults a missing or invalid version to 1 and synthesizes an id', () => {
    const identities = identitiesOf([{ id: 'a', name: 'A' }, null]);
    expect([...(identities.versions.get('a') ?? [])]).toEqual([1]);
    expect(identities.counts.get('?invalid-2')).toBe(1);
  });
});

describe('layerDiff', () => {
  it('reports added, removed, and authored-changed ids', () => {
    const current = definitionMap([toy('keep'), toy('drop'), toy('edit', 'Before')], adapter);
    const proposed = definitionMap([toy('keep'), toy('edit', 'After'), toy('new')], adapter);
    expect(layerDiff(current, proposed)).toEqual({
      added: ['new'],
      removed: ['drop'],
      changed: ['edit']
    });
  });

  it('does not report a version-only change', () => {
    const current = definitionMap([toy('a', 'A', 1)], adapter);
    const proposed = definitionMap([toy('a', 'A', 2)], adapter);
    expect(layerDiff(current, proposed).changed).toEqual([]);
  });
});

describe('mutationMatches', () => {
  const match = (
    mutation: LayerMutationIntent,
    currentRows: readonly unknown[],
    proposedRows: readonly unknown[]
  ) => {
    const current = definitionMap(
      currentRows.map((r) => adapter.parse(r)).filter((d): d is Toy => d !== null),
      adapter
    );
    const proposed = definitionMap(
      proposedRows.map((r) => adapter.parse(r)).filter((d): d is Toy => d !== null),
      adapter
    );
    return mutationMatches(
      mutation,
      layerDiff(current, proposed),
      proposed.size,
      identitiesOf(currentRows).counts,
      identitiesOf(proposedRows).counts
    );
  };

  it('accepts a create that adds exactly the declared id', () => {
    expect(match(intent('create', 'new'), [row('a')], [row('a'), row('new')])).toBe(true);
  });

  it('rejects a create whose declared id already exists', () => {
    expect(match(intent('create', 'a'), [row('a')], [row('a'), row('b')])).toBe(false);
  });

  it('rejects a create that also changes an untouched row', () => {
    expect(
      match(intent('create', 'new'), [row('a', 'A')], [row('a', 'Changed'), row('new')])
    ).toBe(false);
  });

  it('accepts a duplicate the same way it accepts a create', () => {
    expect(match(intent('duplicate', 'copy'), [row('a')], [row('a'), row('copy')])).toBe(true);
  });

  it('accepts an edit confined to the declared id', () => {
    expect(match(intent('edit', 'a'), [row('a', 'Before')], [row('a', 'After')])).toBe(true);
  });

  it('rejects an edit that touches a second id', () => {
    expect(
      match(
        intent('edit', 'a'),
        [row('a', 'Before'), row('b', 'B')],
        [row('a', 'After'), row('b', 'Changed')]
      )
    ).toBe(false);
  });

  it('rejects an edit that removes the declared id outright', () => {
    expect(match(intent('edit', 'a'), [row('a')], [])).toBe(false);
  });

  it('accepts a remove that drops exactly one copy of the declared id', () => {
    expect(match(intent('remove', 'b'), [row('a'), row('b')], [row('a')])).toBe(true);
  });

  it('accepts a remove that leaves a surviving duplicate', () => {
    expect(match(intent('remove', 'a'), [row('a'), row('a', 'A2')], [row('a', 'A2')])).toBe(true);
  });

  it('rejects a remove that drops an id it did not declare', () => {
    expect(match(intent('remove', 'b'), [row('a'), row('b')], [row('b')])).toBe(false);
  });

  it('accepts a reset only when the proposed layer is empty', () => {
    expect(match(intent('reset'), [row('a')], [])).toBe(true);
    expect(match(intent('reset'), [row('a')], [row('a')])).toBe(false);
  });
});

describe('layerShapeMatches', () => {
  it('requires an empty proposed layer for reset', () => {
    expect(layerShapeMatches(intent('reset'), [row('a')], [], null, adapter)).toBe(true);
    expect(layerShapeMatches(intent('reset'), [row('a')], [row('a')], null, adapter)).toBe(false);
  });

  it('accepts a create inserted at any position', () => {
    expect(
      layerShapeMatches(intent('create', 'new'), [row('a'), row('b')], [row('new'), row('a'), row('b')], null, adapter)
    ).toBe(true);
    expect(
      layerShapeMatches(intent('create', 'new'), [row('a'), row('b')], [row('a'), row('b'), row('new')], null, adapter)
    ).toBe(true);
  });

  it('rejects a create that also reorders the surrounding rows', () => {
    expect(
      layerShapeMatches(intent('create', 'new'), [row('a'), row('b')], [row('b'), row('a'), row('new')], null, adapter)
    ).toBe(false);
  });

  it('accepts a remove of any one matching row', () => {
    expect(
      layerShapeMatches(intent('remove', 'b'), [row('a'), row('b'), row('c')], [row('a'), row('c')], null, adapter)
    ).toBe(true);
  });

  it('accepts an edit in place and honours an identity-repair target', () => {
    expect(
      layerShapeMatches(intent('edit', 'a'), [row('a', 'Before')], [row('a', 'After')], null, adapter)
    ).toBe(true);
    expect(
      layerShapeMatches(intent('edit', 'BAD ID'), [row('BAD ID'), row('b')], [row('good'), row('b')], 'good', adapter)
    ).toBe(true);
  });
});

describe('identityRepairTarget', () => {
  const repair = (
    mutation: LayerMutationIntent,
    currentRows: readonly unknown[],
    proposedRows: readonly unknown[]
  ) => {
    const current = definitionMap(
      currentRows.map((r) => adapter.parse(r)).filter((d): d is Toy => d !== null),
      adapter
    );
    const proposed = definitionMap(
      proposedRows.map((r) => adapter.parse(r)).filter((d): d is Toy => d !== null),
      adapter
    );
    return identityRepairTarget(
      mutation,
      identitiesOf(currentRows).counts,
      identitiesOf(proposedRows).counts,
      layerDiff(current, proposed)
    );
  };

  it('detects renaming a pattern-invalid id to a legal one', () => {
    expect(repair(intent('edit', 'BAD ID'), [row('BAD ID')], [row('good')])).toBe('good');
  });

  it('detects de-duplicating one copy of a repeated id', () => {
    expect(repair(intent('edit', 'dup'), [row('dup'), row('dup', 'D2')], [row('dup'), row('fixed', 'D2')])).toBe(
      'fixed'
    );
  });

  it('returns null for an edit of a single legal id', () => {
    expect(repair(intent('edit', 'a'), [row('a', 'Before')], [row('a', 'After')])).toBeNull();
  });

  it('returns null for non-edit mutations', () => {
    expect(repair(intent('create', 'BAD ID'), [row('BAD ID')], [row('good')])).toBeNull();
    expect(repair(intent('remove', 'BAD ID'), [row('BAD ID')], [row('good')])).toBeNull();
  });

  it('returns null when the rename is accompanied by another change', () => {
    expect(
      repair(intent('edit', 'BAD ID'), [row('BAD ID'), row('b', 'B')], [row('good'), row('b', 'Changed')])
    ).toBeNull();
  });

  it('returns null when more than one id is added', () => {
    expect(repair(intent('edit', 'BAD ID'), [row('BAD ID')], [row('good'), row('extra')])).toBeNull();
  });
});

describe('withHostVersions', () => {
  const versioned = (
    mutation: LayerMutationIntent,
    currentRows: readonly unknown[],
    proposedRows: readonly unknown[]
  ) => {
    const currentDefs = currentRows
      .map((r) => adapter.parse(r))
      .filter((d): d is Toy => d !== null);
    const identities = identitiesOf(currentRows);
    return withHostVersions(
      proposedRows.map((r) => adapter.parse(r)).filter((d): d is Toy => d !== null),
      definitionMap(currentDefs, adapter),
      identities.counts,
      identities.versions,
      mutation,
      adapter
    );
  };

  it('holds the version steady when no authored field changed', () => {
    expect(versioned(intent('edit', 'a'), [row('a', 'A', 4)], [row('a', 'A', 4)])[0].version).toBe(
      4
    );
  });

  it('increments the version when an authored field changed', () => {
    expect(
      versioned(intent('edit', 'a'), [row('a', 'Before', 4)], [row('a', 'After', 4)])[0].version
    ).toBe(5);
  });

  it('starts a brand-new id at version 1', () => {
    const result = versioned(intent('create', 'new'), [row('a')], [row('a'), row('new')]);
    expect(result.find((entry) => entry.id === 'new')?.version).toBe(1);
  });

  it('resurrects a previously removed id above its highest known version', () => {
    const identities = identitiesOf([row('a', 'A', 7)]);
    const result = withHostVersions(
      [toy('a', 'Revived', 7)],
      new Map(),
      identities.counts,
      identities.versions,
      intent('create', 'a'),
      adapter
    );
    expect(result[0].version).toBe(8);
  });

  it('preserves the source version of a surviving duplicate under edit', () => {
    const result = versioned(
      intent('edit', 'dup'),
      [row('dup', 'One', 2), row('dup', 'Two', 5)],
      [row('dup', 'Two', 5)]
    );
    expect(result[0].version).toBe(5);
  });

  it('preserves the source version of a surviving duplicate under remove', () => {
    const result = versioned(
      intent('remove', 'dup'),
      [row('dup', 'One', 2), row('dup', 'Two', 5)],
      [row('dup', 'Two', 5)]
    );
    expect(result[0].version).toBe(5);
  });

  it('freezes every returned definition', () => {
    const result = versioned(intent('edit', 'a'), [row('a', 'Before')], [row('a', 'After')]);
    expect(Object.isFrozen(result[0])).toBe(true);
  });
});
