/**
 * The two-stage narrowing: a quoted name selects a candidate, the absence of a conditionality
 * marker narrows a candidate to a finding.
 *
 * FR-R3-167 / FR-002, FR-010, FR-011, FR-013, FR-018. `docs/hard-rules.md` rule 67 is the reason
 * stage one matches a field's **name** and never its value.
 *
 * Every terminal disposition in the transition table is reached here, on a synthetic population,
 * so the shape is pinned independently of what today's tree happens to contain.
 *
 * Fixture field names are invented on purpose; see the note in `absent-field-census-scan.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  type ContractDocument,
  type FileScan,
  classify,
  formatFindings,
  readContract,
  scanSource,
} from '../../lint/absent-field-census';

const FILE = 'tests/fixture.test.ts';

function population(source: string): {
  readonly scans: readonly FileScan[];
  readonly sourceOf: (file: string) => readonly string[];
} {
  const lines = source.split('\n');
  return { scans: [scanSource(FILE, source)], sourceOf: () => lines };
}

const unconditional = readContract(
  'docs/reference/audit-events.md',
  'repo-docs',
  ['| Field | Type | Notes |', '|-------|------|-------|', '| `alphaField` | string | Always present. |'].join('\n')
);

const conditionalOptional = readContract(
  'docs/reference/audit-events.md',
  'repo-docs',
  ['| Field | Type | Notes |', '|-------|------|-------|', '| `betaField` | string, optional | Added later. |'].join(
    '\n'
  )
);

const conditionalNullable = readContract(
  'specs/x/contracts/state-schema.md',
  'envelope-specs',
  ['```ts', 'interface S {', '  gammaField: number | null;', '}', '```', '', 'The `gammaField` is nullable.'].join('\n')
);

const conditionalAnnotated = readContract(
  'specs/x/contracts/sidebar-ipc.md',
  'envelope-specs',
  [
    'The `deltaField` is documented below.',
    '',
    '```ts',
    'interface S {',
    '  // present iff the phase reached compaction',
    '  deltaField: string;',
    '}',
    '```',
  ].join('\n')
);

const proseOnly = readContract(
  'docs/reference/audit-events.md',
  'repo-docs',
  ['# Audit events', '', 'The `epsilonField` is mentioned but never declared.'].join('\n')
);

describe('classify — the five terminal dispositions', () => {
  it('a dynamic key is unclassifiable, with its reason, and is not dropped', () => {
    const { scans, sourceOf } = population('expect(record).not.toHaveProperty(key);');
    const result = classify(scans, [unconditional], sourceOf);

    expect(result.unclassifiable).toHaveLength(1);
    expect(result.unclassifiable[0]?.reason).toMatch(/dynamic/i);
    expect(result.findings).toEqual([]);
    expect(result.ordinary).toEqual([]);
  });

  it('a name no contract quotes is ordinary', () => {
    const { scans, sourceOf } = population("expect(record).not.toHaveProperty('zetaField');");
    const result = classify(scans, [unconditional], sourceOf);

    expect(result.ordinary).toHaveLength(1);
    expect(result.candidates).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  it('a candidate whose declaration cannot be located is unclassifiable, not a finding', () => {
    const { scans, sourceOf } = population("expect(record).not.toHaveProperty('epsilonField');");
    const result = classify(scans, [proseOnly], sourceOf);

    expect(result.candidates).toHaveLength(1);
    expect(result.unclassifiable).toHaveLength(1);
    expect(result.unclassifiable[0]?.reason).toMatch(/not located|declaration/i);
    expect(result.findings).toEqual([]);
  });

  it('a candidate every contract declares conditionally is ordinary — the contract permits the absence', () => {
    const { scans, sourceOf } = population("expect(record).not.toHaveProperty('betaField');");
    const result = classify(scans, [conditionalOptional], sourceOf);

    expect(result.candidates).toHaveLength(1);
    expect(result.ordinary).toHaveLength(1);
    expect(result.findings).toEqual([]);
    expect(result.unclassifiable).toEqual([]);
  });

  it('a candidate with one unconditional declaration is a finding', () => {
    const { scans, sourceOf } = population("expect(record).not.toHaveProperty('alphaField');");
    const result = classify(scans, [unconditional], sourceOf);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.decidedBy.document).toBe('docs/reference/audit-events.md');
    expect(result.findings[0]?.decidedBy.line).toBe(3);
  });
});

describe('classify — the three conditionality shapes', () => {
  it('an optional marker in a markdown Type cell excuses the absence', () => {
    const { scans, sourceOf } = population("expect(record).not.toHaveProperty('betaField');");

    expect(classify(scans, [conditionalOptional], sourceOf).findings).toEqual([]);
  });

  it('a nullable union member excuses the absence', () => {
    const { scans, sourceOf } = population('expect(record.gammaField).toBeNull();');

    expect(classify(scans, [conditionalNullable], sourceOf).findings).toEqual([]);
  });

  it('a `present iff` annotation excuses the absence', () => {
    const { scans, sourceOf } = population('expect(record.deltaField).toBeUndefined();');

    expect(classify(scans, [conditionalAnnotated], sourceOf).findings).toEqual([]);
  });

  it('a `field?:` marker excuses the absence', () => {
    const optionalMarker = readContract(
      'specs/x/contracts/state-schema.md',
      'envelope-specs',
      ['The `etaField` is declared below.', '', '```ts', 'interface S {', '  etaField?: string;', '}', '```'].join('\n')
    );
    const { scans, sourceOf } = population('expect(record.etaField).toBe(undefined);');

    expect(classify(scans, [optionalMarker], sourceOf).findings).toEqual([]);
  });
});

describe('classify — the note decides pass or fail, not the disposition', () => {
  it('a finding with no adjacent dated note carries a null note', () => {
    const { scans, sourceOf } = population("expect(record).not.toHaveProperty('alphaField');");
    const finding = classify(scans, [unconditional], sourceOf).findings.at(0);
    const note = finding?.note ?? null;

    expect(note).toBeNull();
  });

  it('a finding with an adjacent dated note carries it, and is still a finding', () => {
    const { scans, sourceOf } = population(
      "expect(record).not.toHaveProperty('alphaField'); // 2026-09-06 coincidental: queue item, not an audit payload"
    );
    const result = classify(scans, [unconditional], sourceOf);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.note?.date).toBe('2026-09-06');
    expect(result.findings[0]?.note?.siting).toBe('same-line');
  });
});

describe('classify — two contracts that disagree', () => {
  const conflicting: readonly ContractDocument[] = [
    readContract(
      'specs/x/contracts/state-schema.md',
      'envelope-specs',
      ['The `thetaField` is declared below.', '', '```ts', 'interface S {', '  thetaField?: string;', '}', '```'].join(
        '\n'
      )
    ),
    readContract(
      'docs/reference/audit-events.md',
      'repo-docs',
      ['| Field | Type | Notes |', '|-------|------|-------|', '| `thetaField` | string | Always present. |'].join('\n')
    ),
  ];

  it('one unconditional declaration is enough to make it a finding', () => {
    const { scans, sourceOf } = population("expect(record).not.toHaveProperty('thetaField');");

    expect(classify(scans, conflicting, sourceOf).findings).toHaveLength(1);
  });

  it('names the document and line that decided it, so the reader need not re-derive it', () => {
    const { scans, sourceOf } = population("expect(record).not.toHaveProperty('thetaField');");
    const finding = classify(scans, conflicting, sourceOf).findings.at(0);

    expect(finding?.decidedBy.document).toBe('docs/reference/audit-events.md');
    expect(finding?.decidedBy.line).toBe(3);
    expect(finding?.decidedBy.text).toContain('Always present');
  });

  it('records both declarations on the candidate, not only the deciding one', () => {
    const { scans, sourceOf } = population("expect(record).not.toHaveProperty('thetaField');");
    const candidate = classify(scans, conflicting, sourceOf).candidates.at(0);

    expect(candidate?.declarations).toHaveLength(2);
  });
});

describe('classify — the reconciliation invariant', () => {
  const mixed = [
    "expect(record).not.toHaveProperty('alphaField');", // finding
    "expect(record).not.toHaveProperty('betaField');", // ordinary — conditional
    "expect(record).not.toHaveProperty('zetaField');", // ordinary — no contract quotes it
    "expect(record).not.toHaveProperty('epsilonField');", // unclassifiable — not located
    'expect(record).not.toHaveProperty(key);', // unclassifiable — dynamic
  ].join('\n');

  const contracts = [unconditional, conditionalOptional, proseOnly];

  it('every assertion lands in exactly one terminal disposition', () => {
    const { scans, sourceOf } = population(mixed);
    const result = classify(scans, contracts, sourceOf);
    const total = scans[0]?.assertions.length ?? 0;

    expect(total).toBe(5);
    expect(result.ordinary.length + result.findings.length + result.unclassifiable.length).toBe(total);
  });

  it('candidates is at least findings', () => {
    const { scans, sourceOf } = population(mixed);
    const result = classify(scans, contracts, sourceOf);

    expect(result.candidates.length).toBeGreaterThanOrEqual(result.findings.length);
  });

  it('orders findings by file then line, deterministically', () => {
    const source = [
      "expect(a).not.toHaveProperty('alphaField');",
      'const x = 1;',
      "expect(b).not.toHaveProperty('alphaField');",
    ].join('\n');
    const { scans, sourceOf } = population(source);
    const result = classify(scans, [unconditional], sourceOf);

    expect(result.findings.map((f) => f.assertion.line)).toEqual([1, 3]);
  });
});

describe('classify — how much corpus text a message can carry out of the tree', () => {
  // Every string in a failure message is corpus text, and a failure message reaches CI logs: the
  // field name, the asserted line, and the contract line that decided it all come from files on
  // disk. Each goes through one clip helper at 240 characters. Nothing pinned that bound, so an
  // edit could drop it in silence and the next over-long line — a pasted payload, a token-shaped
  // literal — would go out whole with nothing failing.
  //
  // A field name is the one that looks safe and is not. It is a capture from an `expect(...)`
  // argument, not a checked identifier, and a fixture line that opens a paren without closing it
  // hands family A a capture as long as the rest of the line.
  //
  // 405 characters is chosen so the residue is arithmetic a reader can check: 405 - 240 = 165, and
  // that number is asserted rather than derived from the helper's own constant. Moving the bound is
  // then a visible edit to this file instead of a silent widening.
  const LONG_NAME = `omega${'X'.repeat(400)}`;

  it('clips an over-long field name echoed into an unclassifiable reason', () => {
    const quotedNeverDeclared = readContract(
      'docs/reference/audit-events.md',
      'repo-docs',
      ['# Audit events', '', `The \`${LONG_NAME}\` is mentioned but never declared.`].join('\n')
    );
    const { scans, sourceOf } = population(`expect(record).not.toHaveProperty(${JSON.stringify(LONG_NAME)});`);
    const reason = classify(scans, [quotedNeverDeclared], sourceOf).unclassifiable[0]?.reason ?? '';

    expect(reason).toMatch(/not located/i);
    expect(reason).toContain('… (165 more characters)');
    expect(reason).not.toContain(LONG_NAME);
  });

  it('clips all three corpus echoes in a finding report, not just the first', () => {
    const longRow = `| \`${LONG_NAME}\` | string | Always present. |`;
    const declaresIt = readContract(
      'docs/reference/audit-events.md',
      'repo-docs',
      ['| Field | Type | Notes |', '|-------|------|-------|', longRow].join('\n')
    );
    const assertionLine = `expect(record).not.toHaveProperty(${JSON.stringify(LONG_NAME)});`;
    const { scans, sourceOf } = population(assertionLine);
    const findings = classify(scans, [declaresIt], sourceOf).findings;

    expect(findings).toHaveLength(1);
    const message = formatFindings(findings)[0] ?? '';

    // Three echoes, three clips. Counting them is what distinguishes "the bound is applied" from
    // "the bound is applied at the site someone happened to test".
    expect(message.split('… (').length - 1).toBe(3);
    expect(message).toContain('… (165 more characters)');
    expect(message).not.toContain(LONG_NAME);
    expect(message).not.toContain(longRow);
    expect(message).not.toContain(assertionLine);
  });
});
