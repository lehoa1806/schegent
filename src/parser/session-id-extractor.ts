/**
 * Session ID extractor — parses the Claude CLI's stream-json output for
 * the session identifier emitted in the `system` or `init` event at the
 * start of a conversation.
 *
 * Pure module. No `vscode` import. No I/O. No module-level mutable state.
 *
 * Hard invariants (validated by tests):
 *   - Never throws on any input.
 *   - Linear time in `stdout.length` (no catastrophic backtracking).
 *   - Pure: no I/O, no `Date.now()` inside the body.
 *   - Deterministic for any fixed `stdout`.
 *
 * The extractor scans stdout lines (JSON objects) for any of:
 *   - `{ "type": "system", "session_id": "..." }`
 *   - `{ "type": "init", "session_id": "..." }`
 *   - `{ "session_id": "..." }` (any type, fallback)
 *
 * When the CLI is invoked without `--output-format stream-json`, stdout
 * is plain text and this extractor returns `null` — the caller falls back
 * to the existing `-c` flag behavior.
 */

/**
 * Minimum viable length for a JSON line to contain a session_id field.
 * `{"session_id":"x"}` = 20 chars minimum. This avoids JSON.parse on
 * trivially short lines.
 */
const MIN_SESSION_JSON_LEN = 18;

/**
 * Fast substring guard. Lines that don't contain "session_id" as a
 * substring are skipped without JSON.parse.
 */
const SESSION_ID_SIGIL = 'session_id';

/**
 * UUID-like validation: the session_id should be a non-empty string.
 * We don't enforce a strict UUID format because the CLI may use other
 * identifier formats in the future.
 */
const MAX_SESSION_ID_LEN = 256;

/**
 * Extract the CLI session ID from stream-json stdout.
 *
 * Scans lines from the START (session_id is emitted early in the
 * conversation, typically in the first few lines of stream-json output).
 * Returns the first valid session_id found, or `null` when no
 * parseable session ID is present.
 */
export function extractCliSessionId(stdout: string): string | null {
  if (!stdout || stdout.length < MIN_SESSION_JSON_LEN) return null;
  // Fast-fail: if the entire stdout doesn't contain the sigil,
  // skip the line-by-line scan entirely.
  if (stdout.indexOf(SESSION_ID_SIGIL) === -1) return null;

  const lines = stdout.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length < MIN_SESSION_JSON_LEN) continue;
    // Shape check: must start with '{' and end with '}'.
    if (line.charCodeAt(0) !== 0x7b /* { */) continue;
    if (line.charCodeAt(line.length - 1) !== 0x7d /* } */) continue;
    // Substring guard: must contain 'session_id'.
    if (line.indexOf(SESSION_ID_SIGIL) === -1) continue;

    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    const rec = obj as Record<string, unknown>;

    // Primary: top-level `session_id` field.
    const sessionId = rec.session_id;
    if (
      typeof sessionId === 'string' &&
      sessionId.length > 0 &&
      sessionId.length <= MAX_SESSION_ID_LEN
    ) {
      return sessionId;
    }

    // Secondary: nested inside a `conversation` or `session` object.
    for (const key of ['conversation', 'session'] as const) {
      const nested = rec[key];
      if (nested && typeof nested === 'object') {
        const nestedId = (nested as Record<string, unknown>).session_id;
        if (
          typeof nestedId === 'string' &&
          nestedId.length > 0 &&
          nestedId.length <= MAX_SESSION_ID_LEN
        ) {
          return nestedId;
        }
      }
    }
  }

  return null;
}
