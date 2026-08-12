// Feature 085 T056/T057 — the format is lossless for everything it admits.
//
// Two properties, and they fail differently, which is why both are here:
//
//   text  → resources → text   must be byte-identical. Catches a reader that
//                              drops a field the writer emits, and a writer
//                              whose key order or scalar style is not a
//                              function of the value alone (FR-017).
//   value → text     → value   must be deeply equal. Catches the opposite: a
//                              writer that emits something the reader then
//                              reads back as a DIFFERENT value — a version
//                              renumbered, a `"2"` re-typed to `2`, an omitted
//                              list read as absent rather than empty.
//
// A single direction would pass on a symmetric mistake. Both directions over
// the same corpus is what makes "lossless" checkable rather than asserted.
//
// The corpus is deliberately made of documents this project WROTE — every
// fixture is produced by `serializePipelineDocument`, so a fixture cannot drift
// from the emitter and quietly stop testing the thing it names. The one
// hand-written document below exists to prove that is not circular: it is
// typed out by hand at the indentation the grammar specifies and must survive
// the same loop.

import { describe, expect, it } from 'vitest';

import type {
  PhaseBinding,
  PipelineDefinition,
  PipelineInputPort,
  PipelineOutputPort
} from '../../../src/contracts/pipeline-definitions';
import {
  PIPELINE_INPUT_PORT_TYPES,
  PIPELINE_OUTPUT_PORT_TYPES
} from '../../../src/contracts/pipeline-definitions';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import { phaseDefinitionFromDocument } from '../../../src/services/process-yaml/phase-yaml-mapper';
import {
  documentFromPipelineDefinition,
  parsePipelinePackage,
  serializePipelineDocument
} from '../../../src/services/process-yaml/pipeline-document';
import { parseDocumentText } from '../../../src/services/process-yaml/yaml-parser';

// ---------------------------------------------------------------------------
// The loop, in both directions
// ---------------------------------------------------------------------------

interface ReadPackage {
  readonly pipeline: PipelineDefinition;
  readonly phases: readonly PhaseDefinition[];
}

/** Read a document the way preflight does, insisting every resource is valid. */
function readPackage(text: string): ReadPackage {
  const parsed = parseDocumentText(text);
  if (!parsed.ok) {
    throw new Error(`did not parse: ${parsed.refusal.code} ${parsed.refusal.message}`);
  }
  const result = parsePipelinePackage(parsed.node);
  if (!result.ok) throw new Error(`refused: ${result.refusal.code} ${result.refusal.message}`);

  let pipeline: PipelineDefinition | null = null;
  const phases: PhaseDefinition[] = [];
  for (const resource of result.resources) {
    if (!resource.ok) {
      throw new Error(
        `invalid ${resource.resourceKind} ${resource.resourceId ?? '<no id>'}: ` +
          resource.defects.map((defect) => `${defect.field}/${defect.code}`).join(', ')
      );
    }
    if (resource.resourceKind === 'pipeline') pipeline = resource.definition;
    else phases.push(phaseDefinitionFromDocument(resource.document));
  }
  if (pipeline === null) throw new Error('no root Pipeline in the document');
  return { pipeline, phases };
}

/** Write what was read, with the same inclusion choice the document made. */
function writePackage(read: ReadPackage, include: boolean): string {
  return serializePipelineDocument(
    documentFromPipelineDefinition(read.pipeline, include ? read.phases : undefined)
  );
}

// ---------------------------------------------------------------------------
// Definitions worth round-tripping
// ---------------------------------------------------------------------------

const PHASES: readonly PhaseDefinition[] = Object.freeze([
  Object.freeze({
    phaseId: 'specify',
    name: 'Specify',
    version: 2,
    description: 'Write the spec.',
    instruction: 'Write the spec, then stop.',
    model: 'opus',
    effort: 'high',
    timeoutSeconds: 900,
    loopable: true,
    // Carried verbatim and never read on this path (FR-053).
    retryCondition: 'exitCode != 0 && attempt < 3',
    isRequired: true,
    runner: 'claude'
  }) as PhaseDefinition,
  Object.freeze({
    phaseId: 'plan',
    name: 'Plan',
    version: 5,
    skill: 'speckit-plan'
  }) as PhaseDefinition
]);

/**
 * One input port per admitted type, so no type is round-tripped by proxy.
 *
 * `required` is stated on every port, and alternated rather than set true on
 * all, because `required: false` is the value most easily lost — it is also the
 * catalog's non-default. It is never OMITTED here: the catalog validator
 * materializes an absent `required` to `true` (pinned since 082), so a
 * definition without it is not one the catalog can produce, and a fixture built
 * that way would be testing a value that cannot reach the exporter. The
 * normalization itself is pinned below, where it belongs.
 */
const EVERY_INPUT_PORT: readonly PipelineInputPort[] = PIPELINE_INPUT_PORT_TYPES.map(
  (type, index) => ({
    portId: `in-${type}`,
    label: `Input ${type}`,
    type,
    required: index % 2 === 0,
    ...(index % 3 === 0 ? { description: `The ${type} input.` } : {})
  })
);

const EVERY_OUTPUT_PORT: readonly PipelineOutputPort[] = PIPELINE_OUTPUT_PORT_TYPES.map(
  (type, index) => ({
    portId: `out-${type}`,
    label: `Output ${type}`,
    type,
    ...(index % 2 === 0 ? { description: `The ${type} output.` } : {})
  })
);

/** Both binding variants, and both `source` shapes of the input variant. */
const EVERY_BINDING: readonly PhaseBinding[] = Object.freeze([
  {
    kind: 'input',
    phaseIndex: 0,
    inputKey: 'brief',
    source: { from: 'pipeline-input', portId: 'in-text' }
  },
  {
    kind: 'input',
    phaseIndex: 1,
    inputKey: 'spec',
    source: { from: 'phase-output', phaseIndex: 0, portId: 'spec-doc' }
  },
  { kind: 'output', phaseIndex: 1, portId: 'plan-doc', outputKey: 'out-markdown' }
] as const);

const EVERYTHING: PipelineDefinition = Object.freeze({
  pipelineId: 'ship-it',
  name: 'Ship It',
  version: 7,
  description: 'Specify, then plan.',
  phaseIds: ['specify', 'plan'],
  inputs: EVERY_INPUT_PORT,
  outputs: EVERY_OUTPUT_PORT,
  bindings: EVERY_BINDING,
  executionDefaults: {
    runner: 'claude',
    model: 'opus',
    effort: 'high' as const,
    timeoutSeconds: 900
  },
  recommendedNext: ['review-it']
});

/** The absent-list end of the rule: every list-typed key is empty. */
const NOTHING_OPTIONAL: PipelineDefinition = Object.freeze({
  pipelineId: 'bare',
  name: 'Bare',
  version: 1,
  phaseIds: ['specify'],
  inputs: [],
  outputs: [],
  bindings: [],
  recommendedNext: []
});

/** A Pipeline that names one Phase twice — `included` must still write it once. */
const REPEATED_PHASE: PipelineDefinition = Object.freeze({
  ...NOTHING_OPTIONAL,
  pipelineId: 'twice',
  name: 'Twice',
  phaseIds: ['specify', 'plan', 'specify']
});

/**
 * Feature 091 T024a (US3, FR-033, FR-028a) — a definition holding characters
 * outside the Basic Multilingual Plane.
 *
 * An astral character is a surrogate PAIR in memory: `'\u{1d400}'.length` is 2,
 * and `charCodeAt(0)` reads 0xD835, which is not a character. Slice C refuses a
 * `\u` escape that names one half of such a pair, and the risk of a rule stated
 * that way is that it comes out too wide — the same code units, arriving
 * legitimately as UTF-8 in the source bytes and paired correctly, must still
 * pass. FR-028a is exactly that boundary, and this fixture is where the corpus
 * would notice a decoded-text scan: nothing here is written as an escape, so a
 * scanner that examined decoded scalars would refuse a document it must accept.
 *
 * Put in several fields rather than one so a partial fix — quoting rule right,
 * plain-scalar path wrong, or vice versa — cannot pass.
 */
const ASTRAL_TEXT = 'Ship \u{1d400}\u{1d401} to \u{20bb7}';

const ASTRAL: PipelineDefinition = Object.freeze({
  ...NOTHING_OPTIONAL,
  pipelineId: 'astral',
  name: ASTRAL_TEXT,
  description: `${ASTRAL_TEXT} — and one at the very end \u{1d7ce}`,
  inputs: [
    {
      portId: 'brief',
      label: ASTRAL_TEXT,
      type: 'text' as const,
      required: true,
      description: ASTRAL_TEXT
    }
  ]
});

interface Fixture {
  readonly label: string;
  readonly definition: PipelineDefinition;
  readonly include: boolean;
}

const CORPUS: readonly Fixture[] = Object.freeze([
  { label: 'every field, dependencies included', definition: EVERYTHING, include: true },
  { label: 'every field, references only', definition: EVERYTHING, include: false },
  { label: 'nothing optional, references only', definition: NOTHING_OPTIONAL, include: false },
  { label: 'nothing optional, dependencies included', definition: NOTHING_OPTIONAL, include: true },
  { label: 'a repeated phase reference', definition: REPEATED_PHASE, include: true },
  { label: 'characters outside the BMP', definition: ASTRAL, include: false }
]);

function documentFor(fixture: Fixture): string {
  return serializePipelineDocument(
    documentFromPipelineDefinition(fixture.definition, fixture.include ? PHASES : undefined)
  );
}

// ---------------------------------------------------------------------------
// T056 — both directions
// ---------------------------------------------------------------------------

describe('Feature 085 T056 — a document survives being read and written (FR-017)', () => {
  for (const fixture of CORPUS) {
    it(`re-emits '${fixture.label}' byte for byte`, () => {
      const original = documentFor(fixture);
      expect(writePackage(readPackage(original), fixture.include)).toBe(original);
    });
  }

  it('re-emits a hand-written document, so the corpus is not just self-consistent', () => {
    // Typed out rather than generated. If the emitter's indentation, key order,
    // or block-scalar rule drifted, this fails while a generated corpus would
    // happily agree with the drift.
    const HAND_WRITTEN = [
      'apiVersion: schegent/v1',
      'kind: Pipeline',
      'metadata:',
      '  id: hand-written',
      '  name: Hand Written',
      '  version: 2',
      '  description: Typed by a person.',
      'spec:',
      '  phaseIds:',
      '    - specify',
      '  inputs:',
      '    - portId: brief',
      '      label: Feature brief',
      '      type: text',
      '      required: true',
      '  outputs:',
      '    - portId: spec-doc',
      '      label: Spec',
      '      type: markdown',
      '  bindings:',
      '    - kind: input',
      '      phaseIndex: 0',
      '      inputKey: brief',
      '      source:',
      '        from: pipeline-input',
      '        portId: brief',
      '  executionDefaults:',
      '    runner: claude',
      '  recommendedNext:',
      '    - review-it',
      'included:',
      '  phases:',
      '    - metadata:',
      '        phaseId: specify',
      '        name: Specify',
      '        version: 2',
      '      spec:',
      '        instruction: Write the spec.',
      ''
    ].join('\n');

    expect(writePackage(readPackage(HAND_WRITTEN), true)).toBe(HAND_WRITTEN);
  });

  for (const fixture of CORPUS) {
    it(`reads '${fixture.label}' back to the same definition`, () => {
      const read = readPackage(documentFor(fixture));
      expect(read.pipeline).toEqual(fixture.definition);
      if (fixture.include) {
        // Included Phases are the referenced ones in first-mention order
        // (FR-016), de-duplicated — not the array the caller passed.
        const expected = [...new Set(fixture.definition.phaseIds)].map((phaseId) =>
          PHASES.find((phase) => phase.phaseId === phaseId)
        );
        expect(read.phases).toEqual(expected);
      } else {
        expect(read.phases).toEqual([]);
      }
    });
  }

  it('carries every admitted port type through, not a representative one', () => {
    const read = readPackage(documentFor(CORPUS[0]!));
    expect(read.pipeline.inputs.map((port) => port.type)).toEqual([...PIPELINE_INPUT_PORT_TYPES]);
    expect(read.pipeline.outputs.map((port) => port.type)).toEqual([...PIPELINE_OUTPUT_PORT_TYPES]);
  });

  it('carries both binding variants and both source shapes', () => {
    const read = readPackage(documentFor(CORPUS[0]!));
    expect(read.pipeline.bindings).toEqual(EVERY_BINDING);
  });

  it('is stable under repetition — writing twice produces the same bytes', () => {
    // FR-017 is a statement about the value, not about a first render. A cached
    // or mutated intermediate would show up here and nowhere else.
    const once = documentFor(CORPUS[0]!);
    expect(documentFor(CORPUS[0]!)).toBe(once);
    expect(writePackage(readPackage(once), true)).toBe(once);
  });
});

// ---------------------------------------------------------------------------
// T057 — absent versus empty, and the declared version
// ---------------------------------------------------------------------------

describe('Feature 085 T057 — absent and empty are the same document (research R3)', () => {
  it('writes no key at all for an empty list', () => {
    // A bare `inputs:` would read back as an empty MAPPING, not an empty list,
    // so the omission is the rule rather than a cosmetic choice.
    const text = documentFor({ label: '', definition: NOTHING_OPTIONAL, include: false });
    for (const key of ['inputs:', 'outputs:', 'bindings:', 'recommendedNext:']) {
      expect(text).not.toContain(key);
    }
    expect(text).toContain('phaseIds:');
  });

  it('reads an omitted list-typed key back as an empty list', () => {
    const read = readPackage(documentFor({ label: '', definition: NOTHING_OPTIONAL, include: false }));
    expect(read.pipeline.inputs).toEqual([]);
    expect(read.pipeline.outputs).toEqual([]);
    expect(read.pipeline.bindings).toEqual([]);
    expect(read.pipeline.recommendedNext).toEqual([]);
  });

  it('writes no `included` key for a references-only export (FR-013)', () => {
    const text = documentFor({ label: '', definition: EVERYTHING, include: false });
    expect(text).not.toContain('included');
  });

  it('writes no `executionDefaults` key when the mapping carries nothing', () => {
    const text = serializePipelineDocument(
      documentFromPipelineDefinition({ ...NOTHING_OPTIONAL, executionDefaults: {} })
    );
    expect(text).not.toContain('executionDefaults');
    expect(readPackage(text).pipeline.executionDefaults).toBeUndefined();
  });

  it('normalizes an omitted `required` once, then is stable (the one text-level rewrite)', () => {
    // The single place a hand-authored document does NOT come back byte-identical,
    // and it is a rule rather than a loss: the catalog has always read an absent
    // `required` as `true` (pinned since 082), so the import stores a port that
    // means what the document said and states it outright. Suppressing the field
    // on the way out to preserve the bytes would make the exported document
    // depend on how the row was authored rather than on what it is — and would
    // hide the default from the next reader.
    //
    // What matters is that the rewrite happens ONCE. A second pass that changed
    // the bytes again would mean the format has no fixed point.
    const OMITTED = [
      'apiVersion: schegent/v1',
      'kind: Pipeline',
      'metadata:',
      '  id: omitted',
      '  name: Omitted',
      '  version: 1',
      'spec:',
      '  phaseIds:',
      '    - specify',
      '  inputs:',
      '    - portId: brief',
      '      label: Feature brief',
      '      type: text',
      ''
    ].join('\n');

    const once = writePackage(readPackage(OMITTED), false);
    expect(once).not.toBe(OMITTED);
    expect(once).toContain('      required: true');
    expect(writePackage(readPackage(once), false)).toBe(once);
    expect(readPackage(OMITTED).pipeline.inputs[0]?.required).toBe(true);
  });

  it('keeps an explicit `required: false`, which the default would swallow', () => {
    const text = documentFor({ label: '', definition: EVERYTHING, include: false });
    expect(text).toContain('      required: false');
    const read = readPackage(text);
    expect(read.pipeline.inputs.map((port) => port.required)).toEqual(
      EVERY_INPUT_PORT.map((port) => port.required)
    );
  });

  it('distinguishes an absent optional scalar from an empty one', () => {
    // `description` absent must not become `description: ''` on the way out,
    // and an authored empty string is a value the catalog refuses — so the two
    // cannot be collapsed into one representation.
    const text = documentFor({ label: '', definition: NOTHING_OPTIONAL, include: false });
    expect(text).not.toContain('description');
    expect(readPackage(text).pipeline).not.toHaveProperty('description');
  });
});

describe('Feature 085 T057 — a declared version is stored exactly as declared (FR-044)', () => {
  const VERSIONS = [1, 2, 7, 41, 999] as const;

  for (const version of VERSIONS) {
    it(`stores version ${version} unchanged through the loop`, () => {
      const definition = { ...NOTHING_OPTIONAL, version };
      const read = readPackage(
        serializePipelineDocument(documentFromPipelineDefinition(definition, PHASES))
      );
      expect(read.pipeline.version).toBe(version);
    });
  }

  it('does not renumber an included Phase to 1 either', () => {
    // The failure this guards is a real one on the single-Phase path: a `create`
    // mutation renumbers to 1, which is why import declares `import-package`
    // instead. Here it would show as a version the author never wrote.
    const read = readPackage(documentFor(CORPUS[0]!));
    expect(read.phases.map((phase) => phase.version)).toEqual([2, 5]);
  });

  it('refuses a document that declares no version rather than defaulting it', () => {
    // Defaulting is right for a catalog row an operator is editing and wrong on
    // an imported document: it would invent a version the author never wrote and
    // make the round trip lossy.
    const parsed = parseDocumentText(
      [
        'apiVersion: schegent/v1',
        'kind: Pipeline',
        'metadata:',
        '  id: no-version',
        '  name: No Version',
        'spec:',
        '  phaseIds:',
        '    - specify',
        ''
      ].join('\n')
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = parsePipelinePackage(parsed.node);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [root] = result.resources;
    expect(root?.ok).toBe(false);
    if (root === undefined || root.ok) return;
    expect(root.defects.map((defect) => `${defect.field}/${defect.code}`)).toContain(
      'version/required'
    );
  });

  it('keeps a quoted numeric string a string, and a bare number a number', () => {
    // The one place the reader is allowed to type a scalar. A version written
    // `"2"` is text by the author's own hand; re-typing it to 2 would make the
    // document and the stored row disagree about what was declared.
    const parsed = parseDocumentText(
      [
        'apiVersion: schegent/v1',
        'kind: Pipeline',
        'metadata:',
        '  id: quoted',
        '  name: "2"',
        '  version: 2',
        'spec:',
        '  phaseIds:',
        '    - specify',
        ''
      ].join('\n')
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = parsePipelinePackage(parsed.node);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [root] = result.resources;
    expect(root?.ok).toBe(true);
    if (root === undefined || !root.ok || root.resourceKind !== 'pipeline') return;
    expect(root.definition.name).toBe('2');
    expect(root.definition.version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Feature 091 T024a — characters outside the BMP (FR-033, FR-028a, SC-007)
// ---------------------------------------------------------------------------
//
// This block, and nothing else, discharges the round-trip half of Slice C.
//
// The corpus runner in `tests/contract/process-yaml-grammar.test.ts` parses a
// fixture and compares it against a captured tree. It never serializes, so it
// cannot observe byte-identity: `accepted/091/surrogate-pair` shows that a
// well-formed escape pair DECODES, not that a document holding what it decodes
// to survives being written back out. The two are different claims and the
// second is the one the defect was about — the corruption happened on the
// export write, not on the read.
//
// The astral fixture in CORPUS above carries the byte-identity and deep-equality
// loops for the literal form. What is left, and is here:
//
//   * the escape-pair source form, which is the only shape that reaches the
//     amended production at all;
//   * the UTF-8 encode step itself, which is where a lone surrogate turned into
//     U+FFFD with no error — a property no in-memory comparison can see, because
//     both sides of it are the same corrupted string.

describe('Feature 091 T024a — an astral character survives the whole loop (FR-033)', () => {
  const ASTRAL_DEFINITION: Fixture = {
    label: 'characters outside the BMP',
    definition: ASTRAL,
    include: false
  };

  /** The one document in this file that spells the character as an escape pair. */
  const ESCAPED = [
    'apiVersion: schegent/v1',
    'kind: Pipeline',
    'metadata:',
    '  id: escaped',
    '  name: "\\ud835\\udc00"',
    '  version: 1',
    'spec:',
    '  phaseIds:',
    '    - specify',
    ''
  ].join('\n');

  it('emits the characters literally, never as an escape', () => {
    // `quoteDouble` only escapes below 0x20 and 0x7f, so this is a statement
    // about what the serializer must NOT start doing: emitting an astral
    // character as a `\uXXXX` pair would produce a document its own reader now
    // reads one escape at a time, and the amended production is the reason that
    // has to keep working rather than a reason to start writing it that way.
    const text = documentFor(ASTRAL_DEFINITION);
    expect(text).toContain(ASTRAL_TEXT);
    expect(text).not.toContain('\\u');
  });

  it('survives the UTF-8 encode the export write performs', () => {
    // `extension.ts` writes the export with `Buffer.from(text, 'utf8')`. That
    // call is total: it never fails, it substitutes U+FFFD for any code unit it
    // cannot encode. A lone surrogate reaching here was therefore silent data
    // loss, so the round trip is asserted through the encoding rather than
    // around it.
    const text = documentFor(ASTRAL_DEFINITION);
    const written = Buffer.from(text, 'utf8');
    expect(written.toString('utf8')).toBe(text);
    expect(written.toString('utf8')).not.toContain('�');
  });

  it('reads a source document that spells the character as an escape pair', () => {
    // The only shape in this file that enters the amended production. The pair
    // is consumed as one unit and yields ONE code point — asserted by code point
    // rather than by `.length`, which counts the two code units and would pass
    // just as happily for two lone halves.
    const read = readPackage(ESCAPED);
    expect(read.pipeline.name).toBe('\u{1d400}');
    expect([...read.pipeline.name]).toHaveLength(1);
    expect(read.pipeline.name.codePointAt(0)).toBe(0x1d400);
  });

  it('normalizes the escape pair to its literal form once, then is stable', () => {
    // The second of the two places a hand-authored document does not come back
    // byte-identical (the first is `required: true` above), and for the same
    // reason: the stored value is the character, and the serializer writes what
    // the value is rather than how it was spelled. What has to hold is that the
    // rewrite happens ONCE — a format whose output is not a fixed point would
    // churn the operator's file on every export.
    const once = writePackage(readPackage(ESCAPED), false);
    expect(once).not.toBe(ESCAPED);
    expect(once).toContain('  name: \u{1d400}');
    expect(writePackage(readPackage(once), false)).toBe(once);
  });

  it('accepts a legitimately encoded astral character with no escape anywhere (FR-028a)', () => {
    // The FR-028a boundary. Every astral character in this document arrives as
    // UTF-8 in the source bytes; none is written as an escape. A scanner that
    // enforced the surrogate rule by sweeping DECODED scalar text — rather than
    // deciding at the escape site — would refuse this, because after decoding
    // the two shapes are indistinguishable. That is the whole reason the check
    // is specified at the escape and not after it.
    const text = documentFor(ASTRAL_DEFINITION);
    expect(text).not.toContain('\\u');

    const parsed = parseDocumentText(text);
    expect(parsed.ok).toBe(true);

    const read = readPackage(text);
    expect(read.pipeline.name).toBe(ASTRAL_TEXT);
    expect(read.pipeline.inputs[0]?.label).toBe(ASTRAL_TEXT);
  });
});
