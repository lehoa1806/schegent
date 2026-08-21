// Feature 107 (T610, FR-008, SC-002) — these tests were *not* relocated, and
// none had to be dropped. Recording why, because the obvious reading of the
// task was to move them.
//
// `detectTerminationToken` stopped being the sole decision point when the
// trailing region landed: `detectTermination` now decides outcomes when the
// stream carries a complete audit block. But the primitive did not become dead
// code — it is the **degraded path** (FR-009), reached whenever no complete
// block is present, which is the shape a run that crashed mid-block produces.
// A reachable path with no tests is worse than a redundant test file, so these
// stay exactly where they are, pinning tolerance on the path they always
// pinned.
//
// Every tolerated shape here is additionally re-asserted against the deciding
// path, in `stdout-injection.test.ts` → "in-region decoration tolerance is
// preserved (FR-008, SC-002)", which covers all three decorations plus the
// whitespace, case, and synonym variants. Tolerance is therefore observed on
// both paths rather than moved from one to the other — a stronger guarantee
// than relocation would have given, since relocation would have left the
// degraded path unpinned.

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
