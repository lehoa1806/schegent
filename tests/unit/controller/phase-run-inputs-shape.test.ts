import { describe, it, expect } from 'vitest';
import type { PhaseRunInputs } from '../../../src/controller/phase-runner';

/**
 * Feature 032 — T004: contract test for the extended `PhaseRunInputs`
 * shape with the new optional `isContinue?: boolean` field. The field is
 * additive and optional; all existing call sites that construct
 * `PhaseRunInputs` without it MUST continue to type-check.
 */
describe('PhaseRunInputs shape (feature 032)', () => {
  it('accepts the optional isContinue?: boolean field set to true', () => {
    const inputs: PhaseRunInputs = {
      phase: 'speckit-implement',
      iteration: 1,
      iterationCap: 5,
      featureDescription: 'feature',
      featureDir: null,
      cliPath: 'claude',
      cwd: '/repo',
      timeoutMs: 5_000,
      runId: 'run-abc',
      isContinue: true
    };
    expect(inputs.isContinue).toBe(true);
  });

  it('accepts the optional isContinue?: boolean field set to false', () => {
    const inputs: PhaseRunInputs = {
      phase: 'speckit-implement',
      iteration: 1,
      iterationCap: 5,
      featureDescription: 'feature',
      featureDir: null,
      cliPath: 'claude',
      cwd: '/repo',
      timeoutMs: 5_000,
      runId: 'run-abc',
      isContinue: false
    };
    expect(inputs.isContinue).toBe(false);
  });

  it('accepts construction without the isContinue field (backwards-compat)', () => {
    const inputs: PhaseRunInputs = {
      phase: 'speckit-implement',
      iteration: 1,
      iterationCap: 5,
      featureDescription: 'feature',
      featureDir: null,
      cliPath: 'claude',
      cwd: '/repo',
      timeoutMs: 5_000,
      runId: 'run-abc'
    };
    expect(inputs.isContinue).toBeUndefined();
  });
});
