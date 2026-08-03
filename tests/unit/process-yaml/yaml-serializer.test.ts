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
  DOCUMENT_KEY_ORDER,
  METADATA_KEY_ORDER,
  SPEC_KEY_ORDER,
  serializePhaseDocument
} from '../../../src/services/process-yaml/yaml-serializer';
import { parseDocumentText } from '../../../src/services/process-yaml/yaml-parser';
import {
  PHASE_YAML_API_VERSION,
  PHASE_YAML_KIND,
  type PhaseYamlDocument,
  type YamlMappingNode
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
