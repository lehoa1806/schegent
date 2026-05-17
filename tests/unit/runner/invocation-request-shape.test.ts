import { describe, it, expect } from 'vitest';
import type { InvocationRequest } from '../../../src/runner/invocation-result';

/**
 * Feature 032 — T003: contract test for the extended `InvocationRequest`
 * shape with the new optional `isContinue?: boolean` field. The field is
 * additive and optional; all existing call sites that construct an
 * `InvocationRequest` without it MUST continue to type-check.
 *
 * The assertions here exercise the contract at the TYPE level
 * (compile-time enforcement) and at the RUNTIME level (a constructed
 * value satisfies the shape).
 */
describe('InvocationRequest shape (feature 032)', () => {
  it('accepts the optional isContinue?: boolean field set to true', () => {
    const request: InvocationRequest = {
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'do work',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo',
      isContinue: true
    };
    expect(request.isContinue).toBe(true);
  });

  it('accepts the optional isContinue?: boolean field set to false', () => {
    const request: InvocationRequest = {
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'do work',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo',
      isContinue: false
    };
    expect(request.isContinue).toBe(false);
  });

  it('accepts construction without the isContinue field (backwards-compat)', () => {
    const request: InvocationRequest = {
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'do work',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo'
    };
    // The optional field is undefined when omitted.
    expect(request.isContinue).toBeUndefined();
  });
});
