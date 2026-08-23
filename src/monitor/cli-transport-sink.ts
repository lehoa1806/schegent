// Feature FR-R3-007 (T355, T356, T357) — where the CLI's own output goes now
// that it no longer goes into the structured audit log.
//
// The finding this closes (blueprint DATA-01) is a ratio, not a leak.
// `monitor-stdout-line` wrote one audit entry per line of CLI stdout and
// nothing in the product ever read one back, so 93.2% of `audit.log` was a
// write-only duplicate of content the CLI had already emitted. The audit log's
// retention budget is what bounds the metrics horizon, so spending it on
// transport capped that horizon at roughly forty runs.
//
// The distinction this file exists to hold is the same one the fatal-signature
// registry draws: `audit.log` records what Schegent *did*, and a line of stdout
// is content Schegent was merely *transporting*. Removing the writer without a
// destination would have been silent loss — operators do read those lines — so
// the content moves here rather than disappearing.
//
// What this sink is NOT: it is not the audit writer, and nothing about it is
// durable. Three properties follow, and each is deliberate:
//
//   - **Best-effort.** A write failure warns once per (path, cause) and the
//     phase continues, matching `verbose-diagnostic-writer` rather than the
//     audit writer. Transport capture is a convenience for reading a run back;
//     failing a phase because a log line could not be appended would trade a
//     real outcome for a diagnostic one.
//   - **Bounded by its own rotation.** `CLI_TRANSPORT_MAX_BYTES` per
//     generation and `CLI_TRANSPORT_MAX_GENERATIONS` behind the live file, so
//     the ceiling is fixed and, critically, independent of the audit log's.
//     The whole point of the split is that this file's growth can no longer
//     evict a metrics event.
//   - **Sanitized.** Every line passes through the injected sanitizer, which is
//     `SanitizedLogger.sanitize` and therefore the one `SECRET_PATTERNS` set.
//     The sink applies it itself rather than trusting callers to: a per-line
//     write is exactly the kind of hot loop where a second call site would
//     forget.
//
// Paths are a different matter from secrets. The audit log refuses to carry a
// workspace path at all (`PATH_OR_ENDPOINT_RE` in `audit-payload.ts`), and that
// rule is unchanged by this feature. This file is not the audit log: raw CLI
// output names the files the CLI touched, and stripping those would leave a
// record no operator could use. The sanitized-but-path-bearing posture is the
// same one the runtime log already has.
//
// Record format, one physical line per record:
//
//   <ISO-8601>\t<runId>\t<phase>\t<stream>\t<sanitized line>
//
// Tab-separated with the content last, so `cut -f5-` recovers the CLI's own
// bytes and `jq` still works on a stream-json run. A record is one line because
// the monitor split the stream on `\n` before calling; the line content is
// otherwise written through untouched, and no per-line truncation is applied.
// Bounding the *line* is what cost the audit log 7046 of 7452 lines from one
// run on 2026-08-16 (see `AUDIT_PAYLOAD_TRUNCATION_MARKER`); here the bound is
// the file, which is the only bound that does not lose the informative lines.
//
// Feature FR-R3-005's containment rule applies in full: rotation renames and
// unlinks are proven against the workspace root through the one oracle in
// `src/lib/path-containment.ts` before they run.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { KeyBlockLineRedactor } from '../lib/logger';
import type { SanitizedLogger } from '../lib/logger';
import {
  resolveContainedForWrite,
  resolveContainedLink,
  type ContainmentVerdict
} from '../lib/path-containment';

/** Directory the sink writes inside, relative to the workspace root. */
export const CLI_TRANSPORT_DIRECTORY = '.schegent';

/** The live file. Generations are `<name>.1` … `<name>.N` beside it. */
export const CLI_TRANSPORT_FILE_NAME = 'cli-transport.log';

/**
 * Per-generation ceiling, matching the runtime log's default. With
 * `CLI_TRANSPORT_MAX_GENERATIONS` behind the live file the whole sink is
 * bounded at 20 MiB per workspace.
 *
 * Code-resident on purpose. Making these operator settings would put transport
 * capture on the same `schegent.logging.*` surface that gates the audit log's
 * rotation, and an operator raising one would then be able to starve the other
 * — which is the coupling this feature exists to remove. The accessor below is
 * the seam where a future setting would plug in, and it is read per emit
 * precisely so nothing here can become a cached field.
 */
export const CLI_TRANSPORT_MAX_BYTES = 5 * 1024 * 1024;

/** Generations retained behind the live file. */
export const CLI_TRANSPORT_MAX_GENERATIONS = 3;

/** Which of the CLI's two streams a record came from. */
export type CliTransportStream = 'stdout' | 'stderr';

/**
 * One line of CLI output, attributed to the Run that produced it.
 *
 * `line` is the raw line as the CLI emitted it. Sanitization happens inside the
 * sink, so a caller cannot forget it.
 */
export interface CliTransportRecord {
  readonly runId: string;
  readonly phase: string;
  readonly stream: CliTransportStream;
  readonly line: string;
}

/**
 * The seam the monitor holds. Narrow by design: the monitor's only business
 * with transport is handing over a line, and a test double is one method.
 */
export interface CliTransportRecorder {
  record(entry: CliTransportRecord): void;
}

/** Everything a single emit needs to decide where to write and when to rotate. */
export interface CliTransportSettings {
  /**
   * The containment root. Derived alongside `path` from one workspace-root
   * read, so the location the sink writes and the roots it proves against
   * cannot drift into two policies — the failure `backend-wiring.ts` records
   * for the runtime log's roots.
   */
  readonly root: string;
  readonly path: string;
  readonly maxBytes: number;
  readonly maxGenerations: number;
}

/**
 * Read once per emit, never held. Returning `null` means "no destination right
 * now" (no workspace folder), which drops the line rather than guessing a
 * location.
 */
export interface CliTransportSettingsAccessor {
  read(): CliTransportSettings | null;
}

/** Bounded causes recorded against a path so each warns at most once. */
type TransportFailureCause =
  | 'ENOENT-parent'
  | 'EACCES'
  | 'EROFS'
  | 'ENOSPC'
  | 'EIO'
  | 'stat-failed'
  | 'rotation-failed'
  | 'containment-refused'
  | 'format-failed'
  | 'unknown';

interface AppendFn {
  (target: string, data: string): Promise<void>;
}
interface WriteFileFn {
  (target: string, data: string): Promise<void>;
}
interface MkdirFn {
  (target: string, opts: { recursive: true }): Promise<unknown>;
}
interface RenameFn {
  (oldPath: string, newPath: string): Promise<void>;
}
interface UnlinkFn {
  (target: string): Promise<void>;
}
interface StatFn {
  (target: string): Promise<{ size: number }>;
}
interface ReaddirFn {
  (target: string): Promise<readonly string[]>;
}

export interface CliTransportSinkDeps {
  readonly settings: CliTransportSettingsAccessor;
  /**
   * `SanitizedLogger.sanitize`. Injected rather than imported so the sink has
   * no opinion about which logger it belongs to, and so a test can prove the
   * sink calls it on every line.
   */
  readonly sanitize: (line: string) => string;
  /**
   * FR-R3-048 (H-07) — optional stateful line sanitizer, used in preference to
   * `sanitize` when present.
   *
   * This sink is line-oriented: it sanitizes one CLI output line per call, so a
   * multiline `BEGIN…END` expression can never match here and a private key
   * spread over forty lines became forty records each holding a fragment.
   * Suppressing from a BEGIN marker to its matching END needs state, and state
   * needs to know which run and which stream a line belongs to — `stdout` is not
   * one stream once the concurrency cap rises above 1.
   *
   * Optional so every existing construction site and test double keeps compiling
   * and behaving exactly as before; the production factory supplies it.
   */
  readonly sanitizeStreamLine?: (
    line: string,
    runId: string | null,
    stream: CliTransportStream
  ) => string;
  readonly logger: Pick<SanitizedLogger, 'warn'>;
  readonly now?: () => Date;
  /** Injection points, each defaulting to the matching `fs.promises` call. */
  readonly appendFile?: AppendFn;
  readonly writeFile?: WriteFileFn;
  readonly mkdir?: MkdirFn;
  readonly rename?: RenameFn;
  readonly unlink?: UnlinkFn;
  readonly stat?: StatFn;
  readonly readdir?: ReaddirFn;
  readonly realpath?: (target: string) => Promise<string>;
}

/**
 * Replace the two characters that would break the record's column layout.
 *
 * Applied to the attribution fields only. A run id is host-generated and a
 * phase id is operator-authored through a validated grammar, so neither is
 * expected to contain a tab; the substitution is here so that if one ever does,
 * the result is a readable record rather than a shifted one. The line content
 * is deliberately NOT passed through this — it is the last field, so it cannot
 * shift anything, and rewriting the CLI's own bytes is the one thing this sink
 * must not do.
 */
function field(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ');
}

function errnoCode(error: unknown): string | null {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

function mapFailureCause(code: string | null): TransportFailureCause {
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

/**
 * Resolve the sink's destination from the workspace root, fresh on every call.
 *
 * The root is re-read rather than captured because a host outlives one folder,
 * which is the same reason `createRuntimeLogAccessor` takes a provider instead
 * of a string.
 */
export function createCliTransportSettingsAccessor(
  workspaceRoot: () => string | null
): CliTransportSettingsAccessor {
  return {
    read: (): CliTransportSettings | null => {
      const root = workspaceRoot();
      if (!root) return null;
      return Object.freeze({
        root,
        path: path.join(root, CLI_TRANSPORT_DIRECTORY, CLI_TRANSPORT_FILE_NAME),
        maxBytes: CLI_TRANSPORT_MAX_BYTES,
        maxGenerations: CLI_TRANSPORT_MAX_GENERATIONS
      });
    }
  };
}

export class CliTransportSink implements CliTransportRecorder {
  private readonly settings: CliTransportSettingsAccessor;
  private readonly sanitizeLine: (line: string) => string;
  private readonly sanitizeStreamLine?: (
    line: string,
    runId: string | null,
    stream: CliTransportStream
  ) => string;
  private readonly logger: Pick<SanitizedLogger, 'warn'>;
  private readonly now: () => Date;
  private readonly appendFile: AppendFn;
  private readonly writeFile: WriteFileFn;
  private readonly mkdir: MkdirFn;
  private readonly rename: RenameFn;
  private readonly unlink: UnlinkFn;
  private readonly stat: StatFn;
  private readonly readdir: ReaddirFn;
  private readonly containmentFs: { realpath(target: string): Promise<string> };

  /**
   * Per-path write chain, so a rotation that is mid-flight finishes before the
   * next line decides whether to rotate. Without it two concurrent Runs' lines
   * can both observe the pre-rotation byte count and both rename.
   */
  private readonly chains = new Map<string, Promise<void>>();

  /** Test seam: lets a suite await the fire-and-forget IO deterministically. */
  private readonly pending = new Set<Promise<void>>();

  /** Accumulated bytes per path, seeded from one `stat` on first emit. */
  private readonly bytesOnDisk = new Map<string, number>();
  private readonly bytesSeeded = new Set<string>();

  /** One WARN per (path, cause). */
  private readonly warned = new Map<string, Set<TransportFailureCause>>();

  /**
   * Paths a containment check refused.
   *
   * A refusal is deterministic for as long as the workspace layout holds, so
   * unlike a write failure there is nothing to retry: re-asking costs a
   * `realpath` per line and gets the same answer. Write failures are the
   * opposite — `ENOSPC` and `EIO` clear on their own — so those warn once and
   * keep trying rather than closing the path for the session.
   */
  private readonly refused = new Set<string>();

  /**
   * The append target's verdict, cached per path.
   *
   * This is the per-line path, and an uncached check adds a `realpath` to every
   * line of CLI output. The cached verdict is risk reduction rather than a
   * guarantee — a destination replaced mid-session keeps its verdict — which is
   * the same bargain `RuntimeLogSink` documents, minus the settings-save signal
   * that lets that sink drop its cache.
   */
  private readonly containmentCache = new Map<string, ContainmentVerdict>();

  constructor(deps: CliTransportSinkDeps) {
    this.settings = deps.settings;
    this.sanitizeLine = deps.sanitize;
    this.sanitizeStreamLine = deps.sanitizeStreamLine;
    this.logger = deps.logger;
    this.now = deps.now ?? ((): Date => new Date());
    this.appendFile = deps.appendFile ?? fs.appendFile;
    this.writeFile = deps.writeFile ?? fs.writeFile;
    this.mkdir = deps.mkdir ?? fs.mkdir;
    this.rename = deps.rename ?? fs.rename;
    this.unlink = deps.unlink ?? fs.unlink;
    this.stat = deps.stat ?? (async (target: string) => {
      const stats = await fs.stat(target);
      return { size: stats.size };
    });
    this.readdir = deps.readdir ?? (async (target: string) => fs.readdir(target));
    this.containmentFs = { realpath: deps.realpath ?? fs.realpath };
  }

  /**
   * Record one line. Never throws, never awaits — the monitor calls this from
   * a synchronous stream handler on the phase's hot path.
   */
  public record(entry: CliTransportRecord): void {
    // Per emit, never a field. The destination and the bounds are re-derived
    // on every line so a workspace change is observed at the next one.
    const settings = this.settings.read();
    if (!settings) return;
    if (this.refused.has(settings.path)) return;
    let data: string;
    try {
      data = this.format(entry);
    } catch {
      // Formatting is the only work this method does on the phase's own stack:
      // the injected sanitizer runs here, and a stream-json line can be
      // megabytes. A regex or allocation failure costs one line, not a phase.
      this.warn(settings.path, 'format-failed');
      return;
    }
    const previous = this.chains.get(settings.path) ?? Promise.resolve();
    const next = previous.then(() => this.writeAbsorbing(settings, data));
    this.chains.set(settings.path, next);
    this.pending.add(next);
    void next.finally(() => {
      this.pending.delete(next);
      if (this.chains.get(settings.path) === next) {
        this.chains.delete(settings.path);
      }
    });
  }

  /** Await in-flight writes. Settles immediately when none are pending. */
  public async flushPendingWrites(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled(Array.from(this.pending));
    }
  }

  private format(entry: CliTransportRecord): string {
    const stamp = this.now().toISOString();
    // FR-R3-048 — the stateful sanitizer when the caller supplied one, so a key
    // block spanning lines is suppressed rather than written a fragment at a
    // time. Falls back to the stateless one, which keeps every existing test
    // double and construction site behaving as before.
    const sanitized = this.sanitizeStreamLine
      ? this.sanitizeStreamLine(entry.line, entry.runId, entry.stream)
      : this.sanitizeLine(entry.line);
    return `${stamp}\t${field(entry.runId)}\t${field(entry.phase)}\t${entry.stream}\t${sanitized}\n`;
  }

  /**
   * The chain link. Two obligations meet here, and one `try` discharges both.
   *
   * `record()` is fire-and-forget, so a rejection has no `await` to surface at:
   * under Node's default it ends the extension host, which is a far louder
   * failure than the dropped line it would be reporting. And each link is the
   * next record's `previous` — `p.then(fn)` on a rejected `p` never calls `fn`
   * — so one rejection would silently stop transport capture for the rest of
   * the session. Absorbing here makes every link fulfil, so neither happens.
   *
   * Nothing is logged from the catch. Every failure `write()` can name has
   * already warned for its own cause by the time it returns; what reaches here
   * is something unforeseen, and reaching for the logger on that path is how
   * the throwing-logger case became a crash in the first place.
   */
  private async writeAbsorbing(settings: CliTransportSettings, data: string): Promise<void> {
    try {
      await this.write(settings, data);
    } catch {
      // Deliberately silent; see above.
    }
  }

  private async write(settings: CliTransportSettings, data: string): Promise<void> {
    const targetPath = settings.path;
    // Ahead of the stat, so a refused destination costs one resolution rather
    // than a syscall against a location nothing has established we may read.
    if (!(await this.appendTargetIsContained(settings))) return;
    const dataBytes = Buffer.byteLength(data, 'utf8');
    if (!(await this.seedBytes(targetPath))) return;
    const currentBytes = this.bytesOnDisk.get(targetPath) ?? 0;
    // `>` not `>=`: the file may grow up to and including `maxBytes`, and
    // rotation fires only when the next record would push it past. A single
    // record larger than the whole budget still rotates, which is the
    // degenerate-but-correct reading.
    if (currentBytes + dataBytes > settings.maxBytes) {
      if (!(await this.rotate(settings))) return;
      if (await this.writeWithParentRecovery(this.writeFile, targetPath, data)) {
        this.bytesOnDisk.set(targetPath, dataBytes);
      }
      return;
    }
    if (await this.writeWithParentRecovery(this.appendFile, targetPath, data)) {
      this.bytesOnDisk.set(targetPath, currentBytes + dataBytes);
    }
  }

  /**
   * Establish the byte tally for a path once. ENOENT is benign — the file has
   * simply not been created — and any other stat failure drops this record
   * rather than writing blind, because a write with no size in hand cannot
   * honour the rotation bound. The path is not marked seeded on that branch,
   * so a transient failure recovers on the next line.
   */
  private async seedBytes(targetPath: string): Promise<boolean> {
    if (this.bytesSeeded.has(targetPath)) return true;
    try {
      const { size } = await this.stat(targetPath);
      this.bytesOnDisk.set(targetPath, size);
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') {
        this.warn(targetPath, 'stat-failed');
        return false;
      }
      this.bytesOnDisk.set(targetPath, 0);
    }
    this.bytesSeeded.add(targetPath);
    return true;
  }

  /**
   * `path.<N-1>` → `path.<N>`, …, `path` → `path.1`, oldest dropped.
   *
   * Shifts oldest-first so a slot is always free before a rename targets it.
   * ENOENT anywhere in the shift is benign: the slot is empty because the sink
   * has not rotated that many times yet.
   */
  private async rotate(settings: CliTransportSettings): Promise<boolean> {
    const targetPath = settings.path;
    if (settings.maxGenerations === 0) {
      // No generations retained: truncate in place by writing the record as
      // the file's only content. The caller sets the byte tally.
      return true;
    }
    for (let generation = settings.maxGenerations - 1; generation >= 1; generation -= 1) {
      const moved = await this.moveGeneration(
        settings,
        `${targetPath}.${generation}`,
        `${targetPath}.${generation + 1}`
      );
      if (!moved) return false;
    }
    if (!(await this.moveGeneration(settings, targetPath, `${targetPath}.1`))) return false;
    await this.dropGeneration(settings, `${targetPath}.${settings.maxGenerations + 1}`);
    await this.sweepStaleGenerations(settings);
    return true;
  }

  /**
   * Unlink any `path.<n>` above the cap.
   *
   * The cap is code-resident, so the case this covers is a release that lowers
   * it: the shift loop never visits the orphaned slots, and without the sweep
   * they would sit on an operator's disk for the life of the workspace.
   * Best-effort and bounded by the directory listing — a failure here must not
   * fail the rotation that triggered it.
   */
  private async sweepStaleGenerations(settings: CliTransportSettings): Promise<void> {
    const directory = path.dirname(settings.path);
    const prefix = `${path.basename(settings.path)}.`;
    let entries: readonly string[];
    try {
      entries = await this.readdir(directory);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.startsWith(prefix)) continue;
      const suffix = name.slice(prefix.length);
      // Purely-numeric suffixes only. Anything else belongs to the operator.
      if (!/^\d+$/.test(suffix)) continue;
      const generation = Number(suffix);
      if (!Number.isInteger(generation) || generation <= settings.maxGenerations) continue;
      await this.dropGeneration(settings, path.join(directory, name));
    }
  }

  /**
   * Rename one generation. Both ends are proven: a rename out of the root
   * relocates a file just as surely as one into it.
   */
  private async moveGeneration(
    settings: CliTransportSettings,
    from: string,
    to: string
  ): Promise<boolean> {
    if (!(await this.generationIsContained(settings, from))) return false;
    if (!(await this.generationIsContained(settings, to))) return false;
    try {
      await this.rename(from, to);
      return true;
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return true;
      this.warn(settings.path, 'rotation-failed');
      return false;
    }
  }

  /** Remove one generation. Best-effort; the next rotation retries. */
  private async dropGeneration(settings: CliTransportSettings, victim: string): Promise<void> {
    if (!(await this.generationIsContained(settings, victim))) return;
    try {
      await this.unlink(victim);
    } catch {
      // Best-effort by design: the rotation itself already succeeded.
    }
  }

  /**
   * Prove the append target once per path.
   *
   * `resolveContainedForWrite` is the right entry point because the first
   * record creates the file and every later one follows an existing leaf — so
   * a destination replaced by a symlink out of the workspace is refused rather
   * than written through.
   */
  private async appendTargetIsContained(settings: CliTransportSettings): Promise<boolean> {
    const targetPath = settings.path;
    let verdict = this.containmentCache.get(targetPath);
    if (!verdict) {
      verdict = await resolveContainedForWrite(targetPath, [settings.root], this.containmentFs);
      this.containmentCache.set(targetPath, verdict);
    }
    if (verdict.outcome === 'contained') return true;
    this.refuse(targetPath, verdict);
    return false;
  }

  /**
   * Prove a generation file this rotation is about to rename or unlink.
   *
   * Link form and uncached: `rename` and `unlink` act on the directory entry
   * without following it, and each names a different file from the one the
   * append proved. Rotation runs once per rollover, so the syscall is not on
   * any hot path.
   */
  private async generationIsContained(
    settings: CliTransportSettings,
    generation: string
  ): Promise<boolean> {
    const verdict = await resolveContainedLink(generation, [settings.root], this.containmentFs);
    if (verdict.outcome === 'contained') return true;
    this.refuse(settings.path, verdict);
    return false;
  }

  /**
   * Close a path against further writes and warn once.
   *
   * Keyed on the live path even when the refused entry was a generation file:
   * the live path is the one the next record consults, and a rotation that
   * cannot be proven safe must not be reattempted on every subsequent line.
   * The refused path is never in the WARN text — a path outside the root is
   * precisely the string that must not reach a log.
   *
   * `record()`'s early return on `this.refused` cannot carry the suppression on
   * its own: a phase hands over a whole chunk's lines synchronously, so every
   * line of that chunk is queued before the first resolution has answered, and
   * all of them reach this method. The bookkeeping is what makes it once.
   */
  private refuse(targetPath: string, verdict: ContainmentVerdict): void {
    if (verdict.outcome !== 'refused') return;
    this.refused.add(targetPath);
    if (!this.markWarned(targetPath, 'containment-refused')) return;
    this.emitWarning(
      `[cli-transport] refused to write outside the workspace root (${verdict.reason}); CLI transport capture is off for this session.`
    );
  }

  /**
   * The write helper both the append and the post-rotation create go through.
   * A missing parent directory is recovered once — the `.schegent` directory
   * may not exist on a workspace's first phase — and any other failure warns
   * once for its cause and drops the record.
   */
  private async writeWithParentRecovery(
    write: AppendFn | WriteFileFn,
    targetPath: string,
    data: string
  ): Promise<boolean> {
    try {
      await write(targetPath, data);
      return true;
    } catch (error) {
      const code = errnoCode(error);
      if (code === 'ENOENT') {
        try {
          await this.mkdir(path.dirname(targetPath), { recursive: true });
          await write(targetPath, data);
          return true;
        } catch {
          this.warn(targetPath, 'ENOENT-parent');
          return false;
        }
      }
      this.warn(targetPath, mapFailureCause(code));
      return false;
    }
  }

  /**
   * Claim the one WARN slot for `(path, cause)`, returning whether this caller
   * got it. Test-and-set in one place because the two warning sites below had
   * drifted: `refuse()` read the slot without ever claiming it, so its
   * suppression never engaged and a refused destination warned once per line.
   */
  private markWarned(targetPath: string, cause: TransportFailureCause): boolean {
    let causes = this.warned.get(targetPath);
    if (!causes) {
      causes = new Set();
      this.warned.set(targetPath, causes);
    }
    if (causes.has(cause)) return false;
    causes.add(cause);
    return true;
  }

  /**
   * One WARN per (path, cause), and the path is never in the text. A phase can
   * emit tens of thousands of lines, so an unsuppressed warning would bury the
   * runtime log in the failure it is reporting.
   */
  private warn(targetPath: string, cause: TransportFailureCause): void {
    if (!this.markWarned(targetPath, cause)) return;
    this.emitWarning(
      `[cli-transport] could not record CLI output (${cause}); the phase is unaffected and the lines are still in the phase diagnostics.`
    );
  }

  /**
   * The one place the logger is called, so a logger that throws cannot be the
   * thing that fails the phase. `warn()` is reached from `record()`'s
   * synchronous formatting guard as well as from the async chain, so a throw
   * here would land on the monitor's stream handler on one path and in an
   * unobserved rejection on the other. `ClaudeCliMonitor.appendAudit` guards its
   * own failure log the same way and for the same reason.
   */
  private emitWarning(message: string): void {
    try {
      this.logger.warn(message);
    } catch {
      // Nothing left to report it to.
    }
  }
}

/**
 * Production construction: the workspace-rooted destination plus the host's
 * one sanitizing logger.
 */
export function createCliTransportSink(
  workspaceRoot: () => string | null,
  logger: Pick<SanitizedLogger, 'sanitize' | 'warn'>
): CliTransportSink {
  // FR-R3-048 (H-07) — the injected sanitizer is STATEFUL here, because this sink
  // is line-oriented. `format()` sanitizes one CLI output line per call, so a
  // multiline `BEGIN…END` expression can never match: by the time the sanitizer
  // runs, a key block has already been split across calls. Fixing only the
  // pattern in `SECRET_PATTERNS` leaves this log holding the key while the whole
  // suite goes green.
  //
  // Keyed by run AND stream, not by stream alone. `stdout` is not one stream: the
  // concurrency cap can be raised to 20, and with a shared key a block opened by
  // one Run's stdout would suppress every other Run's stdout until it closed.
  // Both parts come off the record the caller already supplies.
  //
  // The map is not a leak: each entry is a boolean, a label and a counter (no
  // lines), and `releaseRedactionState` drops a Run's entries when its streams
  // end. A missing release costs O(1) per Run rather than O(output).
  // Bounded by construction rather than by a release hook.
  //
  // A release hook would be tidier, but this sink has no per-run terminal
  // callback and inventing a caller for one means reaching into the controller —
  // scope this item does not own. So the map self-bounds: past the cap the
  // oldest-inserted entry is evicted.
  //
  // The arithmetic is what makes that safe. Each entry is a boolean, a label and
  // a counter, so the whole map is O(1) memory; and the default concurrency cap
  // is 1 with a documented maximum of 20, i.e. at most 40 live (run, stream)
  // pairs. A cap well above that means eviction can only ever reach state
  // belonging to runs that already finished — never a live open block, which is
  // the one case where discarding state would release a tail.
  const MAX_TRACKED_STREAMS = 256;
  const redactors = new Map<string, KeyBlockLineRedactor>();
  const keyFor = (runId: string | null, stream: string): string => `${runId ?? '-'}:${stream}`;
  return new CliTransportSink({
    settings: createCliTransportSettingsAccessor(workspaceRoot),
    sanitize: (line) => logger.sanitize(line),
    sanitizeStreamLine: (line, runId, stream) => {
      const key = keyFor(runId, stream);
      let redactor = redactors.get(key);
      if (!redactor) {
        if (redactors.size >= MAX_TRACKED_STREAMS) {
          // Map iteration order is insertion order, so the first key is the
          // oldest-inserted — a finished run's, given the arithmetic above.
          const oldest = redactors.keys().next().value;
          if (oldest !== undefined) redactors.delete(oldest);
        }
        redactor = new KeyBlockLineRedactor((input) => logger.sanitize(input));
        redactors.set(key, redactor);
      }
      return redactor.sanitizeLine(line);
    },
    logger
  });
}
