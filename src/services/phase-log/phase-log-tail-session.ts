// Feature 020 T045, FR-R6-F07 (T016) — PhaseLogTailSession.
//
// Reads one stream file from a byte position and posts acknowledged batches.
// The watcher (`fs.watch` or polling) belongs to the registry; this session
// exposes `start`, `tick`, `ack`, `setVisible` and `dispose`.
//
// Invariants:
//   - Body strings ARE sanitized here, before a batch is posted. On-disk bytes
//     are NEVER altered. The order is projection, per-field truncation, the
//     SHARED sanitizer (Feature 098 PRIV-01: never a local field loop), then the
//     whole-entry budget, whose cuts are prefixes of sanitized text.
//   - Feature 020 BUG-002 (T083, FR-012a) — one projector per read position, so
//     an agy step whose lines span two ticks is emitted once. It is replaced,
//     with the framer, whenever the position moves: a rewind, a skip, a reset.
//   - Records are framed on bytes, so a multibyte character split across two
//     appends is decoded whole. An unterminated record above the residual bound
//     becomes an `oversized-record` gap; a line that does not parse becomes a
//     `parse-omission` gap. Omissions are counted once, however often replayed.
//   - Nothing is posted before the consumer's ack 0. Unacknowledged batches stay
//     within LIVE_LOG_PENDING_MAX_BYTES; an ack releases credit.
//   - Each entry carries `(at, n)`: its record's end offset and its ordinal
//     there. A batch's `toCursor` is the last projector-idle record boundary it
//     passed, or null; replay from such a boundary yields the same positions.
//   - A refused post (a hidden view) suspends the session and rewinds it to the
//     last acknowledged boundary, as a `resync` ack does.
//   - After `dispose()`, `tick()` is a no-op and nothing more is posted.
//
// See contracts/live-log-ipc.md (FR-R6-F07) and contracts/phase-log-service.md §7.

import type { FileHandle } from 'node:fs/promises';
import { openWithinRootByPath } from '../../lib/safe-open';
import { readBoundedRange } from '../../lib/bounded-read';
import {
  LIVE_LOG_BATCH_MAX_BYTES,
  LIVE_LOG_ENTRY_MAX_BYTES,
  LIVE_LOG_PENDING_MAX_BYTES,
  LIVE_LOG_PROTOCOL_VERSION,
  LIVE_LOG_READ_CHUNK_BYTES,
  LIVE_LOG_REPLAY_PASS_MAX_BYTES,
  LIVE_LOG_RESIDUAL_MAX_BYTES
} from '../../contracts/phase-log-bounds';
import type {
  LiveLogBatchMode,
  PhaseLogCursorStatus
} from '../../contracts/sidebar-ipc/phase-log';
import type { PhaseLogDisplayEntry, PhaseLogSelection } from './types';
import { StreamLineProjector } from './phase-log-display-projector';
import { sanitizeDisplayEntryBody } from './phase-log-sanitizer';
import { truncateDisplayEntryBody } from './phase-log-truncator';
import { fitEntryToBudget } from './live-log-entry-budget';
import { BatchBuilder } from './live-log-batcher';
import { LiveLogCounters, type LiveLogCounterSnapshot } from './live-log-counters';
import { RecordFramer, type FramedItem } from './live-log-record-framer';
import { alignedSnapshotStart, coverageGapEntry } from './live-log-snapshot';
import {
  cursorAtOffset,
  generationOf,
  readBeforeFromHandle,
  streamDigest,
  validateCursor,
  type CursorResetCause,
  type ReadBytesBefore
} from './live-log-cursor';

export type TailEndedReason = 'webview-stop' | 'webview-dispose' | 'phase-complete';

/** The position a terminal `tail-ended` entry takes: after every record. */
const TERMINAL_POSITION = Number.MAX_SAFE_INTEGER;

/**
 * FR-R6-F07 (FR-012) — the first `n` a refused-open gap takes at the furthest
 * offset read: past every entry one record projects to, so a consumer that has
 * applied that record still applies the gap.
 */
const REFUSAL_FIRST_N = 1_000_000;

/** Why the source could not be opened on a tick: gone, or refused by containment. */
type RefusalReason = 'artifact-expired' | 'permission-refused';

/** Cursor resets that mean the file the cursor named is gone. */
const SOURCE_REPLACED_CAUSES: ReadonlySet<CursorResetCause> = new Set([
  'generation-changed',
  'offset-past-size'
]);

export interface LiveLogBatchItem {
  readonly at: number;
  readonly n: number;
  readonly entry: PhaseLogDisplayEntry;
}

/** One batch, as the bridge posts it in MSG_PHASE_LOG_BATCH. */
export interface PhaseLogBatchPush {
  readonly protocol: typeof LIVE_LOG_PROTOCOL_VERSION;
  readonly tailSessionId: string;
  readonly batchSeq: number;
  readonly generation: string;
  readonly mode: LiveLogBatchMode;
  readonly toCursor: string | null;
  readonly entries: readonly LiveLogBatchItem[];
}

export interface TailSessionStart {
  readonly snapshotCutoff: string;
  readonly nextCursor: string;
  readonly cursorStatus: PhaseLogCursorStatus;
}

export interface TailSessionAck {
  readonly batchSeq: number;
  readonly resync?: boolean;
  readonly duplicate?: boolean;
}

export interface PhaseLogTailCaps {
  readonly perFieldBytes: number;
  /** The unterminated-record bound; LIVE_LOG_RESIDUAL_MAX_BYTES when absent. */
  readonly residualMaxBytes?: number;
}

export interface PhaseLogTailSessionDeps {
  readonly sessionId: string;
  /**
   * FR-R3-080 (T1071) — the trusted root the tailed file must sit under.
   * Required: a tail session with no root would open its file by pathname.
   */
  readonly workspaceRoot: string;
  readonly filePath: string;
  readonly selection: PhaseLogSelection;
  readonly sanitize: (s: string) => string;
  readonly caps: PhaseLogTailCaps;
  /** Posts one batch; false when it was not delivered, for example to a hidden view. */
  readonly postBatch: (batch: PhaseLogBatchPush) => boolean;
}

type CarryItem =
  | { readonly kind: 'entry'; readonly item: LiveLogBatchItem }
  | { readonly kind: 'idle'; readonly end: number };

interface PostedBatch {
  readonly batchSeq: number;
  readonly bytes: number;
  readonly toOffset: number | null;
  readonly mode: LiveLogBatchMode;
}

export class PhaseLogTailSession {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly filePath: string;
  readonly selection: PhaseLogSelection;

  private readonly postBatch: (batch: PhaseLogBatchPush) => boolean;
  private readonly sanitize: (s: string) => string;
  private readonly caps: { readonly perFieldBytes: number };
  private readonly residualMaxBytes: number;
  private readonly digest: string;
  private readonly counterSet = new LiveLogCounters();
  private readonly builder = new BatchBuilder<LiveLogBatchItem>(LIVE_LOG_BATCH_MAX_BYTES);

  private generation = '';
  /** The next byte to read; the framer has been fed everything before it. */
  private readOffset = 0;
  private framer = new RecordFramer(0);
  private projector = new StreamLineProjector();
  private carry: CarryItem[] = [];
  private batchIdleEnd: number | null = null;
  private ackedOffset = 0;
  private unacked: PostedBatch[] = [];
  private pendingBytes = 0;
  private nextBatchSeq = 1;
  private mode: LiveLogBatchMode = 'reset';
  /** True until a `reset` batch is acknowledged; a rewind before then replays as `reset`. */
  private resetPending = false;
  /** Gaps that lead the reset batch, re-sent if it is replayed. */
  private leadingGaps: PhaseLogDisplayEntry[] = [];
  /** Omissions at or before this offset are already counted. */
  private countedThrough = 0;
  private skippedLeadingBytes = 0;
  /** The furthest byte read in this generation; a rewind does not lower it. */
  private furthestRead = 0;
  /** The refusal the last tick met, counted once until an open succeeds again. */
  private refusal: RefusalReason | null = null;
  /** True once the gap for `refusal` is queued; a rewind re-arms it. */
  private refusalQueued = false;
  private refusalSlot = 0;
  private seq = 0;
  private skipped = 0;
  private started = false;
  private ready = false;
  private suspended = false;
  private disposed = false;
  private inTick = false;
  private tickRequested = false;
  private rewindRequested = false;

  constructor(deps: PhaseLogTailSessionDeps) {
    this.sessionId = deps.sessionId;
    this.workspaceRoot = deps.workspaceRoot;
    this.filePath = deps.filePath;
    this.selection = deps.selection;
    this.postBatch = deps.postBatch;
    this.sanitize = deps.sanitize;
    this.caps = { perFieldBytes: deps.caps.perFieldBytes };
    this.residualMaxBytes = deps.caps.residualMaxBytes ?? LIVE_LOG_RESIDUAL_MAX_BYTES;
    this.digest = streamDigest(deps.workspaceRoot, deps.selection);
  }

  /** Lines that did not parse, each counted once. */
  get skippedLines(): number {
    return this.skipped;
  }

  /**
   * FR-R3-052 — bytes before the snapshot start this session never read. A
   * counter nothing can read is a silent cap.
   */
  get skippedLeadingByteCount(): number {
    return this.skippedLeadingBytes;
  }

  /** FR-R6-F03, FR-R6-F07 — bytes held for an unterminated record. */
  get retainedResidualBytes(): number {
    return this.framer.retainedBytes;
  }

  /** FR-R6-F07 (NFR-003) — serialized bytes posted and not yet acknowledged. */
  get pendingDeliveryBytes(): number {
    return this.pendingBytes;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  counters(): LiveLogCounterSnapshot {
    return this.counterSet.snapshot();
  }

  /**
   * Opens the file, settles where reading starts and returns the cursors the
   * start response carries. Null when the file cannot be opened within the root.
   */
  async start(fromCursor?: string): Promise<TailSessionStart | null> {
    const opened = await openWithinRootByPath(this.workspaceRoot, this.filePath, { flags: 'r' });
    if (opened.outcome === 'refused') return null;
    const handle = opened.handle;
    try {
      const stat = await handle.stat();
      this.generation = generationOf(stat, process.platform);
      const readBefore = readBeforeFromHandle(handle);
      const settled = await this.settleStart(handle, stat.size, readBefore, fromCursor);
      this.started = true;
      const cursor = await cursorAtOffset(this.stream(), settled.offset, readBefore);
      return { snapshotCutoff: cursor, nextCursor: cursor, cursorStatus: settled.cursorStatus };
    } finally {
      await closeQuietly(handle);
    }
  }

  private async settleStart(
    handle: FileHandle,
    size: number,
    readBefore: ReadBytesBefore,
    fromCursor: string | undefined
  ): Promise<{ offset: number; cursorStatus: PhaseLogCursorStatus }> {
    if (fromCursor === undefined) {
      await this.resetTo(handle, size, false);
      return { offset: this.ackedOffset, cursorStatus: 'none' };
    }
    const expected = { digest: this.digest, generation: this.generation, size };
    const verdict = await validateCursor(fromCursor, expected, readBefore);
    if (verdict.outcome === 'accepted') {
      this.mode = 'resume';
      this.ackedOffset = verdict.offset;
      this.countedThrough = verdict.offset;
      this.position(verdict.offset);
      return { offset: verdict.offset, cursorStatus: 'accepted' };
    }
    const replaced = verdict.outcome === 'reset' && SOURCE_REPLACED_CAUSES.has(verdict.cause);
    await this.resetTo(handle, size, replaced);
    return { offset: this.ackedOffset, cursorStatus: verdict.outcome };
  }

  /** Starts over at the newest snapshot, as a `reset` batch. */
  private async resetTo(handle: FileHandle, size: number, replaced: boolean): Promise<void> {
    const start = await alignedSnapshotStart(handle, size);
    this.leadingGaps = [];
    if (replaced) {
      this.counterSet.add('sourceResets');
      this.leadingGaps.push(coverageGapEntry('source-replaced', 1, 0));
    }
    if (size === 0 && !replaced) {
      this.counterSet.add('deliveryGaps');
      this.leadingGaps.push(coverageGapEntry('not-yet-produced', 1));
    }
    if (start > 0) {
      this.skippedLeadingBytes += start;
      this.counterSet.add('deliveryGaps');
      this.counterSet.add('omittedBytes', start);
      this.leadingGaps.push(coverageGapEntry('range-skipped', 1, start));
    }
    this.furthestRead = start;
    this.unacked = [];
    this.pendingBytes = 0;
    this.ackedOffset = start;
    this.countedThrough = start;
    this.mode = 'reset';
    this.resetPending = true;
    this.position(start);
  }

  /** Reads from `offset` with a fresh framer and projector, dropping unposted entries. */
  private position(offset: number): void {
    this.readOffset = offset;
    this.framer = new RecordFramer(offset, this.residualMaxBytes);
    this.projector = new StreamLineProjector();
    this.builder.take();
    this.carry = [];
    this.batchIdleEnd = null;
    this.refusalQueued = false;
    if (!this.resetPending) return;
    this.leadingGaps.forEach((entry, n) => {
      this.carry.push({ kind: 'entry', item: { at: offset, n, entry: this.stamp(entry) } });
    });
  }

  ack(input: TailSessionAck): void {
    if (this.disposed) return;
    if (input.duplicate === true) this.counterSet.add('duplicateBatches');
    if (input.batchSeq === 0) this.ready = true;
    this.release(input.batchSeq);
    if (input.resync === true) {
      this.counterSet.add('replayAttempts');
      this.counterSet.add('deliveryGaps');
      this.rewindRequested = true;
    }
  }

  /** Hidden: post nothing and rewind on reveal. Visible: resume. */
  setVisible(visible: boolean): void {
    if (this.disposed) return;
    if (!visible) {
      this.suspended = true;
      this.rewindRequested = true;
      return;
    }
    this.suspended = false;
  }

  private release(batchSeq: number): void {
    for (let head = this.unacked.at(0); head !== undefined && head.batchSeq <= batchSeq; head = this.unacked.at(0)) {
      this.unacked.shift();
      this.pendingBytes -= head.bytes;
      if (head.toOffset !== null) this.ackedOffset = head.toOffset;
      if (head.mode === 'reset') {
        this.resetPending = false;
        this.leadingGaps = [];
      }
    }
  }

  async tick(): Promise<void> {
    if (this.inTick) {
      this.tickRequested = true;
      return;
    }
    this.inTick = true;
    try {
      do {
        this.tickRequested = false;
        await this.tickOnce();
      } while (this.shouldTickAgain());
    } finally {
      this.inTick = false;
    }
  }

  /** A tick requested while one was in progress runs once more, unless disposed. */
  private shouldTickAgain(): boolean {
    return this.tickRequested && !this.disposed;
  }

  private async tickOnce(): Promise<void> {
    if (this.disposed || !this.started || !this.ready || this.suspended) return;
    // FR-R3-080 (T1071) — the components walked, not just the leaf opened. A
    // refusal waits for the next tick with state preserved: a view that cannot
    // prove its file shows nothing rather than whatever the path now names.
    // FR-R6-F07 (FR-012) — and says so, once, as a coverage gap.
    const opened = await openWithinRootByPath(this.workspaceRoot, this.filePath, { flags: 'r' });
    if (opened.outcome === 'refused') {
      const gone = opened.reason === 'io-failed' && opened.errno === 'ENOENT';
      await this.onRefused(gone ? 'artifact-expired' : 'permission-refused');
      return;
    }
    this.refusal = null;
    const handle = opened.handle;
    try {
      const stat = await handle.stat();
      if (this.rewindRequested) this.applyRewind();
      await this.checkSource(handle, stat);
      await this.pump(handle, stat.size, readBeforeFromHandle(handle));
    } finally {
      await closeQuietly(handle);
    }
  }

  /**
   * One gap per refusal, after everything read, counted once until an open
   * succeeds again. Nothing is read; the batch carries no cursor.
   */
  private async onRefused(reason: RefusalReason): Promise<void> {
    if (this.rewindRequested) this.applyRewind();
    if (reason !== this.refusal) {
      this.refusal = reason;
      this.refusalQueued = false;
      this.counterSet.add('deliveryGaps');
    }
    if (!this.refusalQueued) {
      this.refusalQueued = true;
      const n = REFUSAL_FIRST_N + this.refusalSlot;
      this.refusalSlot += 1;
      this.pushEntry(this.furthestRead, n, coverageGapEntry(reason, 1));
    }
    if (!(await this.drainCarry(null))) return;
    if (!this.builder.isEmpty && this.hasCredit()) await this.flush(null);
  }

  private applyRewind(): void {
    this.rewindRequested = false;
    this.unacked = [];
    this.pendingBytes = 0;
    this.mode = this.resetPending ? 'reset' : 'resume';
    this.position(this.ackedOffset);
  }

  /** A replaced or truncated file resets; a backlog above one pass skips ahead. */
  private async checkSource(
    handle: FileHandle,
    stat: { size: number; dev: number; ino: number; birthtimeMs: number }
  ): Promise<void> {
    const generation = generationOf(stat, process.platform);
    if (generation !== this.generation || stat.size < this.readOffset) {
      this.generation = generation;
      await this.resetTo(handle, stat.size, true);
      return;
    }
    if (stat.size - this.readOffset <= LIVE_LOG_REPLAY_PASS_MAX_BYTES) return;
    const start = await alignedSnapshotStart(handle, stat.size);
    const skippedBytes = start - this.framer.consumedOffset;
    // A replay from an acknowledged offset before this skip meets it again; count only bytes not yet counted.
    const uncountedFrom = Math.max(this.framer.consumedOffset, this.countedThrough);
    if (start > uncountedFrom) {
      this.counterSet.add('deliveryGaps');
      this.counterSet.add('omittedBytes', start - uncountedFrom);
      this.countedThrough = start;
    }
    this.readOffset = start;
    this.furthestRead = Math.max(this.furthestRead, start);
    this.framer = new RecordFramer(start, this.residualMaxBytes);
    this.projector = new StreamLineProjector();
    if (this.mode === 'continue') this.mode = 'resume';
    const gap = this.stamp(coverageGapEntry('range-skipped', 1, skippedBytes));
    this.carry.push({ kind: 'entry', item: { at: start, n: 0, entry: gap } });
  }

  private async pump(handle: FileHandle, size: number, readBefore: ReadBytesBefore): Promise<void> {
    for (;;) {
      if (this.disposed || this.rewindRequested || this.suspended) return;
      if (!(await this.drainCarry(readBefore))) return;
      const item = this.framer.next();
      if (item !== null) {
        this.accept(item);
        continue;
      }
      if (this.readOffset >= size) break;
      const wanted = Math.min(LIVE_LOG_READ_CHUNK_BYTES, size - this.readOffset);
      const range = await readBoundedRange(handle, this.readOffset, wanted, wanted);
      if (range.bytes.length === 0) break;
      this.framer.feed(range.bytes);
      this.readOffset = range.nextOffset;
      this.furthestRead = Math.max(this.furthestRead, this.readOffset);
    }
    if (!this.builder.isEmpty && this.hasCredit()) await this.flush(readBefore);
  }

  /** Moves carried entries into the batch, posting full batches; false when blocked. */
  private async drainCarry(readBefore: ReadBytesBefore | null): Promise<boolean> {
    for (let next = this.carry.shift(); next !== undefined; next = this.carry.shift()) {
      if (next.kind === 'idle') {
        this.batchIdleEnd = next.end;
        continue;
      }
      if (this.builder.tryAdd(next.item)) continue;
      this.carry.unshift(next);
      if (!this.hasCredit()) return false;
      if (!(await this.flush(readBefore))) return false;
    }
    return true;
  }

  private hasCredit(): boolean {
    return this.pendingBytes + LIVE_LOG_BATCH_MAX_BYTES <= LIVE_LOG_PENDING_MAX_BYTES;
  }

  private accept(item: FramedItem): void {
    if (item.kind === 'oversized-record') {
      if (this.countOnce(item.at)) this.counterSet.add('omittedRecords');
      this.pushEntry(item.at, 0, coverageGapEntry('oversized-record', 1));
      return;
    }
    if (item.kind === 'record') {
      const prepared = this.projector.project(item.value).map((entry) => this.prepare(entry));
      // FR-R6-F07 (FR-016) — a record no shrink could fit is one omitted record.
      if (prepared.some(isDisplayTruncation) && this.countOnce(item.end)) {
        this.counterSet.add('omittedRecords');
      }
      prepared.forEach((entry, n) => {
        this.pushEntry(item.end, n, entry);
      });
    } else if (item.kind === 'parse-omission') {
      if (this.countOnce(item.end)) {
        this.skipped += 1;
        this.counterSet.add('omittedRecords');
        this.counterSet.add('omittedBytes', item.bytes);
      }
      this.pushEntry(item.end, 0, coverageGapEntry('parse-omission', 1, item.bytes));
    } else if (this.countOnce(item.end)) {
      this.counterSet.add('omittedBytes', item.bytes);
    }
    if (this.projector.isIdle()) this.carry.push({ kind: 'idle', end: item.end });
  }

  /** True the first time an omission at `offset` is seen; replays do not recount it. */
  private countOnce(offset: number): boolean {
    if (offset <= this.countedThrough) return false;
    this.countedThrough = offset;
    return true;
  }

  private pushEntry(at: number, n: number, entry: PhaseLogDisplayEntry): void {
    this.carry.push({ kind: 'entry', item: { at, n, entry: this.stamp(entry) } });
  }

  private prepare(entry: PhaseLogDisplayEntry): PhaseLogDisplayEntry {
    const truncated = truncateDisplayEntryBody(entry, this.caps);
    const sanitized = sanitizeDisplayEntryBody(truncated, this.sanitize);
    return fitEntryToBudget(sanitized, LIVE_LOG_ENTRY_MAX_BYTES);
  }

  private stamp(entry: PhaseLogDisplayEntry): PhaseLogDisplayEntry {
    this.seq += 1;
    return { ...entry, seq: this.seq };
  }

  /**
   * Posts the built batch; false when it was not delivered. With no file to
   * read (`readBefore` null) the batch carries no cursor and moves no offset.
   */
  private async flush(readBefore: ReadBytesBefore | null): Promise<boolean> {
    const toOffset = readBefore === null ? null : this.batchIdleEnd;
    const toCursor =
      readBefore === null || toOffset === null ? null : await cursorAtOffset(this.stream(), toOffset, readBefore);
    if (this.disposed || this.rewindRequested) return false;
    const bytes = this.builder.bytes;
    const batch: PhaseLogBatchPush = {
      protocol: LIVE_LOG_PROTOCOL_VERSION,
      tailSessionId: this.sessionId,
      batchSeq: this.nextBatchSeq,
      generation: this.generation,
      mode: this.mode,
      toCursor,
      entries: this.builder.take()
    };
    if (!this.postBatch(batch)) {
      this.suspended = true;
      this.rewindRequested = true;
      return false;
    }
    this.unacked.push({ batchSeq: batch.batchSeq, bytes, toOffset, mode: batch.mode });
    this.pendingBytes += bytes;
    this.nextBatchSeq += 1;
    this.mode = 'continue';
    this.batchIdleEnd = null;
    return true;
  }

  private stream(): { digest: string; generation: string } {
    return { digest: this.digest, generation: this.generation };
  }

  /**
   * Ends the session. A ready consumer gets one terminal batch holding a
   * `tail-ended` entry after every record; credit does not apply to it.
   */
  async dispose(reason: TailEndedReason): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.ready) return;
    const entry = this.stamp({
      seq: 0,
      kind: 'tail-ended',
      ts: null,
      body: { reason },
      bodyTruncated: null
    });
    this.postBatch({
      protocol: LIVE_LOG_PROTOCOL_VERSION,
      tailSessionId: this.sessionId,
      batchSeq: this.nextBatchSeq,
      generation: this.generation,
      // A reset not yet flushed must not clear what the view shows as the session ends.
      mode: this.mode === 'reset' ? 'resume' : this.mode,
      toCursor: null,
      entries: [{ at: TERMINAL_POSITION, n: 0, entry }]
    });
    this.nextBatchSeq += 1;
  }
}

function isDisplayTruncation(entry: PhaseLogDisplayEntry): boolean {
  return entry.kind === 'coverage-gap' && entry.body.reason === 'display-truncation';
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // best-effort
  }
}
