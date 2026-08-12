// Feature 091 T007–T010 — shared shapes for the one-time Wake-up cleanup
// schedulers.
//
// These types are declared here, next to the modules that produce them,
// rather than in `../cleanup-record.ts`, so Phase 2 of the removal is
// self-contained: the removal capability must exist and be testable
// *before* `src/wakeup/` is deleted. `cleanup-record.ts` re-exports
// `SchedulerAttempt`, so every consumer still sees the data model's
// stated home for the shape.
//
// This whole directory is withdrawn at v0.6.0 — see
// `WAKEUP_CLEANUP_END_OF_LIFE` in `../wakeup-cleanup.ts`.

/** The four schedulers past releases (014/024/031) could register with. */
export type SchedulerName = 'launchd' | 'systemd-user' | 'cron' | 'task-scheduler';

/**
 * Outcome of a single scheduler's removal attempt.
 *
 * `absent` is a success, not a failure: a machine that never enabled
 * Wake-up has nothing to remove and must stay silent (FR-014). Only
 * `failed` degrades the overall outcome.
 */
export type SchedulerResult = 'removed' | 'absent' | 'failed';

export interface SchedulerAttempt {
  readonly scheduler: SchedulerName;
  readonly result: SchedulerResult;
  /**
   * Short failure summary. Never a stack trace and never an operator
   * path — the caller redacts before persisting (contract C-02, FR-012).
   */
  readonly reason?: string;
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface CommandRunOptions {
  readonly input?: string;
  readonly timeoutMs?: number;
}

/**
 * Ported verbatim from the `CommandRunner` interface of the deleted
 * `src/wakeup/daemon-manager.ts` so the removal operations keep the
 * seam their tests inject through.
 */
export interface CommandRunner {
  run(
    cmd: string,
    args: readonly string[],
    opts?: CommandRunOptions
  ): Promise<CommandResult>;
}

/**
 * Per-scheduler removal dependencies. Every field is optional so
 * `remove()` satisfies the bare `remove(): Promise<SchedulerAttempt>`
 * shape of contract C-02 while staying injectable from tests.
 */
export interface SchedulerRemovalDeps {
  readonly runner?: CommandRunner;
  /** launchd only — stands in for `os.homedir()`. */
  readonly homeDir?: string;
  /** systemd-user only — stands in for the resolved unit directory. */
  readonly unitDir?: string;
}

/**
 * Filesystem paths appearing anywhere in a failure summary.
 *
 * Node's `ErrnoException.message` embeds the offending path verbatim —
 * `EACCES: permission denied, unlink '/Users/someone/Library/…'` — so
 * dropping the stack is not sufficient on its own. The lookbehind pins
 * each match to a real path start (line start, whitespace, quote, or
 * bracket) so a scheduler identity such as `gui/501/com.schegent.wakeup`
 * is left intact: it is not a path, and eliding it would throw away the
 * only diagnostic the log line carries.
 *
 * This is path elision, not secret redaction. `SECRET_PATTERNS` in
 * `lib/logger.ts` remains the single source of truth for secrets, and
 * every reason still passes through it before being persisted.
 */
const FILESYSTEM_PATH = /(?<=^|[\s'"`(=[])(?:[A-Za-z]:[\\/]|~[\\/]|\/)[^\s'"`,;)\]]*/g;

/**
 * Collapses an unknown thrown value into a short, single-line summary.
 *
 * Deliberately drops the stack and elides filesystem paths: contract
 * C-01 guarantee 4 forbids the record from containing either, and
 * contract C-02 guarantee 3 requires a redacted `reason`.
 */
export function describeFailure(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/\s+/g, ' ')
    .replace(FILESYSTEM_PATH, '<path>')
    .trim()
    .slice(0, 200);
}
