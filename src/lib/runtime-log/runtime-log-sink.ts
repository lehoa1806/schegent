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
//
// Feature FR-R3-005 (T329) — every mutation below is contained at the point
// of effect. Feature 098's SEC-03 narrowed the allowed roots to workspace,
// `globalStorageUri` and OS temp, and `runtime-log-path.ts` compares them
// lexically; a lexical comparison cannot see a symlink, so the narrowed list
// bounds the blast radius but does not establish containment. This file is
// where the syscalls are, so this is where the oracle is consulted. The roots
// arrive through `containmentRoots` and are NOT re-derived here — the accessor
// and the sink must agree on what "allowed" means or one of them is enforcing
// a different policy from the other.
//
// Feature 217 (FR-004, FR-005) — owner-only. With a containment layer, which
// production always supplies, every open this sink makes declares
// `RUNTIME_LOG_FILE_MODE` and `RUNTIME_LOG_DIR_MODE`: the append, and the
// successor or truncate a rollover leaves at the live path. The open narrows a
// log or directory an earlier release left wider, and the generations beside
// it are narrowed where they lie once per destination, because a rename keeps
// the mode a file was born with. The ENOENT retry above is the rootless
// branch's: the walk creates a missing parent itself.

import * as fs from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import * as path from 'path';

import {
  resolveContainedForWrite,
  resolveContainedLink,
  type ContainmentVerdict
} from '../path-containment';
import { listGenerations, NarrowingReporter, narrowRotatedFiles } from '../evidence-narrowing';
import { openWithinRootByPath, type SafeOpenRefusal } from '../safe-open';
import type { LogSink, SanitizedLogger } from '../logger';
import { HeldAppendHandles } from './held-append-handles';
import {
  isRuntimeLogLevel,
  shouldEmit,
  type RuntimeLogLevel
} from './runtime-log-level';
import type { RuntimeLogAccessor } from './runtime-log-settings';
import type { EvidenceHealthReporter } from '../../services/evidence-health/evidence-health-monitor';

/**
 * Feature 217 (FR-004) — owner-only. Before this, the append open and the
 * rollover's successor both declared no mode, so a 022 umask gave every local
 * account read access to the host's log.
 */
const RUNTIME_LOG_FILE_MODE = 0o600;
const RUNTIME_LOG_DIR_MODE = 0o700;

/** Stable causes recorded against a suppressed path. */
type SuppressionCause =
  | 'ENOENT-parent'
  | 'EACCES'
  | 'EROFS'
  | 'ENOSPC'
  | 'EIO'
  | 'unknown'
  // Feature FR-R3-005 (T329) — a refused path belongs in the suppression map
  // for the same reason a permission failure does: retrying it every emit
  // achieves nothing, and an operator's correction to the setting is what
  // should unlock it. The two are reported apart, though, because they mean
  // opposite things — one says the write failed, the other says it never ran.
  | 'not-contained'
  | 'resolve-failed';

/**
 * FR-R3-080 (T1064) — the checked walk's refusal vocabulary, mapped onto the
 * suppression causes this sink already reports.
 *
 * Deliberately lossy in one direction only: every walk refusal that means "this
 * path is not somewhere I may write" becomes `not-contained`, and every one that
 * means "I could not find out" becomes `resolve-failed`. The distinction the
 * union's own comment draws — the write failed vs. it never ran — is what has to
 * survive, and both arms of this map are on the "never ran" side.
 */
function mapSafeOpenRefusal(reason: SafeOpenRefusal): SuppressionCause {
  // FR-R3-083 — `reparse-point-leaf` sits with the two symlink refusals, not in
  // `default`. It is the Windows leaf check standing in for the `O_NOFOLLOW`
  // that platform does not have (`docs/architecture/native-binding-decision.md`),
  // so it answers the same question `symlink-leaf` answers by a weaker route: the
  // path is not somewhere this sink may write. Left in `default` it reported
  // "I could not find out", which is the one thing the walk did in fact find out.
  switch (reason) {
    case 'escapes-root':
    case 'symlink-component':
    case 'symlink-leaf':
    case 'reparse-point-leaf':
    case 'not-a-directory':
    case 'not-a-regular-file':
      return 'not-contained';
    default:
      return 'resolve-failed';
  }
}

/** The refusal causes, so the WARN text can distinguish them from failures. */
const CONTAINMENT_CAUSES: ReadonlySet<SuppressionCause> = new Set([
  'not-contained',
  'resolve-failed'
]);

interface AppendFn {
  (target: string, data: string): Promise<void>;
}
interface MkdirFn {
  (target: string, opts: { recursive: true; mode?: number }): Promise<unknown>;
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
  /**
   * Optional injection points used by the unit tests. With `containmentRoots`
   * supplied, the append and the rollover's successor open through the checked
   * walk, and `appendFile`, `writeFile` and `mkdir` serve only the rootless
   * branch below.
   */
  readonly appendFile?: AppendFn;
  readonly mkdir?: MkdirFn;
  readonly rename?: RenameFn;
  readonly unlink?: UnlinkFn;
  readonly stat?: StatFn;
  readonly writeFile?: WriteFileFn;
  readonly readdir?: ReaddirFn;
  readonly evidenceHealth?: EvidenceHealthReporter;
  /**
   * Feature FR-R3-005 (T329) — the roots this sink may mutate inside, read
   * fresh on every check because the workspace root can change under a host
   * that outlives one folder.
   *
   * Optional so the sink's existing unit tests, which drive rotation against
   * injected doubles rather than a real filesystem, keep constructing it with
   * two arguments. Omitting it means "no containment layer", which is what
   * those tests already had; production MUST supply it, and
   * `tests/lint/destructive-fs-requires-containment.test.ts` fails the build
   * if `backend-wiring.ts` stops doing so. An empty array is not the same
   * thing — the oracle refuses everything against it, which is the correct
   * fail-closed reading of "nothing is allowed" and the wrong reading of
   * "this is a test double".
   */
  readonly containmentRoots?: () => readonly string[];
  /** The oracle's own seam, on the same optional terms. */
  readonly realpath?: (target: string) => Promise<string>;
  /** Feature 218 (FR-003) — the release's drain bound; omitted, the module's default applies. */
  readonly drainGraceMs?: number;
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

  private readonly containmentRoots?: () => readonly string[];
  private readonly containmentFs: { realpath(target: string): Promise<string> };

  /**
   * Feature FR-R3-005 (T329) — the append path's verdict, cached per target
   * path.
   *
   * The append path is the ~10⁴-emits-per-run hot path the module header
   * describes, and an uncached check adds a `realpath` syscall to every line.
   * The cache is dropped by `clearSuppression` / `clearAllSuppression`, which
   * is exactly when the target can have changed by any route the sink knows
   * about: an operator editing the path, the level, or the rotation policy.
   *
   * Rotation's renames and unlinks are deliberately NOT cached. They are the
   * destructive half, they run once per rollover rather than once per line, so
   * the syscall does not matter, and each names a different generation file
   * from the one the append proved.
   *
   * This is risk reduction, not a guarantee: a target replaced mid-run with no
   * accompanying settings change keeps its cached verdict until the next
   * clear. Shrinking that window further means paying `realpath` per line.
   */
  private readonly containmentCache: Map<string, ContainmentVerdict> = new Map();

  /**
   * FR-R3-080 (T1064) — the append path's descriptors, held per target path, and
   * feature 218's release of them. `held-append-handles.ts` says why both.
   */
  private readonly appendHandles: HeldAppendHandles;

  /** Feature 218 (FR-002) — set by `flushAndDispose`; from then on every new line is refused. */
  private closed = false;

  /** Feature 217 (FR-003, data-model.md §2) — says once, path-free, what narrowing found. */
  private readonly narrowing = new NarrowingReporter('runtime-log-sink:', (message) =>
    this.fallback.warn(message)
  );

  /**
   * Feature 217 (FR-005) — destinations whose generations have been narrowed.
   *
   * Once per destination is enough: the generations an earlier release left
   * widened are narrowed the first time this sink opens the destination, and
   * every generation after that is a file this sink created or narrowed, renamed.
   */
  private readonly generationsNarrowed: Set<string> = new Set();

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
    this.containmentRoots = deps.containmentRoots;
    this.containmentFs = { realpath: deps.realpath ?? fs.realpath };
    this.appendHandles = new HeldAppendHandles(
      (message) => this.fallback.warn(`runtime-log-sink: ${message}`),
      deps.drainGraceMs
    );
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
    // Feature FR-R3-005 (T329) — the cached containment verdict goes with the
    // byte seed, and for the same reason: the operator may have just repointed
    // the path at something else.
    this.containmentCache.delete(targetPath);
    void this.appendHandles.close(targetPath);
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
    this.containmentCache.clear();
    this.appendHandles.closeAll();
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
    // Feature 218 (FR-002) — check 1: a released writer reads no settings and reports nothing.
    if (this.closed) return;
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

  /**
   * Feature 218 (FR-001 to FR-008) — the release: refuse every new line now,
   * then let `HeldAppendHandles.release` bound the drain and close every
   * descriptor. Not `async`, so every call receives the same promise.
   */
  public flushAndDispose(): Promise<void> {
    this.closed = true;
    return this.appendHandles.release(() => this.flushPendingWrites());
  }

  /** Feature 218 (FR-009) — the descriptors held now, read from the writer's own record. */
  public get openDescriptorCount(): number {
    return this.appendHandles.size;
  }

  /**
   * The containment layer, or `null` when this sink was built without one.
   * Returning `null` rather than a permissive verdict keeps the two states
   * distinguishable at every call site: "proven contained" and "never asked"
   * must not collapse into one branch.
   */
  private roots(): readonly string[] | null {
    return this.containmentRoots ? this.containmentRoots() : null;
  }

  /**
   * Prove the append target, once per path until the next suppression clear.
   * Records the refusal and returns false so the caller drops the line.
   */
  private async appendTargetIsContained(targetPath: string): Promise<boolean> {
    const roots = this.roots();
    if (!roots) return true;
    let verdict = this.containmentCache.get(targetPath);
    if (!verdict) {
      verdict = await resolveContainedForWrite(targetPath, roots, this.containmentFs);
      this.containmentCache.set(targetPath, verdict);
    }
    if (verdict.outcome === 'contained') return true;
    if (verdict.outcome === 'refused') {
      this.recordSuppressionDirect(targetPath, verdict.reason);
    }
    return false;
  }

  /**
   * FR-R3-080 (T1064) — the append descriptor for `targetPath`, opened through
   * the checked walk (`openRooted`) and held until the target's identity can
   * change.
   */
  private async appendHandleFor(targetPath: string): Promise<FileHandle | null> {
    const roots = this.roots();
    if (!roots) return null;
    // The roots are read FRESH on every append, exactly as they were before the
    // descriptor was held: a workspace folder can change under a host that
    // outlives it, and a handle proved against the old set must not keep
    // admitting writes under the new one. The held descriptor removes the
    // check-to-use window; it does not license inheriting an admission.
    return this.appendHandles.acquire(targetPath, roots, () =>
      this.openRooted(targetPath, roots, 'a')
    );
  }

  /**
   * FR-R3-080 (T1064) — open `targetPath` through the checked walk.
   *
   * The root is CHOSEN by trying each configured containment root in turn: the
   * walk answers `escapes-root` for a root the path does not sit under, and
   * succeeds for the one it does. Roots are one or two in practice, and letting
   * the walk decide is what keeps the selection from becoming a second, lexical
   * containment rule of its own.
   *
   * Feature 217 — every open this sink makes, the append and the rollover's
   * successor alike, comes through here with both modes declared; what the
   * open narrowed is said once, and the destination's generations are narrowed
   * the first time it is opened. A refusal is recorded here, so `null` means
   * the caller drops the line and says nothing more.
   */
  private async openRooted(
    targetPath: string,
    roots: readonly string[],
    flags: 'a' | 'w'
  ): Promise<FileHandle | null> {
    for (const root of roots) {
      const opened = await openWithinRootByPath(root, targetPath, {
        flags,
        createDirs: true,
        dirMode: RUNTIME_LOG_DIR_MODE,
        fileMode: RUNTIME_LOG_FILE_MODE
      });
      if (opened.outcome === 'opened') {
        this.narrowing.report(opened.narrowing);
        await this.narrowGenerationsOnce(targetPath, roots);
        return opened.handle;
      }
      if (opened.reason === 'escapes-root') continue;
      // A real refusal against a root this path DOES sit under: record it and
      // stop, rather than letting a later root's `escapes-root` mask it.
      this.recordSuppressionDirect(targetPath, mapSafeOpenRefusal(opened.reason));
      return null;
    }
    this.recordSuppressionDirect(targetPath, 'not-contained');
    return null;
  }

  /**
   * Feature 217 (FR-004, FR-005) — narrow the generations beside `targetPath`
   * where they lie. A rotation renames, and a rename keeps the mode, so the
   * generations a widened live log was rotated into are widened too, and no
   * open ever reaches them. A first emit that overflows rotates the widened
   * live log before any open has narrowed it, which is why this runs after the
   * successor's open as well as the append's.
   *
   * Only after an open through the walk succeeded, so a refused destination is
   * never touched; and only what the stale-generation sweep would also call a
   * generation, so an operator's `<live>.bak` keeps its mode.
   *
   * Marked before the listing, so opens that overlap list once; unmarked when
   * the directory could not be listed, so the next open lists again rather than
   * leaving the generations widened for the life of the sink. The append handle
   * is held, so the next open is usually a rotation's successor.
   */
  private async narrowGenerationsOnce(
    targetPath: string,
    roots: readonly string[]
  ): Promise<void> {
    if (this.generationsNarrowed.has(targetPath)) return;
    this.generationsNarrowed.add(targetPath);
    const generations = await listGenerations(targetPath, this.readdir);
    if (generations === null) {
      this.generationsNarrowed.delete(targetPath);
      return;
    }
    this.narrowing.report(
      await narrowRotatedFiles(generations, RUNTIME_LOG_FILE_MODE, roots, this.containmentFs)
    );
  }

  /**
   * The file a rollover leaves at the live path: the successor after a shift,
   * or the live log itself, truncated, when no generations are kept.
   *
   * Feature 217 (FR-005) — with a containment layer, through the checked walk
   * with both modes declared, exactly like the append. It used to be
   * `writeFile` on the pathname with no mode, so every file a rotation created
   * was the umask's to decide, and a truncate kept whatever mode it found. Not
   * held afterwards: the next emit opens its own append descriptor, as it
   * always has. Without a containment layer the injected port stands in, for
   * the reason it does for the append.
   */
  private async writeSuccessor(targetPath: string, data: string): Promise<boolean> {
    const roots = this.roots();
    if (roots === null) return this.writeFileWithEnoentRecovery(targetPath, data);
    const handle = await this.openRooted(targetPath, roots, 'w');
    if (handle === null) return false;
    try {
      await handle.write(data, null, 'utf8');
      return true;
    } catch (err) {
      this.recordSuppressionDirect(targetPath, mapSuppressionCause(errnoCode(err)));
      return false;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * Prove a generation file this rotation is about to rename or unlink.
   * Uncached and link-form: `rename` and `unlink` act on the directory entry
   * and follow neither end, so resolving the leaf would refuse the removal of
   * a link the host itself put there.
   */
  private async rotationPathIsContained(
    targetPath: string,
    generation: string
  ): Promise<boolean> {
    const roots = this.roots();
    if (!roots) return true;
    const verdict = await resolveContainedLink(generation, roots, this.containmentFs);
    if (verdict.outcome === 'contained') return true;
    if (verdict.outcome === 'refused') {
      // Suppressed against the live path, not the generation file: the live
      // path is the one the operator configured and the one the next emit
      // will consult, and a rotation that cannot be proven safe must not be
      // retried on every subsequent line.
      this.recordSuppressionDirect(targetPath, verdict.reason);
    }
    return false;
  }

  private async tryWrite(
    targetPath: string,
    line: string,
    maxBytes: number,
    maxGenerations: number
  ): Promise<void> {
    // Feature 218 (FR-004) — check 2: a queued line whose chain resumed after the close step.
    if (this.appendHandles.isReleased()) return;
    // Before the stat, so a refused path costs one resolution and not a
    // syscall against a location the host was never allowed to look at.
    if (!(await this.appendTargetIsContained(targetPath))) return;
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
      // FR-R3-080 (T1064) — drop the held descriptor before either branch. A
      // rotation renames this file and a truncate replaces its contents; a
      // descriptor held across either would follow the inode into the rotated
      // generation and append there forever.
      await this.appendHandles.close(targetPath);
      if (maxGenerations === 0) {
        // Operator opted out of rotation; truncate in place. The new
        // line is the only content after this call.
        const ok = await this.writeSuccessor(targetPath, data);
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
      const ok = await this.writeSuccessor(targetPath, data);
      if (ok) {
        this.bytesOnDisk.set(targetPath, dataBytes);
      }
      return;
    }

    try {
      // FR-R3-080 (T1064) — the append goes to the DESCRIPTOR the walk produced,
      // not to the pathname a verdict once approved. When this sink was built
      // without a containment layer at all there is no root to walk from, and
      // the injected port stands in — the same "proven contained" vs. "never
      // asked" distinction `roots()` keeps everywhere else in this file.
      // Feature 218 (FR-004) — check 2b: the close step may have run during the awaits above.
      if (this.appendHandles.isReleased()) return;
      const handle = this.roots() === null ? null : await this.appendHandleFor(targetPath);
      if (this.roots() !== null && handle === null) return;
      if (handle === null) await this.appendFile(targetPath, data);
      else await handle.write(data, null, 'utf8');
      this.bytesOnDisk.set(targetPath, currentBytes + dataBytes);
      return;
    } catch (err) {
      // The held descriptor is dropped on ANY write failure: the next emit
      // re-walks rather than retrying a handle whose file may have been
      // unlinked, rotated or filled.
      await this.appendHandles.close(targetPath);
      const code = errnoCode(err);
      // Feature 217 — the recovery is the rootless branch's. It re-creates the
      // parent and appends by name, which with a containment layer would be a
      // write the walk never proved, at a mode the walk never declared; and a
      // write to a descriptor the walk opened cannot meet a missing parent, so
      // a rooted failure is recorded like any other.
      // Feature 218 (FR-004) — check 6: no recovery opens anything after the close step.
      if (code === 'ENOENT' && this.roots() === null && !this.appendHandles.isReleased()) {
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
          await this.mkdir(path.dirname(targetPath), { recursive: true, mode: RUNTIME_LOG_DIR_MODE });
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
      this.recordSuppressionDirect(targetPath, mapSuppressionCause(code));
    }
  }

  /**
   * Single source of truth for the `writeFile + ENOENT-recovery + suppress`
   * pattern. Used by both the `maxGenerations === 0` truncate-in-place
   * branch and the post-rotation fresh-file write — those two call sites
   * had drifted into byte-identical duplicates. Feature 217 — reached only
   * from `writeSuccessor`'s rootless branch. Returns false on any
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
          await this.mkdir(path.dirname(targetPath), { recursive: true, mode: RUNTIME_LOG_DIR_MODE });
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
      const victim = path.join(dir, name);
      // The sweep runs over whatever `readdir` returned, so its entries were
      // never named by the operator and never proved by the append check.
      if (!(await this.rotationPathIsContained(targetPath, victim))) continue;
      try {
        await this.unlink(victim);
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
    // Both ends. A rename whose source is contained and whose destination is
    // not moves a file out of the allowed roots just as surely as the reverse
    // moves one in.
    if (!(await this.rotationPathIsContained(targetPath, from))) return false;
    if (!(await this.rotationPathIsContained(targetPath, to))) return false;
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
    targetPath: string,
    victim: string
  ): Promise<void> {
    if (!(await this.rotationPathIsContained(targetPath, victim))) return;
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
    // FR-R3-080 (T1075) — a containment refusal reaches evidence health as a
    // refusal, so the phase runner can surface it at phase end. The failure
    // causes keep their own codes: "the write went wrong" and "the write never
    // ran" are different facts and an operator acts on them differently.
    if (CONTAINMENT_CAUSES.has(cause)) {
      this.evidenceHealth?.reportFailure('runtimeLog', 'path-refused');
    }
    let set = this.suppressed.get(targetPath);
    if (!set) {
      set = new Set();
      this.suppressed.set(targetPath, set);
    }
    if (set.has(cause)) return;
    set.add(cause);
    const shouldWarn = this.evidenceHealth?.reportFailure('runtimeLog', cause) ?? true;
    // One WARN per (path, cause) pair via the fallback logger. The refusal
    // causes get their own sentence: "append failed" sends an operator looking
    // at permissions, and the finding here is that the configured path does
    // not resolve where it claims to, which is a different thing to fix. The
    // path itself is never in the line — the cause is bounded, and a refused
    // path is precisely the string that would name a location outside the
    // allowed roots.
    if (shouldWarn) {
      this.fallback.warn(
        CONTAINMENT_CAUSES.has(cause)
          ? `runtime-log-sink: refused to write outside the allowed roots (${cause}); suppressing until settings change.`
          : `runtime-log-sink: append failed for path (${cause}); suppressing until settings change.`
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
