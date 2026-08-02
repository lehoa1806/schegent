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

  it.each(['sideEffects', 'evidencePolicy', 'promptVersion'])('rejects host field %s', (field) => {
    expect(validatePhaseDefinition(valid({ [field]: 'none' })).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field, code: 'unknown-field' })])
    );
  });

  it('normalizes legacy versions when requested', () => {
    const legacy = valid();
    delete legacy.version;
    expect(validatePhaseDefinition(legacy, { defaultVersion: 1 }).definition?.version).toBe(1);
  });
});
