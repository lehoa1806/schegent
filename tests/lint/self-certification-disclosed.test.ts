// FR-R3-038 — the phase verdict is the model's own report, and the documents
// have to say so.
//
// Two layers, and conflating them would misstate a property this product
// actually holds:
//
//   * The CONTROL SENTINEL — whether a phase terminated — is not forgeable.
//     Feature 107 moved termination detection into a positional trailing region
//     and `tests/lint/no-content-driven-process-control.test.ts` forbids the
//     mechanism rather than an identifier. T25 covers it. Nothing here weakens
//     that, and text implying otherwise would be wrong in a new direction.
//
//   * The OUTCOME CLASSIFICATION reads the model's own words. `stdout-parser.ts`
//     decides clean / remaining_issues / open_questions from the audit block's
//     body, and a phase resolving clean advances the pipeline. No test suite is
//     run, no build is checked, and `resolveRunOutputs` probes whether a declared
//     output EXISTS rather than whether it is correct.
//
// The second is structurally unavoidable where the model is the worker. This gate
// does not try to close it — it holds the disclosure, because an operator
// composing an unattended pipeline needs to know a verification phase is theirs
// to author.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const read = (path: string): string => readFileSync(resolve(REPO_ROOT, path), 'utf8');
const collapse = (text: string): string => text.replace(/\s+/g, ' ');

const THREAT_MODEL = 'docs/security/threat-model.md';
const CUSTOM_PHASES = 'docs/features/custom-phases.md';

/**
 * Just the limits section, collapsed.
 *
 * Every assertion about the disclosure is scoped here rather than to the whole
 * document, and that is not fussiness: an earlier version checked the phrase
 * "control sentinel" against all of `threat-model.md`, where it also appears in
 * T25's own title. Removing the distinction from the limits entry left the test
 * green on an unrelated occurrence forty sections away. A claim stated somewhere
 * in a long document is not the claim stated where a reader looks for it.
 */
function limitsSection(): string {
  const text = readFileSync(resolve(REPO_ROOT, THREAT_MODEL), 'utf8');
  const start = text.indexOf('## What Schegent cannot prevent');
  expect(
    start,
    `${THREAT_MODEL} has no "What Schegent cannot prevent" section. That list is where this ` +
      `limit belongs; if the section was renamed, teach this gate the new name rather than ` +
      `dropping the assertion.`
  ).toBeGreaterThanOrEqual(0);
  const end = text.indexOf('\n## ', start + 1);
  return collapse(text.slice(start, end < 0 ? undefined : end));
}

describe('self-certification is disclosed', () => {
  it('names the limit in the list of what Schegent cannot prevent', () => {
    // Scoped to that section: the limit stated anywhere else in a long document
    // is not the same as the limit stated among the limits, which is where a
    // reader evaluating risk actually looks.
    const section = limitsSection();
    expect(
      /reports itself finished|self-certif|the model's own account|its own account of its work/i.test(section),
      `${THREAT_MODEL}'s limits list does not name self-certification. The phase verdict is the ` +
        `model's own account of its work and a phase resolving clean advances the pipeline; an ` +
        `operator composing an unattended run needs that among the limits, not inferred from ` +
        `elsewhere.`
    ).toBe(true);
  });

  it('distinguishes the bounded control sentinel from the unbounded classification', () => {
    // Credit the layer that IS bounded. A disclosure that blurred the two would
    // claim this product is weaker than it is, and would contradict T25.
    const section = limitsSection();
    expect(
      /control sentinel/i.test(section),
      `${THREAT_MODEL} states the self-certification limit without distinguishing it from the ` +
        `control sentinel. Termination detection is NOT forgeable — feature 107 and T25 — and a ` +
        `disclosure that implies otherwise is wrong in the opposite direction.`
    ).toBe(true);
  });

  it('says what the host checks about a declared output, which is existence', () => {
    const section = limitsSection();
    expect(
      /resolveRunOutputs/.test(section) && /exists/i.test(section),
      `${THREAT_MODEL} must say that a declared output is probed for existence rather than ` +
        `correctness. "The host checks outputs" is the misreading this sentence exists to prevent.`
    ).toBe(true);
  });

  it('tells a phase author the verification phase is theirs to write', () => {
    // The higher-value surface: the operator who needs this is the one about to
    // author the pipeline, not the one evaluating risk afterwards.
    const text = collapse(read(CUSTOM_PHASES));
    expect(
      /host does not verify your phase/i.test(text),
      `${CUSTOM_PHASES} must state that the host verifies no phase. This is where a pipeline is ` +
        `authored, and it is the moment the exposure is created.`
    ).toBe(true);
    expect(
      /retryCondition/.test(text) && /sideEffects: none/.test(text),
      `${CUSTOM_PHASES} must show the shape of a verification phase, not merely advise that one ` +
        `is needed. Advice without a shape is how the advice goes unfollowed.`
    ).toBe(true);
  });

  it('keeps the two documents pointing at each other', () => {
    expect(
      limitsSection().includes('custom-phases.md'),
      `${THREAT_MODEL} states the limit but does not point at the remedy. A limit a reader cannot ` +
        `act on is a caveat.`
    ).toBe(true);
  });

  it('does not weaken the control-sentinel gate it credits', () => {
    // If the mechanism ban were ever deleted, this disclosure would start
    // describing a property that no longer holds.
    const guard = 'tests/lint/no-content-driven-process-control.test.ts';
    expect(
      () => read(guard),
      `${guard} is gone. ${THREAT_MODEL} credits it for the property that a model cannot forge a ` +
        `termination signal; without it, that sentence is no longer true.`
    ).not.toThrow();
  });
});
