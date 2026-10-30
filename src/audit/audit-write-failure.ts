// FR-R4-F03 (FR-022; contract W6, R9; TA6) — what an audit append failure is CALLED.
//
// THE FINDING. A log the writer cannot open fails inside `openWithinRoot` with an errno, and the
// writer wraps that as `AuditPathRefusedError(reason, errno)`. The failure handler read only
// `err.code`, which that wrapper does not set, so a real `EACCES` reached the evidence-health
// monitor as `io-error`: an operator was told the disk "failed" and went looking at the disk, when
// the log was simply not writable. A refusal on `write` (ENOSPC) carries `code` and was already
// `disk-full`, so the two common causes were told apart only by accident of where they were thrown.
//
// ONE PURE TABLE. The classification lives here, apart from the writer, so each row is a unit case
// and the writer stays under its size bound (TA6). It reads the error's SHAPE, never its message:
// a message can carry a path, and the monitor stores no path (FR-019).
import type { AuditWriteCause } from '../services/evidence-health/evidence-health-monitor';

/**
 * The caller's latency bound expired. The write itself may still land, and a row that lands after
 * its caller stopped waiting is a landed row (FR-005); this only names what the caller was told.
 */
export class AuditAppendTimeoutError extends Error {
  public readonly code = 'timeout';

  public constructor(public readonly boundMs: number) {
    super(`audit append timed out after ${boundMs}ms`);
    this.name = 'AuditAppendTimeoutError';
  }
}

/**
 * A write that returned having written less than the whole line. Part of the line is on disk, so
 * the next step owes a tail check, and it must never be read as an ordinary I/O error.
 */
export class AuditPartialWriteError extends Error {
  public readonly code = 'partial-write';

  public constructor(
    public readonly bytesWritten: number,
    public readonly bytesExpected: number
  ) {
    super(`audit write was short: ${bytesWritten} of ${bytesExpected} bytes`);
    this.name = 'AuditPartialWriteError';
  }
}

/** The shape of an `AuditPathRefusedError`, read without importing the writer (which imports this). */
interface PathRefusalShape {
  readonly name: string;
  readonly reason: string;
  readonly errno: string;
}

function isPathRefusal(err: unknown): err is PathRefusalShape {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as Partial<PathRefusalShape>;
  return (
    candidate.name === 'AuditPathRefusedError'
    && typeof candidate.reason === 'string'
    && typeof candidate.errno === 'string'
  );
}

/** The cause an errno names, or `io-error` for anything this table does not know. */
function causeOfErrno(errno: unknown): AuditWriteCause {
  switch (errno) {
    case 'EACCES':
    case 'EPERM':
      return 'permission-denied';
    case 'ENOSPC':
      return 'disk-full';
    case 'EROFS':
      return 'read-only-filesystem';
    default:
      return 'io-error';
  }
}

/**
 * The write cause of a rejected append, or `null` when the rejection is not a write failure at all:
 * a refusal because this window is not the owner is the owner check working, and neither reports
 * health nor counts as a failed write (W4).
 */
export function classifyAuditWriteFailure(err: unknown): AuditWriteCause | null {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (code === 'audit-not-owner') return null;
    if (code === 'timeout') return 'timeout';
    if (code === 'partial-write') return 'partial-write';
  }
  if (isPathRefusal(err)) {
    // Only an I/O failure under the walk is named by its errno. Every containment reason, a link
    // where a directory belongs, is a refusal of the path itself: look at the tree, not the disk.
    return err.reason === 'io-failed' ? causeOfErrno(err.errno) : 'path-refused';
  }
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return causeOfErrno(code);
}
