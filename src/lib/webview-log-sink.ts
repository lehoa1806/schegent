/**
 * WebviewLogSink — ring-buffer LogSink that captures sanitized log lines
 * for projection into the webview's System tab via STATE_SNAPSHOT.
 *
 * The sink parses each line emitted by SanitizedLogger.write() into a
 * structured DebugLogEntry and stores it in a fixed-capacity ring buffer.
 * When the buffer overflows, the oldest entry is evicted.
 *
 * The getEntries() snapshot is called by the StateProjector during each
 * snapshot build. It returns a frozen copy of the current buffer contents
 * in chronological order (oldest first), so the webview can reverse for
 * display.
 *
 * Thread safety: single-threaded (VS Code extension host is
 * single-threaded). No locking required.
 */

import type { LogSink } from './logger';

// FR-R3-132 (T1502) — moved to `src/contracts/snapshot-vocabulary.ts` so the webview
// imports it instead of restating it. Re-exported unchanged.
import type { DebugLogEntry } from '../contracts/snapshot-vocabulary';

export type { DebugLogEntry };




const VALID_LEVELS = new Set(['DEBUG', 'INFO', 'WARN', 'ERROR']);

// SanitizedLogger emits lines in the format:
//   [2026-07-30T20:14:02.071Z] DEBUG router: inbound {"type":"..."}
// Group 1: ISO timestamp, Group 2: level, Group 3: message body.
const LINE_PATTERN = /^\[([^\]]+)\]\s+(DEBUG|INFO|WARN|ERROR)\s+([\s\S]*)$/;

export const DEBUG_LOG_TAIL_MAX = 200;

export class WebviewLogSink implements LogSink {
  private readonly buffer: DebugLogEntry[];
  private readonly capacity: number;
  private head = 0; // next write position
  private size = 0;
  private counter = 0;

  private onAppend?: () => void;

  constructor(capacity: number = DEBUG_LOG_TAIL_MAX) {
    this.capacity = Math.max(1, capacity);
    this.buffer = new Array<DebugLogEntry>(this.capacity);
  }

  public setOnAppend(callback: () => void): void {
    this.onAppend = callback;
  }

  appendLine(line: string): void {
    const match = LINE_PATTERN.exec(line);
    if (!match) return; // malformed line — skip silently

    const [, timestamp, levelStr, message] = match;
    if (!VALID_LEVELS.has(levelStr)) return;

    const entry: DebugLogEntry = Object.freeze({
      id: ++this.counter,
      timestamp,
      level: levelStr as DebugLogEntry['level'],
      message
    });

    this.buffer[this.head] = entry;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
    this.onAppend?.();
  }

  /**
   * Return a chronologically ordered snapshot of the current buffer.
   * Called by StateProjector during each snapshot build cycle.
   */
  getEntries(): readonly DebugLogEntry[] {
    if (this.size === 0) return [];
    const result: DebugLogEntry[] = new Array(this.size);
    const start = this.size < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.size; i++) {
      result[i] = this.buffer[(start + i) % this.capacity];
    }
    return Object.freeze(result);
  }

  /** Current number of buffered entries. */
  get length(): number {
    return this.size;
  }

  /** Reset the buffer. */
  clear(): void {
    this.head = 0;
    this.size = 0;
    this.buffer.fill(undefined as unknown as DebugLogEntry);
  }
}
