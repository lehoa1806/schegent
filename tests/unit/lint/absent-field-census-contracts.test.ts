/**
 * The contract corpus: which documents are payload contracts, what names they quote, and where
 * a named field is actually declared.
 *
 * FR-R3-167 / FR-009, FR-013, FR-027. The basename set is the retired census's, unwidened — a
 * gate that grew its own corpus would answer a different question every release.
 *
 * Fixture field names are invented on purpose; see the note in `absent-field-census-scan.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { isContractBasename, locateDeclaration, readContract } from '../../lint/absent-field-census';

describe('isContractBasename', () => {
  const accepted = [
    'audit-events.md',
    'audit-events-v2.md',
    'sidebar-ipc.md',
    'sidebar-ipc-contract.md',
    'state-schema.md',
    'state-schema-notes.md',
    'audit-payload-delta.md',
    'audit-payload-delta-round-3.md',
  ];

  for (const name of accepted) {
    it(`accepts ${name}`, () => {
      expect(isContractBasename(name)).toBe(true);
    });
  }

  const rejected = [
    'README.md',
    'audit.md',
    'events.md',
    'ipc.md',
    'schema.md',
    'audit-events.ts',
    'my-audit-events.md',
    'threat-model.md',
  ];

  for (const name of rejected) {
    it(`rejects ${name}`, () => {
      expect(isContractBasename(name)).toBe(false);
    });
  }
});

describe('readContract — backtick-quoted names', () => {
  const source = [
    '# Audit events',
    '',
    'The `alphaField` is described in prose here.',
    '',
    '| Field | Type | Notes |',
    '|-------|------|-------|',
    '| `betaField` | string | always present |',
    '',
    '```ts',
    'interface Payload {',
    '  gammaField: number;',
    '}',
    '```',
    '',
    'See [the other page](./other.md) for `deltaField`.',
  ].join('\n');

  it('collects every backtick-quoted identifier in the document', () => {
    const doc = readContract('docs/reference/audit-events.md', 'repo-docs', source);

    expect(doc.quotedNames.has('alphaField')).toBe(true);
    expect(doc.quotedNames.has('betaField')).toBe(true);
    expect(doc.quotedNames.has('deltaField')).toBe(true);
  });

  it('does not collect a name that is only inside a fenced block, unquoted', () => {
    const doc = readContract('docs/reference/audit-events.md', 'repo-docs', source);

    expect(doc.quotedNames.has('gammaField')).toBe(false);
  });

  it('records the root it was found under and keeps the document lines', () => {
    const doc = readContract('specs/x/contracts/state-schema.md', 'envelope-specs', source);

    expect(doc.root).toBe('envelope-specs');
    expect(doc.path).toBe('specs/x/contracts/state-schema.md');
    expect(doc.lines).toHaveLength(source.split('\n').length);
  });
});

describe('locateDeclaration — a markdown table row', () => {
  const tableDoc = readContract(
    'docs/reference/audit-events.md',
    'repo-docs',
    [
      '| Field | Type | Notes |',
      '|-------|------|-------|',
      '| `alphaField` | string | Always present. |',
      '| `betaField` | number, optional on historical input | Added later. |',
      '| `gammaField` | string \\| null | Null when unknown. |',
    ].join('\n')
  );

  it('locates a name whose first cell is the backtick-quoted field', () => {
    const declaration = locateDeclaration(tableDoc, 'alphaField');

    expect(declaration.kind).toBe('found');
    if (declaration.kind !== 'found') return;
    expect(declaration.line).toBe(3);
    expect(declaration.document).toBe('docs/reference/audit-events.md');
    expect(declaration.conditionality).toEqual([]);
  });

  it('reads `optional` in the Type cell as a conditionality marker', () => {
    const declaration = locateDeclaration(tableDoc, 'betaField');

    expect(declaration.kind).toBe('found');
    if (declaration.kind !== 'found') return;
    expect(declaration.conditionality).toContain('optional-marker');
  });

  it('reads a nullable union in the Type cell as a conditionality marker', () => {
    const declaration = locateDeclaration(tableDoc, 'gammaField');

    expect(declaration.kind).toBe('found');
    if (declaration.kind !== 'found') return;
    expect(declaration.conditionality).toContain('nullable-union');
  });
});

describe('locateDeclaration — a name a document declares twice', () => {
  // First-match-wins was wrong in one direction only, and silently. A conditional declaration
  // standing ahead of an unconditional one moved the assertion out of `findings` and into
  // `ordinary`: a bare count, no row in the register, no note demanded, nothing for a reader to
  // notice it had happened. Loud is the direction a gate is allowed to be wrong in.

  it('prefers the unconditional row when a conditional one comes first', () => {
    const doc = readContract(
      'docs/reference/audit-events.md',
      'repo-docs',
      [
        '| Field | Type | Notes |',
        '|-------|------|-------|',
        '| `alphaField` | string, optional | On the historical envelope. |',
        '',
        '| Field | Type | Notes |',
        '|-------|------|-------|',
        '| `alphaField` | string | On the current envelope, always present. |',
      ].join('\n')
    );

    const declaration = locateDeclaration(doc, 'alphaField');

    expect(declaration.kind).toBe('found');
    if (declaration.kind !== 'found') return;
    expect(declaration.line).toBe(7);
    expect(declaration.conditionality).toEqual([]);
  });

  it('prefers an unconditional fenced declaration over a conditional table row', () => {
    // The same precedence across the two locators, not just within one. The table is read first
    // because it is the published reference's form, which is an ordering, not an authority.
    const doc = readContract(
      'specs/x/contracts/state-schema.md',
      'envelope-specs',
      [
        '| Field | Type | Notes |',
        '|-------|------|-------|',
        '| `alphaField` | string | Omitted on the legacy path. |',
        '',
        '```ts',
        'interface Snapshot {',
        '  alphaField: string;',
        '}',
        '```',
      ].join('\n')
    );

    const declaration = locateDeclaration(doc, 'alphaField');

    expect(declaration.kind).toBe('found');
    if (declaration.kind !== 'found') return;
    expect(declaration.line).toBe(7);
    expect(declaration.conditionality).toEqual([]);
  });

  it('keeps document order between two declarations that agree', () => {
    const doc = readContract(
      'docs/reference/audit-events.md',
      'repo-docs',
      [
        '| Field | Type | Notes |',
        '|-------|------|-------|',
        '| `alphaField` | string, optional | First. |',
        '| `alphaField` | string, optional | Second. |',
      ].join('\n')
    );

    const declaration = locateDeclaration(doc, 'alphaField');

    expect(declaration.kind).toBe('found');
    if (declaration.kind !== 'found') return;
    expect(declaration.line).toBe(3);
  });
});

describe('locateDeclaration — a fenced code declaration', () => {
  const fencedDoc = readContract(
    'specs/x/contracts/state-schema.md',
    'envelope-specs',
    [
      'The `alphaField` and `betaField` and `gammaField` are declared below.',
      '',
      '```ts',
      'interface Snapshot {',
      '  alphaField: string;',
      '  betaField?: number;',
      '  // present iff the run reached the execute phase',
      '  gammaField: string;',
      '}',
      '```',
    ].join('\n')
  );

  it('locates a `name:` declaration inside a fence', () => {
    const declaration = locateDeclaration(fencedDoc, 'alphaField');

    expect(declaration.kind).toBe('found');
    if (declaration.kind !== 'found') return;
    expect(declaration.line).toBe(5);
    expect(declaration.conditionality).toEqual([]);
  });

  it('reads `name?:` as an optional marker', () => {
    const declaration = locateDeclaration(fencedDoc, 'betaField');

    expect(declaration.kind).toBe('found');
    if (declaration.kind !== 'found') return;
    expect(declaration.conditionality).toContain('optional-marker');
  });

  it('reads a `present iff` annotation on the preceding line', () => {
    const declaration = locateDeclaration(fencedDoc, 'gammaField');

    expect(declaration.kind).toBe('found');
    if (declaration.kind !== 'found') return;
    expect(declaration.conditionality).toContain('conditional-annotation');
  });
});

describe('locateDeclaration — conditional presence written in English', () => {
  /**
   * Every phrasing here is one a discovered contract uses today for a field some test asserts
   * absent. Reading only the literal `present iff` reported thirteen contradictions the contracts
   * do not assert. The list is narrow on purpose — each entry earns its place by appearing in the
   * corpus — and each is pinned here so widening it is a visible edit rather than a quiet one.
   */
  const phrasings: readonly { readonly label: string; readonly notes: string }[] = [
    { label: 'present iff', notes: 'Present iff the phase reached compaction.' },
    { label: 'present if and only if', notes: 'Integer, >= 1. Present if and only if the rule applied.' },
    { label: 'when present', notes: 'Always `true` when present, never `false`.' },
    { label: 'if present', notes: 'A finite number if present.' },
    { label: 'present when', notes: 'Present when the run was scheduled.' },
    { label: 'present only when', notes: 'Present only when a prior iteration exists.' },
    { label: 'absent when', notes: 'Array of identifiers. Absent when no key was missing.' },
    { label: 'absent means', notes: 'Integer. Absent means the rule did not apply.' },
    { label: 'not persisted', notes: '~~Non-empty string.~~ Not persisted — see the note above.' },
    { label: 'never persisted', notes: 'Never persisted; the message survives in the operator log.' },
    { label: 'omitted', notes: 'Sanitized string, omitted by the generic projection.' },
  ];

  for (const { label, notes } of phrasings) {
    it(`reads "${label}" in a table row as a conditionality marker`, () => {
      const doc = readContract(
        'docs/reference/audit-events.md',
        'repo-docs',
        ['| Field | Constraint |', '|---|---|', `| \`alphaField\` | ${notes} |`].join('\n')
      );
      const declaration = locateDeclaration(doc, 'alphaField');

      expect(declaration.kind).toBe('found');
      if (declaration.kind !== 'found') return;
      expect(declaration.conditionality).toContain('conditional-annotation');
    });
  }

  it('does not read an unconditional constraint row as conditional', () => {
    const doc = readContract(
      'docs/reference/audit-events.md',
      'repo-docs',
      ['| Field | Constraint |', '|---|---|', '| `alphaField` | Matches `^[a-z][a-z0-9-]{0,63}$`. |'].join('\n')
    );
    const declaration = locateDeclaration(doc, 'alphaField');

    expect(declaration.kind).toBe('found');
    if (declaration.kind !== 'found') return;
    expect(declaration.conditionality).toEqual([]);
  });

  it('does not read a non-nullable literal union as conditional', () => {
    const doc = readContract(
      'specs/x/contracts/audit-events.md',
      'envelope-specs',
      ['```ts', 'interface P {', "  alphaField: 'operator' | 'cascade';   // NEW — required", '}', '```'].join('\n')
    );
    const declaration = locateDeclaration(doc, 'alphaField');

    expect(declaration.kind).toBe('found');
    if (declaration.kind !== 'found') return;
    expect(declaration.conditionality).toEqual([]);
  });
});

describe('locateDeclaration — a unified-diff contract', () => {
  // Five of the thirteen documents the census discovers are `*.diff.md`, where every added line
  // carries a `+` in column one. Read literally, none of their declarations ever locates: the field
  // is quoted, so it becomes a candidate, and then falls straight into "declaration not located".
  const diff = [
    '```diff',
    ' interface Payload {',
    '   existingField: string;',
    '+  alphaField: string;',
    '-  removedField: string;',
    ' }',
    '```',
  ].join('\n');

  it('reads an added fenced declaration', () => {
    const doc = readContract('specs/x/contracts/audit-payload-delta.diff.md', 'envelope-specs', diff);
    const declaration = locateDeclaration(doc, 'alphaField');

    expect(declaration.kind).toBe('found');
    if (declaration.kind !== 'found') return;
    expect(declaration.conditionality).toEqual([]);
    expect(declaration.line).toBe(4);
  });

  it('does not read a removed declaration as what the contract says', () => {
    // The `-` side is what the contract no longer declares. Reading it would resurrect a retired
    // field and manufacture a contradiction against a test that correctly asserts it absent.
    const doc = readContract('specs/x/contracts/audit-payload-delta.diff.md', 'envelope-specs', diff);

    expect(locateDeclaration(doc, 'removedField').kind).toBe('not-located');
  });

  it('reads an added table row', () => {
    const doc = readContract(
      'specs/x/contracts/state-schema.diff.md',
      'envelope-specs',
      ['| Field | Type | Notes |', '|---|---|---|', '+| `alphaField` | string | Always present. |'].join('\n')
    );
    const declaration = locateDeclaration(doc, 'alphaField');

    expect(declaration.kind).toBe('found');
    if (declaration.kind !== 'found') return;
    expect(declaration.conditionality).toEqual([]);
  });
});

describe('locateDeclaration — a field name that is also regex syntax', () => {
  it('locates `$schema`, whose leading `$` would otherwise compile to an end-anchor', () => {
    // The field name is corpus data reaching a regex constructor. Unescaped, `$schema` matches
    // nothing and the candidate is silently downgraded from finding to unclassifiable.
    const doc = readContract(
      'docs/reference/state-schema.md',
      'repo-docs',
      ['```ts', 'interface P {', '  $schema: string;', '}', '```'].join('\n')
    );
    const declaration = locateDeclaration(doc, '$schema');

    expect(declaration.kind).toBe('found');
    if (declaration.kind !== 'found') return;
    expect(declaration.conditionality).toEqual([]);
  });

  it('does not let a name with regex metacharacters match a different field', () => {
    const doc = readContract(
      'docs/reference/state-schema.md',
      'repo-docs',
      ['```ts', 'interface P {', '  axc: string;', '}', '```'].join('\n')
    );

    expect(locateDeclaration(doc, 'a.c').kind).toBe('not-located');
  });
});

describe('locateDeclaration — not located', () => {
  const proseDoc = readContract(
    'docs/reference/audit-events.md',
    'repo-docs',
    ['# Audit events', '', 'The `alphaField` is discussed at length but never declared.'].join('\n')
  );

  it('returns not-located with a reason when the name appears only in prose', () => {
    const declaration = locateDeclaration(proseDoc, 'alphaField');

    expect(declaration.kind).toBe('not-located');
    if (declaration.kind !== 'not-located') return;
    expect(declaration.document).toBe('docs/reference/audit-events.md');
    expect(declaration.reason).toMatch(/prose|heading|link|not declared/i);
  });

  it('returns not-located for a name the document never mentions', () => {
    const declaration = locateDeclaration(proseDoc, 'zetaField');

    expect(declaration.kind).toBe('not-located');
  });

  it('does not treat a heading as a declaration', () => {
    const headingDoc = readContract(
      'docs/reference/audit-events.md',
      'repo-docs',
      ['## `alphaField`', '', 'Some prose.'].join('\n')
    );

    expect(locateDeclaration(headingDoc, 'alphaField').kind).toBe('not-located');
  });
});
