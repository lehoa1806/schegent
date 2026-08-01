// Feature 019 — RuntimeLogSink: append-only file sink driven by the
// per-call RuntimeLogAccessor.
//
// Lifecycle:
//   - `SanitizedLogger.addSink(runtimeLogSink)` registers the sink.
//   - Every emit reads the accessor: if it returns `null` (path
//     unresolvable) the line is dropped. Otherwise, the level token
//     parsed from the formatted `[<ts>] <LEVEL> ...` line is compared
//     against the configured filter via `shouldEmit()`.
//   - First write to a fresh path may fail with ENOENT (missing
//     parent). The sink calls `mkdir(parent, { recursive: true })`
//     and retries ONCE. Any other failure → record a path-keyed
//     suppression and emit one WARN through the fallback logger.
//   - `clearSuppression(path)` is invoked from the post-save callback
//     in `writeGeneralSettings` so an operator's correction unlocks
//     the next emit.
//
// Why short-circuit BEFORE formatting work?
//   The hot path emits ~10⁴ DEBUG lines per long run; filter-first
//   trims allocation pressure.
//
// File writes use `fs.promises.appendFile`. POSIX guarantees atomicity
// up to PIPE_BUF (≥ 512 bytes) for a single line; cross-platform we
// rely on the OS-level append-mode write being last-writer-safe.

import * as fs from 'fs/promises';
import * as path from 'path';

import type { LogSink, SanitizedLogger } from '../logger';
import {
  isRuntimeLogLevel,
  shouldEmit,
  type RuntimeLogLevel
} from './runtime-log-level';
import type { RuntimeLogAccessor } from './runtime-log-settings';
import type { EvidenceHealthReporter } from '../../services/evidence-health/evidence-health-monitor';

/** Stable causes recorded against a suppressed path. */
type SuppressionCause =
  | 'ENOENT-parent'
  | 'EACCES'
  | 'EROFS'
  | 'ENOSPC'
  | 'EIO'
  | 'unknown';

interface AppendFn {
  (target: string, data: string): Promise<void>;
}
interface MkdirFn {
  (target: string, opts: { recursive: true }): Promise<unknown>;
}
// Feature 056 Track 9 — rotation injection points. Each defaults to the
// matching `fs.promises` call in production but is overridable from
// `RuntimeLogSinkDeps` so tests can drive failure modes deterministically.
interface RenameFn {
  (oldPath: string, newPath: string): Promise<void>;
}
interface UnlinkFn {
  (target: string): Promise<void>;
}
interface StatFn {
  (target: string): Promise<{ size: number }>;
}
interface WriteFileFn {
  (target: string, data: string): Promise<void>;
}
interface ReaddirFn {
  (target: string): Promise<readonly string[]>;
}

export interface RuntimeLogSinkDeps {
  readonly accessor: RuntimeLogAccessor;
  readonly fallbackLogger: SanitizedLogger;
  /** Optional injection points used by the unit tests. */
  readonly appendFile?: AppendFn;
  readonly mkdir?: MkdirFn;
  readonly rename?: RenameFn;
  readonly unlink?: UnlinkFn;
  readonly stat?: StatFn;
  readonly writeFile?: WriteFileFn;
  readonly readdir?: ReaddirFn;
  readonly evidenceHealth?: EvidenceHealthReporter;
}

/**
 * Parse the level token out of a formatted SanitizedLogger line. The
 * formatter writes `[<ISO-8601>] <LEVEL> <message>`; we recover the
 * `<LEVEL>` token via the first whitespace after the closing bracket.
 * Returns `null` when the line doesn't look like a SanitizedLogger
 * emission — those lines pass through unfiltered (no sink would have
 * emitted them through this writer, but we tolerate the case).
 */
function extractLevel(line: string): RuntimeLogLevel | null {
  if (!line.startsWith('[')) return null;
  const closeIdx = line.indexOf(']');
  if (closeIdx < 0) return null;
  const after = line.slice(closeIdx + 1).trimStart();
  const spaceIdx = after.indexOf(' ');
  const token = spaceIdx < 0 ? after : after.slice(0, spaceIdx);
  return isRuntimeLogLevel(token) ? token : null;
}

export class RuntimeLogSink implements LogSink {
  private readonly accessor: RuntimeLogAccessor;
  private readonly fallback: SanitizedLogger;
  private readonly appendFile: AppendFn;
  private readonly mkdir: MkdirFn;
  private readonly rename: RenameFn;
  private readonly unlink: UnlinkFn;
  private readonly stat: StatFn;
  private readonly writeFile: WriteFileFn;
  private readonly readdir: ReaddirFn;
  private readonly evidenceHealth?: EvidenceHealthReporter;

  /** Per-path suppression set. A path-cause pair appears at most once. */
  private readonly suppressed: Map<string, Set<SuppressionCause>> = new Map();

  /** In-flight retry guards keyed by absolute path. */
  private readonly retryInFlight: Set<string> = new Set();

  /**
   * Per-path serialization chain. Each new emit appends to the chain
   * for its target path so writes that arrive during an in-flight
   * ENOENT-recovery wait for the recovery to complete before issuing
   * their own appendFile.
   */
  private readonly writeChains: Map<string, Promise<void>> = new Map();

  /**
   * Test-only — collects in-flight write promises so unit/integration
   * tests can deterministically await the sink's fire-and-forget IO.
   * Resolved promises are removed on completion to keep memory bounded.
   */
  private readonly pendingWrites: Set<Promise<void>> = new Set();

  /**
   * Feature 056 Track 9 — accumulated byte tally per path, lazily seeded
   * from `fs.stat` on first emit. The seed runs inside the per-path
   * write chain so concurrent emits wait for the stat to land before
   * computing their rotation decision.
   */
  private readonly bytesOnDisk: Map<string, number> = new Map();
  private readonly bytesSeeded: Set<string> = new Set();

  constructor(deps: RuntimeLogSinkDeps) {
    this.accessor = deps.accessor;
    this.fallback = deps.fallbackLogger;
    this.appendFile = deps.appendFile ?? fs.appendFile;
    this.mkdir = deps.mkdir ?? fs.mkdir;
    this.rename = deps.rename ?? fs.rename;
    this.unlink = deps.unlink ?? fs.unlink;
    this.stat = deps.stat ?? (async (target: string) => {
      const s = await fs.stat(target);
      return { size: s.size };
    });
    this.writeFile = deps.writeFile ?? fs.writeFile;
    this.readdir = deps.readdir ?? (async (target: string) => {
      return fs.readdir(target);
    });
    this.evidenceHealth = deps.evidenceHealth;
  }

  /**
   * Clear the suppression set for a path. Called from the post-save
   * callback so an operator's correction (level change, path change,
   * permission fix, rotation-policy change) gives the next emit a
   * clean retry.
   *
   * Idempotent — missing entries are a no-op. Also drops the lazy
   * `bytesOnDisk` seed for the path so the next emit re-stats the
   * file — important if the operator just rotated / truncated /
   * deleted it out of band.
   */
  public clearSuppression(targetPath: string | null | undefined): void {
    if (!targetPath) return;
    this.suppressed.delete(targetPath);
    this.bytesOnDisk.delete(targetPath);
    this.bytesSeeded.delete(targetPath);
  }

  /**
   * Clear suppression for ALL paths. The post-save callback in
   * `writeGeneralSettings` does not know which path was just saved
   * (the path key is one of many that touch the runtime log), so the
   * callback invokes this variant on any save of a runtime-log key.
   * Idempotent and cheap — at most a handful of paths are tracked.
   */
  public clearAllSuppression(): void {
    this.suppressed.clear();
    this.bytesOnDisk.clear();
    this.bytesSeeded.clear();
  }

  /** Read-only view used by tests. */
  public isSuppressed(targetPath: string, cause?: SuppressionCause): boolean {
    const set = this.suppressed.get(targetPath);
    if (!set) return false;
    return cause === undefined ? set.size > 0 : set.has(cause);
  }

  /**
   * `LogSink.appendLine` — invoked synchronously by SanitizedLogger.
   * Schedules an async write but never throws.
   */
  public appendLine(line: string): void {
    const settings = this.accessor.read();
    if (!settings) {
      this.evidenceHealth?.reportFailure('runtimeLog', 'configuration');
      return;
    }
    const recordLevel = extractLevel(line);
    if (recordLevel && !shouldEmit(recordLevel, settings.level)) return;
    if (this.isSuppressed(settings.path)) return;
    // Serialize writes per target path so emits arriving during an
    // ENOENT-recovery wait for the recovery to land before attempting
    // their own appendFile — prevents data loss under emit bursts.
    const targetPath = settings.path;
    const maxBytes = settings.maxBytes;
    const maxGenerations = settings.maxGenerations;
    const previous = this.writeChains.get(targetPath) ?? Promise.resolve();
    const next = previous.then(() => {
      // Re-check suppression at write time: a prior write in this
      // chain may have just recorded a failure for the same path.
      if (this.isSuppressed(targetPath)) return;
      return this.tryWrite(targetPath, line, maxBytes, maxGenerations);
    });
    this.writeChains.set(targetPath, next);
    this.pendingWrites.add(next);
    void next.finally(() => {
      this.pendingWrites.delete(next);
      if (this.writeChains.get(targetPath) === next) {
        this.writeChains.delete(targetPath);
      }
    });
  }

  /**
   * Await all in-flight `appendFile` (and ENOENT-retry) promises. Used
   * by unit/integration tests to drain the sink without relying on
   * fragile microtask counting. Safe to call from production code too
   * — settles immediately when no writes are pending.
   */
  public async flushPendingWrites(): Promise<void> {
    while (this.pendingWrites.size > 0) {
      await Promise.allSettled(Array.from(this.pendingWrites));
    }
  }

  private async tryWrite(
    targetPath: string,
    line: string,
    maxBytes: number,
    maxGenerations: number
  ): Promise<void> {
    const data = `${line}\n`;
    // Why the ASCII fast path: the module header documents this as a
    // ~10^4-emits-per-long-run hot path, and SanitizedLogger output is
    // overwhelmingly 7-bit ASCII (ISO timestamp + LEVEL token + sanitized
    // message — secrets have already been redacted to `<REDACTED>`).
    // For pure-ASCII strings the UTF-8 byte count equals `string.length`,
    // so we can skip the native Buffer.byteLength call on the common
    // case. The non-ASCII branch falls back to the exact computation.
    const dataBytes = isAscii(data) ? data.length : Buffer.byteLength(data, 'utf8');

    // Feature 056 Track 9 — seed bytesOnDisk lazily. On first emit for
    // a path we stat the file; ENOENT is benign (the file may not yet
    // exist). Any other stat error suppresses the path.
    if (!this.bytesSeeded.has(targetPath)) {
      try {
        const { size } = await this.stat(targetPath);
        this.bytesOnDisk.set(targetPath, size);
      } catch (err) {
        const code = errnoCode(err);
        if (code === 'ENOENT') {
          this.bytesOnDisk.set(targetPath, 0);
        } else {
          this.recordSuppression(targetPath, mapSuppressionCause(code));
          return;
        }
      }
      this.bytesSeeded.add(targetPath);
    }

    const currentBytes = this.bytesOnDisk.get(targetPath) ?? 0;
    // Why `>` and not `>=`: the operator setting is documented as
    // "rotate when the file would exceed maxBytes" — i.e. the file
    // is allowed to grow up to and including `maxBytes`, and rotation
    // fires only when the next write would push it past that ceiling.
    // The previous `>=` rotated a single emit earlier and produced an
    // effective per-generation cap of `maxBytes - dataBytes` on every
    // rollover, which is off-by-one against the documented contract
    // and against operator expectations. The new line size still wins
    // the rotation race when it alone exceeds maxBytes (currentBytes
    // = 0, dataBytes > maxBytes), preserving the degenerate-but-
    // correct behavior under a misconfigured cap.
    const wouldOverflow = currentBytes + dataBytes > maxBytes;

    if (wouldOverflow) {
      if (maxGenerations === 0) {
        // Operator opted out of rotation; truncate in place. The new
        // line is the only content after this call.
        const ok = await this.writeFileWithEnoentRecovery(targetPath, data);
        if (ok) {
          this.bytesOnDisk.set(targetPath, dataBytes);
        }
        return;
      }
      // Rotate: path → path.1, path.1 → path.2, ..., drop the oldest.
      // ENOENT during the shift is benign (the file simply hasn't
      // been created yet); any other failure suppresses the path so
      // we don't keep retrying a doomed rename loop.
      const rotated = await this.rotateGenerations(targetPath, maxGenerations);
      if (!rotated) return;
      const ok = await this.writeFileWithEnoentRecovery(targetPath, data);
      if (ok) {
        this.bytesOnDisk.set(targetPath, dataBytes);
      }
      return;
    }

    try {
      await this.appendFile(targetPath, data);
      this.bytesOnDisk.set(targetPath, currentBytes + dataBytes);
      return;
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT') {
        if (this.retryInFlight.has(targetPath)) {
          // A concurrent emit arrived while the first ENOENT-recovery
          // is still in flight. The recovery promise will fix the
          // parent dir; this emit is dropped silently (no suppression)
          // so the next emit after recovery can proceed normally.
          //
          // Emit ONE DEBUG diagnostic per dropped emit so an operator
          // troubleshooting a "missing log lines" report can spot the
          // race in the runtime log. The diagnostic itself flows back
          // through the SanitizedLogger → sink chain; the per-path
          // write chain at `appendLine` re-queues it after the in-flight
          // recovery completes, so the diagnostic lands on disk
          // exactly like any other DEBUG line. WARN would be the wrong
          // severity — the drop is benign (the recovery is fixing the
          // missing parent dir), and one WARN per concurrent emit
          // would overwhelm the operator on a burst.
          this.fallback.debug(
            'runtime-log-sink: emit dropped during ENOENT recovery (concurrent retry in flight)'
          );
          return;
        }
        this.retryInFlight.add(targetPath);
        try {
          await this.mkdir(path.dirname(targetPath), { recursive: true });
          await this.appendFile(targetPath, data);
          // The parent directory was just created, so the file is fresh
          // after this appendFile — its on-disk size is exactly
          // `dataBytes`, not `currentBytes + dataBytes`. Reusing the
          // pre-recovery `currentBytes` would double-count any seed
          // value left over from a now-vanished file, which would in
          // turn trip rotation prematurely on the very next emit.
          this.bytesOnDisk.set(targetPath, dataBytes);
          return;
        } catch {
          // Any failure inside the ENOENT recovery path collapses to the
          // synthetic 'ENOENT-parent' cause — the parent directory could
          // not be made writable.
          this.recordSuppressionDirect(targetPath, 'ENOENT-parent');
          return;
        } finally {
          this.retryInFlight.delete(targetPath);
        }
      }
      this.recordSuppression(targetPath, mapSuppressionCause(code));
    }
  }

  /**
   * Single source of truth for the `writeFile + ENOENT-recovery + suppress`
   * pattern. Used by both the `maxGenerations === 0` truncate-in-place
   * branch and the post-rotation fresh-file write — those two call sites
   * had drifted into byte-identical duplicates. Returns false on any
   * failure (path is then suppressed; the suppression callback already
   * emits a WARN, so the caller does not need to log again).
   *
   * NOT used by the `tryWrite` appendFile path: that path carries an
   * additional `retryInFlight` concurrency guard that is meaningfully
   * different from this helper's semantics. Merging the two would
   * either weaken the appendFile guard or over-abstract this helper.
   */
  private async writeFileWithEnoentRecovery(
    targetPath: string,
    data: string
  ): Promise<boolean> {
    try {
      await this.writeFile(targetPath, data);
      return true;
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT') {
        try {
          await this.mkdir(path.dirname(targetPath), { recursive: true });
          await this.writeFile(targetPath, data);
          return true;
        } catch {
          this.recordSuppressionDirect(targetPath, 'ENOENT-parent');
          return false;
        }
      }
      this.recordSuppression(targetPath, mapSuppressionCause(code));
      return false;
    }
  }

  /**
   * Shift generations: `path.<N-1>` → `path.<N>`, …, `path.1` → `path.2`,
   * `path` → `path.1`, drop `path.<N+1>` if it survived a prior shift.
   * ENOENT during any rename is benign (the slot is empty); anything
   * else suppresses the path. Returns true on success.
   *
   * On partial failure the path is suppressed via `tolerantRename` →
   * `recordSuppression` (generic "append failed" WARN). We ALSO emit a
   * dedicated rotation-step WARN here so an operator inspecting the
   * fallback log can distinguish a rotation rename failure (likely
   * permissions on `path.<N>` files) from a plain append failure
   * (likely permissions on the live log file). The dedicated WARN
   * fires once per rotation attempt — the suppression map then
   * dedupes the follow-on "append failed" emit.
   */
  private async rotateGenerations(
    targetPath: string,
    maxGenerations: number
  ): Promise<boolean> {
    // Shift from oldest to newest so a slot is always free before we
    // rename into it.
    for (let i = maxGenerations - 1; i >= 1; i--) {
      const from = `${targetPath}.${i}`;
      const to = `${targetPath}.${i + 1}`;
      const ok = await this.tolerantRename(targetPath, from, to);
      if (!ok) {
        this.fallback.warn(
          `runtime-log-sink: rotation step ${i}→${i + 1} failed; triggering log line dropped, path suppressed until settings change.`
        );
        return false;
      }
    }
    const renamedHead = await this.tolerantRename(
      targetPath,
      targetPath,
      `${targetPath}.1`
    );
    if (!renamedHead) {
      this.fallback.warn(
        'runtime-log-sink: rotation head→.1 failed; triggering log line dropped, path suppressed until settings change.'
      );
      return false;
    }
    // Drop the oldest generation if it survived the shift. A stale
    // file beyond maxGenerations was rotated up by the loop above to
    // `path.<maxGenerations + 1>` — unlink it.
    await this.tolerantUnlink(targetPath, `${targetPath}.${maxGenerations + 1}`);
    // Sweep any stale generations beyond the current cap that the
    // shift loop didn't touch (operator lowered `maxGenerations` after
    // earlier rotations had already populated higher slots). Without
    // this sweep those files leak forever. Bounded by readdir output,
    // best-effort — failures are swallowed so a wedged readdir cannot
    // block the next emit.
    await this.sweepStaleGenerations(targetPath, maxGenerations);
    return true;
  }

  /**
   * Unlink any `path.<n>` for n > maxGenerations. Called from the tail
   * of `rotateGenerations`. Bounded by the directory's actual file
   * count (typically a handful); best-effort — readdir/unlink failures
   * are swallowed so the rotation that triggered the sweep still
   * succeeds.
   */
  private async sweepStaleGenerations(
    targetPath: string,
    maxGenerations: number
  ): Promise<void> {
    const dir = path.dirname(targetPath);
    const baseName = path.basename(targetPath);
    const prefix = `${baseName}.`;
    let entries: readonly string[];
    try {
      entries = await this.readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.startsWith(prefix)) continue;
      const suffix = name.slice(prefix.length);
      if (suffix.length === 0) continue;
      // Only sweep purely-numeric suffixes that exceed the cap.
      // Non-numeric suffixes (e.g. `.bak`, `.old.2024-01-01`) belong
      // to the operator and are NEVER touched.
      if (!/^\d+$/.test(suffix)) continue;
      const n = Number(suffix);
      if (!Number.isInteger(n) || n <= maxGenerations) continue;
      try {
        await this.unlink(path.join(dir, name));
      } catch {
        // Best-effort — the next rotation will retry.
      }
    }
  }

  /**
   * Rename helper that swallows ENOENT (benign — the source slot is
   * empty) and suppresses the target path on any other failure.
   */
  private async tolerantRename(
    targetPath: string,
    from: string,
    to: string
  ): Promise<boolean> {
    try {
      await this.rename(from, to);
      return true;
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT') return true;
      this.recordSuppression(targetPath, mapSuppressionCause(code));
      return false;
    }
  }

  /**
   * Unlink helper that swallows ENOENT and silently logs no other
   * errors — the oldest generation is best-effort cleanup.
   */
  private async tolerantUnlink(
    _targetPath: string,
    victim: string
  ): Promise<void> {
    try {
      await this.unlink(victim);
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT') return;
      // Best-effort — the file will be overwritten on the next
      // rotation cycle. We deliberately do NOT suppress the path
      // here, since the rotation itself succeeded.
    }
  }

  private recordSuppression(targetPath: string, code: string): void {
    this.recordSuppressionDirect(targetPath, mapSuppressionCause(code));
  }

  private recordSuppressionDirect(
    targetPath: string,
    cause: SuppressionCause
  ): void {
    let set = this.suppressed.get(targetPath);
    if (!set) {
      set = new Set();
      this.suppressed.set(targetPath, set);
    }
    if (set.has(cause)) return;
    set.add(cause);
    const shouldWarn = this.evidenceHealth?.reportFailure('runtimeLog', cause) ?? true;
    // One WARN per (path, cause) pair via the fallback logger.
    if (shouldWarn) {
      this.fallback.warn(
        `runtime-log-sink: append failed for path (${cause}); suppressing until settings change.`
      );
    }
  }
}

/**
 * Hot-path ASCII detector. Returns true when every code unit is in the
 * 7-bit range, which guarantees the UTF-8 byte length equals the JS
 * string length (each code unit is a single ASCII byte). The check
 * short-circuits on the first non-ASCII unit; for the common all-ASCII
 * case it visits every character once with a single integer comparison.
 *
 * Why not a regex (e.g. /^[\x00-\x7F]*$/): regex engines walk the same
 * characters but with substantially more overhead per call (allocation,
 * VM dispatch). A tight integer loop is the fastest portable option and
 * keeps the sink dependency-free.
 */
function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

function errnoCode(err: unknown): string | null {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

function mapSuppressionCause(code: string | null): SuppressionCause {
  switch (code) {
    case 'ENOENT':
      return 'ENOENT-parent';
    case 'EACCES':
    case 'EPERM':
      return 'EACCES';
    case 'EROFS':
      return 'EROFS';
    case 'ENOSPC':
      return 'ENOSPC';
    case 'EIO':
      return 'EIO';
    default:
      return 'unknown';
  }
}
