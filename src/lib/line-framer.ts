/**
 * FR-R3-052 (H-03) — one bounded incremental framer, shared by the monitor and
 * the Claude runner.
 *
 * Both had the same defect in different shapes. The monitor did
 * `splitLines(state.stdoutBuffer + chunk)` and assigned the remainder straight
 * back, and `splitLines` returns the WHOLE buffer as the remainder when it finds
 * no newline. The runner did `stdoutLineBuffer += char`, reset only on a
 * newline. Either way, a stream that never emits a newline retains every byte
 * the CLI has produced, in one string, for the life of the invocation.
 *
 * The 64 MiB compressed capture bound does not help. It bounds what is CAPTURED;
 * this bounds what is held while deciding where a line ends. Measured before the
 * fix: 8 MiB of newline-free output, 8 MiB retained.
 *
 * NO SILENT CAPS
 *
 * A truncating framer that says nothing turns a corrupted stream into a
 * plausible one. Every truncation is counted and every discarded byte is
 * counted, so a caller can put both in evidence rather than a reader inferring
 * from a line that merely looks short.
 *
 * WHAT THE LIMIT COUNTS
 *
 * UTF-16 code units, because that is what the runtime holds and what these
 * callers receive: `child.stdout` is read as strings, not Buffers. Memory is up
 * to twice the limit in bytes. Named for what it counts rather than for the
 * "byte size" the requirement asks for, because a limit that claims bytes and
 * counts units is off by a factor nobody remembers at the wrong moment.
 */

/** One logical line, in UTF-16 code units. 1 MiB is far above any real record. */
export const DEFAULT_MAX_LINE_UNITS = 1024 * 1024;

export interface FramedOutput {
  /** Complete logical lines, in order. Empty lines are dropped, as before. */
  readonly lines: readonly string[];
  /** How many of `lines` were cut at the limit rather than at a newline. */
  readonly truncatedLines: number;
  /** Units discarded after a truncation, before the next newline arrived. */
  readonly droppedUnits: number;
}

const EMPTY: FramedOutput = Object.freeze({
  lines: Object.freeze([]),
  truncatedLines: 0,
  droppedUnits: 0
});

export class LineFramer {
  private buffer = '';
  /**
   * Set after a truncation: everything up to the next newline belongs to a line
   * already emitted, so it is discarded rather than framed as a line of its own.
   * Without this, one oversized record becomes a stream of bogus lines, each
   * looking like real output to every downstream consumer.
   */
  private discarding = false;
  private totalTruncated = 0;
  private totalDropped = 0;

  public constructor(private readonly maxLineUnits: number = DEFAULT_MAX_LINE_UNITS) {
    if (!Number.isInteger(maxLineUnits) || maxLineUnits < 1) {
      throw new Error(`LineFramer: maxLineUnits must be a positive integer, got ${maxLineUnits}`);
    }
  }

  /** Units currently held while waiting for a newline. Never above the limit. */
  public get retainedUnits(): number {
    return this.buffer.length;
  }

  /**
   * The held text itself. Exposed because the monitor publishes it as observable
   * state, and a state field that no longer matches what is actually retained is
   * worse than no field.
   */
  public get retained(): string {
    return this.buffer;
  }

  public get totals(): { readonly truncatedLines: number; readonly droppedUnits: number } {
    return { truncatedLines: this.totalTruncated, droppedUnits: this.totalDropped };
  }

  public append(chunk: string): FramedOutput {
    if (chunk.length === 0) return EMPTY;

    const lines: string[] = [];
    let truncated = 0;
    let dropped = 0;
    let rest = chunk;

    while (rest.length > 0) {
      if (this.discarding) {
        const nl = rest.indexOf('\n');
        if (nl === -1) {
          dropped += rest.length;
          rest = '';
          break;
        }
        dropped += nl;
        this.discarding = false;
        rest = rest.slice(nl + 1);
        continue;
      }

      const nl = rest.indexOf('\n');
      if (nl === -1) {
        // No line end in what is left. Take it, then check the bound -- taking
        // first is what keeps a conforming stream's framing byte-identical.
        this.buffer += rest;
        rest = '';
        if (this.buffer.length > this.maxLineUnits) {
          lines.push(this.buffer.slice(0, this.maxLineUnits));
          dropped += this.buffer.length - this.maxLineUnits;
          this.buffer = '';
          this.discarding = true;
          truncated += 1;
        }
        break;
      }

      const candidate = this.buffer + rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      this.buffer = '';
      if (candidate.length > this.maxLineUnits) {
        lines.push(candidate.slice(0, this.maxLineUnits));
        dropped += candidate.length - this.maxLineUnits;
        truncated += 1;
        continue;
      }
      // Empty lines are dropped, matching the framing this replaces.
      if (candidate.length > 0) lines.push(candidate);
    }

    this.totalTruncated += truncated;
    this.totalDropped += dropped;
    return { lines, truncatedLines: truncated, droppedUnits: dropped };
  }

  /**
   * End of stream: surface whatever is held as a final line, since no newline is
   * coming. Callers that only ever consumed complete lines can ignore it, but
   * dropping it silently would lose the last record of a CLI that exits without
   * a trailing newline.
   */
  public flush(): FramedOutput {
    if (this.discarding) {
      this.discarding = false;
      this.buffer = '';
      return EMPTY;
    }
    if (this.buffer.length === 0) return EMPTY;
    const line = this.buffer;
    this.buffer = '';
    return { lines: [line], truncatedLines: 0, droppedUnits: 0 };
  }
}
