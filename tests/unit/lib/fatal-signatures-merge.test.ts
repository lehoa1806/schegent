/**
 * Feature 011 T060/T061 — invariants for the operator-additive
 * fatal-signature registry. Covers FR-033 (merge), FR-034 (dedup),
 * FR-036 (graceful fallback on malformed config), FR-037 (source
 * attribution on classification), FR-038 (built-ins never demoted).
 */

import { describe, expect, it } from 'vitest';
import {
  FATAL_SIGNATURES,
  classifyFatal,
  getEffectiveSignatures,
  type EffectiveSignature
} from '../../../src/lib/fatal-signature-registry';
import {
  readFatalSignaturesSetting,
  type GeneralSettingsConfig
} from '../../../src/config/general-settings';

function makeConfig(value: unknown): GeneralSettingsConfig {
  return {
    get<T>(_key: string, _fallback: T): T {
      return value as T;
    },
    inspect() {
      return undefined;
    },
    update() {
      return Promise.resolve();
    }
  };
}

describe('Feature 011 T060 — getEffectiveSignatures invariants', () => {
  it('empty operator additions returns built-ins only (FR-033 baseline)', () => {
    const effective = getEffectiveSignatures([]);
    expect(effective.length).toBe(FATAL_SIGNATURES.length);
    for (let i = 0; i < FATAL_SIGNATURES.length; i++) {
      expect(effective[i].pattern).toBe(FATAL_SIGNATURES[i]);
      expect(effective[i].source).toBe('built-in');
    }
  });

  it('returned array is frozen (immutability invariant)', () => {
    const effective = getEffectiveSignatures(['operator-pattern-1']);
    expect(Object.isFrozen(effective)).toBe(true);
  });

  it('duplicate operator entry matching a built-in stays attributed as built-in (FR-038)', () => {
    const builtIn = FATAL_SIGNATURES[0];
    const effective = getEffectiveSignatures([builtIn]);
    const matching = effective.filter((e) => e.pattern === builtIn);
    expect(matching.length).toBe(1);
    expect(matching[0].source).toBe('built-in');
  });

  it('operator additions are deduped against each other', () => {
    const effective = getEffectiveSignatures(['p', 'q', 'p', 'q', 'r']);
    const patterns = effective.map((e) => e.pattern);
    const operatorOnly = effective.filter((e) => e.source === 'operator-defined').map((e) => e.pattern);
    expect(operatorOnly).toEqual(['p', 'q', 'r']);
    // Built-ins keep their order, then operator-defined entries appear once each
    expect(patterns.length).toBe(FATAL_SIGNATURES.length + 3);
  });

  it('built-ins appear first, then operator additions (deterministic order)', () => {
    const effective = getEffectiveSignatures(['op-A', 'op-B']);
    const builtInCount = effective.filter((e) => e.source === 'built-in').length;
    expect(builtInCount).toBe(FATAL_SIGNATURES.length);
    for (let i = 0; i < FATAL_SIGNATURES.length; i++) {
      expect(effective[i].source).toBe('built-in');
    }
    expect(effective[FATAL_SIGNATURES.length].source).toBe('operator-defined');
    expect(effective[FATAL_SIGNATURES.length + 1].source).toBe('operator-defined');
  });

  it('classifyFatal returns source=operator-defined for an operator-only match (FR-037)', () => {
    const effective = getEffectiveSignatures(['custom-killswitch']);
    const r = classifyFatal('output contains custom-killswitch token', '', effective);
    expect(r.matched).toBe(true);
    if (r.matched) {
      expect(r.signature).toBe('custom-killswitch');
      expect(r.source).toBe('operator-defined');
    }
  });

  it('classifyFatal returns source=built-in when both built-in and operator would match (built-ins win)', () => {
    const builtIn = FATAL_SIGNATURES[0];
    const effective = getEffectiveSignatures([builtIn, 'op-pattern']);
    const text = `${builtIn} and op-pattern both appear`;
    const r = classifyFatal(text, '', effective);
    expect(r.matched).toBe(true);
    if (r.matched) {
      expect(r.signature).toBe(builtIn);
      expect(r.source).toBe('built-in');
    }
  });

  it('classifyFatal returns no match when nothing in effective list matches', () => {
    const effective = getEffectiveSignatures(['z']);
    const r = classifyFatal('clean stdout output', '', effective);
    expect(r.matched).toBe(false);
  });
});

describe('Feature 011 T061 — readFatalSignaturesSetting failure-mode fallback (FR-036)', () => {
  it('undefined / setting not set yields []', () => {
    expect(readFatalSignaturesSetting(makeConfig(undefined))).toEqual([]);
  });

  it('empty array yields []', () => {
    expect(readFatalSignaturesSetting(makeConfig([]))).toEqual([]);
  });

  it('non-array (string) falls back to [] without throwing', () => {
    expect(readFatalSignaturesSetting(makeConfig('not-an-array' as unknown))).toEqual([]);
  });

  it('non-array (object) falls back to [] without throwing', () => {
    expect(readFatalSignaturesSetting(makeConfig({ foo: 'bar' } as unknown))).toEqual([]);
  });

  it('non-array (number) falls back to [] without throwing', () => {
    expect(readFatalSignaturesSetting(makeConfig(42 as unknown))).toEqual([]);
  });

  it('array with non-string elements filters them out (returns []) — never throws', () => {
    const value = ['ok', 42, null] as unknown[];
    // Implementation returns [] on the first non-string per defensive contract.
    const result = readFatalSignaturesSetting(makeConfig(value));
    expect(Array.isArray(result)).toBe(true);
    for (const el of result) {
      expect(typeof el).toBe('string');
      expect(el.length).toBeGreaterThan(0);
    }
  });

  it('array with empty / whitespace strings falls back to [] — never throws', () => {
    const value = ['', '   '];
    const result = readFatalSignaturesSetting(makeConfig(value));
    expect(result).toEqual([]);
  });

  it('valid array yields a non-empty frozen array', () => {
    const result = readFatalSignaturesSetting(makeConfig(['alpha', 'beta']));
    expect(result).toEqual(['alpha', 'beta']);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('integrates with getEffectiveSignatures: a malformed setting + getEffectiveSignatures([]) preserves the built-in floor', () => {
    const operatorAdditions = readFatalSignaturesSetting(makeConfig({ malformed: true } as unknown));
    const effective = getEffectiveSignatures(operatorAdditions);
    expect(effective.length).toBe(FATAL_SIGNATURES.length);
    for (const e of effective) {
      expect(e.source).toBe('built-in');
    }
  });
});

describe('Feature 011 — EffectiveSignature type sanity', () => {
  it('exports the EffectiveSignature shape', () => {
    const e: EffectiveSignature = { pattern: 'x', source: 'built-in' };
    expect(e.pattern).toBe('x');
    expect(e.source).toBe('built-in');
  });
});
