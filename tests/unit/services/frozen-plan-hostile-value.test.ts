import { describe, expect, it } from 'vitest';
import { isSafeArgvValue, ARGV_VALUE_MAX_LEN } from '../../../src/contracts/argv-value';

/**
 * FR-R3-105 (FR-063) — the defensive half, exercised against the values a plan frozen
 * before the bound existed could carry.
 *
 * WHY A SECOND CHECK AT ALL. The validator refuses a hostile `model` at ingress. A
 * `FrozenRunPlan` persisted before that rule existed carries whatever its document said,
 * and re-resolving a frozen plan at drain time is forbidden — the freeze is the entire
 * point of the freeze, and AGENTS.md states it as a hard rule. So the value arrives at
 * `phase-runner.ts`'s request construction, and that is where it is caught.
 *
 * DROPPED, NOT REWRITTEN. An unsafe `model` is omitted from the request rather than
 * sanitised, so the backend uses its own default. Rewriting would launder untrusted input
 * into something that looks legitimate; omitting is the honest reading of "we could not
 * honour what was asked".
 *
 * Both callers read `isSafeArgvValue`, so this tests the shared authority rather than one
 * of two copies — which is the point of extracting it.
 */
describe('FR-R3-105 — a hostile value from a frozen plan is refused at dispatch', () => {
  it.each([
    '--dangerously-skip-permissions',
    '-m',
    '--settings=/tmp/evil.json',
    '-',
    '--',
    'claude opus',
    'claude;id',
    'claude$(id)',
    'claude|tee /tmp/x',
    'claude\nopus',
    'claude\topus',
    '../../etc/passwd -x'
  ])('refuses %j', (value) => {
    expect(isSafeArgvValue(value)).toBe(false);
  });

  it('refuses a non-string, which a hand-edited persisted plan could carry', () => {
    // The persisted record is JSON an operator can edit; a number or object reaching argv
    // construction would stringify into something nobody chose.
    for (const value of [undefined, null, 42, {}, [], true]) {
      expect(isSafeArgvValue(value)).toBe(false);
    }
  });

  it('refuses an over-long value and accepts one exactly at the bound', () => {
    expect(isSafeArgvValue('a'.repeat(ARGV_VALUE_MAX_LEN + 1))).toBe(false);
    expect(isSafeArgvValue('a'.repeat(ARGV_VALUE_MAX_LEN))).toBe(true);
  });

  it('accepts the vendor-shaped identifiers a legitimate frozen plan carries', () => {
    // The bound must not refuse plans that were always fine: a defensive check that
    // breaks existing runs would be reverted, and then there would be no defensive check.
    for (const value of [
      'claude-opus-4-20250514',
      'claude-sonnet-4-5',
      'gpt-5-codex',
      'o3-mini',
      'anthropic/claude-3.7',
      'model_v2:latest',
      'gpt-4.1'
    ]) {
      expect(isSafeArgvValue(value), `${value} must remain acceptable`).toBe(true);
    }
  });

  it('the phase runner drops rather than rewrites, and reads the shared authority', async () => {
    // Asserted against the source, because the alternative — constructing a full phase
    // runner with a frozen plan — would test the harness more than the rule. What matters
    // is that the request-building site consults `isSafeArgvValue` and that no
    // sanitising helper appears beside it.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(
      resolve(__dirname, '../../../src/controller/phase-runner.ts'),
      'utf8'
    );
    expect(source).toContain("import { isSafeArgvValue } from '../contracts/argv-value'");
    // The authored model is read ONCE into `authoredModel` and checked once — a shape this test
    // asked for indirectly and a lint ratchet then required outright, since the double read was
    // also a double optional-chain the compiler called unnecessary.
    expect(source).toContain('const authoredModel = inputs.phaseDef?.model;');
    expect(source).toContain('isSafeArgvValue(authoredModel)');
    // No rewriting on this path: a `replace` or `sanitize` applied to the model value
    // would be the laundering this item forbids.
    const line = source
      .split('\n')
      .find((l) => l.includes('isSafeArgvValue(authoredModel)')) as string;
    expect(line).not.toMatch(/replace\(|sanitize|slice\(|normalize/);
  });
});
