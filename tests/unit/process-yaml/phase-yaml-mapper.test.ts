// Feature 084 T018/T020 — the mapper bijection (test-first).
//
// Two things are pinned here:
//
//   1. The mapping is lossless in both directions over the portable field set,
//      including `retryCondition`, which travels as inert text — an expression
//      the DSL would reject survives a round trip byte-for-byte (FR-012).
//   2. The DSL parser is never called. The whole export/import path is
//      exercised with `src/lib/retry-condition` spied, and a control case
//      proves the spy would have fired had anything reached it.
//
// T020 closes the format: the key set the mapper emits must equal the portable
// set, and the portable set must equal the catalog's authored fields minus the
// storage key. A field added to a Phase therefore fails this test until someone
// decides, in writing, whether it is portable (SC-008, QS-4).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AUTHORED_PHASE_FIELDS,
  validatePhaseDefinition
} from '../../../src/config/process-definition-validator';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import {
  PORTABLE_PHASE_FIELDS,
  documentFromPhaseDefinition,
  phaseDefinitionFromDocument
} from '../../../src/services/process-yaml/phase-yaml-mapper';
import { serializePhaseDocument } from '../../../src/services/process-yaml/yaml-serializer';
import { parseDocumentText } from '../../../src/services/process-yaml/yaml-parser';
import { validatePhaseDocument } from '../../../src/services/process-yaml/phase-yaml-validator';

const { validateSpy } = vi.hoisted(() => ({ validateSpy: vi.fn() }));

vi.mock('../../../src/lib/retry-condition', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/retry-condition')>();
  return {
    ...actual,
    validate: (expression: string) => {
      validateSpy(expression);
      return actual.validate(expression);
    }
  };
});

const FULL_INSTRUCTION: PhaseDefinition = {
  phaseId: 'my-phase',
  name: 'My Phase',
  version: 3,
  description: 'A phase that does the thing',
  instruction: 'line one\nline two',
  model: 'opus',
  effort: 'high',
  timeoutSeconds: 120,
  loopable: true,
  retryCondition: 'attempts < 3',
  forceContinueOnRetryCap: true,
  isRequired: false,
  runner: 'claude',
  // Feature 098 T012/T014 — both values are deliberately NOT the FR-005 defaults
  // (`workspace` / `required`), so a field dropped anywhere on the path shows up
  // as a changed value rather than as a coincidentally-correct one. `git` pairs
  // legally with the `claude` runner above.
  sideEffects: 'git',
  evidencePolicy: 'none'
};

const FULL_SKILL: PhaseDefinition = {
  phaseId: 'plan-it',
  name: 'Plan It',
  version: 1,
  skill: 'speckit-plan',
  runner: 'codex',
  effort: 'low',
  timeoutSeconds: 60,
  loopable: false,
  isRequired: true
};

const MINIMAL: PhaseDefinition = {
  phaseId: 'bare',
  name: 'Bare',
  version: 1,
  instruction: 'Do the thing'
};

/** Export, write, read, validate, import — the whole path both ways. */
function roundTrip(definition: PhaseDefinition): PhaseDefinition {
  const text = serializePhaseDocument(documentFromPhaseDefinition(definition));
  const parsed = parseDocumentText(text);
  if (!parsed.ok) throw new Error(`did not parse: ${parsed.refusal.message}`);
  const validated = validatePhaseDocument(parsed.node);
  if (!validated.ok) {
    throw new Error(
      validated.kind === 'document'
        ? `document refused: ${validated.refusal.message}`
        : `resource refused: ${validated.defects.map((d) => `${d.field}/${d.code}`).join(', ')}`
    );
  }
  return phaseDefinitionFromDocument(validated.document);
}

beforeEach(() => {
  validateSpy.mockClear();
});

describe('phase-yaml-mapper — bijection over the portable field set', () => {
  it.each([
    ['every portable field', FULL_INSTRUCTION],
    ['a skill Phase', FULL_SKILL],
    ['the minimum', MINIMAL]
  ])('round-trips %s unchanged', (_label, definition) => {
    expect(roundTrip(definition)).toEqual(definition);
  });

  it('does not invent an optional the definition did not carry', () => {
    const document = documentFromPhaseDefinition(MINIMAL);
    expect(Object.keys(document.metadata)).toEqual(['phaseId', 'name', 'version']);
    expect(Object.keys(document.spec)).toEqual(['instruction']);
  });

  it('keeps false and zero, which are values rather than absences', () => {
    const definition: PhaseDefinition = { ...MINIMAL, loopable: false, isRequired: false };
    const document = documentFromPhaseDefinition(definition);
    expect(document.spec.loopable).toBe(false);
    expect(document.spec.isRequired).toBe(false);
    expect(roundTrip(definition)).toEqual(definition);
  });

  it('is a fixpoint on the document side as well', () => {
    const once = documentFromPhaseDefinition(FULL_INSTRUCTION);
    expect(documentFromPhaseDefinition(phaseDefinitionFromDocument(once))).toEqual(once);
  });
});

describe('phase-yaml-mapper — retryCondition is inert text (FR-012)', () => {
  it('carries an expression the DSL would reject, unchanged', () => {
    const nonsense = 'attempts <<>> banana AND';
    const definition: PhaseDefinition = { ...MINIMAL, retryCondition: nonsense };
    expect(roundTrip(definition).retryCondition).toBe(nonsense);
  });

  it('never calls the DSL parser in either direction', () => {
    roundTrip(FULL_INSTRUCTION);
    roundTrip({ ...MINIMAL, retryCondition: 'attempts <<>> banana AND' });
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it('control: the spy does fire when the catalog validator runs', () => {
    validatePhaseDefinition({ ...FULL_INSTRUCTION });
    expect(validateSpy).toHaveBeenCalledWith('attempts < 3');
  });
});

describe('phase-yaml-mapper — the format stays closed (T020, SC-008)', () => {
  it('emits exactly the portable field set and nothing else', () => {
    const emitted = new Set<string>();
    for (const definition of [FULL_INSTRUCTION, FULL_SKILL]) {
      const document = documentFromPhaseDefinition(definition);
      for (const key of Object.keys(document.metadata)) emitted.add(key);
      for (const key of Object.keys(document.spec)) emitted.add(key);
    }
    expect([...emitted].sort()).toEqual([...PORTABLE_PHASE_FIELDS].sort());
  });

  it('is the catalog authored set minus the storage key', () => {
    const authored = new Set(AUTHORED_PHASE_FIELDS);
    // `id` is the legacy storage key, not a portable one; every other authored
    // field is portable. A new authored field fails here on purpose.
    authored.delete('id');
    expect([...authored].sort()).toEqual([...PORTABLE_PHASE_FIELDS].sort());
  });

  // Feature 098 T012/T014 — `sideEffects` and `evidencePolicy` left this list.
  // They are the author's declaration, not the host's resolution, so they are
  // portable now (FR-003); `promptVersion` and `sourceScope` are still resolved
  // by the host and still have nowhere to go in a document.
  it('excludes the host-resolved fields a Phase carries at runtime', () => {
    for (const field of ['promptVersion', 'sourceScope']) {
      expect(PORTABLE_PHASE_FIELDS.has(field)).toBe(false);
    }
  });

  it('carries the two declared fields as portable', () => {
    for (const field of ['sideEffects', 'evidencePolicy']) {
      expect(PORTABLE_PHASE_FIELDS.has(field)).toBe(true);
    }
  });
});
