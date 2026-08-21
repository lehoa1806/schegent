import { describe, expect, it } from 'vitest';
import { PHASE_RETRY_CONDITION_MAX_LEN } from '../../../src/contracts/process-definitions';
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

  // --- Feature 111 (T691) — the retryCondition length bound ---

  /** A `retryCondition` of exactly `n` characters that parses. */
  const conditionOfLength = (n: number): string => {
    const source = `a > 0 or ${'b'.repeat(n - 13)} > 0`;
    expect(source.length, 'fixture builder is wrong').toBe(n);
    return source;
  };

  it('accepts a retryCondition of exactly the bound', () => {
    const result = validatePhaseDefinition(
      valid({ retryCondition: conditionOfLength(PHASE_RETRY_CONDITION_MAX_LEN) })
    );
    expect(result.errors.filter((e) => e.field === 'retryCondition')).toEqual([]);
  });

  it('refuses one character past the bound as a length, not as a bad expression', () => {
    const over = PHASE_RETRY_CONDITION_MAX_LEN + 1;
    const result = validatePhaseDefinition(valid({ retryCondition: conditionOfLength(over) }));
    const errors = result.errors.filter((e) => e.field === 'retryCondition');
    expect(errors).toHaveLength(1);
    // The code is the load-bearing half: `invalid-expression` would send an
    // operator looking for a syntax error in a condition that has none.
    expect(errors[0].code).toBe('invalid-length');
    // Both numbers, per FR-012: the limit alone leaves an operator with a
    // 4 KiB condition guessing whether they are 1 character over or 3,500.
    // Asserted as the whole sentence because the three routes are required to
    // emit the same one, and a `toContain` on either number alone would pass
    // while they drifted apart.
    expect(errors[0].message).toBe(`retryCondition is ${over} characters; the maximum is 512`);
  });

  it('still reports invalid-expression for a short but unparseable condition', () => {
    // The length branch must not swallow the parse branch — a vacuity guard on the
    // assertion above.
    const errors = validatePhaseDefinition(
      valid({ retryCondition: 'process.exit()' })
    ).errors.filter((e) => e.field === 'retryCondition');
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('invalid-expression');
  });
});
