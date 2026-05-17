// Feature 031 — Constants shared by the wake-up session capture/log surface.
//
// All three user stories rely on the same size invariants and block delimiters,
// so they live in a single vscode-free module that the headless runner (US2
// capture + US3 writer) and the host reader (US2 IPC dispatcher) all import.
//
// The 64 KB / 32 KB / 32 MB / 128 MB invariants come from the contracts under
// `specs/031-advanced-wakeup-logs-models/contracts/`:
//   - capture buffer cap (in-memory FIFO ring) — see US2 session-capture spec
//   - IPC body projection cap (host → webview) — see wakeup-session-log-ipc.md
//   - on-disk soft retention cap — see US3 session-log retention spec
//   - on-disk hard cap (emergency truncate) — same
//
// Block delimiter format: `=== wakeup-block <iso> id=<uuid> ... ===` at the
// head of each block. The prefix + suffix constants are exported so both the
// writer (compose) and reader (scan) consume the same string verbatim.
//
// This module MUST remain `vscode`-import-free so the headless runner bundle
// (`dist/wakeup-runner.js`) does not transitively reach the VS Code namespace
// at runtime (014 hard rule, retained for 031).

/**
 * 64 KB FIFO ring buffer cap for the in-memory capture of the Claude CLI
 * subprocess stdout + stderr during a single wake-up invocation. When the
 * total captured bytes exceed this cap, the oldest bytes are evicted from
 * the head of the ring. Sets `sessionCaptureTruncated: true` on the
 * `InvocationRecord` when eviction occurred. The cap protects the runner's
 * memory footprint against pathological subprocess output.
 */
export const SESSION_CAPTURE_MAX_BYTES = 64 * 1024;

/**
 * 32 KB cap on the body bytes the host IPC projection includes in the
 * `CMD_READ_WAKEUP_SESSION_LOG` response. The on-disk block may be larger
 * (up to `SESSION_CAPTURE_MAX_BYTES`); the projection sets `bodyTruncated:
 * true` and the webview surfaces the "see full file" affordance pointing
 * at the snapshot's `wakeUp.sessionLogPath`.
 */
export const SESSION_PROJECTION_MAX_BYTES = 32 * 1024;

/**
 * 32 MB soft retention cap on the on-disk `<globalStorageUri>/wakeup/session.log`
 * file. After each block append, if the resulting file exceeds this cap,
 * the writer trims the oldest *complete* blocks from the head (boundary
 * defined by `BLOCK_HEADER_PREFIX`) until the file is at or below this
 * size. Setting `sessionLogTrimmed: true` on the invocation record signals
 * a trim pass ran.
 */
export const SESSION_LOG_MAX_BYTES = 32 * 1024 * 1024;

/**
 * 128 MB hard cap defense-in-depth. If a hand-edit corruption breaks the
 * block-boundary scan and the file balloons past this cap, the writer
 * truncates the tail to ~64 MB at the next block boundary (or to zero
 * with a `hard-cap-emergency-truncate` annotation if no boundary is
 * found in the surviving tail). Operators are not expected to ever
 * trip this path in normal use; it exists to prevent disk exhaustion
 * from corrupted state.
 */
export const SESSION_LOG_HARD_CAP_BYTES = 128 * 1024 * 1024;

/**
 * Block header prefix, used by the writer to compose the leading line of
 * each block and by the reader to scan for block boundaries during the
 * `correlationId` lookup and during retention trimming.
 *
 * Full header format (composed by the writer):
 *   `=== wakeup-block <iso8601> id=<uuid> trigger=<src> model=<id> status=<status> ===\n`
 */
export const BLOCK_HEADER_PREFIX = '=== wakeup-block ';

/**
 * Block header suffix. Mirrors the prefix; the writer always emits these
 * two markers verbatim. The full header line is the body chunk; the
 * reader uses both markers to bound the header substring.
 */
export const BLOCK_HEADER_SUFFIX = ' ===';
