// Feature 085 T012 — the conformance corpus.
//
// specs/085-pipeline-package-exchange/contracts/yaml-grammar.md is the
// authority; `tests/fixtures/process-yaml/` is that grammar written out as
// documents. Two halves, and the distinction between them is the whole point:
//
//   084 — the shipped single-Phase format. Every expectation in this half was
//         captured by running the PRE-CHANGE reader, so a disagreement here is
//         a behavior change, which research R1 says this feature does not make.
//         The widening is additive: same trees, same refusal codes, same
//         refusal messages, for every document that was already in the language.
//
//   085 — the one production the subset gained, and the narrowings that bound
//         it. Every accepted fixture here was refused by the pre-change reader.
//
//   086 — the Workflow package kind. This half adds NO production: it exists to
//         hold the subset's deepest reachable nesting — a condition literal list
//         inside a connection item — and to pin that the 085 narrowings still
//         bite at that depth. If a fixture here ever needed a scanner change to
//         pass, the feature was mis-planned; see the T001 gate below.
//
// The corpus is also checked for its own integrity: an orphaned document or an
// orphaned expectation fails, because a golden corpus that silently skips a case
// is worse than no corpus.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parseDocumentBytes, parseDocumentText } from '../../src/services/process-yaml/yaml-parser';
import type {
  DocumentRefusal,
  DocumentRefusalCode,
  YamlMappingNode,
  YamlNode
} from '../../src/services/process-yaml/types';
import { PHASE_YAML_MAX_BYTES } from '../../src/services/process-yaml/types';

const FIXTURES = resolve(__dirname, '../fixtures/process-yaml');

type Half = 'accepted' | 'refused';
// The runner enumerates vintages explicitly, so a fixture directory named here
// is executed and one that is not is silently never read. Adding a vintage
// directory without adding it to this union is the failure mode 086's analyze
// pass caught: the corpus half of the no-widening guarantee would have covered
// nothing while still reporting green.
type Vintage = '084' | '085' | '086';

function directory(half: Half, vintage: Vintage): string {
  return join(FIXTURES, half, vintage);
}

function names(half: Half, vintage: Vintage): readonly string[] {
  return readdirSync(directory(half, vintage))
    .filter((entry) => entry.endsWith('.yaml'))
    .map((entry) => entry.slice(0, -'.yaml'.length))
    .sort();
}

function documentText(half: Half, vintage: Vintage, name: string): string {
  return readFileSync(join(directory(half, vintage), `${name}.yaml`), 'utf8');
}

function expectation<T>(half: Half, vintage: Vintage, name: string, suffix: string): T {
  const path = join(directory(half, vintage), `${name}.${suffix}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    throw new Error(`missing or unreadable expectation file: ${path}`);
  }
}

/** Every scalar in the tree, depth-first, for the properties that scan values. */
function scalars(node: YamlNode): readonly { value: string; quoted: boolean }[] {
  if (node.kind === 'scalar') return [{ value: node.value, quoted: node.quoted }];
  if (node.kind === 'sequence') return node.items.flatMap(scalars);
  return node.entries.flatMap((entry) => scalars(entry.value));
}

function parse(text: string): YamlMappingNode {
  const result = parseDocumentText(text);
  if (!result.ok) {
    throw new Error(`expected a parse, got ${result.refusal.code}: ${result.refusal.message}`);
  }
  return result.node;
}

describe.each(['084', '085', '086'] as const)('process-yaml corpus — accepted/%s', (vintage) => {
  const cases = names('accepted', vintage);

  it('has fixtures', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)('%s parses to the captured tree', (name) => {
    const result = parseDocumentText(documentText('accepted', vintage, name));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.node).toEqual(expectation('accepted', vintage, name, 'tree.json'));
  });

  it('has one expectation per document and no orphans', () => {
    const files = readdirSync(directory('accepted', vintage)).sort();
    expect(files).toEqual(
      cases.flatMap((name) => [`${name}.tree.json`, `${name}.yaml`]).sort()
    );
  });
});

describe.each(['084', '085', '086'] as const)('process-yaml corpus — refused/%s', (vintage) => {
  const cases = names('refused', vintage);

  it('has fixtures', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)('%s is refused with the captured code and message', (name) => {
    const result = parseDocumentText(documentText('refused', vintage, name));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toEqual(expectation<DocumentRefusal>('refused', vintage, name, 'refusal.json'));
    // No refusal carries a node, however far the reader got before refusing.
    expect(result).not.toHaveProperty('node');
  });

  it('has one expectation per document and no orphans', () => {
    const files = readdirSync(directory('refused', vintage)).sort();
    expect(files).toEqual(
      cases.flatMap((name) => [`${name}.refusal.json`, `${name}.yaml`]).sort()
    );
  });
});

describe('process-yaml corpus — the widening is additive (research R1)', () => {
  it('refuses every 084 refusal with the same code it always did', () => {
    // Stated as a set rather than per-case so a NEW code appearing anywhere in
    // the regression half fails here too, not only in the per-case assertions.
    const codes = names('refused', '084').map(
      (name) => expectation<DocumentRefusal>('refused', '084', name, 'refusal.json').code
    );
    expect([...new Set(codes)].sort()).toEqual(['disallowed-syntax', 'empty', 'multi-document']);
  });

  it('keeps every narrowing on the new production a syntax refusal at the token', () => {
    for (const name of names('refused', '085')) {
      const refusal = expectation<DocumentRefusal>('refused', '085', name, 'refusal.json');
      expect(refusal.code).toBe('disallowed-syntax');
      expect(refusal.message).toMatch(/\(line \d+\)$/);
    }
  });
});

describe('process-yaml corpus — no implicit typing (FR-005)', () => {
  const tree = parse(documentText('accepted', '084', 'no-implicit-typing'));
  const values = tree.entries[0]?.value;

  it.each([
    ['bool', 'true'],
    ['boolWord', 'yes'],
    ['boolOff', 'off'],
    ['number', '3'],
    ['float', '1.5'],
    ['hex', '0x1f'],
    ['nullWord', 'null'],
    ['nullTilde', '~'],
    ['date', '2026-08-03'],
    ['infinity', '.inf']
  ])('reads %s back as the text "%s"', (key, text) => {
    if (values?.kind !== 'mapping') throw new Error('expected a mapping');
    const entry = values.entries.find((e) => e.key === key);
    expect(entry?.value).toMatchObject({ kind: 'scalar', value: text, quoted: false });
    // Belt and braces: the node type says string, and so does the runtime.
    expect(typeof (entry?.value as { value: unknown }).value).toBe('string');
  });

  it('marks the quoted form so a later stage can tell the two apart', () => {
    if (values?.kind !== 'mapping') throw new Error('expected a mapping');
    const plain = values.entries.find((e) => e.key === 'number')?.value;
    const quoted = values.entries.find((e) => e.key === 'quotedNumber')?.value;
    expect(plain).toMatchObject({ value: '3', quoted: false });
    expect(quoted).toMatchObject({ value: '3', quoted: true });
  });
});

describe('process-yaml corpus — comments and blank lines are permitted on read (FR-010)', () => {
  it('keeps only the entries, at any indent', () => {
    const tree = parse(documentText('accepted', '084', 'comments-and-blank-lines'));
    expect(tree.entries.map((entry) => entry.key)).toEqual(['kind', 'metadata']);
  });

  it('carries no comment text anywhere in the tree', () => {
    const tree = parse(documentText('accepted', '084', 'comments-and-blank-lines'));
    for (const scalar of scalars(tree)) {
      expect(scalar.value).not.toContain('comment');
      expect(scalar.value).not.toContain('#');
    }
  });

  it('strips a trailing comment from a value without touching a "#" inside one', () => {
    const tree = parse(documentText('accepted', '084', 'plain-scalar-edges'));
    const spec = tree.entries[0]?.value;
    if (spec?.kind !== 'mapping') throw new Error('expected a mapping');
    const read = (key: string) => spec.entries.find((e) => e.key === key)?.value;
    expect(read('effort')).toMatchObject({ value: 'value' });
    expect(read('model')).toMatchObject({ value: 'a#b' });
    // The dash and the question mark are indicators only where they act as one.
    expect(read('timeoutSeconds')).toMatchObject({ value: '-1' });
    expect(read('runner')).toMatchObject({ value: '?not-a-complex-key' });
  });
});

describe('process-yaml corpus — the new production (FR-004)', () => {
  it('reads a scalar sequence as a sequence node of scalars', () => {
    const tree = parse(documentText('accepted', '085', 'scalar-sequence'));
    const seq = tree.entries[0]?.value;
    expect(seq?.kind).toBe('sequence');
    if (seq?.kind !== 'sequence') return;
    expect(seq.items.map((item) => (item.kind === 'scalar' ? item.value : null))).toEqual([
      'specify',
      'plan',
      'tasks'
    ]);
  });

  it('reads the package document shape end to end', () => {
    const tree = parse(documentText('accepted', '085', 'package-document'));
    expect(tree.entries.map((entry) => entry.key)).toEqual([
      'apiVersion',
      'kind',
      'metadata',
      'spec',
      'included'
    ]);
    const spec = tree.entries.find((entry) => entry.key === 'spec')?.value;
    if (spec?.kind !== 'mapping') throw new Error('expected a mapping');
    expect(spec.entries.map((entry) => entry.key)).toEqual([
      'phaseIds',
      'inputs',
      'outputs',
      'bindings',
      'executionDefaults',
      'recommendedNext'
    ]);
    const bindings = spec.entries.find((entry) => entry.key === 'bindings')?.value;
    if (bindings?.kind !== 'sequence') throw new Error('expected a sequence');
    expect(bindings.items).toHaveLength(2);
    // A binding addresses its Phase by index into `phaseIds`, never by id.
    for (const item of bindings.items) {
      if (item.kind !== 'mapping') throw new Error('expected a mapping item');
      expect(item.entries.map((entry) => entry.key)).toContain('phaseIndex');
      expect(item.entries.map((entry) => entry.key)).not.toContain('phaseId');
    }
  });
});

// ---------------------------------------------------------------------------
// Feature 086 T001 — the stage-0 gate: this feature needs no new production
// ---------------------------------------------------------------------------
//
// The single most load-bearing claim in 086's plan is that a Workflow package
// fits the subset 085 left behind, unchanged. The shape that could have broken
// it is a condition literal list — what the `in` / `not-in` operators need —
// because it puts a block sequence two levels below a `- ` dash that is itself
// a block sequence item, which is the deepest nesting the bounded form has ever
// been asked for.
//
// This is a GATE, not a regression test. If it is red, the correct response is
// to re-plan the feature, NOT to widen `yaml-scanner.ts`. The three grammar
// modules are additionally pinned by content hash in
// `tests/lint/process-yaml-grammar-frozen.test.ts` so that widening them to
// make this pass fails a second, louder check.

describe('Feature 086 T001 — a Workflow condition literal list needs no new production', () => {
  // `spec.connections` is a bounded block sequence; each item is a mapping; that
  // mapping's `condition.right` is itself a bounded block sequence. Nothing here
  // is outside the form 085 admitted — the dash takes one indent level and its
  // body sits at that level plus one, at both depths.
  const DOCUMENT = [
    'apiVersion: schegent/v1',
    'kind: Workflow',
    'metadata:',
    '  name: release',
    'spec:',
    '  connections:',
    '    - from:',
    '        nodeId: build',
    '        portId: artifact',
    '      to:',
    '        nodeId: publish',
    '        portId: artifact',
    '      condition:',
    '        left:',
    '          source: node-output',
    '          nodeId: build',
    '          field: status',
    '        operator: in',
    '        right:',
    '          - ok',
    '          - warn',
    ''
  ].join('\n');

  it('parses, with the literal list read as a sequence node of scalars', () => {
    const result = parseDocumentText(DOCUMENT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const spec = result.node.entries.find((entry) => entry.key === 'spec')?.value;
    if (spec?.kind !== 'mapping') throw new Error('expected spec to be a mapping');
    const connections = spec.entries.find((entry) => entry.key === 'connections')?.value;
    if (connections?.kind !== 'sequence') throw new Error('expected connections to be a sequence');
    expect(connections.items).toHaveLength(1);

    const item = connections.items[0];
    if (item?.kind !== 'mapping') throw new Error('expected a mapping item');
    const condition = item.entries.find((entry) => entry.key === 'condition')?.value;
    if (condition?.kind !== 'mapping') throw new Error('expected condition to be a mapping');
    const right = condition.entries.find((entry) => entry.key === 'right')?.value;

    // Lines pinned too: the reader locates the deepest construct correctly, so a
    // defect reported against a literal points at the literal.
    expect(right).toEqual({
      kind: 'sequence',
      line: 20,
      items: [
        { kind: 'scalar', value: 'ok', quoted: false, line: 20 },
        { kind: 'scalar', value: 'warn', quoted: false, line: 21 }
      ]
    });
  });

  it('keeps the endpoints structured, so no dotted string has to be parsed', () => {
    const result = parseDocumentText(DOCUMENT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const spec = result.node.entries.find((entry) => entry.key === 'spec')?.value;
    if (spec?.kind !== 'mapping') throw new Error('expected spec to be a mapping');
    const connections = spec.entries.find((entry) => entry.key === 'connections')?.value;
    if (connections?.kind !== 'sequence') throw new Error('expected connections to be a sequence');
    const item = connections.items[0];
    if (item?.kind !== 'mapping') throw new Error('expected a mapping item');

    for (const key of ['from', 'to'] as const) {
      const endpoint = item.entries.find((entry) => entry.key === key)?.value;
      if (endpoint?.kind !== 'mapping') throw new Error(`expected ${key} to be a mapping`);
      expect(endpoint.entries.map((entry) => entry.key)).toEqual(['nodeId', 'portId']);
    }
  });
});

// ---------------------------------------------------------------------------
// Feature 085 T060 — the refusal table, entire (FR-047, FR-048, FR-003a)
// ---------------------------------------------------------------------------
//
// The corpus above covers the constructs that have fixture files. This covers
// the rest of `contracts/yaml-grammar.md`'s table, and the three properties the
// table as a whole is asserting:
//
//   FR-047  every refusal is a returned value — nothing on this path throws,
//           for any bytes at all
//   FR-048  the guard order is size → encoding/BOM → decode → scanner → parser,
//           and it is load-bearing rather than incidental
//   FR-003a the refusal lands at the token, so nothing the document declared is
//           constructed first and nothing it declared is echoed back
//
// Cases are written as bytes-in / code-out so the table is checked against the
// reader rather than against a reading of the reader.

const CONSTRUCTED = 'CONSTRUCTED-PAYLOAD';

interface TableCase {
  readonly construct: string;
  readonly code: DocumentRefusalCode;
  readonly text: string;
}

/** Inherited from 084, unchanged by this feature (research R1). */
const INHERITED: readonly TableCase[] = [
  { construct: 'an anchor', code: 'disallowed-syntax', text: `metadata: &base\n  name: ${CONSTRUCTED}\n` },
  { construct: 'an alias', code: 'disallowed-syntax', text: `metadata:\n  name: A\nspec: *base\n` },
  { construct: 'a merge key', code: 'disallowed-syntax', text: `spec:\n  <<: *base\n` },
  { construct: 'a shorthand tag', code: 'disallowed-syntax', text: `metadata:\n  name: !!str ${CONSTRUCTED}\n` },
  { construct: 'a named tag', code: 'disallowed-syntax', text: `metadata: !Foo\n  name: A\n` },
  { construct: 'a directive', code: 'disallowed-syntax', text: `%YAML 1.2\n---\nkind: Phase\n` },
  { construct: 'a flow mapping', code: 'disallowed-syntax', text: `metadata: { name: ${CONSTRUCTED} }\n` },
  { construct: 'a flow sequence', code: 'disallowed-syntax', text: `metadata: [ ${CONSTRUCTED} ]\n` },
  { construct: 'a folded scalar', code: 'disallowed-syntax', text: `spec:\n  instruction: >\n    ${CONSTRUCTED}\n` },
  { construct: 'a single-quoted scalar', code: 'disallowed-syntax', text: `metadata:\n  name: '${CONSTRUCTED}'\n` },
  { construct: 'a block literal other than |-', code: 'disallowed-syntax', text: `spec:\n  instruction: |\n    ${CONSTRUCTED}\n` },
  { construct: 'a complex key', code: 'disallowed-syntax', text: `? ${CONSTRUCTED}\n: value\n` },
  { construct: 'a tab', code: 'disallowed-syntax', text: `metadata:\n\tname: ${CONSTRUCTED}\n` },
  { construct: 'a bare carriage return', code: 'disallowed-syntax', text: `metadata:\n  name: A\r${CONSTRUCTED}\n` },
  { construct: 'a second document start', code: 'multi-document', text: `kind: Phase\n---\nkind: Phase\n` },
  { construct: 'a document end marker', code: 'multi-document', text: `kind: Phase\n...\n` },
  // The contract's table calls this `duplicate-key`. The shipped union has no
  // such member and never did: a duplicate key is a syntax refusal whose
  // message names the key. See the reconciliation test below.
  { construct: 'a duplicate key in one mapping', code: 'disallowed-syntax', text: `metadata:\n  name: A\n  name: ${CONSTRUCTED}\n` },
  { construct: 'an indent that is not a multiple of two', code: 'disallowed-syntax', text: `metadata:\n   name: ${CONSTRUCTED}\n` },
  { construct: 'an indent increasing by more than one level', code: 'disallowed-syntax', text: `metadata:\n    name: ${CONSTRUCTED}\n` },
  { construct: 'an indented entry with no owning mapping', code: 'disallowed-syntax', text: `  name: ${CONSTRUCTED}\n` },
  { construct: 'trailing content after the document', code: 'disallowed-syntax', text: `metadata:\n  name: A\n${CONSTRUCTED}\n  oops: y\n` },
  { construct: 'an empty document', code: 'empty', text: '' },
  { construct: 'a document of only comments', code: 'empty', text: `# ${CONSTRUCTED}\n\n` }
];

/** New in 085 — every one a narrowing on the sequence production (FR-004b). */
const NARROWINGS: readonly TableCase[] = [
  { construct: '`-` alone on a line', code: 'disallowed-syntax', text: `spec:\n  phaseIds:\n    -\n    - a\n` },
  { construct: '`-` followed by two spaces', code: 'disallowed-syntax', text: `spec:\n  phaseIds:\n    -  ${CONSTRUCTED}\n` },
  { construct: 'a nested sequence', code: 'disallowed-syntax', text: `spec:\n  - - ${CONSTRUCTED}\n` },
  { construct: 'a level holding both items and entries', code: 'disallowed-syntax', text: `spec:\n  phaseIds:\n    - a\n    k: ${CONSTRUCTED}\n` },
  { construct: 'an item under an entry that took an inline value', code: 'disallowed-syntax', text: `spec:\n  phaseIds: x\n    - ${CONSTRUCTED}\n` }
];

const TABLE: readonly TableCase[] = [...INHERITED, ...NARROWINGS];

describe('Feature 085 T060 — the refusal table is the reader (FR-047, FR-003a)', () => {
  it.each(TABLE.map((c) => [c.construct, c] as const))(
    '%s is refused',
    (_construct, testCase) => {
      let result: ReturnType<typeof parseDocumentBytes> | undefined;
      // FR-047 asserted per case rather than once in aggregate: a throw from any
      // single construct is the failure this property exists to catch.
      expect(() => {
        result = parseDocumentBytes(new Uint8Array(Buffer.from(testCase.text, 'utf8')));
      }).not.toThrow();
      expect(result?.ok).toBe(false);
      if (result === undefined || result.ok) return;
      expect(result.refusal.code).toBe(testCase.code);
      expect(result.refusal.message.length).toBeGreaterThan(0);
      // FR-003a — refused at the token, so no declared value was constructed and
      // none is quoted back.
      expect(JSON.stringify(result)).not.toContain(CONSTRUCTED);
      expect(result).not.toHaveProperty('node');
    }
  );

  it('covers every code the table can produce, and no code it cannot', () => {
    // The document-validator codes are absent by construction: this table is the
    // syntactic layer, and `unsupported-version`/`unsupported-kind`/`duplicate-id`
    // are decided after a tree exists.
    expect([...new Set(TABLE.map((c) => c.code))].sort()).toEqual([
      'disallowed-syntax',
      'empty',
      'multi-document'
    ]);
  });

  it('names the offending key when a mapping repeats one', () => {
    // The contract table's `duplicate-key` row: the refusal is `disallowed-syntax`,
    // and what makes it actionable is the message, not a dedicated code. Pinned
    // so the reconciliation is a decision on record rather than a silent drift.
    const result = parseDocumentBytes(
      new Uint8Array(Buffer.from('metadata:\n  name: A\n  name: B\n', 'utf8'))
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('disallowed-syntax');
    expect(result.refusal.message).toContain('name');
  });

  it('accepts CRLF line endings, normalizing them away', () => {
    // The contract table's "carriage returns" row reads as a blanket refusal. It
    // is not, and must not be: a document authored on Windows has to import. The
    // refusal is for a BARE carriage return INSIDE a line, which is the case in
    // the table above. Both halves are pinned because a "simplification" that
    // made the rule uniform would break every Windows-authored document.
    const crlf = parseDocumentBytes(
      new Uint8Array(Buffer.from('kind: Phase\r\nmetadata:\r\n  name: A\r\n', 'utf8'))
    );
    const lf = parseDocumentBytes(
      new Uint8Array(Buffer.from('kind: Phase\nmetadata:\n  name: A\n', 'utf8'))
    );
    expect(crlf.ok).toBe(true);
    expect(lf.ok).toBe(true);
    if (!crlf.ok || !lf.ok) return;
    expect(crlf.node).toEqual(lf.node);
  });
});

describe('Feature 085 T060 — the guard order is load-bearing (FR-048)', () => {
  const OVERSIZE = PHASE_YAML_MAX_BYTES + 1;

  it('refuses on size before looking at a single byte of content', () => {
    // Oversized AND mis-encoded AND syntactically illegal. Only the first guard
    // in the chain can be the one that answers.
    const bytes = new Uint8Array(OVERSIZE);
    bytes.fill(0x80); // invalid UTF-8 everywhere
    bytes[0] = 0x09; // and a tab, which the scanner refuses
    const result = parseDocumentBytes(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('too-large');
  });

  it('refuses on encoding before the scanner, once size passes', () => {
    // Mis-encoded AND syntactically illegal, under the bound.
    const result = parseDocumentBytes(new Uint8Array([0x09, 0x6b, 0x3a, 0x20, 0x80, 0x0a]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('unreadable');
  });

  it('refuses a byte-order mark before decoding, not as a stray character', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('\tkind: Phase\n', 'utf8')]);
    const result = parseDocumentBytes(withBom);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('unreadable');
    expect(result.refusal.message).toContain('byte-order mark');
  });

  it('holds the same order on the text entry point, for the round-trip path', () => {
    // `parseDocumentText` is reached by the serializer's own output, but it is
    // exported, so it carries the same guards rather than trusting its caller.
    const bom = parseDocumentText('\ufeffkind: Phase\n');
    expect(bom.ok).toBe(false);
    if (bom.ok) return;
    expect(bom.refusal.code).toBe('unreadable');

    const large = parseDocumentText(`kind: Phase\n# ${'x'.repeat(OVERSIZE)}\n`);
    expect(large.ok).toBe(false);
    if (large.ok) return;
    expect(large.refusal.code).toBe('too-large');
  });

  it('returns rather than throws for any bytes at all (FR-047)', () => {
    const adversarial: readonly Uint8Array[] = [
      new Uint8Array(),
      new Uint8Array([0x00]),
      new Uint8Array([0xff, 0xfe, 0x00, 0x00]),
      new Uint8Array(Buffer.from('\u0000\u0001\u0002\u001f', 'utf8')),
      new Uint8Array(Buffer.from(':'.repeat(4096), 'utf8')),
      new Uint8Array(Buffer.from(' '.repeat(4096) + 'k: v\n', 'utf8')),
      new Uint8Array(Buffer.from('k:\n'.repeat(2048), 'utf8')),
      new Uint8Array(Buffer.from('- '.repeat(2048) + 'a\n', 'utf8')),
      new Uint8Array(Buffer.from('\u{1f600}: \u{1f600}\n', 'utf8')),
      new Uint8Array(Buffer.from('k: "\\u0000"\n', 'utf8'))
    ];
    for (const bytes of adversarial) {
      let result: ReturnType<typeof parseDocumentBytes> | undefined;
      expect(() => {
        result = parseDocumentBytes(bytes);
      }).not.toThrow();
      // A discriminated result either way — never undefined, never a bare throw.
      expect(typeof result?.ok).toBe('boolean');
      if (result !== undefined && !result.ok) {
        expect(result.refusal.message.length).toBeGreaterThan(0);
      }
    }
  });
});
