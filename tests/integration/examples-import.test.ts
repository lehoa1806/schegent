// FR-R3-132 (T1504, FR-003) — the shipped example set parses, and cannot rot.
//
// THE ITEM'S PREMISE WAS PARTLY WRONG, and correcting it is most of the value
// here. The audit found that *"no sample Phase/Pipeline/Workflow definitions exist
// under `repo/docs/` in importable form"* — literally true, and the substantive
// reading is false: `repo/examples/` has carried two importable Pipeline packages
// since the catalog went runtime-only, and `docs/tutorials/user-quickstart.md` §2
// already imports one of them by name. A first Run has never required authoring.
//
// So this cycle did NOT add a parallel `docs/examples/` folder competing with the
// one the quickstart names. It closed the two gaps that were real:
//
//   1. NO WORKFLOW EXAMPLE EXISTED. Both shipped packages are Pipelines. The
//      graph feature — the thing that distinguishes this product from a task
//      runner — had no importable demonstration, so
//      `example-two-node.workflow.yaml` is new here.
//   2. THE SUITES THAT SWEEP THIS DIRECTORY DID NOT KNOW ABOUT WORKFLOWS, and
//      they said so the moment one arrived. `examples-round-trip.test.ts` threw
//      *"declares kind 'Workflow', which this test does not know how to walk;
//      extend declaredKeys() rather than letting the document ship uncovered"* —
//      a refusal written by somebody who anticipated exactly this. Its harness
//      also published only `phase` and `pipeline` layers, and `effectiveKeys()`
//      read only two catalogs. All three were extended; none was bypassed.
//
// A DRAFT OF THIS FILE CLAIMED "nothing tested them", WHICH WAS FALSE.
// `shipped-examples-compatibility.test.ts` and `examples-round-trip.test.ts` have
// swept this directory for two features, and both caught real defects in the new
// workflow within seconds of it landing: a condition authored on the node instead
// of the connection, an operand shape, a port type, and a binding the type made
// impossible. The claim is corrected here rather than quietly dropped, because a
// test file asserting a gap that does not exist is the same defect class this
// round has spent nine items closing.
//
// WHAT THIS FILE ADDS over those two: it pins the example SET (a file added or
// removed is a decision, not a silent change), it checks that the workflow
// references pipeline ids the folder actually declares, and it holds the README
// and the quickstart to naming what is there.
//
// `FR-R3-014` is untouched: the catalog still ships EMPTY. These files are not
// seeded, not installed, and arrive through the same process-YAML import boundary
// an operator's own definitions do.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDocumentText } from '../../src/services/process-yaml/yaml-parser';
import type { YamlMappingNode } from '../../src/services/process-yaml/types';
import { parsePipelinePackage } from '../../src/services/process-yaml/pipeline-document';
import { parseWorkflowPackage } from '../../src/services/process-yaml/workflow-document';

const REPO_ROOT = resolve(__dirname, '..', '..');
const EXAMPLES_DIR = resolve(REPO_ROOT, 'examples');

const read = (name: string): string => readFileSync(resolve(EXAMPLES_DIR, name), 'utf8');

const PIPELINES = ['speckit-new-feature.pipeline.yaml', 'speckit-bugfix.pipeline.yaml'] as const;
const WORKFLOW = 'example-two-node.workflow.yaml';
/** Not a Phase/Pipeline/Workflow package; parsed, but read by its own importer. */
const MODEL_CATALOG = 'model-catalog.yaml';

/**
 * The parsed root of an example, or a failure naming the file.
 *
 * Returns the NODE rather than the result union: `ParseDocumentResult`'s failure
 * branch has no `node`, so returning the union made every call site re-narrow —
 * which reads fine under the default compiler settings and is two diagnostics
 * under the `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` ratchets.
 * Narrowing once here is the honest shape anyway: past this throw, the parse
 * succeeded.
 */
function tree(name: string): YamlMappingNode {
  const result = parseDocumentText(read(name));
  if (!result.ok) {
    throw new Error(`${name} did not parse: ${result.refusal.code} — ${result.refusal.message}`);
  }
  return result.node;
}

describe('FR-R3-132 — the shipped examples import through the real path', () => {
  it('pins the example set, so a file added or removed is a decision', () => {
    // The control, and the reason it is an equality rather than a subset check:
    // every assertion below names a file, so a deletion would shrink what is
    // checked without failing anything. It also makes a NEW example a deliberate
    // act — the next one has to be listed here, which is where somebody notices
    // it needs a test.
    const found = readdirSync(EXAMPLES_DIR)
      .filter((name) => name.endsWith('.yaml'))
      .sort();
    expect(found).toEqual([...PIPELINES, WORKFLOW, MODEL_CATALOG].sort());
  });

  it.each(PIPELINES)('%s is accepted by the package reader', (name) => {
    const result = parsePipelinePackage(tree(name));
    if (!result.ok) throw new Error(`${name} refused: ${result.refusal.code}`);
    // A package, not a bare pipeline: each carries the phases it references, which
    // is what makes one file enough for a first import.
    expect(result.resources.length, `${name} carries no included resources`).toBeGreaterThan(1);
  });

  it(`${WORKFLOW} is accepted by the package reader`, () => {
    const result = parseWorkflowPackage(tree(WORKFLOW));
    if (!result.ok) throw new Error(`${WORKFLOW} refused: ${result.refusal.code}`);
    expect(result.resources.length).toBeGreaterThanOrEqual(1);
  });

  it('the workflow resolves every pipeline it names, from this folder', () => {
    // The failure a newcomer hits first: a graph pointing at a pipeline id that
    // is not in the set they just imported. The workflow is a self-contained
    // PACKAGE — it includes the pipelines it references, so those ids count too,
    // and an id it neither includes nor finds in a sibling package is the defect.
    const declared = new Set(
      [...PIPELINES, WORKFLOW]
        .flatMap((name) => [...read(name).matchAll(/^\s*id:\s*([\w-]+)\s*$/gm)])
        // Destructured with a default: an indexed capture read needs a guard that
        // `noUncheckedIndexedAccess` requires and `no-unnecessary-condition`
        // calls dead. A default satisfies both.
        .map(([, id = '']) => id)
        .filter((id) => id.length > 0)
    );
    const referenced = [...read(WORKFLOW).matchAll(/pipelineId:\s*([\w-]+)/g)]
      .map(([, id = '']) => id)
      .filter((id) => id.length > 0);

    expect(referenced.length, 'a two-node workflow references two pipelines').toBeGreaterThan(1);
    for (const pipelineId of referenced) {
      expect(
        declared,
        `${WORKFLOW} references pipeline "${pipelineId}", which no package in examples/ declares`
      ).toContain(pipelineId);
    }
  });

  it('every example parses as a document at all', () => {
    // Including the model catalog, which the assertions above deliberately do not
    // classify: it is read by its own importer, and "it is still valid YAML of this
    // dialect" is the part that rots when the grammar moves.
    for (const name of [...PIPELINES, WORKFLOW, MODEL_CATALOG]) {
      // `tree` throws on a refusal naming the file, so reaching a node IS the
      // assertion. Asserting on the node's own shape here would be asserting on
      // the parser rather than on the example.
      expect(tree(name).kind, `${name} did not parse to a mapping`).toBe('mapping');
    }
  });

  it('says where the examples are, and that the catalog still ships empty', () => {
    // The quickstart is what a newcomer opens, so that is where this belongs — not
    // in a spec they will never read. `FR-R3-014` is not reopened by any of this.
    const readme = read('README.md');
    expect(readme).toContain('FR-R3-014');
    expect(readme.toLowerCase()).toContain('not shipped');
    expect(readme, 'the workflow example must be listed where the others are').toContain(WORKFLOW);
    expect(
      readFileSync(resolve(REPO_ROOT, 'docs/tutorials/user-quickstart.md'), 'utf8'),
      'the quickstart must name the workflow example too, now that one exists'
    ).toContain(WORKFLOW);
  });
});
