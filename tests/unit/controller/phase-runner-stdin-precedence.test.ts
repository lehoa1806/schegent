import { describe, expect, it } from 'vitest';
import { RECORDABLE_PHASE_END_WARNINGS } from '../../../src/audit/audit-payload';

/**
 * FR-R3-047 (H-04) — the delivery condition outranks a clean parse.
 *
 * `PhaseRunner.run` needs a large collaborator graph, so this file pins the two
 * properties that make the new arm correct and leaves the wiring to the
 * integration suites: the diagnostic code is recordable (without it the audit
 * would say a run failed and not say why), and the arm sits above every other arm
 * in the source order that decides precedence.
 */
describe('stdin delivery precedence', () => {
  it('records the cause rather than only the failure', () => {
    // Not decoration: `outcome: 'failed'` / `terminationReason: 'error'` with no
    // stated cause is what made a real 2026-08-16 failure undiagnosable from the
    // audit alone. A code outside this set is counted and dropped, so if this
    // membership ever lapses the record silently loses the reason.
    expect(RECORDABLE_PHASE_END_WARNINGS.has('stdin-delivery-failed')).toBe(true);
  });

  it('is checked before every other arm of the decision chain', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(
      join(__dirname, '..', '..', '..', 'src', 'controller', 'phase-runner.ts'),
      'utf8'
    );
    const stdinArm = source.indexOf('if (raw.stdinDeliveryFailed)');
    const timeoutArm = source.indexOf("if (raw.timedOut && result.kind !== 'clean')");
    const killedArm = source.indexOf('if (raw.killed && raw.exitCode === null)');
    const cleanNonZero = source.indexOf("if (result.kind === 'clean' && raw.exitCode !== null");

    expect(stdinArm).toBeGreaterThan(-1);
    // A backend that heard half a prompt answered a different question, so its
    // termination token is not evidence about this phase.
    expect(stdinArm).toBeLessThan(timeoutArm);
    expect(stdinArm).toBeLessThan(killedArm);
    expect(stdinArm).toBeLessThan(cleanNonZero);
    // And the arms below it kept their relative order: this feature inserted
    // above an untouched chain rather than reordering it.
    expect(timeoutArm).toBeLessThan(killedArm);
    expect(killedArm).toBeLessThan(cleanNonZero);
  });
});
