// ---------------------------------------------------------------------------
// FR-R4-F15 (feature 243, contracts C3 and C5) — where a failure record is written, listed and read.
//
// One file per failure, in `.schegent/failure-records/`, beside `.schegent/sessions/` and
// `.schegent/history/`. Remove deletes the session tree and nothing here, which is the whole point of
// the directory. The shape follows `history-description-store.ts`: every open goes through
// `openWithinRoot`, which refuses a link at every component and at the leaf; names are parsed strictly
// so a file this feature did not write is left alone; and a failure is reported by code, never by the
// caught message, which quotes the absolute path it was addressing.
//
// WRITING. A record is created exclusively (`wx`) under declared owner-only modes, so a second failure
// of the same Run is a second file and no path ever opens an existing record for writing. A name that
// already exists draws a new suffix, at most three opens in all. A write or close that fails after the
// open removes the file it created, through a containment check.
//
// READING. The reader never writes, renames, narrows or deletes. A file over 32,768 bytes is malformed
// without being read; the rest is decoded as strict UTF-8, parsed, and checked by the one validator
// the webview shares, against the identity its own name carries.
// ---------------------------------------------------------------------------

import { promises as fsp, type Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import {
  FAILURE_RECORD_DIR,
  FAILURE_RECORD_MAX_BYTES,
  recordFileName,
  type FailureRecordV1,
  type ParsedRecordName
} from '../../contracts/failure-record';
import { isValidFailureRecord, parseRecordName } from '../../contracts/validators/failure-record';
import { NarrowingReporter } from '../../lib/evidence-narrowing';
import type { SanitizedLogger } from '../../lib/logger';
import { resolveContainedTarget } from '../../lib/path-containment';
import { openWithinRoot, type SafeOpenResult } from '../../lib/safe-open';
import { historyErrorCode } from '../history/error-code';

/** C3.2 — the opens one write may spend on name collisions before it gives up. */
const MAX_OPENS = 3;

/**
 * The few filesystem calls a real directory cannot be made to fail on demand. Each defaults to the
 * Node call and each is replaceable in a test; nothing else about the store is injectable, because a
 * temporary directory is the better double for everything else.
 */
export interface FailureRecordFsOps {
  readdir(directory: string): Promise<readonly Dirent[]>;
  write(handle: FileHandle, text: string): Promise<void>;
  close(handle: FileHandle): Promise<void>;
  /** Reads at most `maxBytes + 1` bytes from the start, so a file that grew past the bound is seen. */
  read(handle: FileHandle, maxBytes: number): Promise<Buffer>;
  rm(target: string): Promise<void>;
}

const NODE_FS: FailureRecordFsOps = {
  readdir: (directory) => fsp.readdir(directory, { withFileTypes: true }),
  write: async (handle, text) => {
    await handle.write(text, null, 'utf8');
  },
  close: (handle) => handle.close(),
  read: async (handle, maxBytes) => {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    return buffer.subarray(0, bytesRead);
  },
  rm: (containedTarget) => fsp.rm(containedTarget, { force: true })
};

export interface FailureRecordStoreDeps {
  readonly workspaceRoot: string;
  readonly logger: Pick<SanitizedLogger, 'warn'>;
  readonly fs?: Partial<FailureRecordFsOps>;
}

/** Which step failed, as the recorder's single warning names it. */
export type RecordWriteOperation = 'create' | 'write' | 'close';

export type FailureRecordWriteResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly operation: RecordWriteOperation;
      readonly errorCode: string;
      /** Present only when the partial file could not be removed either. */
      readonly cleanup?: 'failed';
    };

/** A record name found in the directory, with the identity it carries. */
export interface ListedRecord extends ParsedRecordName {
  readonly name: string;
}

export type FailureRecordListing =
  | { readonly outcome: 'listed'; readonly records: readonly ListedRecord[] }
  | { readonly outcome: 'unreadable'; readonly code: string };

export type ReadNewestOutcome =
  | { readonly outcome: 'none' }
  | { readonly outcome: 'unreadable'; readonly code: string }
  | { readonly outcome: 'read'; readonly record: FailureRecordV1; readonly recordCount: number }
  | { readonly outcome: 'malformed'; readonly recordCount: number };

type ReadOne =
  | { readonly kind: 'vanished' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'record'; readonly record: FailureRecordV1 };

/** A refusal's most specific code: the errno when the syscall said one, else the refusal's reason. */
function refusalCode(refused: { readonly reason: string; readonly errno: string }): string {
  return refused.errno === 'none' || refused.errno === 'unknown' ? refused.reason : refused.errno;
}

/** Newest first: the greater stamp, then the greater suffix. Both are fixed width, so strings order. */
function newestFirst(left: ParsedRecordName, right: ParsedRecordName): number {
  if (left.stamp !== right.stamp) return left.stamp < right.stamp ? 1 : -1;
  if (left.suffix !== right.suffix) return left.suffix < right.suffix ? 1 : -1;
  return 0;
}

export class FailureRecordStore {
  private readonly workspaceRoot: string;
  private readonly fs: FailureRecordFsOps;
  /** Feature 217 — says once, path-free, what narrowing found. */
  private readonly narrowing: NarrowingReporter;

  constructor(deps: FailureRecordStoreDeps) {
    this.workspaceRoot = deps.workspaceRoot;
    this.fs = { ...NODE_FS, ...deps.fs };
    this.narrowing = new NarrowingReporter('failure-record:', (message) => deps.logger.warn(message));
  }

  private recordsRoot(): string {
    return path.join(this.workspaceRoot, ...FAILURE_RECORD_DIR);
  }

  /**
   * C3 — write `record` to a file of its own.
   *
   * `drawSuffix` supplies a new suffix after a collision. The record's own `suffix` field is replaced
   * with it, because the field and the name's suffix must agree, and the size does not change: a
   * suffix is 8 characters either way.
   */
  public async write(record: FailureRecordV1, drawSuffix: () => string): Promise<FailureRecordWriteResult> {
    let current = record;
    for (let attempt = 1; attempt <= MAX_OPENS; attempt += 1) {
      const name = recordFileName(current);
      if (name === null) return { ok: false, operation: 'create', errorCode: 'invalid-name' };
      let opened: SafeOpenResult;
      try {
        opened = await openWithinRoot(this.workspaceRoot, [...FAILURE_RECORD_DIR, name], {
          flags: 'wx',
          createDirs: true,
          dirMode: 0o700,
          fileMode: 0o600
        });
      } catch (error) {
        return { ok: false, operation: 'create', errorCode: historyErrorCode(error) };
      }
      if (opened.outcome === 'refused') {
        if (opened.errno === 'EEXIST' && attempt < MAX_OPENS) {
          current = { ...current, suffix: drawSuffix() };
          continue;
        }
        return { ok: false, operation: 'create', errorCode: refusalCode(opened) };
      }
      this.narrowing.report(opened.narrowing);
      return this.writeAndClose(opened.handle, name, current);
    }
    return { ok: false, operation: 'create', errorCode: 'EEXIST' };
  }

  private async writeAndClose(
    handle: FileHandle,
    name: string,
    record: FailureRecordV1
  ): Promise<FailureRecordWriteResult> {
    let failure: { operation: RecordWriteOperation; errorCode: string } | null = null;
    try {
      await this.fs.write(handle, JSON.stringify(record, null, 2) + '\n');
    } catch (error) {
      failure = { operation: 'write', errorCode: historyErrorCode(error) };
    }
    // The handle is closed whether or not the write succeeded, so a failed write leaks nothing.
    try {
      await this.fs.close(handle);
    } catch (error) {
      failure ??= { operation: 'close', errorCode: historyErrorCode(error) };
    }
    if (failure === null) return { ok: true };
    const removed = await this.removePartial(name);
    return removed ? { ok: false, ...failure } : { ok: false, ...failure, cleanup: 'failed' };
  }

  /** C3.4 — remove the file this write created, and only that file, through a containment check. */
  private async removePartial(name: string): Promise<boolean> {
    try {
      const root = this.recordsRoot();
      const verdict = await resolveContainedTarget(path.join(root, name), [root]);
      if (verdict.outcome === 'absent') return true;
      if (verdict.outcome !== 'contained') return false;
      await this.fs.rm(verdict.resolved);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * C5.1 — the record names in the directory, newest first, optionally for one Run.
   *
   * Only regular files whose names parse: a symlink is not `isFile()`, and a directory, a foreign
   * file, `.pending` and a `.lock` file do not parse. The Run is matched by exact segment, never by
   * substring. A directory that does not exist is an empty list; one that cannot be read is
   * `unreadable`, with a code and never a message.
   */
  public async list(runId?: string): Promise<FailureRecordListing> {
    const directory = path.join(this.workspaceRoot, ...FAILURE_RECORD_DIR);
    const verdict = await resolveContainedTarget(directory, [this.workspaceRoot]);
    if (verdict.outcome === 'absent') return { outcome: 'listed', records: [] };
    if (verdict.outcome === 'refused') return { outcome: 'unreadable', code: refusalCode(verdict) };
    let entries: readonly Dirent[];
    try {
      entries = await this.fs.readdir(verdict.resolved);
    } catch (error) {
      const code = historyErrorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return { outcome: 'listed', records: [] };
      return { outcome: 'unreadable', code };
    }
    const records: ListedRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const parsed = parseRecordName(entry.name);
      if (parsed === null || (runId !== undefined && parsed.runId !== runId)) continue;
      records.push({ ...parsed, name: entry.name });
    }
    return { outcome: 'listed', records: records.sort(newestFirst) };
  }

  /**
   * C5.2 — the newest record of a Run, read and validated.
   *
   * The newest only: a malformed newest is reported as malformed, not replaced by an older valid
   * record, because the panel says what the Run's latest failure left. A name that vanished between
   * the listing and the open is dropped and the next is tried.
   */
  public async readNewest(runId: string): Promise<ReadNewestOutcome> {
    const listing = await this.list(runId);
    if (listing.outcome === 'unreadable') return listing;
    let remaining = listing.records;
    while (remaining.length > 0) {
      const newest = remaining[0];
      const read = await this.readOne(newest);
      if (read.kind === 'vanished') {
        remaining = remaining.slice(1);
        continue;
      }
      if (read.kind === 'malformed') return { outcome: 'malformed', recordCount: remaining.length };
      return { outcome: 'read', record: read.record, recordCount: remaining.length };
    }
    return { outcome: 'none' };
  }

  private async readOne(listed: ListedRecord): Promise<ReadOne> {
    let opened: SafeOpenResult;
    try {
      opened = await openWithinRoot(this.workspaceRoot, [...FAILURE_RECORD_DIR, listed.name], { flags: 'r' });
    } catch {
      return { kind: 'malformed' };
    }
    if (opened.outcome === 'refused') {
      // A name gone since the listing is not a defect; any other refusal (a link swapped in, a mode
      // that denies the read) leaves a file the panel cannot show.
      const gone = opened.errno === 'ENOENT' || opened.errno === 'ENOTDIR';
      return gone ? { kind: 'vanished' } : { kind: 'malformed' };
    }
    try {
      const stat = await opened.handle.stat();
      if (!stat.isFile() || stat.size > FAILURE_RECORD_MAX_BYTES) return { kind: 'malformed' };
      const bytes = await this.fs.read(opened.handle, FAILURE_RECORD_MAX_BYTES);
      if (bytes.length > FAILURE_RECORD_MAX_BYTES) return { kind: 'malformed' };
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      return isValidFailureRecord(value, listed) ? { kind: 'record', record: value } : { kind: 'malformed' };
    } catch {
      return { kind: 'malformed' };
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  }
}
