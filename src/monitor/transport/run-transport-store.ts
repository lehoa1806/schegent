// FR-R4-F04 (FR-004 to FR-008, contract X3, X4, X7; data-model §2, §3) — the files transport lives in.
//
// File I/O only; no VS Code import, and it never imports the audit writer (X9). The router decides what
// to write and when; this module opens, appends, compacts, promotes and removes, and tells the router
// what is on disk. Every path is under a root:
//
//   - a Run file, `<workspace>/.schegent/sessions/<runId>/transport.log`, opened `0600` in `0700`
//     directories through the checked walk;
//   - a stage file, `<os temp>/schegent-transport-<key>/<runId>.log`, where `<key>` is the hex SHA-256 of
//     a domain string and the workspace's real path, so two workspaces never share a stage and a stage
//     survives a host crash;
//   - the legacy generations, `.schegent/cli-transport.log` and `.1` to `.3`, which nothing writes any
//     more: they are narrowed where they lie, expired whole by their newest record, and never rewritten.
//
// WHY APPEND DESCRIPTORS ARE HELD. A transport record is one line of CLI output and a Run can emit tens
// of thousands, so a walk per record would put the checked open on the hot path. A handle is held per
// file and dropped wherever the file's identity can change: a compaction renames it, a removal unlinks
// it, a Run's end releases it, and disposal closes all of them.
//
// EVERY REMOVAL IS CONTAINED. Each `rename`, `unlink` and `rmdir` is preceded by `resolveContainedLink`
// against the workspace root (Run files, legacy) or the stage directory (stage files) and acts on the
// resolved path (hard rule 69's sibling, `destructive-fs-requires-containment`).

import { createHash } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { NarrowingReporter } from '../../lib/evidence-narrowing';
import { narrowMode, noticeFor } from '../../lib/narrow-mode';
import { resolveContainedLink } from '../../lib/path-containment';
import { ensureAnchorWithinRoot, openWithinRoot } from '../../lib/safe-open';
import { CLI_TRANSPORT_DIRECTORY, CLI_TRANSPORT_FILE_NAME } from '../cli-transport-sink';
import {
  TRANSPORT_RUN_FILE_NAME,
  TRANSPORT_SPOOL_KEY_DOMAIN,
  TRANSPORT_SPOOL_PREFIX,
  recordTimeMs,
  selectCompaction
} from './transport-policy';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const SESSIONS_DIRECTORY = 'sessions';
const STAGE_FILE_SUFFIX = '.log';
const COMPACT_SUFFIX = '.compact';
const FIRST_LINE_PROBE_BYTES = 128;
const TAIL_CHUNK_BYTES = 64 * 1024;
/** `.schegent/cli-transport.log` and its numeric generations; anything else beside them is the operator's. */
const LEGACY_NAME = new RegExp(`^${CLI_TRANSPORT_FILE_NAME.replace(/\./g, '\\.')}(\\.\\d+)?$`);

/** Where one file lives. A Run file is under the workspace, a stage file under the OS temp root. */
export interface TransportTarget {
  readonly kind: 'run' | 'stage';
  readonly workspaceRoot: string;
  readonly runId: string;
}

/** What the store knows about one file, kept in memory so an append never rescans it. */
export interface TransportFileState {
  readonly bytes: number;
  /** The first record's time, or `null` for an empty file or one with no readable time. */
  readonly oldestMs: number | null;
  /** The last record's time, or `null` likewise. */
  readonly newestMs: number | null;
}

export interface RunFileEntry {
  readonly runId: string;
  readonly path: string;
  readonly bytes: number;
  readonly newestMs: number;
}

export interface StageEntry {
  readonly runId: string;
  readonly path: string;
  readonly bytes: number;
}

export interface LegacyEntry {
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
  /** The last record's time, or the file's mtime when it holds no readable record. */
  readonly newestMs: number;
}

export interface CompactionResult {
  readonly outcome: 'unchanged' | 'compacted' | 'removed';
}

/** A bounded, path-free reason a store operation could not proceed. */
export class TransportStoreError extends Error {
  constructor(readonly code: string) {
    super(`transport store: ${code}`);
    this.name = 'TransportStoreError';
  }
}

export interface RunTransportStoreDeps {
  /** The OS temp root, or a stand-in a test passes. Stage directories are created beneath it. */
  readonly tempRoot: string;
  /** Path-free narrowing notices, said once per distinct notice. */
  readonly warn: (message: string) => void;
  /** This account's uid, `undefined` where there is none (Windows). Defaults to `process.getuid`; a test passes another. */
  readonly ownerUid?: () => number | undefined;
}

interface Location {
  /** The root the checked walk trusts. */
  readonly walkRoot: string;
  /** The segments from `walkRoot` to the file. */
  readonly segments: readonly string[];
  readonly fullPath: string;
  /** What a removal of this file is proven against. */
  readonly containmentRoot: string;
}

function errnoOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'unknown';
}

const isMissing = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes(errnoOf(error));

/**
 * The bounded code for a refused checked open: the refusal's own reason, except `io-failed`, which says
 * a syscall failed and is worth no more than the errno it carries (`EACCES`, `ENOSPC`, `EROFS`).
 */
function refusalCode(refusal: { readonly reason: string; readonly errno: string }): string {
  return refusal.reason === 'io-failed' && /^[A-Z][A-Z0-9_]{0,31}$/.test(refusal.errno)
    ? refusal.errno
    : refusal.reason;
}

/** The per-Run transport files and the stage: append, compaction, promotion and listing, all through the checked walk. */
export class RunTransportStore {
  private readonly tempRoot: string;
  private readonly ownerUid: () => number | undefined;
  private readonly narrowing: NarrowingReporter;
  private readonly handles = new Map<string, { readonly handle: FileHandle; readonly runId: string }>();
  private readonly states = new Map<string, TransportFileState>();
  private readonly stageDirectories = new Map<string, string>();
  private readonly legacyNarrowed = new Set<string>();
  private compactSequence = 0;
  /** Set by `dispose()`: no descriptor is opened afterwards, because nothing would be left to close it. */
  private disposed = false;

  constructor(deps: RunTransportStoreDeps) {
    this.tempRoot = deps.tempRoot;
    this.ownerUid = deps.ownerUid ?? (() => process.getuid?.());
    this.narrowing = new NarrowingReporter('[cli-transport]', deps.warn);
  }

  /** How many append descriptors are held; a disposal test asserts it reaches zero. */
  get openDescriptorCount(): number {
    return this.handles.size;
  }

  // ---------------------------------------------------------------------------------------------
  // Locations
  // ---------------------------------------------------------------------------------------------

  /**
   * The stage directory's name for a workspace: the prefix and the hex SHA-256 of a domain string and
   * the workspace's real path. Cached per root; a root that cannot be resolved falls back to its text,
   * which still keys the same workspace the same way within a host.
   */
  private async stageDirectoryName(workspaceRoot: string): Promise<string> {
    const cached = this.stageDirectories.get(workspaceRoot);
    if (cached !== undefined) return cached;
    let resolved = workspaceRoot;
    try {
      resolved = await fs.realpath(workspaceRoot);
    } catch {
      // The key still separates workspaces by the text they were given.
    }
    const key = createHash('sha256').update(TRANSPORT_SPOOL_KEY_DOMAIN + resolved).digest('hex');
    const name = `${TRANSPORT_SPOOL_PREFIX}${key}`;
    this.stageDirectories.set(workspaceRoot, name);
    return name;
  }

  private runDirectorySegments(runId: string): readonly string[] {
    return [CLI_TRANSPORT_DIRECTORY, SESSIONS_DIRECTORY, runId];
  }

  private async locate(target: TransportTarget): Promise<Location> {
    if (target.kind === 'run') {
      const segments = [...this.runDirectorySegments(target.runId), TRANSPORT_RUN_FILE_NAME];
      return {
        walkRoot: target.workspaceRoot,
        segments,
        fullPath: path.join(target.workspaceRoot, ...segments),
        containmentRoot: target.workspaceRoot
      };
    }
    const directory = await this.stageDirectoryName(target.workspaceRoot);
    const segments = [directory, `${target.runId}${STAGE_FILE_SUFFIX}`];
    return {
      walkRoot: this.tempRoot,
      segments,
      fullPath: path.join(this.tempRoot, ...segments),
      containmentRoot: path.join(this.tempRoot, directory)
    };
  }

  /** The stage directory for a workspace, created `0700` the first time it is needed (X3). */
  private async ensureStageDirectory(workspaceRoot: string): Promise<string> {
    const made = await ensureAnchorWithinRoot(this.tempRoot, [await this.stageDirectoryName(workspaceRoot)], DIR_MODE);
    if (made.outcome === 'refused') throw new TransportStoreError(`stage-${made.reason}`);
    // The stage's name is derived from the workspace path, so on a shared temp root another account can make
    // it first; one it owns can have its files swapped for files that account reads. Never adopted.
    const uid = this.ownerUid();
    if (uid === undefined) return made.anchor;
    const owner = await fs.lstat(made.anchor).then((stat) => stat.uid, (error: unknown) => errnoOf(error));
    if (owner !== uid) throw new TransportStoreError(typeof owner === 'string' ? owner : 'stage-not-owned');
    return made.anchor;
  }

  // ---------------------------------------------------------------------------------------------
  // Opens
  // ---------------------------------------------------------------------------------------------

  private async openForAppend(location: Location): Promise<FileHandle> {
    const opened = await openWithinRoot(location.walkRoot, location.segments, {
      flags: 'a',
      createDirs: true,
      dirMode: DIR_MODE,
      fileMode: FILE_MODE
    });
    if (opened.outcome === 'refused') throw new TransportStoreError(refusalCode(opened));
    this.narrowing.report(opened.narrowing);
    return opened.handle;
  }

  private async openForRead(location: Location): Promise<FileHandle | null> {
    const opened = await openWithinRoot(location.walkRoot, location.segments, { flags: 'r' });
    if (opened.outcome === 'opened') return opened.handle;
    if (opened.errno === 'ENOENT' || opened.errno === 'ENOTDIR') return null;
    throw new TransportStoreError(refusalCode(opened));
  }

  private async handleFor(target: TransportTarget, location: Location): Promise<FileHandle> {
    const held = this.handles.get(location.fullPath);
    if (held !== undefined) return held.handle;
    if (this.disposed) throw new TransportStoreError('disposed');
    if (target.kind === 'stage') await this.ensureStageDirectory(target.workspaceRoot);
    const handle = await this.openForAppend(location);
    // The walk awaits, so disposal can run in between; a handle it never saw would have no owner left.
    if (this.isDisposed()) {
      await handle.close().catch(() => undefined);
      throw new TransportStoreError('disposed');
    }
    this.handles.set(location.fullPath, { handle, runId: target.runId });
    return handle;
  }

  private async dropHandle(fullPath: string): Promise<void> {
    const held = this.handles.get(fullPath);
    if (held === undefined) return;
    this.handles.delete(fullPath);
    await held.handle.close().catch(() => undefined);
  }

  /**
   * `disposed`, read through an accessor. The checker carries the check at the top of `handleFor` across
   * its awaits and would call a second read of the field dead, but `dispose()` sets it while an open is
   * suspended. A function entry resets that narrowing.
   */
  private isDisposed(): boolean {
    return this.disposed;
  }

  /** Close every descriptor held for a Run: its Run file and its stage file. Called at the Run's end. */
  async releaseRun(runId: string): Promise<void> {
    for (const [fullPath, held] of [...this.handles]) {
      if (held.runId === runId) await this.dropHandle(fullPath);
    }
  }

  /** Close every descriptor; the owner's release at disposal. */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const fullPath of [...this.handles.keys()]) await this.dropHandle(fullPath);
  }

  // ---------------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------------

  /**
   * What the file holds, seeded once with one read of its size, its first line and its last record, and
   * then maintained by `append` and `compact` (X4). A file that does not exist is empty.
   */
  async stateOf(target: TransportTarget): Promise<TransportFileState> {
    const location = await this.locate(target);
    const known = this.states.get(location.fullPath);
    if (known !== undefined) return known;
    const handle = await this.openForRead(location);
    if (handle === null) {
      const empty: TransportFileState = { bytes: 0, oldestMs: null, newestMs: null };
      this.states.set(location.fullPath, empty);
      return empty;
    }
    try {
      const seeded = await this.readState(handle);
      this.states.set(location.fullPath, seeded);
      return seeded;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async readState(handle: FileHandle): Promise<TransportFileState> {
    const { size } = await handle.stat();
    if (size === 0) return { bytes: 0, oldestMs: null, newestMs: null };
    const probe = Buffer.alloc(Math.min(size, FIRST_LINE_PROBE_BYTES));
    await handle.read(probe, 0, probe.length, 0);
    return {
      bytes: size,
      oldestMs: recordTimeMs(probe.toString('utf8')),
      newestMs: await readNewestRecordMs(handle, size)
    };
  }

  /**
   * The state of a file this store is not currently appending to, read from the disk. A listing walks
   * files other actors may have removed (the retention sweep, an operator), so a cached entry is not
   * trusted for a file with no held descriptor.
   */
  private async freshState(target: TransportTarget): Promise<TransportFileState | null> {
    const location = await this.locate(target);
    if (!this.handles.has(location.fullPath)) this.forget(location.fullPath);
    return this.stateOf(target).catch(() => null);
  }

  /** Forget a file's cached state, so the next read of it is from the disk. */
  private forget(fullPath: string): void {
    this.states.delete(fullPath);
  }

  // ---------------------------------------------------------------------------------------------
  // Append, compact
  // ---------------------------------------------------------------------------------------------

  /** Append one formatted record. The caller has already applied the bounds (X4). */
  async append(target: TransportTarget, data: string): Promise<void> {
    const location = await this.locate(target);
    const before = await this.stateOf(target);
    const handle = await this.handleFor(target, location);
    try {
      await handle.write(data, null, 'utf8');
    } catch (error) {
      // The descriptor is dropped on any failure: the next record re-walks rather than retrying a handle
      // whose file may have been removed or filled.
      await this.dropHandle(location.fullPath);
      this.forget(location.fullPath);
      throw new TransportStoreError(errnoOf(error));
    }
    const at = recordTimeMs(data);
    this.states.set(location.fullPath, {
      bytes: before.bytes + Buffer.byteLength(data, 'utf8'),
      oldestMs: before.bytes === 0 ? at : before.oldestMs,
      newestMs: at ?? before.newestMs
    });
  }

  /**
   * Compact a file in place: keep the newest records that are inside the age bound and within
   * `targetBytes` (data-model §2). The survivors go to a sibling temp file `wx` `0600`, which is renamed
   * over the original after a containment check, and the result's mtime is set to its newest record's
   * time (R6) so a rewrite does not make old evidence look new. A compaction that would keep nothing
   * removes the file.
   */
  async compact(
    target: TransportTarget,
    nowMs: number,
    maxAgeMs: number,
    targetBytes: number
  ): Promise<CompactionResult> {
    const location = await this.locate(target);
    await this.dropHandle(location.fullPath);
    const handle = await this.openForRead(location);
    if (handle === null) {
      this.forget(location.fullPath);
      return { outcome: 'unchanged' };
    }
    let content: string;
    try {
      content = await handle.readFile({ encoding: 'utf8' });
    } finally {
      await handle.close().catch(() => undefined);
    }
    const records = splitRecords(content);
    const kept = selectCompaction(records, nowMs, maxAgeMs, targetBytes);
    if (kept.length === records.length) {
      this.forget(location.fullPath);
      return { outcome: 'unchanged' };
    }
    if (kept.length === 0) {
      await this.removeContained(location.fullPath, location.containmentRoot);
      this.forget(location.fullPath);
      if (target.kind === 'run') await this.removeEmptyDirectory(path.dirname(location.fullPath), target.workspaceRoot);
      return { outcome: 'removed' };
    }
    await this.replaceWith(location, kept);
    return { outcome: 'compacted' };
  }

  private async replaceWith(location: Location, kept: readonly string[]): Promise<void> {
    const body = kept.join('');
    this.compactSequence += 1;
    const tempName = `${location.segments[location.segments.length - 1]}${COMPACT_SUFFIX}-${process.pid}-${this.compactSequence}`;
    const tempSegments = [...location.segments.slice(0, -1), tempName];
    const opened = await openWithinRoot(location.walkRoot, tempSegments, { flags: 'wx', fileMode: FILE_MODE });
    if (opened.outcome === 'refused') throw new TransportStoreError(refusalCode(opened));
    const tempPath = path.join(location.walkRoot, ...tempSegments);
    try {
      await opened.handle.write(body, null, 'utf8');
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
    const newest = recordTimeMs(kept[kept.length - 1] ?? '');
    try {
      const from = await resolveContainedLink(tempPath, [location.containmentRoot]);
      const to = await resolveContainedLink(location.fullPath, [location.containmentRoot]);
      if (from.outcome !== 'contained' || to.outcome !== 'contained') {
        throw new TransportStoreError('containment-refused');
      }
      await fs.rename(from.resolved, to.resolved);
      if (newest !== null) await fs.utimes(to.resolved, new Date(newest), new Date(newest));
    } catch (error) {
      // The temp file is this store's own and sits beside the original; removing it by name is proven
      // by the same containment check before the rename was attempted.
      const stray = await resolveContainedLink(tempPath, [location.containmentRoot]);
      if (stray.outcome === 'contained') await fs.unlink(stray.resolved).catch(() => undefined);
      throw error instanceof TransportStoreError ? error : new TransportStoreError(errnoOf(error));
    }
    this.states.set(location.fullPath, {
      bytes: Buffer.byteLength(body, 'utf8'),
      oldestMs: recordTimeMs(kept[0] ?? ''),
      newestMs: newest
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Promote, discard, remove
  // ---------------------------------------------------------------------------------------------

  /**
   * Append a Run's stage file to its Run file, then remove the stage (data-model §3). Returns whether
   * anything was promoted. A stage that is absent promotes nothing and is not an error: a cleared spool
   * is an expected state.
   */
  async promote(workspaceRoot: string, runId: string): Promise<boolean> {
    const stage = await this.locate({ kind: 'stage', workspaceRoot, runId });
    const handle = await this.openForRead(stage);
    if (handle === null) return false;
    let content: string;
    try {
      content = await handle.readFile({ encoding: 'utf8' });
    } finally {
      await handle.close().catch(() => undefined);
    }
    await this.dropHandle(stage.fullPath);
    if (content.length > 0) {
      const run: TransportTarget = { kind: 'run', workspaceRoot, runId };
      const runLocation = await this.locate(run);
      const runHandle = await this.handleFor(run, runLocation);
      await runHandle.write(content, null, 'utf8');
      this.forget(runLocation.fullPath);
    }
    await this.removeContained(stage.fullPath, stage.containmentRoot);
    this.forget(stage.fullPath);
    return content.length > 0;
  }

  /** Remove a Run's stage file. Absent is not an error. */
  async discardStage(workspaceRoot: string, runId: string): Promise<boolean> {
    const stage = await this.locate({ kind: 'stage', workspaceRoot, runId });
    await this.dropHandle(stage.fullPath);
    this.forget(stage.fullPath);
    return this.removeContained(stage.fullPath, stage.containmentRoot);
  }

  /** Remove a Run's transport file, and the Run directory when that leaves it empty. */
  async removeRunFile(workspaceRoot: string, runId: string): Promise<boolean> {
    const location = await this.locate({ kind: 'run', workspaceRoot, runId });
    await this.dropHandle(location.fullPath);
    this.forget(location.fullPath);
    const removed = await this.removeContained(location.fullPath, location.containmentRoot);
    await this.removeEmptyDirectory(path.dirname(location.fullPath), workspaceRoot);
    return removed;
  }

  /** Remove one legacy generation, whole. */
  async removeLegacy(workspaceRoot: string, entry: LegacyEntry): Promise<boolean> {
    return this.removeContained(entry.path, workspaceRoot);
  }

  /**
   * `unlink` after proving the entry's directory is inside `root`, acting on the resolved path. `false`
   * when there was nothing to remove.
   */
  private async removeContained(target: string, root: string): Promise<boolean> {
    // An entry that is not there has nothing to remove, and says nothing about containment: a stage
    // directory that was never created (nothing was staged) or was cleared is an expected state.
    try {
      await fs.lstat(target);
    } catch (error) {
      if (isMissing(error)) return false;
      throw new TransportStoreError(errnoOf(error));
    }
    const verdict = await resolveContainedLink(target, [root]);
    if (verdict.outcome === 'refused') throw new TransportStoreError(`containment-${verdict.reason}`);
    if (verdict.outcome === 'absent') return false;
    try {
      await fs.unlink(verdict.resolved);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw new TransportStoreError(errnoOf(error));
    }
  }

  /** Best-effort `rmdir` of a directory this store may have created; a non-empty one is not touched. */
  private async removeEmptyDirectory(directory: string, root: string): Promise<void> {
    const verdict = await resolveContainedLink(directory, [root]);
    if (verdict.outcome !== 'contained') return;
    await fs.rmdir(verdict.resolved).catch(() => undefined);
  }

  // ---------------------------------------------------------------------------------------------
  // Listing
  // ---------------------------------------------------------------------------------------------

  /** Every Run directory under `.schegent/sessions/` that holds a transport file. */
  async listRunFiles(workspaceRoot: string): Promise<readonly RunFileEntry[]> {
    const sessions = path.join(workspaceRoot, CLI_TRANSPORT_DIRECTORY, SESSIONS_DIRECTORY);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(sessions, { withFileTypes: true });
    } catch {
      return [];
    }
    const found: RunFileEntry[] = [];
    for (const entry of entries) {
      // A symbolic link is not a Run directory this store made; a dot-name is the staging area.
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const file = path.join(sessions, entry.name, TRANSPORT_RUN_FILE_NAME);
      const state = await this.freshState({ kind: 'run', workspaceRoot, runId: entry.name });
      if (state === null || state.bytes === 0) continue;
      found.push({ runId: entry.name, path: file, bytes: state.bytes, newestMs: state.newestMs ?? 0 });
    }
    return found;
  }

  /** Every stage file for this workspace. */
  async listStages(workspaceRoot: string): Promise<readonly StageEntry[]> {
    const directory = path.join(this.tempRoot, await this.stageDirectoryName(workspaceRoot));
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return [];
    }
    const found: StageEntry[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(STAGE_FILE_SUFFIX)) continue;
      const runId = entry.name.slice(0, -STAGE_FILE_SUFFIX.length);
      const state = await this.freshState({ kind: 'stage', workspaceRoot, runId });
      found.push({ runId, path: path.join(directory, entry.name), bytes: state?.bytes ?? 0 });
    }
    return found;
  }

  /** Every legacy generation that exists: the shared file and its numeric generations. */
  async listLegacy(workspaceRoot: string): Promise<readonly LegacyEntry[]> {
    const directory = path.join(workspaceRoot, CLI_TRANSPORT_DIRECTORY);
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch {
      return [];
    }
    const found: LegacyEntry[] = [];
    for (const name of names.filter((candidate) => LEGACY_NAME.test(candidate)).sort()) {
      const file = path.join(directory, name);
      try {
        const stats = await fs.lstat(file);
        if (!stats.isFile()) continue;
        found.push({
          path: file,
          name,
          bytes: stats.size,
          newestMs: await this.newestOfLegacy(workspaceRoot, name, stats)
        });
      } catch {
        // Gone between the listing and the read: nothing to report.
      }
    }
    return found;
  }

  /**
   * The time of a legacy file's last record, read through the checked walk, or its mtime when it holds no
   * readable record (an empty file, or one with no timestamp). A file the walk refuses reads as its mtime.
   */
  private async newestOfLegacy(workspaceRoot: string, name: string, stats: Stats): Promise<number> {
    if (stats.size === 0) return stats.mtimeMs;
    const opened = await openWithinRoot(workspaceRoot, [CLI_TRANSPORT_DIRECTORY, name], { flags: 'r' });
    if (opened.outcome === 'refused') return stats.mtimeMs;
    try {
      return (await readNewestRecordMs(opened.handle, stats.size)) ?? stats.mtimeMs;
    } catch {
      return stats.mtimeMs;
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  }

  /**
   * Narrow the legacy generations to owner-only where they lie (FR-008), once per host per workspace. An
   * earlier release left them at the mode the umask gave; nothing writes them now, so nothing else
   * would. Bytes are never touched, a symbolic link is refused, and only existing files are visited so
   * a missing one is not reported as a failure to narrow.
   */
  async narrowLegacy(workspaceRoot: string): Promise<void> {
    if (this.legacyNarrowed.has(workspaceRoot)) return;
    this.legacyNarrowed.add(workspaceRoot);
    const entries = await this.listLegacy(workspaceRoot);
    for (const entry of entries) {
      const verdict = await resolveContainedLink(entry.path, [workspaceRoot]);
      if (verdict.outcome !== 'contained') continue;
      const notice = noticeFor('file', await narrowMode(verdict.resolved, FILE_MODE));
      if (notice !== null) this.narrowing.report([notice]);
    }
  }
}

/** A file's lines, each with its newline, in order. A final partial line is kept as it is. */
function splitRecords(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  const records = lines.slice(0, -1).map((line) => `${line}\n`);
  const tail = lines[lines.length - 1] ?? '';
  if (tail.length > 0) records.push(tail);
  return records;
}

/**
 * The time of a file's last record, from a bounded read of its tail. The last line can be as long as the
 * file bound, so the window grows backwards until it holds the line's start or the whole file.
 */
async function readNewestRecordMs(handle: FileHandle, size: number): Promise<number | null> {
  let window = Math.min(size, TAIL_CHUNK_BYTES);
  for (;;) {
    const start = size - window;
    const chunk = Buffer.alloc(window);
    await handle.read(chunk, 0, window, start);
    const text = chunk.toString('utf8');
    const body = text.endsWith('\n') ? text.slice(0, -1) : text;
    const boundary = body.lastIndexOf('\n');
    if (boundary >= 0) return recordTimeMs(body.slice(boundary + 1));
    if (start === 0) return recordTimeMs(body);
    window = Math.min(size, window * 2);
  }
}

