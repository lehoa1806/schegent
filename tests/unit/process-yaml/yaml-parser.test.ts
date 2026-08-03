// Feature 084 T006 — the accepted subset (test-first).
//
// Block mappings, nesting, plain scalars, double-quoted scalars with escapes,
// `|-` block literals, and the absence of implicit typing: every scalar the
// parser produces is text plus a flag saying whether its source form fixes it
// as text. Nothing is coerced to a number, a boolean, or null (FR-003).

import { describe, it, expect } from 'vitest';
import {
  parseDocumentBytes,
  parseDocumentText
} from '../../../src/services/process-yaml/yaml-parser';
import {
  PHASE_YAML_MAX_BYTES,
  type YamlMappingEntry,
  type YamlMappingNode,
  type YamlNode,
  type YamlScalarNode,
  type YamlSequenceNode
} from '../../../src/services/process-yaml/types';

function parse(text: string): YamlMappingNode {
  const result = parseDocumentText(text);
  if (!result.ok) {
    throw new Error(`expected a parse, got ${result.refusal.code}: ${result.refusal.message}`);
  }
  return result.node;
}

function lookup(node: YamlMappingNode, path: readonly string[]): YamlNode {
  let current: YamlNode = node;
  for (const key of path) {
    if (current.kind !== 'mapping') throw new Error(`not a mapping at '${key}'`);
    // Annotated because `current` is reassigned from what this lookup returns,
    // which is a cycle the inferencer will not resolve on its own (TS7022).
    const entry: YamlMappingEntry | undefined = current.entries.find((e) => e.key === key);
    if (!entry) throw new Error(`missing key '${key}'`);
    current = entry.value;
  }
  return current;
}

function scalarAt(node: YamlMappingNode, path: readonly string[]): YamlScalarNode {
  const found = lookup(node, path);
  if (found.kind !== 'scalar') throw new Error('expected a scalar');
  return found;
}

function sequenceAt(node: YamlMappingNode, path: readonly string[]): YamlSequenceNode {
  const found = lookup(node, path);
  if (found.kind !== 'sequence') throw new Error(`expected a sequence, got ${found.kind}`);
  return found;
}

/** Every item's scalar text, for the shape assertions that only read values. */
function itemTexts(node: YamlSequenceNode): readonly string[] {
  return node.items.map((item) => {
    if (item.kind !== 'scalar') throw new Error(`expected a scalar item, got ${item.kind}`);
    return item.value;
  });
}

function refuse(text: string): { code: string; message: string } {
  const result = parseDocumentText(text);
  if (result.ok) throw new Error('expected the document to be refused');
  return result.refusal;
}

const FULL = [
  '---',
  'apiVersion: schegent/v1',
  'kind: Phase',
  'metadata:',
  '  phaseId: my-phase',
  '  name: My Phase',
  '  version: 3',
  'spec:',
  '  instruction: |-',
  '    line one',
  '    line two',
  '  timeoutSeconds: 120',
  '  loopable: true',
  '  retryCondition: "attempts < 3"',
  ''
].join('\n');

describe('yaml-parser — accepted subset', () => {
  it('builds a nested block mapping', () => {
    const doc = parse(FULL);
    expect(doc.entries.map((e) => e.key)).toEqual(['apiVersion', 'kind', 'metadata', 'spec']);
    expect(lookup(doc, ['metadata']).kind).toBe('mapping');
    expect(lookup(doc, ['spec']).kind).toBe('mapping');
  });

  it('reads plain scalars verbatim', () => {
    expect(scalarAt(parse(FULL), ['metadata', 'name']).value).toBe('My Phase');
  });

  it('reads a block literal preserving line structure', () => {
    expect(scalarAt(parse(FULL), ['spec', 'instruction']).value).toBe('line one\nline two');
  });

  it('applies no implicit typing — every scalar is text', () => {
    const doc = parse(FULL);
    for (const path of [
      ['metadata', 'version'],
      ['spec', 'timeoutSeconds'],
      ['spec', 'loopable']
    ]) {
      expect(typeof scalarAt(doc, path).value).toBe('string');
    }
    expect(scalarAt(doc, ['metadata', 'version']).value).toBe('3');
    expect(scalarAt(doc, ['spec', 'loopable']).value).toBe('true');
  });

  it('marks quoted scalars so a later stage cannot read them as a number', () => {
    const doc = parse('a: 42\nb: "42"\n');
    expect(scalarAt(doc, ['a']).quoted).toBe(false);
    expect(scalarAt(doc, ['b']).quoted).toBe(true);
  });

  it('decodes the escapes the grammar admits', () => {
    const doc = parse('a: "tab:\\t nl:\\n quote:\\" back:\\\\ u:\\u00e9"\n');
    expect(scalarAt(doc, ['a']).value).toBe('tab:\t nl:\n quote:" back:\\ u:é');
  });

  it('treats a block literal as quoted, because its source form fixes it as text', () => {
    const doc = parse('a: |-\n  42\n');
    expect(scalarAt(doc, ['a'])).toMatchObject({ value: '42', quoted: true });
  });

  it('keeps entry order as authored', () => {
    const doc = parse('spec:\n  skill: s\nkind: Phase\n');
    expect(doc.entries.map((e) => e.key)).toEqual(['spec', 'kind']);
  });

  it('records the source line of each entry', () => {
    const doc = parse('kind: Phase\nmetadata:\n  name: A\n');
    expect(doc.entries.map((e) => e.line)).toEqual([1, 2]);
    expect(scalarAt(doc, ['metadata', 'name']).line).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Feature 085 T007 — sequence assembly.
// specs/085-pipeline-package-exchange/contracts/yaml-grammar.md
//
// A key whose value is a block opens EITHER a mapping or a sequence, decided by
// the first token beneath it. A level is one or the other and never both, so the
// interesting cases are the shapes that nest them and the ones that mix them.
// ---------------------------------------------------------------------------

describe('yaml-parser — sequences', () => {
  it('builds a sequence of scalars under a key', () => {
    const seq = sequenceAt(parse('phaseIds:\n  - specify\n  - plan\n  - tasks\n'), ['phaseIds']);
    expect(itemTexts(seq)).toEqual(['specify', 'plan', 'tasks']);
  });

  it('applies no implicit typing to an item, exactly as for an entry', () => {
    const seq = sequenceAt(parse('values:\n  - 42\n  - true\n  - "42"\n'), ['values']);
    expect(seq.items.map((i) => i.kind === 'scalar' && i.quoted)).toEqual([false, false, true]);
    expect(itemTexts(seq)).toEqual(['42', 'true', '42']);
  });

  it('builds a sequence of mappings, one per item', () => {
    const doc = parse(
      [
        'bindings:',
        '  - kind: input',
        '    phaseIndex: 0',
        '  - kind: output',
        '    phaseIndex: 1',
        ''
      ].join('\n')
    );
    const seq = sequenceAt(doc, ['bindings']);
    expect(seq.items.map((i) => i.kind)).toEqual(['mapping', 'mapping']);
    expect(
      seq.items.map((item) =>
        item.kind === 'mapping' ? item.entries.map((e) => [e.key, (e.value as YamlScalarNode).value]) : null
      )
    ).toEqual([
      [
        ['kind', 'input'],
        ['phaseIndex', '0']
      ],
      [
        ['kind', 'output'],
        ['phaseIndex', '1']
      ]
    ]);
  });

  it('builds a mapping nested inside an item body', () => {
    const doc = parse(
      ['bindings:', '  - kind: input', '    source:', '      from: pipeline-input', ''].join('\n')
    );
    const [item] = sequenceAt(doc, ['bindings']).items;
    if (item.kind !== 'mapping') throw new Error('expected a mapping item');
    expect(lookup(item, ['source']).kind).toBe('mapping');
    expect(scalarAt(item, ['source', 'from']).value).toBe('pipeline-input');
  });

  it('builds a sequence nested inside an item body', () => {
    const doc = parse(['included:', '  - phaseIds:', '      - specify', '      - plan', ''].join('\n'));
    const [item] = sequenceAt(doc, ['included']).items;
    if (item.kind !== 'mapping') throw new Error('expected a mapping item');
    expect(itemTexts(sequenceAt(item, ['phaseIds']))).toEqual(['specify', 'plan']);
  });

  it('reads a block literal as an item body value', () => {
    const doc = parse(['phases:', '  - instruction: |-', '      first', '      second', ''].join('\n'));
    const [item] = sequenceAt(doc, ['phases']).items;
    if (item.kind !== 'mapping') throw new Error('expected a mapping item');
    expect(scalarAt(item, ['instruction']).value).toBe('first\nsecond');
  });

  it('keeps a mapping a mapping when no item follows the key', () => {
    // The dispatch reads the first child token and nothing else, so a key whose
    // block happens to CONTAIN a sequence deeper down is still a mapping here.
    const doc = parse('spec:\n  phaseIds:\n    - specify\n');
    expect(lookup(doc, ['spec']).kind).toBe('mapping');
  });

  it('records the source line of the sequence and of each item', () => {
    const seq = sequenceAt(parse('spec:\n  phaseIds:\n    - specify\n    - plan\n'), [
      'spec',
      'phaseIds'
    ]);
    expect(seq.line).toBe(3);
    expect(seq.items.map((i) => i.line)).toEqual([3, 4]);
  });

  it('resumes the enclosing mapping after a sequence ends', () => {
    const doc = parse('phaseIds:\n  - specify\nkind: Pipeline\n');
    expect(doc.entries.map((e) => e.key)).toEqual(['phaseIds', 'kind']);
    expect(scalarAt(doc, ['kind']).value).toBe('Pipeline');
  });
});

describe('yaml-parser — a level is a mapping or a sequence, never both', () => {
  it('refuses a mapping key at a level that opened as a sequence', () => {
    const r = refuse('spec:\n  - specify\n  name: A\n');
    expect(r.code).toBe('disallowed-syntax');
    expect(r.message).toMatch(/may not share one level/);
  });

  it('refuses an item at a level that opened as a mapping', () => {
    const r = refuse('spec:\n  name: A\n  - specify\n');
    expect(r.code).toBe('disallowed-syntax');
    expect(r.message).toMatch(/may not share one level/);
  });

  it('names the document shape when the sequence is the top level', () => {
    const r = refuse('- kind: Phase\n');
    expect(r.code).toBe('disallowed-syntax');
    expect(r.message).toMatch(/must begin with a mapping/);
  });

  it('refuses a second document start inside a sequence', () => {
    expect(refuse('phaseIds:\n  - specify\n---\nkind: Pipeline\n').code).toBe('multi-document');
  });
});

const BOM = '\uFEFF';

describe('yaml-parser — the widening did not move the guards (FR-011)', () => {
  // The spy-backed proof that the scanner is never entered lives in
  // `yaml-parser-guards.test.ts`. What these three add is that the ORDER still
  // holds for the documents this feature introduced: each input is both
  // guard-refusable and sequence-shaped, so a guard that ran after the scanner
  // would report a different code.
  it('refuses an over-sized sequence document on the byte count', () => {
    const oversized = `spec:\n  - - x\n#${'y'.repeat(PHASE_YAML_MAX_BYTES)}\n`;
    // Scanner-first would report the nested sequence as disallowed-syntax.
    expect(refuse(oversized).code).toBe('too-large');
  });

  it('refuses a byte-order mark before reading the sequence', () => {
    expect(refuse(`${BOM}phaseIds:\n  - specify\n`).code).toBe('unreadable');
  });

  it('refuses invalid UTF-8 before reading the sequence', () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('phaseIds:\n  - '),
      0x80,
      0x0a
    ]);
    const result = parseDocumentBytes(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('unreadable');
  });
});
