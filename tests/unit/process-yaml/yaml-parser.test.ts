// Feature 084 T006 — the accepted subset (test-first).
//
// Block mappings, nesting, plain scalars, double-quoted scalars with escapes,
// `|-` block literals, and the absence of implicit typing: every scalar the
// parser produces is text plus a flag saying whether its source form fixes it
// as text. Nothing is coerced to a number, a boolean, or null (FR-003).

import { describe, it, expect } from 'vitest';
import { parseDocumentText } from '../../../src/services/process-yaml/yaml-parser';
import type {
  YamlMappingEntry,
  YamlMappingNode,
  YamlNode,
  YamlScalarNode
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
