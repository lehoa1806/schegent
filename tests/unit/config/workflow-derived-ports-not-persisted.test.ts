// Feature 102 (T029, US3 — FR-018) — derived ports are computed on read and are
// never written down.
//
// `deriveWorkflowPorts` answers "which of this graph's node ports does no
// connection satisfy". The answer is a function of the graph, so storing it beside
// the graph creates a second copy that the graph can move out from under: a
// connection added in the Builder changes the true answer and leaves the stored
// one behind, and the trigger form then asks for a value the run already has —
// or, worse, stops asking for one it does not. FR-018 forbids the second copy
// rather than trying to keep the two in step.
//
// The sibling suite covers what the derivation computes. This one covers where
// the result is allowed to go, and it asks that in two ways because either alone
// is weak:
//
//   * **Structurally** — the derivation's importers are enumerated, and the write
//     path is swept for the vocabulary. A behavioural test can only catch a
//     persisted port on a path it happens to exercise; a scan catches the import
//     the moment it is written, which is the moment the question should be asked.
//
//   * **Behaviourally** — a Workflow is published through the real store on
//     in-memory ports, and every byte that lands is inspected. A scan can be
//     satisfied by a module that spells the field some other way; the bytes
//     cannot.
//
// The second half of the rule — that opening the trigger form N times writes
// nothing — is the same claim from the other end: the form's port list comes from
// a projection, and a projection that touched storage would make reading a
// Workflow a write. Asserted here by deriving N times against a live store and
// counting the port calls, which is the host-side shape of "opened N times".

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { draftTokenOf, NO_DRAFT } from '../../../src/contracts/catalog-lifecycle';
import type { PipelineDefinition } from '../../../src/contracts/pipeline-definitions';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';
import { deriveWorkflowPorts } from '../../../src/config/workflow-derived-ports';
import { createTestStore, type TestStore } from '../../fixtures/catalog-memory-fs';

const SRC_DIR = resolve(__dirname, '../../../src');
const CATALOG_DIR = join(SRC_DIR, 'catalog');

/**
 * Every module allowed to ask what a graph's unsatisfied ports are.
 *
 * All three are read-side: two build the sidebar snapshot and one builds the
 * launch projection off it. The list is exhaustive on purpose — a fourth importer
 * fails this test, and the fix is to add it here *after* confirming it is a read.
 * A guard that quietly admitted new callers would guard nothing.
 */
const PERMITTED_IMPORTERS: readonly string[] = [
  // FR-R3-132 (T1502) — `ui/sidebar/snapshot.ts` was on this list for a PROSE
  // mention, not a call: the check is `code.includes('deriveWorkflowPorts')`, and
  // the only occurrence in that file was a JSDoc sentence explaining where the
  // derivation happens. When the declaration carrying that sentence moved to
  // `src/contracts/snapshot-projections.ts`, the mention moved with it and the
  // entry moved too. Neither file calls the function.
  //
  // Worth saying rather than silently swapping: a textual check cannot tell a
  // mention from a call, so this list has always mixed the two. It still holds the
  // invariant it exists for — the derivation reaches no storage path — because a
  // module of type declarations has no storage path to reach.
  'contracts/snapshot-projections.ts',
  'ui/sidebar/launch-projection.ts',
  'ui/sidebar/workflow-catalog-projector.ts'
];

/** How the projection spells a derived port list. Neither may reach storage. */
const DERIVED_FIELDS: readonly string[] = ['derivedInputs', 'derivedOutputs'];

function sourcesUnder(root: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...sourcesUnder(path));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}

const PIPELINE: PipelineDefinition = {
  pipelineId: 'standard',
  name: 'Standard',
  version: 1,
  phaseIds: ['plan'],
  inputs: [
    { portId: 'brief', label: 'Brief', type: 'text' },
    { portId: 'repo', label: 'Repository', type: 'repository-context' }
  ],
  outputs: [{ portId: 'plan', label: 'Plan', type: 'markdown' }],
  bindings: [],
  recommendedNext: []
};

/** Two nodes, one connection: some ports are satisfied and some are not. */
const GRAPH: WorkflowDefinition = {
  workflowId: 'research',
  name: 'Research',
  version: 1,
  nodes: [
    { nodeId: 'design', pipelineId: 'standard' },
    { nodeId: 'build', pipelineId: 'standard' }
  ],
  connections: [
    { from: { nodeId: 'design', portId: 'plan' }, to: { nodeId: 'build', portId: 'brief' } }
  ],
  startNodeIds: ['design']
};

async function publishGraph(test: TestStore): Promise<void> {
  const draft = await test.store.applyLifecycleWrite({
    op: 'save-draft',
    kind: 'workflow',
    id: GRAPH.workflowId,
    body: GRAPH,
    expectedDraftVersion: NO_DRAFT
  });
  if (draft.outcome !== 'written') throw new Error(`draft refused: ${draft.outcome}`);

  const published = await test.store.applyLifecycleWrite({
    op: 'publish',
    kind: 'workflow',
    id: GRAPH.workflowId,
    expectedDraftVersion: draftTokenOf(draft.draftVersionId)
  });
  if (published.outcome !== 'written') throw new Error(`publish refused: ${published.outcome}`);
}

describe('the derivation is read-side only (FR-018)', () => {
  it('is imported by the projection modules and by nothing else', () => {
    const importers = sourcesUnder(SRC_DIR)
      .filter((path) => !path.endsWith('workflow-derived-ports.ts'))
      .filter((path) => readFileSync(path, 'utf8').includes('deriveWorkflowPorts'))
      .map((path) => relative(SRC_DIR, path).split('\\').join('/'))
      .sort();

    expect(importers).toEqual([...PERMITTED_IMPORTERS].sort());
  });

  it('leaves no trace of the derived vocabulary anywhere in the store', () => {
    const offenders = sourcesUnder(CATALOG_DIR)
      .map((path) => ({ path, code: readFileSync(path, 'utf8') }))
      .filter(({ code }) => DERIVED_FIELDS.some((field) => code.includes(field)))
      .map(({ path }) => relative(SRC_DIR, path));

    expect(offenders).toEqual([]);
  });

  it('sweeps a directory that is actually there', () => {
    // A recursive walk that matched nothing would pass both scans above in
    // silence, which is the failure mode a structural test is most prone to.
    expect(sourcesUnder(CATALOG_DIR).length).toBeGreaterThan(5);
    expect(sourcesUnder(SRC_DIR).length).toBeGreaterThan(50);
  });
});

describe('what a published Workflow leaves on disk (FR-018)', () => {
  it('stores the graph and no port list computed from it', async () => {
    const test = createTestStore();
    await publishGraph(test);

    const written = [...test.fs.files.values()].join('\n');

    // The graph is there — otherwise the assertion below would hold vacuously
    // against a store that wrote nothing at all.
    expect(written).toContain('"design"');
    expect(written).toContain('"connections"');
    for (const field of DERIVED_FIELDS) expect(written).not.toContain(field);
    // And not under any other spelling either: `build.brief` is satisfied by the
    // one connection, so a stored port list would have to name the three that
    // are not, `repo` among them on both nodes.
    expect(written).not.toContain('"unsatisfied"');
    expect(written).not.toContain('"ports"');
  });

  it('records the same bytes however many times the ports are derived', async () => {
    const test = createTestStore();
    await publishGraph(test);
    const afterPublish = JSON.stringify([...test.fs.files.entries()]);
    const writesAfterPublish = test.fs.writeCalls.length;

    for (let open = 0; open < 5; open += 1) {
      const { inputs, outputs } = deriveWorkflowPorts(GRAPH, [PIPELINE]);
      // Non-vacuity: a derivation that returned nothing would write nothing too.
      expect(inputs.length).toBeGreaterThan(0);
      expect(outputs.length).toBeGreaterThan(0);
    }

    expect(test.fs.writeCalls.length).toBe(writesAfterPublish);
    expect(JSON.stringify([...test.fs.files.entries()])).toBe(afterPublish);
  });

  it('touches no port of any kind while deriving', async () => {
    const test = createTestStore();
    await publishGraph(test);
    const before = test.fs.calls.length;

    for (let open = 0; open < 5; open += 1) deriveWorkflowPorts(GRAPH, [PIPELINE]);

    // Not even a read: the graph the form derives from is already in the
    // snapshot, and a projection that went back to storage per open would make
    // looking at a Workflow cost a disk round-trip per keystroke of interest.
    expect(test.fs.calls.length).toBe(before);
  });
});
