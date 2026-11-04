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

import { standaloneNode } from '../../src/services/process-yaml/package-reader';
import { validatePhaseDocument } from '../../src/services/process-yaml/phase-yaml-validator';
import {
  PHASE_YAML_KIND,
  type PhaseYamlDocument,
  type YamlNode
} from '../../src/services/process-yaml/types';
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

function entryOf(node: YamlNode | undefined, key: string): YamlNode | undefined {
  if (node === undefined || node.kind !== 'mapping') return undefined;
  return node.entries.find((entry) => entry.key === key)?.value;
}

export function loadExample(): LoadedExample {
  const parsed = parseDocumentText(readFileSync(EXAMPLE, 'utf8'));
  if (!parsed.ok) throw new Error(`${parsed.refusal.code}: ${parsed.refusal.message}`);

  const metadata = entryOf(parsed.node, 'metadata');
  const versionNode = entryOf(metadata, 'version');
  const pipelineVersion =
    versionNode?.kind === 'scalar' ? Number(versionNode.value) : Number.NaN;

  const spec = entryOf(parsed.node, 'spec');
  const phaseIdsNode = entryOf(spec, 'phaseIds');
  const phaseIds =
    phaseIdsNode?.kind === 'sequence'
      ? phaseIdsNode.items.flatMap((item) => (item.kind === 'scalar' ? [item.value] : []))
      : [];

  const included = entryOf(parsed.node, 'included');
  const phasesNode = entryOf(included, 'phases');
  const phases = new Map<string, PhaseYamlDocument>();
  if (phasesNode?.kind === 'sequence') {
    for (const item of phasesNode.items) {
      if (item.kind !== 'mapping') throw new Error('expected mapping in included.phases');
      const validated = validatePhaseDocument(standaloneNode(item, PHASE_YAML_KIND));
      if (!validated.ok) {
        const id = validated.kind === 'resource' ? validated.resourceId : null;
        throw new Error(`refused phase ${id ?? '<unknown>'}`);
      }
      phases.set(validated.document.metadata.phaseId, validated.document);
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
