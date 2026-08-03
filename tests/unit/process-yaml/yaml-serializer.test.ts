// Feature 084 T012/T014 — the deterministic emitter (test-first).
//
// FR-017 asks for byte-identical output for the same definition. That is only
// true if property order is a property of this module rather than of how the
// object happened to be built, so the first test constructs the same document
// twice with the keys inserted in opposite orders and demands identical bytes.
//
// The last describe closes the loop: emit, parse, emit again, compare bytes
// (SC-003, QS-37).

import { describe, it, expect } from 'vitest';
import type { PhaseDefinitionEffort } from '../../../src/contracts/process-definitions';
import type { BackendRunnerKind } from '../../../src/runner/backend-runner-factory';
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
  emitKey,
  emitMapping,
  emitMappingSequence,
  emitScalarItem,
  emitSequence,
  serializePhaseDocument
} from '../../../src/services/process-yaml/yaml-serializer';
import { parseDocumentText } from '../../../src/services/process-yaml/yaml-parser';
import {
  PHASE_YAML_API_VERSION,
  PHASE_YAML_INDENT,
  PHASE_YAML_KIND,
  type PhaseYamlDocument,
  type YamlMappingNode,
  type YamlNode
} from '../../../src/services/process-yaml/types';

function instructionDoc(overrides: {
  metadata?: Partial<PhaseYamlDocument['metadata']>;
  spec?: Record<string, unknown>;
} = {}): PhaseYamlDocument {
  return {
    apiVersion: PHASE_YAML_API_VERSION,
    kind: PHASE_YAML_KIND,
    metadata: { phaseId: 'my-phase', name: 'My Phase', version: 1, ...overrides.metadata },
    spec: { instruction: 'Do the thing', ...overrides.spec }
  } as PhaseYamlDocument;
}

const FULL = instructionDoc({
  metadata: { description: 'A phase that does the thing' },
  spec: {
    instruction: 'line one\nline two',
    runner: 'claude',
    model: 'opus',
    effort: 'high',
    timeoutSeconds: 120,
    loopable: true,
    isRequired: false,
    retryCondition: 'attempts < 3'
  }
});

describe('yaml-serializer — property order (FR-017)', () => {
  it('exports the order as a constant rather than relying on object keys', () => {
    expect(DOCUMENT_KEY_ORDER).toEqual(['apiVersion', 'kind', 'metadata', 'spec']);
    expect(METADATA_KEY_ORDER).toEqual(['phaseId', 'name', 'version', 'description']);
    expect(SPEC_KEY_ORDER).toEqual([
      'instruction',
      'skill',
      'runner',
      'model',
      'effort',
      'timeoutSeconds',
      'loopable',
      'isRequired',
      'retryCondition'
    ]);
  });

  it('emits in the declared order whatever order the object was built in', () => {
    const forwards: PhaseYamlDocument = {
      apiVersion: PHASE_YAML_API_VERSION,
      kind: PHASE_YAML_KIND,
      metadata: { phaseId: 'p', name: 'N', version: 2 },
      spec: { instruction: 'i', model: 'm', runner: 'codex' }
    };
    const backwards: PhaseYamlDocument = {
      spec: { runner: 'codex', model: 'm', instruction: 'i' },
      metadata: { version: 2, name: 'N', phaseId: 'p' },
      kind: PHASE_YAML_KIND,
      apiVersion: PHASE_YAML_API_VERSION
    };
    expect(serializePhaseDocument(backwards)).toBe(serializePhaseDocument(forwards));
  });

  it('produces the documented layout', () => {
    expect(serializePhaseDocument(instructionDoc())).toBe(
      [
        'apiVersion: schegent/v1',
        'kind: Phase',
        'metadata:',
        '  phaseId: my-phase',
        '  name: My Phase',
        '  version: 1',
        'spec:',
        '  instruction: Do the thing',
        ''
      ].join('\n')
    );
  });

  it('is byte-identical across ten runs', () => {
    const first = serializePhaseDocument(FULL);
    for (let i = 0; i < 10; i++) {
      expect(serializePhaseDocument(FULL)).toBe(first);
    }
  });
});

describe('yaml-serializer — omitted optionals (FR-016)', () => {
  it('omits an absent optional rather than emitting an empty value', () => {
    const text = serializePhaseDocument(instructionDoc());
    expect(text).not.toContain('description');
    expect(text).not.toContain('retryCondition');
    expect(text).not.toContain('skill');
    // `metadata:` and `spec:` open nested mappings; no leaf key may be bare.
    expect(text).not.toMatch(/^ +\w+: *$/m);
  });

  it('emits false and zero, which are present values rather than absent ones', () => {
    const text = serializePhaseDocument(
      instructionDoc({ spec: { loopable: false, timeoutSeconds: 0 } })
    );
    expect(text).toContain('  loopable: false');
    expect(text).toContain('  timeoutSeconds: 0');
  });

  it('emits the skill variant without an instruction key', () => {
    const text = serializePhaseDocument({
      apiVersion: PHASE_YAML_API_VERSION,
      kind: PHASE_YAML_KIND,
      metadata: { phaseId: 'p', name: 'N', version: 1 },
      spec: { skill: 'speckit-plan' }
    });
    expect(text).toContain('  skill: speckit-plan');
    expect(text).not.toContain('instruction');
  });
});

describe('yaml-serializer — scalar styles', () => {
  it('uses a block literal for any multi-line value', () => {
    const text = serializePhaseDocument(
      instructionDoc({ spec: { instruction: 'line one\nline two' } })
    );
    expect(text).toContain('  instruction: |-\n    line one\n    line two\n');
  });

  it('quotes a string that another reader would re-type', () => {
    const text = serializePhaseDocument(instructionDoc({ metadata: { name: '42' } }));
    expect(text).toContain('  name: "42"');
  });

  it('leaves numbers and booleans unquoted, because they are typed in the format', () => {
    const text = serializePhaseDocument(
      instructionDoc({ metadata: { version: 42 }, spec: { loopable: true } })
    );
    expect(text).toContain('  version: 42');
    expect(text).toContain('  loopable: true');
  });

  it('ends with exactly one newline', () => {
    const text = serializePhaseDocument(FULL);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });
});

// A structural inverse of the emitter, deliberately kept local rather than
// swapped for `validatePhaseDocument` + `phaseDefinitionFromDocument` now that
// those exist (T015-T019).
//
// Two reasons. The fixpoint this file asserts is a property of the emitter and
// the parser alone, so routing it through the validator would report an emitter
// regression as a validation failure. And the corpus below carries text the
// catalog has opinions about — padding, a name that reads as a boolean, an
// embedded colon, a tab, a trailing newline — which is exactly the material
// that exercises quoting and block-literal fidelity. The semantic round trip
// (definition -> document -> definition) is covered by phase-yaml-mapper.test.ts.
function documentFromNode(node: YamlMappingNode): PhaseYamlDocument {
  const read = (n: YamlMappingNode, key: string): string | undefined => {
    const entry = n.entries.find((e) => e.key === key);
    return entry && entry.value.kind === 'scalar' ? entry.value.value : undefined;
  };
  const child = (n: YamlMappingNode, key: string): YamlMappingNode => {
    const entry = n.entries.find((e) => e.key === key);
    if (!entry || entry.value.kind !== 'mapping') throw new Error(`missing mapping '${key}'`);
    return entry.value;
  };
  const metadata = child(node, 'metadata');
  const spec = child(node, 'spec');
  const num = (raw: string | undefined) => (raw === undefined ? undefined : Number(raw));
  const bool = (raw: string | undefined) => (raw === undefined ? undefined : raw === 'true');

  const description = read(metadata, 'description');
  const instruction = read(spec, 'instruction');
  const skill = read(spec, 'skill');
  // The emitter only ever writes these from the catalog's enums; the reader has
  // no validator here, so it takes the text back at its word.
  const runner = read(spec, 'runner') as BackendRunnerKind | undefined;
  const effort = read(spec, 'effort') as PhaseDefinitionEffort | undefined;
  const model = read(spec, 'model');
  const timeoutSeconds = num(read(spec, 'timeoutSeconds'));
  const loopable = bool(read(spec, 'loopable'));
  const isRequired = bool(read(spec, 'isRequired'));
  const retryCondition = read(spec, 'retryCondition');

  const common = {
    ...(runner !== undefined ? { runner } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ...(loopable !== undefined ? { loopable } : {}),
    ...(isRequired !== undefined ? { isRequired } : {}),
    ...(retryCondition !== undefined ? { retryCondition } : {})
  };

  return {
    apiVersion: PHASE_YAML_API_VERSION,
    kind: PHASE_YAML_KIND,
    metadata: {
      phaseId: read(metadata, 'phaseId') ?? '',
      name: read(metadata, 'name') ?? '',
      version: num(read(metadata, 'version')) ?? 0,
      ...(description !== undefined ? { description } : {})
    },
    spec:
      instruction !== undefined ? { instruction, ...common } : { skill: skill ?? '', ...common }
  };
}

describe('yaml-serializer — fixpoint (SC-003, QS-37)', () => {
  const CORPUS: readonly PhaseYamlDocument[] = [
    instructionDoc(),
    FULL,
    instructionDoc({ metadata: { name: 'true', description: '  padded  ' } }),
    instructionDoc({ spec: { instruction: 'one\n\nthree', retryCondition: 'attempts < 3' } }),
    instructionDoc({ spec: { instruction: 'trailing newline\n' } }),
    instructionDoc({ metadata: { name: 'has: colon' }, spec: { instruction: 'tab\there' } }),
    {
      apiVersion: PHASE_YAML_API_VERSION,
      kind: PHASE_YAML_KIND,
      metadata: { phaseId: 'p', name: 'N', version: 7 },
      spec: { skill: 'speckit-plan', isRequired: true }
    }
  ];

  it.each(CORPUS.map((doc, index) => [index, doc] as const))(
    'parse(emit(d)) equals d for corpus document %i',
    (_index, doc) => {
      const text = serializePhaseDocument(doc);
      const parsed = parseDocumentText(text);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(documentFromNode(parsed.node)).toEqual(doc);
    }
  );

  it.each(CORPUS.map((doc, index) => [index, doc] as const))(
    'emit(parse(emit(d))) is byte-identical for corpus document %i',
    (_index, doc) => {
      const once = serializePhaseDocument(doc);
      const parsed = parseDocumentText(once);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(serializePhaseDocument(documentFromNode(parsed.node))).toBe(once);
    }
  );
});

// ---------------------------------------------------------------------------
// Feature 085 T010 — sequence emission.
// specs/085-pipeline-package-exchange/data-model.md §2, research R3.
//
// Three properties, in the order the research names them: a sequence sits at
// its key's level + 1 and never at the key's own level; every mapping this
// format writes has a declared order held in this module; and an empty list
// emits nothing at all, because `key:` with no children reads back as an empty
// MAPPING and would make the round trip lossy.
// ---------------------------------------------------------------------------

/** The item at `path`, resolved through the parsed tree. */
function nodeAt(node: YamlNode, path: readonly (string | number)[]): YamlNode {
  let current = node;
  for (const step of path) {
    if (typeof step === 'number') {
      if (current.kind !== 'sequence') throw new Error(`not a sequence at ${step}`);
      const item = current.items[step];
      if (!item) throw new Error(`no item at ${step}`);
      current = item;
      continue;
    }
    if (current.kind !== 'mapping') throw new Error(`not a mapping at '${step}'`);
    const entry = current.entries.find((e) => e.key === step);
    if (!entry) throw new Error(`missing key '${step}'`);
    current = entry.value;
  }
  return current;
}

function textAt(node: YamlNode, path: readonly (string | number)[]): string {
  const found = nodeAt(node, path);
  if (found.kind !== 'scalar') throw new Error(`expected a scalar, got ${found.kind}`);
  return found.value;
}

function parsed(text: string): YamlNode {
  const result = parseDocumentText(text);
  if (!result.ok) {
    throw new Error(`expected a parse, got ${result.refusal.code}: ${result.refusal.message}`);
  }
  return result.node;
}

describe('yaml-serializer — declared key order for the package mappings', () => {
  it('holds every order this format writes as a constant in this module', () => {
    expect(PACKAGE_DOCUMENT_KEY_ORDER).toEqual([
      'apiVersion',
      'kind',
      'metadata',
      'spec',
      'included'
    ]);
    // Mirrors the single-Phase METADATA_KEY_ORDER so the two documents' identity
    // blocks read the same way; data-model.md §2.2 declares the fields, and §2.3
    // is the only section that fixes an order for itself.
    expect(PIPELINE_METADATA_KEY_ORDER).toEqual(['id', 'name', 'version', 'description']);
    expect(PIPELINE_SPEC_KEY_ORDER).toEqual([
      'phaseIds',
      'inputs',
      'outputs',
      'bindings',
      'executionDefaults',
      'recommendedNext'
    ]);
    expect(INPUT_PORT_KEY_ORDER).toEqual(['portId', 'label', 'type', 'required', 'description']);
    expect(OUTPUT_PORT_KEY_ORDER).toEqual(['portId', 'label', 'type', 'description']);
    expect(INPUT_BINDING_KEY_ORDER).toEqual(['kind', 'phaseIndex', 'inputKey', 'source']);
    expect(OUTPUT_BINDING_KEY_ORDER).toEqual(['kind', 'phaseIndex', 'portId', 'outputKey']);
    expect(BINDING_SOURCE_KEY_ORDER).toEqual(['from', 'phaseIndex', 'portId']);
    expect(EXECUTION_DEFAULTS_KEY_ORDER).toEqual([
      'runner',
      'model',
      'effort',
      'timeoutSeconds'
    ]);
  });

  it('emits a mapping in the declared order whatever order the object was built in', () => {
    const forwards = emitMapping(PHASE_YAML_INDENT, INPUT_PORT_KEY_ORDER, {
      portId: 'brief',
      label: 'Brief',
      type: 'text',
      required: true
    });
    const backwards = emitMapping(PHASE_YAML_INDENT, INPUT_PORT_KEY_ORDER, {
      required: true,
      type: 'text',
      label: 'Brief',
      portId: 'brief'
    });
    expect(backwards).toBe(forwards);
    expect(forwards).toBe(
      ['  portId: brief', '  label: Brief', '  type: text', '  required: true', ''].join('\n')
    );
  });

  it('skips an absent optional rather than emitting a bare key', () => {
    const text = emitMapping('', OUTPUT_PORT_KEY_ORDER, {
      portId: 'plan',
      label: 'Plan',
      type: 'markdown'
    });
    expect(text).not.toContain('description');
    expect(text).not.toMatch(/^\w+: *$/m);
  });
});

describe('yaml-serializer — scalar sequences (research R3)', () => {
  it('writes the items one level below the key', () => {
    expect(emitSequence('', 'phaseIds', ['specify', 'plan'])).toBe(
      ['phaseIds:', '  - specify', '  - plan', ''].join('\n')
    );
  });

  it('keeps that relationship at any depth', () => {
    expect(emitSequence(PHASE_YAML_INDENT, 'recommendedNext', ['review'])).toBe(
      ['  recommendedNext:', '    - review', ''].join('\n')
    );
  });

  it('emits NOTHING for an empty list — not a bare key', () => {
    expect(emitSequence(PHASE_YAML_INDENT, 'inputs', [])).toBe('');
  });

  it('quotes an item another reader would re-type', () => {
    expect(emitScalarItem('  ', 'true')).toBe('  - "true"\n');
    expect(emitScalarItem('  ', '42')).toBe('  - "42"\n');
  });

  it('measures a block-literal item body from the dash level + 1', () => {
    // Dash at column 2 -> body at column 4 -> literal content at column 6, which
    // is what the scanner reads back.
    expect(emitScalarItem('  ', 'first\nsecond')).toBe('  - |-\n      first\n      second\n');
  });

  it('round-trips a scalar sequence through the reader', () => {
    const values = ['specify', 'true', '42', 'has: colon', '-1'];
    const tree = parsed(emitSequence('', 'phaseIds', values));
    expect((nodeAt(tree, ['phaseIds']) as { items: readonly YamlNode[] }).items.map((i) =>
      i.kind === 'scalar' ? i.value : null
    )).toEqual(values);
  });
});

describe('yaml-serializer — mapping sequences (data-model.md §2.3)', () => {
  const BINDINGS = [
    { kind: 'input', phaseIndex: 0, inputKey: 'brief' },
    { kind: 'output', phaseIndex: 1, portId: 'plan-document', outputKey: 'plan' }
  ] as const;

  it('puts the dash on the first line of each item and leaves the rest at the body column', () => {
    const text = emitMappingSequence('', 'bindings', [BINDINGS[0]], (bodyIndent, item) =>
      emitMapping(bodyIndent, INPUT_BINDING_KEY_ORDER, item)
    );
    expect(text).toBe(
      ['bindings:', '  - kind: input', '    phaseIndex: 0', '    inputKey: brief', ''].join('\n')
    );
  });

  it('emits NOTHING for an empty list', () => {
    expect(emitMappingSequence('', 'bindings', [], () => 'unreachable')).toBe('');
  });

  it('nests a mapping inside an item body one level below it', () => {
    const text = emitMappingSequence('', 'bindings', [BINDINGS[0]], (bodyIndent, item) => {
      const nestedIndent = `${bodyIndent}${PHASE_YAML_INDENT}`;
      return (
        emitMapping(bodyIndent, INPUT_BINDING_KEY_ORDER, item) +
        emitKey(bodyIndent, 'source') +
        emitMapping(nestedIndent, BINDING_SOURCE_KEY_ORDER, {
          from: 'phase-output',
          phaseIndex: 0,
          portId: 'spec-document'
        })
      );
    });
    expect(text).toBe(
      [
        'bindings:',
        '  - kind: input',
        '    phaseIndex: 0',
        '    inputKey: brief',
        '    source:',
        '      from: phase-output',
        '      phaseIndex: 0',
        '      portId: spec-document',
        ''
      ].join('\n')
    );
  });

  it('nests a sequence inside an item body one level below it', () => {
    const text = emitMappingSequence('', 'included', [{ id: 'p' }], (bodyIndent, item) =>
      emitMapping(bodyIndent, ['id'], item) + emitSequence(bodyIndent, 'phaseIds', ['specify'])
    );
    expect(text).toBe(
      ['included:', '  - id: p', '    phaseIds:', '      - specify', ''].join('\n')
    );
  });

  it('round-trips a mapping sequence, and both variants of the union, through the reader', () => {
    const text =
      emitKey('', 'spec') +
      emitMappingSequence(PHASE_YAML_INDENT, 'bindings', BINDINGS, (bodyIndent, item) =>
        emitMapping(
          bodyIndent,
          item.kind === 'input' ? INPUT_BINDING_KEY_ORDER : OUTPUT_BINDING_KEY_ORDER,
          item
        )
      );
    const tree = parsed(text);
    expect(textAt(tree, ['spec', 'bindings', 0, 'kind'])).toBe('input');
    expect(textAt(tree, ['spec', 'bindings', 0, 'inputKey'])).toBe('brief');
    expect(textAt(tree, ['spec', 'bindings', 1, 'kind'])).toBe('output');
    expect(textAt(tree, ['spec', 'bindings', 1, 'outputKey'])).toBe('plan');
  });

  it('round-trips a block literal carried by an item body', () => {
    const text = emitMappingSequence('', 'phases', [{ instruction: 'first\nsecond' }], (bodyIndent, item) =>
      emitMapping(bodyIndent, ['instruction'], item)
    );
    expect(textAt(parsed(text), ['phases', 0, 'instruction'])).toBe('first\nsecond');
  });
});
