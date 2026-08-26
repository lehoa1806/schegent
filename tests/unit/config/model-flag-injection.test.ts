import { describe, expect, it } from 'vitest';
import {
  ARGV_ENUM_CLOSED_FIELDS,
  ARGV_FREE_FORM_FIELDS,
  ARGV_VALUE_MAX_LEN,
  validatePhaseDefinition
} from '../../../src/config/process-definition-validator';
import { PHASE_EFFORT_LEVELS } from '../../../src/contracts/process-definitions';

/**
 * FR-R3-105 (FR-060, FR-062) — an authored field that reaches the child's command line
 * is bounded, and a flag-shaped value is REFUSED rather than rewritten.
 *
 * THE DEFECT. A pipeline document is operator-imported, untrusted content. `model` was
 * validated as a non-empty string and pushed as its own argv token at all three backends
 * (`claude-cli.ts:336`, `codex-cli.ts:85`, `agy-cli.ts:124`). Spawns are `shell: false`
 * throughout, so this was never shell injection — it was **flag injection**: a document
 * supplying `model: "--dangerously-skip-permissions"` put that literal flag into argv,
 * where the CLI's parser reads it as a flag. The authority that grants is exactly the
 * authority the capability plan exists to narrow, through a field the narrowing never
 * sees.
 *
 * REFUSE, NEVER REWRITE. Stripping the dash or sanitising the value would launder
 * untrusted input into something that looks legitimate — the `catalogVersion` rule's
 * reasoning. The tests below assert the refusal AND that no accepted value was altered.
 */
const phase = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  phaseId: 'build',
  name: 'Build',
  version: 1,
  instruction: 'do the thing',
  ...over
});

const errorsFor = (over: Record<string, unknown>) => {
  const result = validatePhaseDefinition(phase(over));
  return result.errors ?? [];
};

describe('FR-R3-105 — a flag-shaped model is refused at the validator', () => {
  it('refuses the exact value the source item names, and names the field', () => {
    const errors = errorsFor({ model: '--dangerously-skip-permissions' });
    expect(errors.length, 'a leading-dash model must be refused').toBeGreaterThan(0);
    expect(errors.some((e) => e.field === 'model')).toBe(true);
  });

  it.each([
    ['--dangerously-skip-permissions', 'the flag that removes the permission gate'],
    ['-m', 'a short flag'],
    ['--settings=/tmp/evil.json', 'a flag with an attached value'],
    ['-', 'a bare dash, which many parsers read as stdin']
  ])('refuses %s (%s)', (model) => {
    expect(errorsFor({ model }).some((e) => e.field === 'model')).toBe(true);
  });

  it('refuses a value carrying argv or shell metacharacters, even without a leading dash', () => {
    // The leading-dash rule is the specific half; the charset is the general half. A value
    // that is merely absurd rather than flag-shaped still reaches the child.
    for (const model of ['claude opus', 'claude;rm -rf /', 'claude$(id)', 'claude\nopus', 'claude|tee']) {
      expect(
        errorsFor({ model }).some((e) => e.field === 'model'),
        `${JSON.stringify(model)} must be refused`
      ).toBe(true);
    }
  });

  it('refuses a value past the length bound', () => {
    expect(errorsFor({ model: 'a'.repeat(ARGV_VALUE_MAX_LEN + 1) }).some((e) => e.field === 'model')).toBe(
      true
    );
  });

  it('accepts the real vendor-shaped identifiers, unaltered', () => {
    // A bound that refuses legitimate values would be worked around, so the accepted set
    // is asserted too — and asserted to pass through BYTE-IDENTICAL, because a bound that
    // quietly normalises is the rewriting this item forbids.
    for (const model of [
      'claude-opus-4-20250514',
      'claude-sonnet-4-5',
      'gpt-5-codex',
      'o3-mini',
      'anthropic/claude-3.7',
      'model_v2:latest'
    ]) {
      const result = validatePhaseDefinition(phase({ model }));
      expect(result.errors ?? [], `${model} must be accepted`).toEqual([]);
      expect(result.definition?.model, `${model} must not be rewritten`).toBe(model);
    }
  });

  it('effort is refused by its ENUM, not by the new charset bound (research R1)', () => {
    // The source item says `effort` "has the same shape" as `model`. Its emission does; its
    // validation does not — it is already closed to a five-value enum. Recording that is
    // more honest than claiming this item fixed a second field.
    expect(errorsFor({ effort: '--dangerously-skip-permissions' }).some((e) => e.field === 'effort')).toBe(
      true
    );
    for (const effort of PHASE_EFFORT_LEVELS) {
      expect(errorsFor({ effort }), `${effort} is a valid level`).toEqual([]);
    }
  });

  it('the two argv classes are disjoint, and `model` is the only free-form one today', () => {
    for (const field of ARGV_FREE_FORM_FIELDS) {
      expect(ARGV_ENUM_CLOSED_FIELDS.has(field), `${field} cannot be in both classes`).toBe(false);
    }
    expect([...ARGV_FREE_FORM_FIELDS]).toEqual(['model']);
    expect([...ARGV_ENUM_CLOSED_FIELDS]).toEqual(['effort']);
  });
});
