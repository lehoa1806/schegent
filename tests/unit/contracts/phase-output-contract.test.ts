// FR-R3-203 — the phase output contract module: the one definition of the audit
// block's markers, the termination token the prompt asks for, and the rule the
// host uses to accept a token. These literals are pinned here on purpose: a change
// to the contract is an edit to this file as well (contract G1).
import { describe, expect, it } from 'vitest';
import {
  AUDIT_LOG_CLOSE_MARKER,
  AUDIT_LOG_OPEN_MARKER,
  TERMINATION_TOKEN,
  containsTerminationToken
} from '../../../src/contracts/phase-output-contract';

describe('phase-output-contract values (C1 to C3)', () => {
  it('the open marker is exactly the one the prompt prints', () => {
    expect(AUDIT_LOG_OPEN_MARKER).toBe('=== SCHEGENT AUDIT LOG ===');
  });

  it('the close marker is exactly the one the prompt prints', () => {
    expect(AUDIT_LOG_CLOSE_MARKER).toBe('=== END AUDIT LOG ===');
  });

  it('the termination token is exactly the one the prompt asks for', () => {
    expect(TERMINATION_TOKEN).toBe('[SCHEGENT_STATUS: CLEAR]');
  });
});

describe('containsTerminationToken (C4)', () => {
  it('accepts the token the prompt asks for (G2)', () => {
    expect(containsTerminationToken(TERMINATION_TOKEN)).toBe(true);
  });

  it.each([
    ['DONE', '[SCHEGENT_STATUS: DONE]'],
    ['RESOLVED', '[SCHEGENT_STATUS: RESOLVED]'],
    ['lower-case word', '[SCHEGENT_STATUS: clear]'],
    ['no space after the colon', '[SCHEGENT_STATUS:CLEAR]'],
    ['a decorated line', '**[SCHEGENT_STATUS: CLEAR]**']
  ])('accepts %s (G3)', (_label, line) => {
    expect(containsTerminationToken(line)).toBe(true);
  });

  it.each([
    ['FAILED', '[SCHEGENT_STATUS: FAILED]'],
    ['a space before the closing bracket', '[SCHEGENT_STATUS: CLEAR ]'],
    ['the empty string', '']
  ])('rejects %s (G3)', (_label, line) => {
    expect(containsTerminationToken(line)).toBe(false);
  });

  it('keeps no state between calls', () => {
    const line = '[SCHEGENT_STATUS: CLEAR]';
    expect(containsTerminationToken(line)).toBe(true);
    expect(containsTerminationToken(line)).toBe(true);
    expect(containsTerminationToken('[SCHEGENT_STATUS: FAILED]')).toBe(false);
    expect(containsTerminationToken(line)).toBe(true);
  });
});
