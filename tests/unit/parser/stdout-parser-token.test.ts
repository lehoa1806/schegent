import { describe, it, expect } from 'vitest';
import { detectTerminationToken } from '../../../src/parser/stdout-parser';

describe('detectTerminationToken', () => {
  it('matches the canonical token on its own line', () => {
    expect(detectTerminationToken('[SCHEGENT_STATUS: CLEAR]')).toBe(true);
  });

  it('tolerates leading and trailing whitespace', () => {
    expect(detectTerminationToken('   [SCHEGENT_STATUS: CLEAR]   ')).toBe(true);
  });

  it('matches when the token appears on a line within multiline output', () => {
    const stdout = ['Some preamble', 'work was done', '[SCHEGENT_STATUS: CLEAR]', 'trailing'].join('\n');
    expect(detectTerminationToken(stdout)).toBe(true);
  });

  it('accepts the DONE synonym', () => {
    expect(detectTerminationToken('[SCHEGENT_STATUS: DONE]')).toBe(true);
  });

  it('accepts the RESOLVED synonym', () => {
    expect(detectTerminationToken('[SCHEGENT_STATUS: RESOLVED]')).toBe(true);
  });

  it('is case-insensitive on the keyword', () => {
    expect(detectTerminationToken('[schegent_status: clear]')).toBe(true);
  });

  it('handles CRLF line endings', () => {
    const stdout = ['preamble', '[SCHEGENT_STATUS: CLEAR]', 'trailing'].join('\r\n');
    expect(detectTerminationToken(stdout)).toBe(true);
  });

  it('accepts markdown-decorated tokens (bold)', () => {
    expect(detectTerminationToken('**[SCHEGENT_STATUS: CLEAR]**')).toBe(true);
  });

  it('accepts backtick-decorated tokens', () => {
    expect(detectTerminationToken('`[SCHEGENT_STATUS: CLEAR]`')).toBe(true);
  });

  it('accepts tokens embedded within prose on the same line', () => {
    expect(detectTerminationToken('I will mark [SCHEGENT_STATUS: CLEAR] now.')).toBe(true);
  });

  it('rejects unknown status values', () => {
    expect(detectTerminationToken('[SCHEGENT_STATUS: PARTIAL]')).toBe(false);
  });

  it('returns false for empty stdout', () => {
    expect(detectTerminationToken('')).toBe(false);
  });

  it('returns false when the token is missing', () => {
    expect(detectTerminationToken('phase ran successfully but no token was emitted')).toBe(false);
  });
});
