// Feature 086 T018 — the export closure walk, level 1 (test-first).
//
// A Workflow package's `included` order is not alphabetical and not the caller's
// resolution order: it is **authored reference order** (FR-021, data-model.md
// §2.4). `pipelines` follows first-occurrence order across `spec.nodes`. Deriving
// it here, from the graph, rather than accepting whatever sequence the resolver
// happened to build, is what makes two exports of an unchanged catalog produce
// byte-identical documents — the caller cannot perturb the order because it does
// not supply it.
//
// De-duplication is by identifier and happens at FIRST occurrence, which is the
// only choice that is both idempotent and order-preserving: last-occurrence
// de-duplication would move a Pipeline's position in the document when a later
// node referenced it again, changing the bytes without changing the catalog.
//
// The walk is a PROJECTION. Two nodes naming the same Pipeline yield one
// definition and stay two nodes with their own identities (FR-017, FR-062) — the
// document carries a lookup table beside the graph, never a graph rewritten to
// deduplicate itself. `referencedPhaseOrder` in `pipeline-document.ts` is the
// same rule one level down, and this file deliberately mirrors its shape rather
// than inventing a second convention.

import { describe, expect, it } from 'vitest';

import type { PipelineDefinition } from '../../../src/contracts/pipeline-definitions';
import type { WorkflowNode } from '../../../src/contracts/workflow-definitions';
import {
  referencedPhaseClosure,
  referencedPipelineOrder
} from '../../../src/services/process-yaml/workflow-export-closure';

function node(nodeId: string, pipelineId: string): WorkflowNode {
  return { nodeId, pipelineId };
}

function pipeline(pipelineId: string, phaseIds: readonly string[]): PipelineDefinition {
  return {
    pipelineId,
    name: pipelineId,
    version: 1,
    phaseIds,
    inputs: [],
    outputs: [],
    bindings: [],
    recommendedNext: []
  };
}

describe('referencedPipelineOrder (level 1)', () => {
  it('returns distinct pipelineIds in first-occurrence order across the nodes', () => {
    const nodes = [node('a', 'draft'), node('b', 'review'), node('c', 'ship')];
    expect(referencedPipelineOrder(nodes)).toEqual(['draft', 'review', 'ship']);
  });

  it('is authored order, not alphabetical (FR-021)', () => {
    // Sorted output would be the same for every permutation of the graph, which
    // is determinism of the wrong kind: it would also be the same for a graph the
    // operator deliberately reordered.
    const nodes = [node('a', 'zulu'), node('b', 'alpha'), node('c', 'mike')];
    expect(referencedPipelineOrder(nodes)).toEqual(['zulu', 'alpha', 'mike']);
  });

  it('includes a Pipeline named by two nodes exactly once (FR-017)', () => {
    const nodes = [node('a', 'draft'), node('b', 'draft')];
    expect(referencedPipelineOrder(nodes)).toEqual(['draft']);
  });

  it('de-duplicates at first occurrence, so a repeat does not move it (FR-021)', () => {
    const nodes = [node('a', 'draft'), node('b', 'review'), node('c', 'draft')];
    expect(referencedPipelineOrder(nodes)).toEqual(['draft', 'review']);
  });

  it('leaves the nodes untouched — two nodes on one Pipeline stay two (FR-062)', () => {
    const nodes = [node('first', 'draft'), node('second', 'draft'), node('third', 'review')];
    const before = JSON.stringify(nodes);

    expect(referencedPipelineOrder(nodes)).toEqual(['draft', 'review']);
    // The projection is read-only: the graph the document writes beside the
    // lookup table still holds both nodes, each with its own identity.
    expect(JSON.stringify(nodes)).toBe(before);
    expect(nodes.map((entry) => entry.nodeId)).toEqual(['first', 'second', 'third']);
  });

  it('is stable across repeated calls on the same graph (FR-021, SC-006)', () => {
    const nodes = [node('a', 'review'), node('b', 'draft'), node('c', 'review')];
    expect(referencedPipelineOrder(nodes)).toEqual(referencedPipelineOrder(nodes));
  });

  it('is idempotent — re-walking its own result changes nothing', () => {
    const nodes = [node('a', 'draft'), node('b', 'review'), node('c', 'draft')];
    const once = referencedPipelineOrder(nodes);
    const twice = referencedPipelineOrder(once.map((pipelineId, index) => node(`n${index}`, pipelineId)));
    expect(twice).toEqual(once);
  });

  it('returns nothing for a graph with no nodes', () => {
    // Unreachable from a valid Workflow — `nodes` is required and a Workflow with
    // none is a defect, not an empty graph (data-model.md §2.5). Asserted anyway
    // so the walk answers with an empty list rather than throwing if a caller ever
    // reaches it before validation.
    expect(referencedPipelineOrder([])).toEqual([]);
  });
});

// Feature 086 T024 — level 2 (test-first).
//
// The second level is a second walk over the Pipelines the first one yielded, not
// a generalization of it: the input is `PipelineDefinition[]` in the order level 1
// fixed, and the output is the distinct Phases they name in first-occurrence order
// across their CONCATENATED `phaseIds` (FR-019, FR-020).
//
// De-duplication is closure-wide, not per-Pipeline. Two Pipelines naming the same
// Phase must yield one definition, because the document is one lookup table and a
// second copy of the same Phase would put the same identifier at two positions
// with no rule for which one a reader takes.
//
// One seen-set spanning the level, but a SEPARATE one from level 1's: a Pipeline
// and a Phase may legitimately share an identifier, since they are different
// resource kinds in different sections. A literally shared set would drop the
// Phase from the closure and produce a package that does not resolve — the exact
// failure a self-contained export exists to prevent.
describe('referencedPhaseClosure (level 2)', () => {
  it('returns distinct phaseIds in first-occurrence order across the Pipelines', () => {
    const pipelines = [pipeline('draft', ['outline', 'write']), pipeline('review', ['critique'])];
    expect(referencedPhaseClosure(pipelines)).toEqual(['outline', 'write', 'critique']);
  });

  it('follows the order the Pipelines were given, which is level 1 output (FR-019)', () => {
    // Level 1 fixed this order from `spec.nodes`; level 2 must not re-derive or
    // re-sort it, or the two sections of one document would disagree about which
    // Pipeline came first.
    const forward = [pipeline('draft', ['outline']), pipeline('review', ['critique'])];
    const reversed = [pipeline('review', ['critique']), pipeline('draft', ['outline'])];

    expect(referencedPhaseClosure(forward)).toEqual(['outline', 'critique']);
    expect(referencedPhaseClosure(reversed)).toEqual(['critique', 'outline']);
  });

  it('is authored order, not alphabetical (FR-020, FR-021)', () => {
    const pipelines = [pipeline('draft', ['zulu', 'alpha']), pipeline('review', ['mike'])];
    expect(referencedPhaseClosure(pipelines)).toEqual(['zulu', 'alpha', 'mike']);
  });

  it('includes a Phase two Pipelines both name exactly once (FR-019)', () => {
    const pipelines = [
      pipeline('draft', ['shared', 'write']),
      pipeline('review', ['shared', 'critique'])
    ];
    expect(referencedPhaseClosure(pipelines)).toEqual(['shared', 'write', 'critique']);
  });

  it('de-duplicates closure-wide, not per-Pipeline', () => {
    // Per-Pipeline de-duplication would answer ['a','b','a'] here: correct within
    // each Pipeline and wrong for the document, which holds one lookup table.
    const pipelines = [pipeline('one', ['a', 'b']), pipeline('two', ['a']), pipeline('three', ['b'])];
    expect(referencedPhaseClosure(pipelines)).toEqual(['a', 'b']);
  });

  it('de-duplicates a Phase repeated inside one Pipeline as well (FR-015)', () => {
    // A sequence may legitimately run the same Phase twice; the lookup table
    // still carries it once, and both positions keep naming it.
    const pipelines = [pipeline('draft', ['write', 'review', 'write'])];
    expect(referencedPhaseClosure(pipelines)).toEqual(['write', 'review']);
  });

  it('de-duplicates at first occurrence, so a repeat does not move it (FR-021)', () => {
    const pipelines = [
      pipeline('one', ['a', 'b']),
      pipeline('two', ['c']),
      pipeline('three', ['a'])
    ];
    expect(referencedPhaseClosure(pipelines)).toEqual(['a', 'b', 'c']);
  });

  it('keeps a Phase whose id matches a Pipeline id — the levels do not share a set', () => {
    // Different resource kinds in different sections of the document, so the same
    // spelling is two distinct resources. Sharing one seen-set across the levels
    // would silently drop this Phase and export a package that cannot resolve.
    const pipelines = [pipeline('build', ['build', 'ship'])];
    expect(referencedPipelineOrder([node('a', 'build')])).toEqual(['build']);
    expect(referencedPhaseClosure(pipelines)).toEqual(['build', 'ship']);
  });

  it('leaves the Pipelines untouched — the walk is a projection', () => {
    const pipelines = [pipeline('draft', ['a', 'b']), pipeline('review', ['a'])];
    const before = JSON.stringify(pipelines);

    expect(referencedPhaseClosure(pipelines)).toEqual(['a', 'b']);
    expect(JSON.stringify(pipelines)).toBe(before);
  });

  it('is stable across repeated calls and idempotent (FR-021, SC-006)', () => {
    const pipelines = [pipeline('one', ['b', 'a']), pipeline('two', ['b'])];
    const once = referencedPhaseClosure(pipelines);

    expect(referencedPhaseClosure(pipelines)).toEqual(once);
    // Re-walking the result as a single Pipeline's sequence changes nothing.
    expect(referencedPhaseClosure([pipeline('flattened', once)])).toEqual(once);
  });

  it('terminates by construction, with no depth limit to reach (FR-020)', () => {
    // A Phase references nothing, so the closure is exactly two levels deep and
    // there is no recursion to bound. A Phase named after the Pipeline that names
    // it is not a cycle and must not be treated as one: nothing re-enters level 1,
    // so the walk cannot revisit and needs no visited-guard beyond the per-level
    // seen-set that de-duplicates output.
    const pipelines = [pipeline('loop', ['loop']), pipeline('other', ['loop', 'tail'])];
    expect(referencedPhaseClosure(pipelines)).toEqual(['loop', 'tail']);
  });

  it('returns nothing for no Pipelines, and nothing for Pipelines that name no Phase', () => {
    // The second case is reachable: a placeholder Pipeline carries `phaseIds: []`,
    // and a references-only export supplies no Pipelines at all.
    expect(referencedPhaseClosure([])).toEqual([]);
    expect(referencedPhaseClosure([pipeline('empty', [])])).toEqual([]);
  });
});
