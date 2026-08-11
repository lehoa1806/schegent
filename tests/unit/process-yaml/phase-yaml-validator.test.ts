// Feature 084 T015/T017 — the closed-format validator (test-first).
//
// Two refusal levels, and the difference matters (FR-027):
//
//   document — the file is not a thing we know how to read at all: no
//              apiVersion, no kind, or a version or kind we do not support.
//              No plan is produced.
//   resource — the file is one of ours but the resource inside it is
//              malformed. A plan row can still say so, naming every defect
//              in one pass rather than the first (FR-026).
//
// FR-001, FR-002, FR-005, FR-006, FR-008, FR-009, FR-026, QS-11, QS-19-22.

import { describe, it, expect } from 'vitest';
import { parseDocumentText } from '../../../src/services/process-yaml/yaml-parser';
import {
  DEFECT_FIELD_MAX,
  validatePhaseDocument
} from '../../../src/services/process-yaml/phase-yaml-validator';
import type {
  ImportDefect,
  PhaseYamlDocument
} from '../../../src/services/process-yaml/types';

function validate(text: string) {
  const parsed = parseDocumentText(text);
  if (!parsed.ok) {
    throw new Error(`fixture did not parse: ${parsed.refusal.code} ${parsed.refusal.message}`);
  }
  return validatePhaseDocument(parsed.node);
}

function accepted(text: string): PhaseYamlDocument {
  const result = validate(text);
  if (!result.ok) {
    const detail =
      result.kind === 'document'
        ? result.refusal.message
        : result.defects.map((d) => `${d.field}:${d.code}`).join(', ');
    throw new Error(`expected acceptance, got ${result.kind} refusal: ${detail}`);
  }
  return result.document;
}

function defects(text: string): readonly ImportDefect[] {
  const result = validate(text);
  if (result.ok) throw new Error('expected the resource to be refused');
  if (result.kind !== 'resource') {
    throw new Error(`expected a resource refusal, got a document refusal: ${result.refusal.code}`);
  }
  return result.defects;
}

function documentRefusal(text: string) {
  const result = validate(text);
  if (result.ok) throw new Error('expected the document to be refused');
  if (result.kind !== 'document') {
    throw new Error(`expected a document refusal, got defects on ${result.resourceId}`);
  }
  return result.refusal;
}

function doc(body: {
  apiVersion?: string | null;
  kind?: string | null;
  metadata?: readonly string[];
  spec?: readonly string[];
}): string {
  const lines: string[] = [];
  if (body.apiVersion !== null) lines.push(`apiVersion: ${body.apiVersion ?? 'schegent/v1'}`);
  if (body.kind !== null) lines.push(`kind: ${body.kind ?? 'Phase'}`);
  lines.push('metadata:');
  for (const line of body.metadata ?? ['phaseId: my-phase', 'name: My Phase', 'version: 1']) {
    lines.push(`  ${line}`);
  }
  lines.push('spec:');
  for (const line of body.spec ?? ['instruction: Do the thing']) {
    lines.push(`  ${line}`);
  }
  return `${lines.join('\n')}\n`;
}

describe('phase-yaml-validator — document level (FR-002, FR-027)', () => {
  it('accepts the minimal well-formed document', () => {
    expect(accepted(doc({}))).toEqual({
      apiVersion: 'schegent/v1',
      kind: 'Phase',
      metadata: { phaseId: 'my-phase', name: 'My Phase', version: 1 },
      spec: { instruction: 'Do the thing' }
    });
  });

  it('refuses a document that declares no apiVersion', () => {
    expect(documentRefusal(doc({ apiVersion: null })).code).toBe('unsupported-version');
  });

  it('refuses a document that declares no kind', () => {
    expect(documentRefusal(doc({ kind: null })).code).toBe('unsupported-kind');
  });

  it('refuses an unsupported apiVersion', () => {
    const refusal = documentRefusal(doc({ apiVersion: 'schegent/v2' }));
    expect(refusal.code).toBe('unsupported-version');
    expect(refusal.message).toContain('schegent/v1');
  });

  it('refuses an unsupported kind', () => {
    expect(documentRefusal(doc({ kind: 'Pipeline' })).code).toBe('unsupported-kind');
  });

  it('checks the version before the kind, so an unknown format is not misreported', () => {
    expect(documentRefusal(doc({ apiVersion: 'other/v9', kind: 'Pipeline' })).code).toBe(
      'unsupported-version'
    );
  });

  it('bounds the echoed value rather than reflecting the document back', () => {
    const refusal = documentRefusal(doc({ apiVersion: 'x'.repeat(5000) }));
    expect(refusal.message.length).toBeLessThanOrEqual(512);
  });
});

describe('phase-yaml-validator — closed key set (FR-001)', () => {
  it('refuses an unknown top-level key', () => {
    const found = defects(`${doc({})}extra: value\n`);
    expect(found).toContainEqual(expect.objectContaining({ field: 'extra', code: 'unknown-field' }));
  });

  it('refuses an unknown metadata key', () => {
    const found = defects(
      doc({ metadata: ['phaseId: my-phase', 'name: N', 'version: 1', 'author: someone'] })
    );
    expect(found).toContainEqual(
      expect.objectContaining({ field: 'author', code: 'unknown-field' })
    );
  });

  it('refuses an unknown spec key', () => {
    const found = defects(doc({ spec: ['instruction: i', 'shell: rm -rf /'] }));
    expect(found).toContainEqual(expect.objectContaining({ field: 'shell', code: 'unknown-field' }));
  });

  // T017 — FR-009. Each of these is a host-resolved field on the runtime
  // definition and none is portable. The closed-format rule is what refuses
  // them; there is no per-field denial list to keep in sync.
  it.each(['sideEffects', 'evidencePolicy', 'promptVersion', 'sourceScope'])(
    'refuses the non-portable field %s',
    (field) => {
      const found = defects(doc({ spec: ['instruction: i', `${field}: something`] }));
      expect(found).toContainEqual(
        expect.objectContaining({ field, code: 'unknown-field' })
      );
    }
  );

  it('refuses metadata or spec that is not a mapping', () => {
    const found = defects('apiVersion: schegent/v1\nkind: Phase\nmetadata: nope\nspec:\n  instruction: i\n');
    expect(found).toContainEqual(
      expect.objectContaining({ field: 'metadata', code: 'mapping-required' })
    );
  });

  it('refuses a document with no spec', () => {
    const found = defects('apiVersion: schegent/v1\nkind: Phase\nmetadata:\n  phaseId: p\n  name: N\n  version: 1\n');
    expect(found).toContainEqual(expect.objectContaining({ field: 'spec', code: 'required' }));
  });
});

describe('phase-yaml-validator — identity metadata (FR-005)', () => {
  it('requires phaseId to match the catalog id pattern', () => {
    const found = defects(doc({ metadata: ['phaseId: Not Valid', 'name: N', 'version: 1'] }));
    expect(found).toContainEqual(
      expect.objectContaining({ field: 'phaseId', code: 'invalid-pattern' })
    );
  });

  it('requires a name', () => {
    const found = defects(doc({ metadata: ['phaseId: p', 'version: 1'] }));
    expect(found).toContainEqual(expect.objectContaining({ field: 'name', code: 'required' }));
  });

  it('requires version to be a positive integer', () => {
    for (const raw of ['0', '-1', '1.5', 'abc']) {
      const found = defects(doc({ metadata: ['phaseId: p', 'name: N', `version: ${raw}`] }));
      expect(found).toContainEqual(
        expect.objectContaining({ field: 'version', code: 'positive-integer-required' })
      );
    }
  });

  it('refuses a quoted version, because the author marked it as text', () => {
    const found = defects(doc({ metadata: ['phaseId: p', 'name: N', 'version: "1"'] }));
    expect(found).toContainEqual(
      expect.objectContaining({ field: 'version', code: 'positive-integer-required' })
    );
  });

  it('accepts an optional description', () => {
    const document = accepted(
      doc({ metadata: ['phaseId: p', 'name: N', 'version: 1', 'description: What it does'] })
    );
    expect(document.metadata.description).toBe('What it does');
  });
});

describe('phase-yaml-validator — directive (FR-006, FR-007)', () => {
  it('refuses a resource carrying both instruction and skill', () => {
    const found = defects(doc({ spec: ['instruction: i', 'skill: speckit-plan'] }));
    expect(found).toContainEqual(
      expect.objectContaining({ field: 'directive', code: 'exactly-one-required' })
    );
  });

  it('refuses a resource carrying neither', () => {
    const found = defects(doc({ spec: ['model: opus'] }));
    expect(found).toContainEqual(
      expect.objectContaining({ field: 'directive', code: 'exactly-one-required' })
    );
  });

  it('carries skill through as a plain string without resolving it', () => {
    const document = accepted(doc({ spec: ['skill: does-not-exist-anywhere'] }));
    expect(document.spec.skill).toBe('does-not-exist-anywhere');
  });
});

describe('phase-yaml-validator — portable behavior fields (FR-008)', () => {
  it('accepts every portable field at once', () => {
    const document = accepted(
      doc({
        spec: [
          'instruction: |-',
          '  line one',
          '  line two',
          'runner: claude',
          'model: opus',
          'effort: high',
          'timeoutSeconds: 120',
          'loopable: true',
          'isRequired: false',
          'retryCondition: attempts < 3'
        ]
      })
    );
    expect(document.spec).toEqual({
      instruction: 'line one\nline two',
      runner: 'claude',
      model: 'opus',
      effort: 'high',
      timeoutSeconds: 120,
      loopable: true,
      isRequired: false,
      retryCondition: 'attempts < 3'
    });
  });

  it('constrains runner to the values the catalog accepts', () => {
    const found = defects(doc({ spec: ['instruction: i', 'runner: rogue'] }));
    expect(found).toContainEqual(
      expect.objectContaining({ field: 'runner', code: 'invalid-enum' })
    );
  });

  it('constrains effort to the values the catalog accepts', () => {
    const found = defects(doc({ spec: ['instruction: i', 'effort: extreme'] }));
    expect(found).toContainEqual(
      expect.objectContaining({ field: 'effort', code: 'invalid-enum' })
    );
  });

  it('keeps the runner and effort compatibility rule the catalog enforces', () => {
    const found = defects(doc({ spec: ['instruction: i', 'runner: agy', 'effort: max'] }));
    expect(found).toContainEqual(
      expect.objectContaining({ field: 'effort', code: 'runner-incompatible' })
    );
  });

  it('constrains timeoutSeconds to the catalog range', () => {
    for (const raw of ['0', '3601', 'soon', '"120"']) {
      const found = defects(doc({ spec: ['instruction: i', `timeoutSeconds: ${raw}`] }));
      expect(found).toContainEqual(
        expect.objectContaining({ field: 'timeoutSeconds', code: 'invalid-range' })
      );
    }
  });

  it('requires booleans to be unquoted true or false', () => {
    for (const raw of ['yes', '1', '"true"']) {
      const found = defects(doc({ spec: ['instruction: i', `loopable: ${raw}`] }));
      expect(found).toContainEqual(
        expect.objectContaining({ field: 'loopable', code: 'boolean-required' })
      );
    }
  });

  it('carries retryCondition as text without judging the expression', () => {
    const document = accepted(
      doc({ spec: ['instruction: i', 'retryCondition: "this is not a valid expression"'] })
    );
    expect(document.spec.retryCondition).toBe('this is not a valid expression');
  });

  it('refuses an empty retryCondition', () => {
    const found = defects(doc({ spec: ['instruction: i', 'retryCondition: ""'] }));
    expect(found).toContainEqual(
      expect.objectContaining({ field: 'retryCondition', code: 'non-empty-required' })
    );
  });
});

describe('phase-yaml-validator — reports every defect in one pass (FR-026)', () => {
  it('names all four problems rather than stopping at the first', () => {
    const found = defects(
      doc({
        metadata: ['phaseId: Not Valid', 'version: 0', 'author: x'],
        spec: ['effort: extreme']
      })
    );
    const codes = found.map((d) => `${d.field}/${d.code}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        'phaseId/invalid-pattern',
        'name/required',
        'version/positive-integer-required',
        'author/unknown-field',
        'effort/invalid-enum',
        'directive/exactly-one-required'
      ])
    );
  });

  it('bounds every defect field so a document cannot inject a wall of text', () => {
    const found = defects(doc({ metadata: ['phaseId: p', 'name: N', 'version: 1', `${'k'.repeat(200)}: v`] }));
    for (const defect of found) {
      // Asserted against the constant, not a literal: this bound and the catalog
      // validator's own came to disagree precisely because each was written as a
      // number in its own file.
      expect(defect.field.length).toBeLessThanOrEqual(DEFECT_FIELD_MAX);
      expect(defect.code.length).toBeLessThanOrEqual(64);
      expect(defect.message.length).toBeLessThanOrEqual(512);
    }
  });

  it('reports the resource id when it is readable, and null when it is not', () => {
    const withId = validate(doc({ spec: ['instruction: i', 'skill: s'] }));
    expect(withId.ok).toBe(false);
    if (!withId.ok && withId.kind === 'resource') expect(withId.resourceId).toBe('my-phase');

    const withoutId = validate(doc({ metadata: ['name: N', 'version: 1'] }));
    expect(withoutId.ok).toBe(false);
    if (!withoutId.ok && withoutId.kind === 'resource') expect(withoutId.resourceId).toBeNull();
  });
});
