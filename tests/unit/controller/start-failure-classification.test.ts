// The module that decides how a start failure is REPORTED, tested directly.
//
// WHY THIS FILE DID NOT EXIST UNTIL NOW, which is part of the finding it records.
// `start-failure-classification.ts` was extracted by FR-R3-146 to put one decision
// in one place, and its behaviour was covered only through the controller that
// calls it. A module whose whole job is "which shape is this throw" is exactly the
// module whose UNHANDLED shapes nobody notices: the tests that exercised it all
// arrived holding one of the three shapes it already knew.
import { describe, expect, it } from 'vitest';
import { LockHeldError } from '../../../src/lib/errors';
import { ALL_PHASE_CAPABILITIES } from '../../../src/contracts/phase-capabilities';
import { CapabilityNotEnforceableError } from '../../../src/services/capability-refusal';
import { UncontainedBackendRefusedError } from '../../../src/services/backend-containment-policy';
import {
  UNEXPECTED_MESSAGE_MAX,
  classifyStartFailure
} from '../../../src/controller/start-failure-classification';

const FEATURE = 'feat-1';
const identity = (raw: string): string => raw;

describe('a deliberate policy refusal is never reported as an unexpected fault', () => {
  // The module states its own membership rule, in the docblock on
  // UNEXPECTED_MESSAGE_MAX: the bound is for "an ARBITRARY throw ... whatever a
  // dependency chose to put in it", and the classified shapes are exempt "because
  // both are built by this product from constants and both are cut mid-remedy by
  // it". A capability refusal satisfies that rule word for word and was outside
  // the set anyway — the rule was written and one member was missed.
  const refusal = (): CapabilityNotEnforceableError =>
    new CapabilityNotEnforceableError('claude', ['outside-workspace-write', 'process-spawn']);

  it('is its own kind, not the catch-all', () => {
    const report = classifyStartFailure(refusal(), FEATURE, identity);
    expect(
      report.kind,
      'a refusal that lands in `unexpected` gets the catch-all wording AND the catch-all bound'
    ).not.toBe('unexpected');
    expect(report.code).not.toBe('unexpected-controller-error');
  });

  it('keeps the remedy, which is the half a 240-character cut removes', () => {
    const full = refusal().message;
    expect(full.length, 'the message must exceed the bound or this test proves nothing').toBeGreaterThan(
      UNEXPECTED_MESSAGE_MAX
    );
    // The whole sentence that tells the operator what to DO sits past the cut.
    // Measured for this set: the catch-all bound severs the message at
    // "an unbounded phase where a narrower set was ", and everything below is lost.
    const remedy =
      "Widen the phase's capability set, or run it on a backend whose CLI can express the " +
      'withheld capability.';
    expect(full).toContain(remedy);

    const report = classifyStartFailure(refusal(), FEATURE, identity);
    expect(report.message, 'a remedy an operator cannot read is not a remedy').toContain(remedy);
  });

  it('names both withheld capabilities, not just the first', () => {
    const report = classifyStartFailure(refusal(), FEATURE, identity);
    expect(report.message).toContain('outside-workspace-write');
    expect(report.message).toContain('process-spawn');
  });

  it('is over the bound for EVERY capability set, so this is not an edge case', () => {
    // The shortest message this error can produce is the single-capability one,
    // and it is 370 characters. There is no input for which the catch-all bound
    // leaves the remedy intact: every capability refusal that ever fires loses it.
    for (const set of ALL_PHASE_CAPABILITIES) {
      const one = new CapabilityNotEnforceableError('claude', [set]);
      expect(one.message.length, `a lone '${set}' refusal`).toBeGreaterThan(UNEXPECTED_MESSAGE_MAX);
    }
  });

  it('does not tell the operator the workflow failed unexpectedly', () => {
    const report = classifyStartFailure(refusal(), FEATURE, identity);
    // `capability-refusal.ts`'s own header gives the reason this matters: "a phase
    // that failed because the model wrote bad code and a phase that never started
    // because its declared capability set could not be enforced are different
    // findings, and an operator who cannot tell them apart will debug the wrong one."
    expect(report.announcement).not.toContain('failed unexpectedly');
    expect(report.logLine).not.toContain('failed unexpectedly');
  });

  it('is a decision this product reports, not a fault it confesses', () => {
    // Same call as the held lock and the containment refusal: `error` is what an
    // operator filters for when something is broken, and a refusal is the product
    // working.
    expect(classifyStartFailure(refusal(), FEATURE, identity).level).toBe('warn');
  });

  it('keeps the status bar to one line, like every other shape', () => {
    const report = classifyStartFailure(refusal(), FEATURE, identity);
    expect(report.statusDetail).not.toContain('\n');
    expect(
      report.statusDetail.length,
      'the full text is on the Run record and in the log, which is where it is readable'
    ).toBeLessThanOrEqual(120);
  });

  it('routes the sanitizer over it, with no exemption for a message built here', () => {
    const report = classifyStartFailure(refusal(), FEATURE, () => 'REDACTED');
    expect(report.message).toBe('REDACTED');
  });
});

describe('the shapes that already worked keep working', () => {
  it('still bounds and still names an ARBITRARY throw, which stays out of scope', () => {
    // FR-R3-146 §2 decided this deliberately: an unexpected error's message is
    // whatever a dependency chose to put in it, and a toast is not a sink that can
    // absorb that. This control is why the fix above is a new branch and not a
    // widening of the bound.
    const long = 'x'.repeat(400);
    const report = classifyStartFailure(new Error(long), FEATURE, identity);
    expect(report.kind).toBe('unexpected');
    expect(report.message).toHaveLength(UNEXPECTED_MESSAGE_MAX);
    expect(report.announcement).toContain('failed unexpectedly');
    expect(report.level).toBe('error');
  });

  it('still reports a held lock as a held lock', () => {
    const report = classifyStartFailure(new LockHeldError('owner-9'), FEATURE, identity);
    expect(report.kind).toBe('lock-held');
    expect(report.level).toBe('warn');
  });

  it('still reports a containment refusal untruncated', () => {
    const err = new UncontainedBackendRefusedError('claude', 'the full policy message '.repeat(20));
    const report = classifyStartFailure(err, FEATURE, identity);
    expect(report.kind).toBe('uncontained-backend-refused');
    expect(report.message.length).toBeGreaterThan(UNEXPECTED_MESSAGE_MAX);
  });

  it('falls back to a name when the throw carries no message at all', () => {
    const report = classifyStartFailure(new Error(''), FEATURE, identity);
    expect(report.message).toBe('unknown workflow error');
  });
});
