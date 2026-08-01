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
 *   - `{ "conversation_id": "..." }` (Agy stream-json)
 *   - `{ "conversationId": "..." }` (camel-case tolerant fallback)
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
const SESSION_ID_SIGILS = ['session_id', 'conversation_id', 'conversationId'] as const;

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
export function extractCliSessionId(stdout: IterableIterator<string> | string): string | null {
  const chunks = typeof stdout === 'string' ? [stdout] : stdout;
  let activeLine = '';
  
  for (const chunk of chunks) {
    if (!chunk) continue;
    
    let chunkIdx = 0;
    while (chunkIdx < chunk.length) {
      const newlineIdx = chunk.indexOf('\n', chunkIdx);
      
      if (newlineIdx === -1) {
        // No more newlines in this chunk, append the rest to activeLine
        activeLine += chunk.slice(chunkIdx);
        break;
      }
      
      // We found a newline, so we have a complete line
      const rawLine = activeLine + chunk.slice(chunkIdx, newlineIdx);
      activeLine = ''; // reset for next line
      chunkIdx = newlineIdx + 1;
      
      const line = rawLine.trim();
      if (line.length < MIN_SESSION_JSON_LEN) continue;
      // Shape check: must start with '{' and end with '}'.
      if (line.charCodeAt(0) !== 0x7b /* { */) continue;
      if (line.charCodeAt(line.length - 1) !== 0x7d /* } */) continue;
      if (!hasSessionIdSigil(line)) continue;
      const sessionId = parseSessionIdLine(line);
      if (sessionId !== null) return sessionId;
    }
  }

  // Check the final trailing line if any
  if (activeLine.trim().length >= MIN_SESSION_JSON_LEN) {
    const line = activeLine.trim();
    if (
      line.charCodeAt(0) === 0x7b &&
      line.charCodeAt(line.length - 1) === 0x7d &&
      hasSessionIdSigil(line)
    ) {
      return parseSessionIdLine(line);
    }
  }

  return null;
}

function hasSessionIdSigil(line: string): boolean {
  return SESSION_ID_SIGILS.some((sigil) => line.includes(sigil));
}

function parseSessionIdLine(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const topLevel = readId(record);
  if (topLevel !== null) return topLevel;

  for (const key of ['conversation', 'session'] as const) {
    const nested = record[key];
    if (nested && typeof nested === 'object') {
      const nestedId = readId(nested as Record<string, unknown>);
      if (nestedId !== null) return nestedId;
    }
  }
  return null;
}

function readId(record: Record<string, unknown>): string | null {
  for (const key of SESSION_ID_SIGILS) {
    const value = record[key];
    if (
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= MAX_SESSION_ID_LEN
    ) {
      return value;
    }
  }
  return null;
}
