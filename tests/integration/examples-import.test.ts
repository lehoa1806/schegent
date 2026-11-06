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
import { parseWorkflowPackage } from '../../src/services/process-yaml/workflow-document';

const REPO_ROOT = resolve(__dirname, '..', '..');
const EXAMPLES_DIR = resolve(REPO_ROOT, 'examples');

const read = (name: string): string => readFileSync(resolve(EXAMPLES_DIR, name), 'utf8');

const WORKFLOWS = [
  'speckit-new-feature.workflow.yaml',
  'speckit-bugfix.workflow.yaml',
  'example-two-node.workflow.yaml',
  'example-nested-delivery.workflow.yaml'
] as const;
const WORKFLOW = 'example-two-node.workflow.yaml';
const NESTED_WORKFLOW = 'example-nested-delivery.workflow.yaml';
/** Not a Phase/Workflow package; parsed, but read by its own importer. */
const MODEL_CATALOG = 'model-catalog.yaml';

function tree(name: string): YamlMappingNode {
  const result = parseDocumentText(read(name));
  if (!result.ok) {
    throw new Error(`${name} did not parse: ${result.refusal.code} — ${result.refusal.message}`);
  }
  return result.node;
}

describe('FR-R3-132 / FR-R5-F07 — the shipped examples import through the real path', () => {
  it('pins the example set, so a file added or removed is a decision', () => {
    const found = readdirSync(EXAMPLES_DIR)
      .filter((name) => name.endsWith('.yaml'))
      .sort();
    expect(found).toEqual([...WORKFLOWS, MODEL_CATALOG].sort());
  });

  it('ships no Pipeline YAML document in repo/examples/ (FR-R5-F07)', () => {
    for (const name of WORKFLOWS) {
      expect(read(name)).toContain('kind: Workflow');
      expect(read(name)).not.toContain('kind: Pipeline');
    }
  });

  it.each(WORKFLOWS)('%s is accepted by the Workflow package reader', (name) => {
    const result = parseWorkflowPackage(tree(name));
    if (!result.ok) throw new Error(`${name} refused: ${result.refusal.code}`);
    expect(result.resources.length).toBeGreaterThan(1);
  });

  it.each([WORKFLOW, NESTED_WORKFLOW])(
    '%s resolves every child workflow it names, from this package',
    (name) => {
      const declared = new Set(
        [...read(name).matchAll(/^\s*id:\s*([\w-]+)\s*$/gm)]
          .map(([, id = '']) => id)
          .filter((id) => id.length > 0)
      );
      const referenced = [...read(name).matchAll(/workflowId:\s*([\w-]+)/g)]
        .map(([, id = '']) => id)
        .filter((id) => id.length > 0);

      expect(referenced.length, 'nested workflow references child workflows').toBeGreaterThan(1);
      for (const workflowId of referenced) {
        expect(
          declared,
          `${name} references workflow "${workflowId}", which no resource in ${name} declares`
        ).toContain(workflowId);
      }
    }
  );

  it('every example parses as a document at all', () => {
    // Including the model catalog, which the assertions above deliberately do not
    // classify: it is read by its own importer, and "it is still valid YAML of this
    // dialect" is the part that rots when the grammar moves.
    for (const name of [...WORKFLOWS, MODEL_CATALOG]) {
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

  it('tells the reader the examples track this checkout, what an older build does with them, and the remedy (FR-007, SC-004)', () => {
    // BUG-001. The examples in a checkout can be newer than the build a reader has installed,
    // and an older build can report a valid example as broken. The README is where that reader
    // looks, so the statement is held there, under the heading that explains what these files
    // are and are not. It states three things and chooses no versioning policy: that is the
    // maintainers' decision, not this file's.
    //
    // The README is hard-wrapped, so whitespace is collapsed before matching. A phrase that
    // crosses a line break would otherwise never match, and the miss would read as the
    // statement being absent.
    const heading = '## This is documentation, not shipped state';
    const readme = read('README.md');
    const start = readme.indexOf(heading);
    expect(start, `README.md has no "${heading}" section`).toBeGreaterThanOrEqual(0);
    const afterHeading = readme.slice(start + heading.length);
    const nextHeading = afterHeading.search(/^## /m);
    const section = (nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading))
      .replace(/\s+/g, ' ')
      .toLowerCase();

    expect(section, 'the examples track this checkout').toContain('track this checkout');
    expect(section, 'a build older than the checkout can refuse them').toMatch(
      /build older than (this|the) checkout can refuse/
    );
    expect(section, 'or report field defects on a file that is valid').toContain(
      'field defects on a valid file'
    );
    expect(section, 'the remedy is the matching build').toContain(
      'install the build that matches this checkout'
    );
    expect(section, 'and a reload before importing').toContain('reload the window before importing');
  });
});
