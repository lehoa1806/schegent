// Feature 101 (FR-R3-017) T009 — the changed-field summary between a draft and
// the Active version it would replace (FR-008, FR-009).
//
// Two things here are easy to get wrong in ways that pass a casual test.
//
// The first is the no-prior-version arm. A first publish compared against `null`
// by the ordinary path reports every field as an addition, which is technically
// true and useless: the operator is told their whole definition changed when what
// actually happened is that there was nothing to change from. FR-009 makes that a
// distinct result, so the tests below assert the *arm*, never merely that the
// field list is non-empty.
//
// The second is `reordered` under an insertion. Inserting one entry at the front
// of a four-entry list shifts the absolute index of every entry behind it. An
// implementation comparing absolute indices reports one addition and three
// reorderings, and the one change that matters is buried under its own
// consequences. The rule is relative order *among the entries the two bodies
// share*, which is why the insertion cases below assert `reordered` is EMPTY
// rather than asserting it merely omits the inserted entry.

import { describe, expect, it } from 'vitest';
import { compareForPublish } from '../../../src/catalog/changed-fields';
import type { ChangedCollectionField, ChangedFieldSummary } from '../../../src/catalog/changed-fields';

function fieldsOf(summary: ChangedFieldSummary): Record<string, unknown> {
  expect(summary.kind).toBe('changed');
  if (summary.kind !== 'changed') throw new Error('unreachable');
  return Object.fromEntries(summary.fields.map((field) => [field.field, field]));
}

function collection(summary: ChangedFieldSummary, name: string): ChangedCollectionField {
  const found = fieldsOf(summary)[name];
  expect(found, `expected a change entry for ${name}`).toBeDefined();
  const field = found as ChangedCollectionField;
  expect(field.change).toBe('collection');
  return field;
}

const PIPELINE = {
  pipelineId: 'ship',
  name: 'Ship it',
  version: 1,
  phaseIds: ['plan', 'build', 'test'],
  bindings: [
    { kind: 'input', phaseIndex: 0, inputKey: 'spec', source: { from: 'pipeline-input', portId: 'brief' } },
    { kind: 'output', phaseIndex: 2, portId: 'report', outputKey: 'result' }
  ]
};

describe('compareForPublish: the three arms', () => {
  it('reports no-prior-version rather than listing every field as added', () => {
    const summary = compareForPublish(PIPELINE, null);
    expect(summary).toEqual({ kind: 'no-prior-version' });
  });

  it('reports no-prior-version even for an empty draft, because the arm is about the absence of an active version', () => {
    expect(compareForPublish({}, null)).toEqual({ kind: 'no-prior-version' });
  });

  it('reports unchanged when the bodies are content-identical', () => {
    expect(compareForPublish(PIPELINE, structuredClone(PIPELINE))).toEqual({ kind: 'unchanged' });
  });

  it('reports unchanged when the bodies differ only in key order', () => {
    const reordered = { version: 1, name: 'Ship it', pipelineId: 'ship', phaseIds: PIPELINE.phaseIds, bindings: PIPELINE.bindings };
    expect(compareForPublish(reordered, PIPELINE)).toEqual({ kind: 'unchanged' });
  });

  it('treats a present-but-undefined field as absent, matching the canonical form the store hashes', () => {
    expect(compareForPublish({ ...PIPELINE, description: undefined }, PIPELINE)).toEqual({ kind: 'unchanged' });
  });
});

describe('compareForPublish: unordered top-level fields', () => {
  it('names a scalar field that differs, and says nothing more about it', () => {
    const summary = compareForPublish({ ...PIPELINE, name: 'Ship it faster' }, PIPELINE);
    expect(summary).toEqual({ kind: 'changed', fields: [{ field: 'name', change: 'differs' }] });
  });

  it('names a field the draft adds', () => {
    const summary = compareForPublish({ ...PIPELINE, description: 'now documented' }, PIPELINE);
    expect(fieldsOf(summary)).toHaveProperty('description');
  });

  it('names a field the draft drops', () => {
    const withDescription = { ...PIPELINE, description: 'was documented' };
    const summary = compareForPublish(PIPELINE, withDescription);
    expect(fieldsOf(summary)).toHaveProperty('description');
  });

  it('names every differing field, not only the first', () => {
    const summary = compareForPublish({ ...PIPELINE, name: 'other', version: 2 }, PIPELINE);
    expect(Object.keys(fieldsOf(summary)).sort()).toEqual(['name', 'version']);
  });
});

describe('compareForPublish: phaseIds', () => {
  it('names an added entry', () => {
    const summary = compareForPublish({ ...PIPELINE, phaseIds: ['plan', 'build', 'test', 'deploy'] }, PIPELINE);
    const field = collection(summary, 'phaseIds');
    expect(field.added).toEqual(['deploy']);
    expect(field.removed).toEqual([]);
    expect(field.reordered).toEqual([]);
  });

  it('names a removed entry', () => {
    const summary = compareForPublish({ ...PIPELINE, phaseIds: ['plan', 'test'] }, PIPELINE);
    const field = collection(summary, 'phaseIds');
    expect(field.added).toEqual([]);
    expect(field.removed).toEqual(['build']);
    expect(field.reordered).toEqual([]);
  });

  it('names both entries of a swap as reordered', () => {
    const summary = compareForPublish({ ...PIPELINE, phaseIds: ['plan', 'test', 'build'] }, PIPELINE);
    const field = collection(summary, 'phaseIds');
    expect(field.added).toEqual([]);
    expect(field.removed).toEqual([]);
    expect(field.reordered.slice().sort()).toEqual(['build', 'test']);
  });

  it('reports an insertion at the front as one addition and NO reorderings', () => {
    const summary = compareForPublish({ ...PIPELINE, phaseIds: ['bootstrap', 'plan', 'build', 'test'] }, PIPELINE);
    const field = collection(summary, 'phaseIds');
    expect(field.added).toEqual(['bootstrap']);
    expect(field.reordered).toEqual([]);
  });

  it('reports a removal from the front as one removal and NO reorderings', () => {
    const summary = compareForPublish({ ...PIPELINE, phaseIds: ['build', 'test'] }, PIPELINE);
    const field = collection(summary, 'phaseIds');
    expect(field.removed).toEqual(['plan']);
    expect(field.reordered).toEqual([]);
  });

  it('reports an addition and a genuine reordering together', () => {
    const summary = compareForPublish({ ...PIPELINE, phaseIds: ['plan', 'test', 'build', 'deploy'] }, PIPELINE);
    const field = collection(summary, 'phaseIds');
    expect(field.added).toEqual(['deploy']);
    expect(field.reordered.slice().sort()).toEqual(['build', 'test']);
  });

  it('does not report an entry as reordered when it is already named in added', () => {
    // `build` twice in the draft: one occurrence is an addition, and the extra
    // copy shifts the other. FR-008's exclusion is what stops the same entry
    // being reported under two headings the operator must reconcile.
    const summary = compareForPublish({ ...PIPELINE, phaseIds: ['plan', 'build', 'build', 'test'] }, PIPELINE);
    const field = collection(summary, 'phaseIds');
    expect(field.added).toEqual(['build']);
    expect(field.reordered).not.toContain('build');
  });

  it('does not report an entry as reordered when it is already named in removed', () => {
    const twice = { ...PIPELINE, phaseIds: ['plan', 'build', 'build', 'test'] };
    const summary = compareForPublish(PIPELINE, twice);
    const field = collection(summary, 'phaseIds');
    expect(field.removed).toEqual(['build']);
    expect(field.reordered).not.toContain('build');
  });
});

describe('compareForPublish: bindings, nodes, and connections', () => {
  it('names bindings by what they bind rather than by position', () => {
    const swapped = { ...PIPELINE, bindings: [PIPELINE.bindings[1], PIPELINE.bindings[0]] };
    const field = collection(compareForPublish(swapped, PIPELINE), 'bindings');
    expect(field.added).toEqual([]);
    expect(field.removed).toEqual([]);
    // Both arms are named by what they FILL — `inputKey` and `outputKey`. The
    // output arm's `portId` is the Phase port it reads from, the counterpart of
    // the input arm's `source`, so keying on it would make a rewired binding read
    // as a different binding.
    expect(field.reordered.slice().sort()).toEqual(['input:0.spec', 'output:2.result']);
  });

  it('names an added binding', () => {
    const extra = {
      ...PIPELINE,
      bindings: [
        ...PIPELINE.bindings,
        { kind: 'input', phaseIndex: 1, inputKey: 'plan', source: { from: 'phase-output', phaseIndex: 0, portId: 'out' } }
      ]
    };
    const field = collection(compareForPublish(extra, PIPELINE), 'bindings');
    expect(field.added).toEqual(['input:1.plan']);
  });

  it('names a binding whose content changed in place under no heading, leaving the field named with all three empty', () => {
    // The summary has exactly three buckets and no "modified" one. A binding
    // that keeps its identity and changes its source is therefore reported by
    // the field appearing at all — which is never wrong, and says precisely
    // "something inside this list changed without entering or leaving it".
    const rewired = {
      ...PIPELINE,
      bindings: [
        { kind: 'input', phaseIndex: 0, inputKey: 'spec', source: { from: 'pipeline-input', portId: 'other' } },
        PIPELINE.bindings[1]
      ]
    };
    const field = collection(compareForPublish(rewired, PIPELINE), 'bindings');
    expect(field.added).toEqual([]);
    expect(field.removed).toEqual([]);
    expect(field.reordered).toEqual([]);
  });

  it('names nodes by nodeId', () => {
    const active = { workflowId: 'w', nodes: [{ nodeId: 'a', pipelineId: 'p' }, { nodeId: 'b', pipelineId: 'q' }] };
    const draft = { workflowId: 'w', nodes: [{ nodeId: 'a', pipelineId: 'p' }, { nodeId: 'c', pipelineId: 'r' }] };
    const field = collection(compareForPublish(draft, active), 'nodes');
    expect(field.added).toEqual(['c']);
    expect(field.removed).toEqual(['b']);
  });

  it('names connections by their two endpoints, which is the only identity they have', () => {
    const edge = (fromNode: string, toNode: string) => ({
      from: { nodeId: fromNode, portId: 'out' },
      to: { nodeId: toNode, portId: 'in' }
    });
    const active = { workflowId: 'w', connections: [edge('a', 'b'), edge('b', 'c')] };
    const draft = { workflowId: 'w', connections: [edge('a', 'b'), edge('b', 'd')] };
    const field = collection(compareForPublish(draft, active), 'connections');
    expect(field.added).toEqual(['b.out->d.in']);
    expect(field.removed).toEqual(['b.out->c.in']);
  });

  it('keeps two differently-malformed bindings apart rather than keying both "undefined"', () => {
    // Found in review. `bindingKey` read `String(entry.inputKey)` unguarded, so
    // every input binding missing its key was named `input:undefined.undefined`.
    // The consequence is not an ugly label: `taggedKeys` treats a shared key as a
    // repeat of one entry, so a *removed* broken binding and an *added* broken
    // binding cancel — and the collection reports that nothing entered or left it
    // when both did. The docstring on `entryKey` already promised the canonical
    // fallback these arms were skipping.
    const active = { pipelineId: 'p', bindings: [{ kind: 'input', phaseIndex: 0, note: 'left' }] };
    const draft = { pipelineId: 'p', bindings: [{ kind: 'input', phaseIndex: 0, note: 'right' }] };
    const field = collection(compareForPublish(draft, active), 'bindings');
    expect(field.added).toHaveLength(1);
    expect(field.removed).toHaveLength(1);
    expect(field.added[0]).not.toEqual(field.removed[0]);
    expect(field.added[0]).not.toContain('undefined');
  });

  it('keeps two differently-malformed connections apart for the same reason', () => {
    const active = { workflowId: 'w', connections: [{ from: { nodeId: 'a' }, to: 'x' }] };
    const draft = { workflowId: 'w', connections: [{ from: { nodeId: 'b' }, to: 'y' }] };
    const field = collection(compareForPublish(draft, active), 'connections');
    expect(field.added).toHaveLength(1);
    expect(field.removed).toHaveLength(1);
    expect(field.added[0]).not.toEqual(field.removed[0]);
    expect(field.added[0]).not.toContain('undefined');
  });

  it('falls back to naming the field when an ordered collection is not a list at all', () => {
    // The store never validates a body (099 FR-010), so `phaseIds` can be
    // anything. Entry-level detail is impossible for a non-list; reporting the
    // field as simply differing is the honest answer and keeps the summary from
    // inventing entries.
    const summary = compareForPublish({ ...PIPELINE, phaseIds: 'plan,build' }, PIPELINE);
    expect(fieldsOf(summary).phaseIds).toEqual({ field: 'phaseIds', change: 'differs' });
  });
});

describe('compareForPublish: bodies that are not objects', () => {
  it('reports a changed summary with no named fields when a body is not an object', () => {
    const summary = compareForPublish('a string body', PIPELINE);
    expect(summary).toEqual({ kind: 'changed', fields: [] });
  });

  it('reports unchanged for two identical non-object bodies', () => {
    expect(compareForPublish(7, 7)).toEqual({ kind: 'unchanged' });
  });

  it('reports a changed summary rather than a throw for an array body', () => {
    expect(compareForPublish([1, 2], [1, 3])).toEqual({ kind: 'changed', fields: [] });
  });
});
