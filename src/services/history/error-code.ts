/**
 * Feature 103 (T080, FR-047, FR-048) — what a failed history operation is
 * allowed to say about the error it caught.
 *
 * The obvious line is `${(err as Error).message}`, and for a filesystem error
 * that message reads `ENOTDIR: not a directory, mkdir
 * '<workspaceRoot>/.schegent/history'` — the workspace root, in a log line,
 * which FR-047 forbids in the same breath as it forbids rendering one. The code
 * alone is the actionable half: it says what went wrong, and every caller
 * already knows which file it was addressing, because it composed the
 * workspace-relative reference itself and can log that instead.
 *
 * A non-errno error falls back to its constructor name rather than its message.
 * A message is free text from wherever the error was thrown, and nothing bounds
 * what it quotes back — a parse failure quoting the offending input would put
 * the description this surface exists to sanitize straight into the log.
 *
 * Shared by the recorder and the description store rather than copied into
 * each: the rule is one rule, and a second copy is a second thing to remember
 * when the next history writer needs it.
 */
export function historyErrorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  if (err instanceof Error) return err.constructor.name;
  return 'unknown';
}
