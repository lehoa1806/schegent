// FR-R3-088 §3 — put a NUMBER on the vacuity detector's silent error.
//
// THE ASYMMETRY THIS MEASURES
//
// `scanning-gates-prove-they-scanned.test.ts` classifies a gate as *controlled*
// when its source matches one of the shapes a vacuity control takes. It has
// erred three times, and all three errors ran the same way: a controlled gate
// reported as UNCONTROLLED. That direction is loud — someone investigates a gate
// they believe is broken and finds it is not.
//
// The other direction is silent. An UNCONTROLLED gate reported as CONTROLLED
// produces no signal at all, and the reviewer brief says exactly this: "The
// symmetric error — reporting an uncontrolled gate as controlled — is silent,
// and there is no evidence about how often it happens."
//
// THE METHOD, stated so a second party can reproduce or dispute it
//
//   1. Take every gate the detector currently calls CONTROLLED — the full
//      census, not a sample. The denominator cannot be narrowed to improve the
//      number, which the source item names as the exact failure this item is
//      about.
//   2. Neuter each one IN MEMORY: strip the control shapes from its source text,
//      producing a gate that walks a tree, asserts emptiness, and proves nothing
//      about its scan. No file on disk is touched, so a failing run cannot leave
//      the tree altered.
//   3. Re-run the detector's own predicate on the neutered text.
//   4. The rate is `still-called-controlled / mutated`. Every one of those is a
//      case where the detector would have missed a genuinely uncontrolled gate.
//
// WHAT THE NUMBER IS AND IS NOT. It measures the detector against a specific
// mutation — removing the recognised control idioms. A gate can be vacuous in
// ways this mutation does not model (a control that is present but constrains
// nothing, an anchor that can never fail). Those are outside the denominator and
// the printed output says so. A heuristic with a measured error rate against a
// stated mutation is evidence; one with an unmeasured rate is an assumption.
//
// IF THE NUMBER IS BAD, THE FINDING IS THE NUMBER. Improving it by narrowing the
// sample, or by widening the detector until the mutation stops working, would be
// the failure this item exists to prevent.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROVES_NON_EMPTY, isScanningGate, looksControlled } from './vacuity-detector';

const LINT_DIR = resolve(__dirname, '..');
const RECORD = resolve(
  __dirname,
  '../../../docs/development/gate-integrity-measurements.md'
);

const read = (file: string): string => readFileSync(resolve(LINT_DIR, file), 'utf8');

/**
 * Every gate the detector calls controlled. This is the denominator, and it is
 * a census: every such gate, no sampling, no seed, nothing to tune.
 */
function controlledGates(): string[] {
  return readdirSync(LINT_DIR)
    .filter((file) => file.endsWith('.test.ts'))
    .filter((file) => file !== 'scanning-gates-prove-they-scanned.test.ts')
    .filter((file) => {
      const source = read(file);
      return isScanningGate(source) && looksControlled(source);
    })
    .sort();
}

/**
 * Remove every recognised control from a gate's source, leaving a gate that
 * scans and asserts emptiness and proves nothing.
 *
 * The mutation is a string transform. **Nothing is written.** This module does
 * not import a write function at all, and `no-writes-in-gate-integrity` in
 * `zero-offender-census.test.ts` asserts that for the whole tier — a
 * non-circular check, unlike a file asserting something about its own text.
 */
function neuter(source: string): string {
  return source
    .replace(/toBeGreaterThanOrEqual/g, 'toBeDefinedXX')
    .replace(/toBeGreaterThan/g, 'toBeDefinedXX')
    .replace(/toContain\(/g, 'toIncludeXX(')
    .replace(/toHaveLength\(/g, 'toSizeXX(')
    .replace(/expect\.fail/g, 'expect.noopXX')
    .replace(/ANCHORS/g, 'THINGS')
    .replace(/MIN_[A-Z_]+/g, 'BOUND')
    .replace(/vacuous/g, 'trivial')
    .replace(/vacuity/g, 'triviality');
}

describe('FR-R3-088 — the vacuity detector, measured', () => {
  const gates = controlledGates();

  it('the census has a non-empty denominator', () => {
    // The rule applied to the rule, again: a census over an empty set would
    // report a perfect rate and mean nothing.
    expect(gates.length).toBeGreaterThan(20);
  });

  it('publishes the false-negative rate over a FULL census', () => {
    const survivors: string[] = [];
    for (const gate of gates) {
      const mutated = neuter(read(gate));
      if (looksControlled(mutated)) survivors.push(gate);
    }
    const rate = survivors.length / gates.length;

    // The measurement is printed on every run, whatever it is. A rate without
    // its denominator is a number, not a measurement.
    process.stdout.write(
      `\n[gate-integrity] vacuity detector false-negative census:\n` +
        `  mutated=${gates.length} stillCalledControlled=${survivors.length} ` +
        `rate=${(rate * 100).toFixed(1)}%\n` +
        `  method: strip every recognised control idiom from the gate's source in memory,\n` +
        `          then re-run the detector's own predicate on the result\n` +
        `  NOT measured: gates vacuous in ways this mutation does not model — a control\n` +
        `          that is present but constrains nothing, an anchor that cannot fail\n` +
        (survivors.length > 0 ? `  survivors: ${survivors.join(', ')}\n` : '')
    );

    // The assertion is NOT "the rate is good". It is that the rate is measured
    // and recorded. A threshold here would create pressure to widen the
    // detector until the mutation stops working, which is how a measurement
    // becomes a claim.
    expect(Number.isFinite(rate)).toBe(true);
    expect(rate).toBeGreaterThanOrEqual(0);
    expect(rate).toBeLessThanOrEqual(1);
  });

  it('the published record states the same denominator this run computed', () => {
    // The record and the run are two authorities on one number, so the record
    // derives from the run rather than being transcribed beside it.
    const record = readFileSync(RECORD, 'utf8');
    const match = /vacuity-census-denominator:\s*(\d+)/.exec(record);
    expect(match, 'docs/development/gate-integrity-measurements.md must carry the denominator').not.toBeNull();
    expect(Number((match as RegExpExecArray)[1])).toBe(gates.length);
  });

  it('NON-VACUITY: the mutation genuinely removes what the detector looks for', () => {
    // If `neuter` stopped working, every gate would survive and the rate would
    // read 100% — indistinguishable from a detector that cannot see anything.
    // This pins the mutation itself against a synthetic control of each shape.
    const shapes = [
      "expect(sites.length).toBeGreaterThan(0);",
      "expect(files).toContain(HELPER);",
      "expect(files).toContain('src/lib/logger.ts');",
      "expect(hits).toHaveLength(3);",
      "const MIN_SITES = 4;",
      "// proves the scan was not vacuous"
    ];
    for (const shape of shapes) {
      expect(PROVES_NON_EMPTY.test(shape)).toBe(true);
      expect(PROVES_NON_EMPTY.test(neuter(shape))).toBe(false);
    }
  });

});
