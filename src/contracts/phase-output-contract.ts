// FR-R3-203 — the one definition of the stdout contract's strings and of the
// rule that accepts a termination token. A leaf: it imports nothing, so the host
// and the webview can both take their values from it.

/** The line that opens the audit block; the prompt prints it, the host and the activity feed read it. */
export const AUDIT_LOG_OPEN_MARKER = '=== SCHEGENT AUDIT LOG ===';

/** The line that closes the audit block; the prompt prints it, the host and the activity feed read it. */
export const AUDIT_LOG_CLOSE_MARKER = '=== END AUDIT LOG ===';

/** The completion token the prompt asks for; the host and the activity feed accept it through `containsTerminationToken`. */
export const TERMINATION_TOKEN = '[SCHEGENT_STATUS: CLEAR]';

// The accepted set: `CLEAR`, `DONE` or `RESOLVED`, in any letter case, with optional whitespace after
// the colon, within one line (FR-R4-F12, FR-013). The placement rule, that a token counts only in the
// trailing region of the last complete audit block, is applied by `detectTermination` in
// `src/parser/stdout-parser.ts`, not by this pattern.
// Flag `i` only: a `g` or `y` flag would make `test` keep `lastIndex` between calls.
const TERMINATION_PATTERN = /\[SCHEGENT_STATUS:\s*(CLEAR|DONE|RESOLVED)\]/i;

/**
 * The host's accepting rule for a termination token, over ONE line. Callers split
 * the text first: `\s*` matches a newline, so a whole region would accept a token
 * split across two lines that the host rejects.
 */
export function containsTerminationToken(line: string): boolean {
  return TERMINATION_PATTERN.test(line);
}
