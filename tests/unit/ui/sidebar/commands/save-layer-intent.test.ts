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
  workflowIntentAdapter,
  type LayerIntentAdapter,
  type LayerMutationIntent
} from '../../../../../src/ui/sidebar/commands/save-layer-intent';
import type { WorkflowDefinition } from '../../../../../src/contracts/workflow-definitions';

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

/** Feature 085 — the package intent names a SET and no single target. */
const packageIntent = (...targetIds: readonly string[]): LayerMutationIntent => ({
  kind: 'import-package',
  targetId: null,
  targetIds
});

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

  // Feature 085 T042 (FR-036, research R5). One write appends every eligible
  // resource at once, so the intent names the whole set rather than one id.
  describe('import-package', () => {
    it('accepts an append of exactly the declared set', () => {
      expect(
        match(packageIntent('one', 'two'), [row('a')], [row('a'), row('one'), row('two')])
      ).toBe(true);
    });

    it('accepts a single-resource package, and an append to an empty layer', () => {
      expect(match(packageIntent('one'), [row('a')], [row('a'), row('one')])).toBe(true);
      expect(match(packageIntent('one', 'two'), [], [row('one'), row('two')])).toBe(true);
    });

    it('rejects an unnamed row added alongside the declared set', () => {
      expect(
        match(packageIntent('one'), [row('a')], [row('a'), row('one'), row('stowaway')])
      ).toBe(false);
    });

    it('rejects a declared target that is absent from the proposal', () => {
      expect(match(packageIntent('one', 'two'), [row('a')], [row('a'), row('one')])).toBe(false);
    });

    it('rejects a declared target the current layer already claims (FR-030)', () => {
      expect(match(packageIntent('a'), [row('a')], [row('a'), row('a', 'A2')])).toBe(false);
    });

    it('rejects a package that also removes a row', () => {
      expect(match(packageIntent('one'), [row('a'), row('b')], [row('a'), row('one')])).toBe(false);
    });

    it('rejects a package that also changes a row', () => {
      expect(
        match(packageIntent('one'), [row('a', 'A')], [row('a', 'Changed'), row('one')])
      ).toBe(false);
    });

    it('rejects a package that also duplicates an untouched id', () => {
      expect(
        match(packageIntent('one'), [row('a')], [row('a'), row('a'), row('one')])
      ).toBe(false);
    });

    it('rejects a package that appends its own target twice', () => {
      expect(
        match(packageIntent('one'), [row('a')], [row('a'), row('one'), row('one', 'One2')])
      ).toBe(false);
    });

    it('rejects a declared set that repeats an id, and an empty declared set', () => {
      expect(match(packageIntent('one', 'one'), [row('a')], [row('a'), row('one')])).toBe(false);
      expect(match(packageIntent(), [row('a')], [row('a')])).toBe(false);
    });

    it('rejects the intent when `targetIds` is missing entirely', () => {
      expect(
        match({ kind: 'import-package', targetId: null }, [row('a')], [row('a'), row('one')])
      ).toBe(false);
    });
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

  // Feature 085 T042 — deleting the added rows from the proposal must reproduce
  // the current layer IN ORDER, so a package import cannot silently reorder the
  // layer it appends to.
  describe('import-package', () => {
    const shape = (
      mutation: LayerMutationIntent,
      currentRows: readonly unknown[],
      proposedRows: readonly unknown[]
    ) => layerShapeMatches(mutation, currentRows, proposedRows, null, adapter);

    it('accepts the declared rows inserted at any position', () => {
      expect(shape(packageIntent('one', 'two'), [row('a'), row('b')], [row('a'), row('b'), row('one'), row('two')])).toBe(true);
      expect(shape(packageIntent('one', 'two'), [row('a'), row('b')], [row('one'), row('a'), row('two'), row('b')])).toBe(true);
    });

    it('rejects a package that also reorders the surrounding rows', () => {
      expect(shape(packageIntent('one'), [row('a'), row('b')], [row('b'), row('a'), row('one')])).toBe(false);
    });

    it('rejects a package that also drops a surrounding row', () => {
      expect(shape(packageIntent('one'), [row('a'), row('b')], [row('a'), row('one')])).toBe(false);
    });

    it('rejects a package that also rewrites a surrounding row', () => {
      expect(shape(packageIntent('one'), [row('a', 'A')], [row('a', 'Changed'), row('one')])).toBe(false);
    });

    it('rejects an empty declared set', () => {
      expect(shape(packageIntent(), [row('a')], [row('a')])).toBe(false);
    });
  });
});

/**
 * Feature 085 T042 — the five pre-existing kinds are unchanged by the new one.
 * A `targetIds` field is `import-package`-only: attaching it to a legacy kind
 * must not alter that kind's behavior in either gate.
 */
describe('the pre-085 mutation kinds are unaffected by targetIds', () => {
  const withIds = (mutation: LayerMutationIntent): LayerMutationIntent => ({
    ...mutation,
    targetIds: ['smuggled']
  });

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

  it.each([
    ['create', intent('create', 'new'), [row('a')], [row('a'), row('new')], true],
    ['duplicate', intent('duplicate', 'copy'), [row('a')], [row('a'), row('copy')], true],
    ['edit', intent('edit', 'a'), [row('a', 'Before')], [row('a', 'After')], true],
    ['remove', intent('remove', 'b'), [row('a'), row('b')], [row('a')], true],
    ['reset', intent('reset'), [row('a')], [], true],
    ['create (spread)', intent('create', 'new'), [row('a', 'A')], [row('a', 'B'), row('new')], false]
  ] as const)('%s decides the same with and without targetIds', (_label, mutation, current, proposed, expected) => {
    expect(match(mutation, current, proposed)).toBe(expected);
    expect(match(withIds(mutation), current, proposed)).toBe(expected);
    expect(layerShapeMatches(withIds(mutation), current, proposed, null, adapter)).toBe(
      layerShapeMatches(mutation, current, proposed, null, adapter)
    );
  });

  it('never lets targetIds admit a row the declared kind forbids', () => {
    expect(match(withIds(intent('create', 'new')), [row('a')], [row('a'), row('new'), row('smuggled')])).toBe(
      false
    );
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

describe('workflowIntentAdapter', () => {
  const wf = (id: string, label = 'Design', version = 1): Record<string, unknown> => ({
    id,
    name: id,
    version,
    nodes: [{ nodeId: 'design', pipelineId: 'design-review', label }],
    connections: [],
    startNodeIds: ['design']
  });

  const parsed = (rows: readonly unknown[]) =>
    rows
      .map((r) => workflowIntentAdapter.parse(r))
      .filter((d): d is WorkflowDefinition => d !== null);

  const wfIdentities = (rows: readonly unknown[]) => layerIdentities(rows, workflowIntentAdapter);

  const wfDiff = (currentRows: readonly unknown[], proposedRows: readonly unknown[]) =>
    layerDiff(
      definitionMap(parsed(currentRows), workflowIntentAdapter),
      definitionMap(parsed(proposedRows), workflowIntentAdapter)
    );

  const match = (
    mutation: LayerMutationIntent,
    currentRows: readonly unknown[],
    proposedRows: readonly unknown[]
  ) =>
    mutationMatches(
      mutation,
      wfDiff(currentRows, proposedRows),
      parsed(proposedRows).length,
      wfIdentities(currentRows).counts,
      wfIdentities(proposedRows).counts
    );

  const versioned = (
    mutation: LayerMutationIntent,
    currentRows: readonly unknown[],
    proposedRows: readonly unknown[]
  ) => {
    const identities = wfIdentities(currentRows);
    return withHostVersions(
      parsed(proposedRows),
      definitionMap(parsed(currentRows), workflowIntentAdapter),
      identities.counts,
      identities.versions,
      mutation,
      workflowIntentAdapter
    );
  };

  describe('adapter surface', () => {
    it('reads the portable workflowId, falls back to the authored id, then synthesizes', () => {
      expect(workflowIntentAdapter.sourceIdentity({ workflowId: 'portable' }, 0)).toBe('portable');
      expect(workflowIntentAdapter.sourceIdentity({ id: ' legacy ' }, 0)).toBe('legacy');
      expect(workflowIntentAdapter.sourceIdentity(null, 2)).toBe('?invalid-3');
    });

    it('parses a well-formed row to its portable identity and rejects an unaddressable one', () => {
      const definition = workflowIntentAdapter.parse(wf('design-then-implement'));
      expect(definition).not.toBeNull();
      expect(workflowIntentAdapter.identityOf(definition!)).toBe('design-then-implement');
      expect(workflowIntentAdapter.parse(wf('BAD ID'))).toBeNull();
      expect(workflowIntentAdapter.parse({ id: 'no-nodes', name: 'No nodes' })).toBeNull();
    });

    it('accepts the legacy id key so an existing layer keeps parsing', () => {
      expect(workflowIntentAdapter.parse({ ...wf('legacy-keyed') })?.workflowId).toBe(
        'legacy-keyed'
      );
    });
  });

  describe('mutation kinds', () => {
    it('accepts a create that adds exactly the declared workflow', () => {
      expect(match(intent('create', 'ship'), [wf('draft')], [wf('draft'), wf('ship')])).toBe(true);
    });

    it('rejects a create that also edits an untouched workflow', () => {
      expect(
        match(intent('create', 'ship'), [wf('draft')], [wf('draft', 'Renamed'), wf('ship')])
      ).toBe(false);
    });

    it('accepts a duplicate as a pure addition of the copy id', () => {
      expect(match(intent('duplicate', 'draft-copy'), [wf('draft')], [wf('draft'), wf('draft-copy')])).toBe(
        true
      );
    });

    it('accepts an edit confined to the declared workflow and rejects one that spreads', () => {
      expect(match(intent('edit', 'draft'), [wf('draft', 'Before')], [wf('draft', 'After')])).toBe(
        true
      );
      expect(
        match(
          intent('edit', 'draft'),
          [wf('draft', 'Before'), wf('ship')],
          [wf('draft', 'After'), wf('ship', 'Also changed')]
        )
      ).toBe(false);
    });

    it('accepts a remove of exactly one declared workflow', () => {
      expect(match(intent('remove', 'ship'), [wf('draft'), wf('ship')], [wf('draft')])).toBe(true);
      expect(match(intent('remove', 'ship'), [wf('draft'), wf('ship')], [wf('ship')])).toBe(false);
    });

    it('accepts a reset only when the proposed layer is empty', () => {
      expect(match(intent('reset'), [wf('draft')], [])).toBe(true);
      expect(match(intent('reset'), [wf('draft')], [wf('draft')])).toBe(false);
    });

    it('rejects a create that silently reorders the surrounding rows', () => {
      expect(
        layerShapeMatches(
          intent('create', 'ship'),
          [wf('draft'), wf('review')],
          [wf('review'), wf('draft'), wf('ship')],
          null,
          workflowIntentAdapter
        )
      ).toBe(false);
      expect(
        layerShapeMatches(
          intent('create', 'ship'),
          [wf('draft'), wf('review')],
          [wf('draft'), wf('review'), wf('ship')],
          null,
          workflowIntentAdapter
        )
      ).toBe(true);
    });
  });

  /**
   * Feature 086 T047 (FR-003, FR-036, FR-044). The Workflow layer binds the
   * entity-agnostic package intent with no new algebra: one write appends every
   * eligible Workflow at once, so the intent names the whole SET rather than a
   * single id. These assertions are the Workflow-layer half of the same
   * guarantees 085 pinned for Phases and Pipelines — kept here, next to
   * `workflowIntentAdapter`, so a future change to the adapter's parse or
   * identity cannot pass the generic suite while breaking the third write.
   */
  describe('import-package', () => {
    const shape = (
      mutation: LayerMutationIntent,
      currentRows: readonly unknown[],
      proposedRows: readonly unknown[]
    ) => layerShapeMatches(mutation, currentRows, proposedRows, null, workflowIntentAdapter);

    it('accepts an append of exactly the declared set', () => {
      expect(
        match(packageIntent('one', 'two'), [wf('draft')], [wf('draft'), wf('one'), wf('two')])
      ).toBe(true);
    });

    it('accepts a single-workflow package, and an append to an empty layer', () => {
      expect(match(packageIntent('one'), [wf('draft')], [wf('draft'), wf('one')])).toBe(true);
      expect(match(packageIntent('one', 'two'), [], [wf('one'), wf('two')])).toBe(true);
    });

    it('rejects an unnamed workflow added alongside the declared set', () => {
      expect(
        match(packageIntent('one'), [wf('draft')], [wf('draft'), wf('one'), wf('stowaway')])
      ).toBe(false);
    });

    it('rejects a declared target that is absent from the proposal', () => {
      expect(match(packageIntent('one', 'two'), [wf('draft')], [wf('draft'), wf('one')])).toBe(
        false
      );
    });

    // FR-030 at the algebra level: presence is decided by the planner's stored-row
    // scan, and this gate is the backstop — a target the layer already claims can
    // never arrive as an addition, so an import cannot overwrite authored work.
    it('rejects a declared target the current layer already claims', () => {
      expect(match(packageIntent('draft'), [wf('draft')], [wf('draft'), wf('draft', 'Second')])).toBe(
        false
      );
    });

    it('rejects a package that also removes a workflow', () => {
      expect(match(packageIntent('one'), [wf('draft'), wf('ship')], [wf('draft'), wf('one')])).toBe(
        false
      );
    });

    it('rejects a package that also changes a workflow', () => {
      expect(
        match(packageIntent('one'), [wf('draft', 'Before')], [wf('draft', 'After'), wf('one')])
      ).toBe(false);
    });

    it('rejects a package that appends its own target twice', () => {
      expect(
        match(packageIntent('one'), [wf('draft')], [wf('draft'), wf('one'), wf('one', 'Second')])
      ).toBe(false);
    });

    it('rejects a declared set that repeats an id, and an empty declared set', () => {
      expect(match(packageIntent('one', 'one'), [wf('draft')], [wf('draft'), wf('one')])).toBe(
        false
      );
      expect(match(packageIntent(), [wf('draft')], [wf('draft')])).toBe(false);
    });

    it('rejects the intent when `targetIds` is missing entirely', () => {
      expect(
        match({ kind: 'import-package', targetId: null }, [wf('draft')], [wf('draft'), wf('one')])
      ).toBe(false);
    });

    it('accepts the declared workflows inserted at any position', () => {
      expect(
        shape(
          packageIntent('one', 'two'),
          [wf('draft'), wf('review')],
          [wf('draft'), wf('review'), wf('one'), wf('two')]
        )
      ).toBe(true);
      expect(
        shape(
          packageIntent('one', 'two'),
          [wf('draft'), wf('review')],
          [wf('one'), wf('draft'), wf('two'), wf('review')]
        )
      ).toBe(true);
    });

    it('rejects a package that also reorders the surrounding workflows', () => {
      expect(
        shape(packageIntent('one'), [wf('draft'), wf('review')], [wf('review'), wf('draft'), wf('one')])
      ).toBe(false);
    });

    it('rejects a package that also drops or rewrites a surrounding workflow', () => {
      expect(shape(packageIntent('one'), [wf('draft'), wf('review')], [wf('draft'), wf('one')])).toBe(
        false
      );
      expect(
        shape(packageIntent('one'), [wf('draft', 'Before')], [wf('draft', 'After'), wf('one')])
      ).toBe(false);
    });

    // The algebra deliberately knows nothing about a document's declared version:
    // an id absent from the current layer is brand new, so it starts at 1. That is
    // exactly why FR-003a's "keep the version the document declared" is restored a
    // layer up, in the command, the way `cmd-save-pipelines.ts` already does it.
    it('starts every imported workflow at host version 1, not the document version', () => {
      const result = versioned(
        packageIntent('one'),
        [wf('draft', 'Design', 3)],
        [wf('draft', 'Design', 3), wf('one', 'Design', 7)]
      );
      expect(result.find((entry) => entry.workflowId === 'one')?.version).toBe(1);
      expect(result.find((entry) => entry.workflowId === 'draft')?.version).toBe(3);
    });
  });

  // `targetIds` is `import-package`-only. Smuggling it onto one of the five
  // pre-existing kinds must leave that kind's behavior byte-for-byte unchanged in
  // both gates, so 086 cannot regress the Workflow saves 083 shipped.
  describe('the five existing kinds are unaffected by targetIds', () => {
    const withIds = (mutation: LayerMutationIntent): LayerMutationIntent => ({
      ...mutation,
      targetIds: ['smuggled']
    });

    it('leaves create, duplicate, edit, remove, and reset decisions unchanged', () => {
      expect(match(withIds(intent('create', 'ship')), [wf('draft')], [wf('draft'), wf('ship')])).toBe(
        true
      );
      expect(
        match(withIds(intent('create', 'ship')), [wf('draft')], [wf('draft'), wf('other')])
      ).toBe(false);
      expect(
        match(
          withIds(intent('duplicate', 'draft-copy')),
          [wf('draft')],
          [wf('draft'), wf('draft-copy')]
        )
      ).toBe(true);
      expect(
        match(withIds(intent('edit', 'draft')), [wf('draft', 'Before')], [wf('draft', 'After')])
      ).toBe(true);
      expect(match(withIds(intent('remove', 'ship')), [wf('draft'), wf('ship')], [wf('draft')])).toBe(
        true
      );
      expect(match(withIds(intent('reset')), [wf('draft')], [])).toBe(true);
    });

    it('leaves the shape gate unchanged for a legacy kind', () => {
      expect(
        layerShapeMatches(
          withIds(intent('create', 'ship')),
          [wf('draft'), wf('review')],
          [wf('review'), wf('draft'), wf('ship')],
          null,
          workflowIntentAdapter
        )
      ).toBe(false);
      expect(
        layerShapeMatches(
          withIds(intent('remove', 'review')),
          [wf('draft'), wf('review')],
          [wf('draft')],
          null,
          workflowIntentAdapter
        )
      ).toBe(true);
    });
  });

  describe('identity repair', () => {
    it('detects renaming a pattern-invalid workflow id to a legal one', () => {
      expect(
        identityRepairTarget(
          intent('edit', 'BAD ID'),
          wfIdentities([wf('BAD ID')]).counts,
          wfIdentities([wf('good-id')]).counts,
          wfDiff([wf('BAD ID')], [wf('good-id')])
        )
      ).toBe('good-id');
    });

    it('returns null for an edit of an already-addressable workflow', () => {
      expect(
        identityRepairTarget(
          intent('edit', 'draft'),
          wfIdentities([wf('draft', 'Before')]).counts,
          wfIdentities([wf('draft', 'After')]).counts,
          wfDiff([wf('draft', 'Before')], [wf('draft', 'After')])
        )
      ).toBeNull();
    });
  });

  describe('host version assignment', () => {
    it('holds the version steady when no authored field changed', () => {
      expect(versioned(intent('edit', 'draft'), [wf('draft', 'A', 4)], [wf('draft', 'A', 4)])[0].version).toBe(4);
    });

    it('ignores a version the save tried to dictate', () => {
      expect(versioned(intent('edit', 'draft'), [wf('draft', 'A', 4)], [wf('draft', 'A', 99)])[0].version).toBe(4);
    });

    it('increments by one when an authored field changed', () => {
      expect(
        versioned(intent('edit', 'draft'), [wf('draft', 'Before', 4)], [wf('draft', 'After', 4)])[0]
          .version
      ).toBe(5);
    });

    it('starts a brand-new workflow at version 1', () => {
      const result = versioned(intent('create', 'ship'), [wf('draft')], [wf('draft'), wf('ship')]);
      expect(result.find((entry) => entry.workflowId === 'ship')?.version).toBe(1);
    });

    it('freezes every returned definition', () => {
      const result = versioned(
        intent('edit', 'draft'),
        [wf('draft', 'Before')],
        [wf('draft', 'After')]
      );
      expect(Object.isFrozen(result[0])).toBe(true);
    });
  });
});
