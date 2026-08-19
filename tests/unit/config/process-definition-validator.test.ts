import { describe, expect, it } from 'vitest';
import { validatePhaseDefinition } from '../../../src/config/process-definition-validator';

const valid = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'security-audit',
  name: 'Security audit',
  version: 1,
  instruction: 'Review the staged change.',
  ...overrides
});

describe('validatePhaseDefinition', () => {
  it('enforces the Phase id grammar', () => {
    expect(validatePhaseDefinition(valid({ id: 'Not_Valid' })).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'phaseId', code: 'invalid-pattern' })])
    );
  });

  it('rejects whitespace-only names and oversized descriptions', () => {
    const result = validatePhaseDefinition(valid({ name: '   ', description: 'x'.repeat(1025) }));
    expect(result.errors.map((error) => error.field)).toEqual(
      expect.arrayContaining(['name', 'description'])
    );
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid version %s', (version) => {
    expect(validatePhaseDefinition(valid({ version })).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'version' })])
    );
  });

  it('requires exactly one directive form', () => {
    expect(validatePhaseDefinition(valid({ skill: 'security-review' })).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'directive' })])
    );
    const neither = valid();
    delete neither.instruction;
    expect(validatePhaseDefinition(neither).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'directive' })])
    );
  });

  it('accepts a bounded skill and rejects oversized directives', () => {
    const skill = valid({ skill: 'security-review' });
    delete skill.instruction;
    expect(validatePhaseDefinition(skill).ok).toBe(true);
    expect(validatePhaseDefinition(valid({ instruction: 'x'.repeat(8193) })).ok).toBe(false);
    const longSkill = valid({ skill: 'x'.repeat(257) });
    delete longSkill.instruction;
    expect(validatePhaseDefinition(longSkill).ok).toBe(false);
  });

  it('validates execution override bounds and closed registries', () => {
    const result = validatePhaseDefinition(
      valid({ model: ' ', effort: 'extreme', runner: 'shell', timeoutSeconds: 0, loopable: 'yes' })
    );
    expect(result.errors.map((error) => error.field)).toEqual(
      expect.arrayContaining(['model', 'effort', 'runner', 'timeoutSeconds', 'loopable'])
    );
  });

  it('delegates retry expressions to the closed parser even when loopable is false', () => {
    const result = validatePhaseDefinition(
      valid({ loopable: false, retryCondition: 'process.exit()' })
    );
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'retryCondition' })])
    );
  });

  // Feature 098 T015 — `sideEffects` and `evidencePolicy` left this list. They
  // are the author's declaration of what a Phase is allowed to touch and what
  // evidence it owes (FR-003), so an operator writes them and this validator now
  // has to admit them; `promptVersion` is still resolved by the host and still
  // has no author-facing spelling.
  it('rejects host field promptVersion', () => {
    expect(validatePhaseDefinition(valid({ promptVersion: 'none' })).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'promptVersion', code: 'unknown-field' })
      ])
    );
  });

  it.each([
    ['sideEffects', 'workspace'],
    ['evidencePolicy', 'required']
  ])('accepts authored field %s and carries it onto the definition', (field, value) => {
    const result = validatePhaseDefinition(valid({ [field]: value }));
    expect(result.errors).toEqual([]);
    expect(result.definition?.[field as 'sideEffects' | 'evidencePolicy']).toBe(value);
  });

  it.each(['sideEffects', 'evidencePolicy'])('refuses a value outside the %s registry', (field) => {
    // Admitting the key is not admitting arbitrary text: the closed registry is
    // what keeps a containment class from arriving as a word the freeze cannot
    // act on. `'none'` is legal for `evidencePolicy` and not for `sideEffects`,
    // so the out-of-registry probe has to be a value neither one accepts.
    expect(validatePhaseDefinition(valid({ [field]: 'whatever' })).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field, code: 'invalid-enum' })])
    );
  });

  it('normalizes legacy versions when requested', () => {
    const legacy = valid();
    delete legacy.version;
    expect(validatePhaseDefinition(legacy, { defaultVersion: 1 }).definition?.version).toBe(1);
  });
});
