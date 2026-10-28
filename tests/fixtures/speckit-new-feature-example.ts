// Feature 241 (T007) — the shipped new-feature example, loaded once for the tests
// that read its instructions and its loop condition.
//
// Two test files read `examples/speckit-new-feature.pipeline.yaml` and must read
// the same document, through the same parser the product uses:
//
//   - `speckit-new-feature-authority.test.ts` pins what the Phase instructions say.
//   - `speckit-implement-report-fixtures.test.ts` takes `retryCondition` from here
//     rather than typing it in, so a report fixture can never pass against a
//     condition the example no longer ships.
//
// The loader was the authority test's own until the second reader appeared; it is
// moved here unchanged, so the two cannot drift.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parsePipelinePackage } from '../../src/services/process-yaml/pipeline-document';
import type { PhaseYamlDocument } from '../../src/services/process-yaml/types';
import { parseDocumentText } from '../../src/services/process-yaml/yaml-parser';

const EXAMPLE = resolve(
  __dirname,
  '..',
  '..',
  'examples',
  'speckit-new-feature.pipeline.yaml'
);

export interface LoadedExample {
  readonly phases: ReadonlyMap<string, PhaseYamlDocument>;
  readonly pipelineVersion: number;
  /** The pipeline's Phase ids in running order, as its `phaseIds` lists them. */
  readonly phaseIds: readonly string[];
}

export function loadExample(): LoadedExample {
  const parsed = parseDocumentText(readFileSync(EXAMPLE, 'utf8'));
  if (!parsed.ok) throw new Error(`${parsed.refusal.code}: ${parsed.refusal.message}`);
  const pkg = parsePipelinePackage(parsed.node);
  if (!pkg.ok) throw new Error(`${pkg.refusal.code}: ${pkg.refusal.message}`);

  const phases = new Map<string, PhaseYamlDocument>();
  let pipelineVersion = Number.NaN;
  let phaseIds: readonly string[] = [];
  for (const resource of pkg.resources) {
    if (!resource.ok) throw new Error(`refused ${resource.resourceKind} ${resource.resourceId}`);
    if (resource.resourceKind === 'phase') {
      phases.set(resource.document.metadata.phaseId, resource.document);
    } else {
      pipelineVersion = resource.definition.version;
      phaseIds = resource.definition.phaseIds;
    }
  }
  return { phases, pipelineVersion, phaseIds };
}

export function phaseOf(example: LoadedExample, phaseId: string): PhaseYamlDocument {
  const phase = example.phases.get(phaseId);
  if (phase === undefined) throw new Error(`the example no longer ships ${phaseId}`);
  return phase;
}

export function instructionOf(phase: PhaseYamlDocument): string {
  const text = phase.spec.instruction;
  if (text === undefined) throw new Error(`${phase.metadata.phaseId} carries no instruction`);
  return text;
}
