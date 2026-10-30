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
//   - **Best-effort.** A write failure warns once per cause and the phase
//     continues, matching `verbose-diagnostic-writer` rather than the audit
//     writer. Transport capture is a convenience for reading a run back;
//     failing a phase because a log line could not be appended would trade a
//     real outcome for a diagnostic one.
//   - **Bounded.** Not by this file: feature 251 (FR-R4-F04) moved every byte of
//     file I/O to `src/monitor/transport/`, where each Run has its own file
//     (`.schegent/sessions/<runId>/transport.log`), each file is bounded by size
//     (`TRANSPORT_FILE_MAX_BYTES`) and by record age (the session retention age),
//     an oversize record is replaced by a placeholder, and the files together are
//     bounded by a workspace total. The shared `.schegent/cli-transport.log` is
//     never written again; what an earlier release left there is narrowed and
//     expires whole. Feature 217's former "no per-line truncation" decision is
//     reversed by FR-006 for the one case it could not hold: a single record
//     longer than the file bound.
//   - **Sanitized.** Every line passes through the injected sanitizer, which is
//     `SanitizedLogger.sanitize` and therefore the one `SECRET_PATTERNS` set.
//     The sink applies it itself rather than trusting callers to: a per-line
//     write is exactly the kind of hot loop where a second call site would
//     forget. It does so BEFORE the router decides whether the line is kept
//     (FR-R4-F04 X2), so a line the mode drops still advances the key-block
//     state and a later switch to `on` cannot leak the second half of a block.
//
// What stays here, and why. The sink owns the things that are about the stream
// and not about a destination: the formatting and redaction above, the pending
// byte bound (FR-R3-052), the disposal contract (FR-R3-137) and the drop
// counters `withDropReporting` reads. It hands each formatted line to the router
// synchronously, so the order lines were recorded in is the order they are
// queued in, and a Run's end is queued after every line already accepted.
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
// otherwise written through untouched.

import { TRANSPORT_FILE_MAX_BYTES } from '../contracts/transport-bounds';
import { KeyBlockLineRedactor } from '../lib/logger';
import type { SanitizedLogger } from '../lib/logger';

/** Directory the legacy shared file lives in, relative to the workspace root. */
export const CLI_TRANSPORT_DIRECTORY = '.schegent';

/**
 * The legacy shared file. Nothing writes it any more (feature 251); the name is kept because the
 * generations an earlier release left are `<name>.1` … `<name>.N` beside it, and the router narrows
 * and expires them by it.
 */
export const CLI_TRANSPORT_FILE_NAME = 'cli-transport.log';

/**
 * The per-file ceiling, matching the runtime log's default. Since feature 251 it bounds each Run file
 * and each stage file, not a shared file; its one definition is `TRANSPORT_FILE_MAX_BYTES` in
 * `src/contracts/transport-bounds.ts`, where the privacy profiles can read it too.
 *
 * Code-resident on purpose. Making it an operator setting would put transport capture on the same
 * `schegent.logging.*` surface that gates the audit log's rotation, and an operator raising one would
 * then be able to starve the other — which is the coupling this feature exists to remove.
 */
export const CLI_TRANSPORT_MAX_BYTES = TRANSPORT_FILE_MAX_BYTES;

/** Generations a pre-251 release kept behind the shared file; the disclosure names them. */
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

/**
 * What the sink needs from the router: a place to hand each formatted line and a way to release what
 * the router holds. A structural type, so this module imports nothing from `src/monitor/transport/`
 * (the router imports this module's types and constants, and a value edge back would close a cycle).
 *
 * `route` resolves when the line is written or dropped and must never reject; it queues the line
 * synchronously, which is what lets a Run's end be ordered after the lines already accepted.
 */
export interface CliTransportRouting {
  route(entry: CliTransportRecord, line: string): Promise<void>;
  dispose(): Promise<void>;
  /** Append descriptors the router holds, for disposal accounting. */
  readonly openDescriptorCount: number;
}

/** Bounded causes this sink reports, each at most once. */
type TransportFailureCause =
  | 'format-failed'
  // FR-R3-052 — the pending queue was already at its byte bound, so this line
  // was refused rather than queued. Not an I/O failure: the disk may be fine and
  // simply slower than the CLI is producing.
  | 'pending-bytes-exceeded'
  // FR-R3-137 — the line arrived after `flushAndDispose()` began. Not a failure
  // of anything: the host is shutting down and this sink has already promised
  // its caller that nothing further will be queued.
  | 'sink-closed'
  // FR-R3-137 — the disposal's grace expired with writes still in flight, so
  // those bytes were abandoned and the descriptors closed anyway. The disk is
  // stalled, not broken; an unbounded wait here is a host that will not exit.
  | 'drain-incomplete';

/**
 * FR-R3-052 — how many accepted-but-unwritten bytes this sink will hold.
 * Generous for a transport log at any real rate, and finite, which is the point.
 */
const MAX_PENDING_BYTES = 16 * 1024 * 1024;

/**
 * FR-R3-137 — how long `flushAndDispose()` waits for in-flight writes before it
 * closes the descriptors regardless.
 *
 * 2,000 ms because that is this repository's IO-teardown grace, four times over:
 * `STDIO_CLOSE_GRACE_MS`, `TERMINATION_GRACE_MS`, `OUTPUT_PROBE_TIMEOUT_MS` and
 * `MOUNT_PROBE_TIMEOUT_MS`. Nothing was invented here, and no test waits it out —
 * the bound is injectable through `drainGraceMs` for exactly that reason.
 */
export const TRANSPORT_DRAIN_GRACE_MS = 2_000;

export interface CliTransportSinkDeps {
  readonly router: CliTransportRouting;
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
    runId: string,
    phase: string,
    stream: CliTransportStream
  ) => string;
  readonly logger: Pick<SanitizedLogger, 'warn'>;
  readonly now?: () => Date;
  /**
   * FR-R3-137 — `flushAndDispose()`'s grace, defaulting to
   * `TRANSPORT_DRAIN_GRACE_MS`. Injected only so a test can prove the expiry
   * path without spending two seconds; production supplies nothing.
   */
  readonly drainGraceMs?: number;
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

export class CliTransportSink implements CliTransportRecorder {
  private readonly router: CliTransportRouting;
  private readonly sanitizeLine: (line: string) => string;
  private readonly sanitizeStreamLine?: (
    line: string,
    runId: string,
    phase: string,
    stream: CliTransportStream
  ) => string;
  private readonly logger: Pick<SanitizedLogger, 'warn'>;
  private readonly now: () => Date;

  /** Test seam: lets a suite await the fire-and-forget IO deterministically. */
  private readonly pending = new Set<Promise<void>>();

  /**
   * FR-R3-052 — bytes accepted and not yet written. The quantity nothing upstream
   * bounded.
   */
  private pendingBytes = 0;
  private droppedLines = 0;
  private droppedBytes = 0;
  /** One warn per cause, not one per dropped line. */
  private readonly warned = new Set<TransportFailureCause>();

  /**
   * FR-R3-137 — the disposal's two fields.
   *
   * `closed` is set synchronously, before the first await inside
   * `flushAndDispose()`, so a line racing shutdown is refused rather than queued
   * onto work nothing will drain. `closing` memoizes the drain so concurrent
   * and repeated callers share one settlement: a second drain could close a
   * descriptor a third caller had just re-opened.
   */
  private closed = false;
  private closing: Promise<void> | null = null;
  private readonly drainGraceMs: number;

  constructor(deps: CliTransportSinkDeps) {
    this.router = deps.router;
    this.sanitizeLine = deps.sanitize;
    this.sanitizeStreamLine = deps.sanitizeStreamLine;
    this.logger = deps.logger;
    this.now = deps.now ?? ((): Date => new Date());
    this.drainGraceMs = deps.drainGraceMs ?? TRANSPORT_DRAIN_GRACE_MS;
  }

  /**
   * Record one line. Never throws, never awaits — the monitor calls this from
   * a synchronous stream handler on the phase's hot path.
   */
  public record(entry: CliTransportRecord): void {
    let data: string;
    try {
      // FR-R3-048 — formatting runs BEFORE any destination decision, and the order
      // is load-bearing now that the injected sanitizer is stateful. Skipping
      // the format for a line we are not going to write would hide that line
      // from the key-block state machine: a run that emits its BEGIN marker
      // while the mode is `off` (or there is no workspace root) and then resumes
      // writing would find the redactor CLOSED, and every body line of the key
      // would be written verbatim. Every line the sink is handed must reach the
      // redactor, whether or not it reaches a file.
      //
      // Formatting is the only work this method does on the phase's own stack:
      // the injected sanitizer runs here, and a stream-json line can be
      // megabytes. A regex or allocation failure costs one line, not a phase.
      data = this.format(entry);
    } catch {
      this.warn('format-failed');
      return;
    }

    // FR-R3-137 — refuse anything that arrives once disposal has begun, and
    // count it, because a silent drop is the cap this repository keeps removing.
    //
    // The POSITION is load-bearing and this is the second thing `record()` does,
    // not the first. FR-R3-048's comment above explains why: every line the sink
    // is handed must reach the stateful redactor whether or not it reaches a
    // file, so guarding before `format()` would hide a shutdown-race line from
    // the key-block state machine — and a BEGIN it never sees leaves the redactor
    // open over every body line after it.
    if (this.closed) {
      this.droppedLines += 1;
      this.droppedBytes += data.length;
      this.warn('sink-closed');
      return;
    }

    // FR-R3-052 (H-03) — a pending-byte high-water mark.
    //
    // `OutputSinkBackpressure` pauses the pipes when the transcript sink backs
    // up, and it genuinely works; the review under-credited it. It does not bound
    // THIS queue. Every line accepted here allocates a promise and a formatted
    // string: against a blocked disk, millions of short lines accumulate with
    // nothing to stop them.
    //
    // Composes with the backpressure rather than replacing it. Backpressure slows
    // what arrives; this bounds what has already been accepted and not yet
    // written, which is the part no upstream pause can reclaim.
    const cost = data.length;
    if (this.pendingBytes + cost > MAX_PENDING_BYTES) {
      // No silent caps. Counted always, warned once -- a warn per dropped line
      // under load is the volume problem FR-R3-007 removed.
      this.droppedLines += 1;
      this.droppedBytes += cost;
      this.warn('pending-bytes-exceeded');
      return;
    }
    this.pendingBytes += cost;

    // Handed over synchronously: the router queues the line now, so the order lines were recorded in
    // is the order they are written in, and a Run's end queued later waits for this one.
    let routed: Promise<void>;
    try {
      routed = this.router.route(entry, data);
    } catch {
      routed = Promise.resolve();
    }
    const next = routed.catch(() => undefined);
    this.pending.add(next);
    void next.finally(() => {
      this.pendingBytes -= cost;
      this.pending.delete(next);
    });
  }

  /**
   * FR-R3-052 — lines refused because the pending queue was already at its
   * bound. Readable, because a counter nothing can read is a silent cap.
   */
  public get droppedForBackpressure(): { readonly lines: number; readonly bytes: number } {
    return { lines: this.droppedLines, bytes: this.droppedBytes };
  }

  /** Await in-flight writes. Settles immediately when none are pending. */
  public async flushPendingWrites(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled(Array.from(this.pending));
    }
  }

  /**
   * FR-R3-137 (FR-006) — how many append descriptors the router holds.
   *
   * Derived, never tracked: a counter maintained beside the map is a second
   * truth that can disagree with it, and "the map is empty" is the property a
   * disposal test actually wants to assert. The router's own count rather than
   * the process's, because `/dev/fd` includes descriptors this sink does not own
   * — that number corroborates, it cannot assert.
   */
  public get openDescriptorCount(): number {
    return this.router.openDescriptorCount;
  }

  /**
   * FR-R3-137 (FR-006) — what a disposal would have to wait for. Readable so a
   * test can establish its own precondition instead of assuming one. The router
   * runs one queue, so `chains` is 1 while anything is pending.
   */
  public get inFlight(): { readonly chains: number; readonly writes: number; readonly bytes: number } {
    return { chains: this.pending.size > 0 ? 1 : 0, writes: this.pending.size, bytes: this.pendingBytes };
  }

  /**
   * FR-R3-137 (FR-001, FR-002, FR-004, FR-005) — flush what is in flight, then
   * release the router's descriptors. The owner's release; nothing else closes these.
   *
   * Never rejects. It is called from a `dispose()` chain during shutdown, where a
   * rejection would abandon the steps after it — and the steps after it release
   * the workspace lock. Every failure inside goes to `warn()`.
   *
   * Deliberately NOT `async`, so every caller receives the *same* promise object
   * rather than a fresh wrapper around it. That makes "one drain, however many
   * callers" a property a test can assert by identity instead of by counting side
   * effects, and it costs one microtask less per call on the shutdown path.
   * `drainThenClose` is `async` and so cannot throw synchronously into a caller.
   */
  public flushAndDispose(): Promise<void> {
    // Synchronous, before the first await: see the `closed` field's header.
    this.closed = true;
    this.closing ??= this.drainThenClose();
    return this.closing;
  }

  /**
   * The drain, bounded. Runs exactly once per sink — `flushAndDispose()`
   * memoizes it.
   */
  private async drainThenClose(): Promise<void> {
    let expired = false;
    // The handle is created OUTSIDE the promise executor, and that is not style:
    // assigned inside a callback, TypeScript cannot see the assignment from the
    // `finally` below and reads the handle as always-`undefined` there — so the
    // clear was guarded by an `if` the compiler had already decided was false
    // (`no-unnecessary-condition` reports both that and the `?.` on `unref`). The
    // executor runs synchronously, so `onGraceElapsed` is the real `resolve` by
    // the time the timer can fire.
    let onGraceElapsed = (): void => undefined;
    const graceElapsed = new Promise<void>((resolve) => {
      onGraceElapsed = resolve;
    });
    const timer = setTimeout(() => {
      expired = true;
      onGraceElapsed();
    }, this.drainGraceMs);
    // Unref'd so a sink disposed early in a short-lived process does not hold the
    // event loop open for the length of the grace.
    timer.unref();

    try {
      await Promise.race([this.flushPendingWrites(), graceElapsed]);
    } catch {
      // `flushPendingWrites` uses `allSettled` and cannot reject; this is here
      // so a future change to it cannot turn shutdown into an unhandled throw.
    } finally {
      clearTimeout(timer);
    }

    if (expired) this.countAbandoned();

    // Released regardless. A stalled disk must not be able to hold a descriptor
    // past the shutdown that asked for it back. The router refuses to open another one afterwards.
    await this.router.dispose().catch(() => undefined);
  }

  /**
   * FR-R3-137 (FR-004) — bytes still in flight when the grace expired.
   *
   * Counted once, here, at the boundary, and NOT by touching `pendingBytes`:
   * `record()`'s `finally` remains the only decrement, so if a stalled write
   * does eventually settle the arithmetic lands on zero rather than going
   * negative. The line count is the number of writes abandoned, and the warn is
   * once — the same one-per-cause discipline every other cause here uses.
   */
  private countAbandoned(): void {
    const { writes, bytes } = this.inFlight;
    if (writes === 0 && bytes === 0) return;
    this.droppedLines += writes;
    this.droppedBytes += bytes;
    this.warn('drain-incomplete');
  }

  private format(entry: CliTransportRecord): string {
    const stamp = this.now().toISOString();
    // FR-R3-048 — the stateful sanitizer when the caller supplied one, so a key
    // block spanning lines is suppressed rather than written a fragment at a
    // time. Falls back to the stateless one, which keeps every existing test
    // double and construction site behaving as before.
    const sanitized = this.sanitizeStreamLine
      ? this.sanitizeStreamLine(entry.line, entry.runId, entry.phase, entry.stream)
      : this.sanitizeLine(entry.line);
    return `${stamp}\t${field(entry.runId)}\t${field(entry.phase)}\t${entry.stream}\t${sanitized}\n`;
  }

  /**
   * One WARN per cause, and no path in the text. A phase can emit tens of
   * thousands of lines, so an unsuppressed warning would bury the runtime log in
   * the failure it is reporting.
   */
  private warn(cause: TransportFailureCause): void {
    if (this.warned.has(cause)) return;
    this.warned.add(cause);
    this.emitWarning(
      `[cli-transport] could not record CLI output (${cause}); the phase is unaffected and the lines are still in the phase diagnostics.`
    );
  }

  /**
   * The one place the logger is called, so a logger that throws cannot be the
   * thing that fails the phase. `warn()` is reached from `record()`'s
   * synchronous formatting guard as well as from the async paths, so a throw
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
 * How many (run, stream) key-block redactors the production factory tracks.
 *
 * A cap rather than a release point: the sink has no per-run terminal callback,
 * so the map self-bounds by eviction. Each entry is two primitives, so 256 is
 * O(1) memory and far above the 40 live pairs the documented maximum concurrency
 * of 20 can produce -- eviction is reached only by a long-lived host, never by a
 * busy one.
 */
export const CLI_TRANSPORT_MAX_TRACKED_STREAMS = 256;

/**
 * Production construction: the router that decides where a record goes, plus the host's one sanitizing
 * logger.
 */
export function createCliTransportSink(
  router: CliTransportRouting,
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
  // The map is not a leak: each entry is a boolean and a counter (no lines), so
  // the whole map is O(1) memory. Entries are NOT released when a Run's streams
  // end — this sink has no per-run terminal callback, and inventing a caller for
  // one means reaching into the controller, scope this item does not own — so the
  // map self-bounds by eviction instead.
  //
  // Eviction prefers a CLOSED entry, scanning insertion order for the oldest one.
  // The tempting version — evict the oldest-inserted, full stop — is wrong, and
  // the arithmetic that seems to excuse it (default concurrency 1, documented max
  // 20, so at most 40 live pairs against `CLI_TRANSPORT_MAX_TRACKED_STREAMS`) does
  // not: the oldest INSERTED entry is the oldest Run's, and a Run that streams for
  // hours while a capful of short Runs come and go is both the oldest and still
  // live. Dropping it
  // mid-block resets the state machine to CLOSED and writes the rest of the key
  // verbatim, which is the one case where discarding state releases a tail.
  //
  // If every tracked entry is open — a pathological run of blocks that never
  // close — the oldest is evicted anyway, because an unbounded map is the worse
  // failure and the cap has to be a cap.
  const redactors = new Map<string, KeyBlockLineRedactor>();
  // Keyed by run, PHASE and stream.
  //
  // Phase was added after review, deliberately, because omitting it turned a
  // bounded over-redaction into an unbounded one: an unterminated block in one
  // phase suppressed every LATER phase's stdout for the rest of the run, so a
  // single truncated key header cost the operator their whole transport log.
  //
  // A block cannot legitimately span phases -- each phase is a separate CLI
  // process whose stdout ends when it exits -- so resetting at the boundary
  // abandons state that is necessarily unterminated rather than losing a live
  // block. The race that would make that unsafe (phase N's lines arriving after
  // phase N+1 starts) is closed upstream by FR-R3-047: the runner now always
  // waits for stdio close before a phase finalizes, so a phase's output is fully
  // drained before the next one spawns. Spec FR-007 is amended to match.
  const keyFor = (runId: string, phase: string, stream: string): string =>
    `${runId}\u0000${phase}\u0000${stream}`;
  const evictOne = (): void => {
    for (const [candidate, tracked] of redactors) {
      if (!tracked.isOpen) {
        redactors.delete(candidate);
        return;
      }
    }
    const oldest = redactors.keys().next().value;
    if (oldest !== undefined) redactors.delete(oldest);
  };
  return new CliTransportSink({
    router,
    sanitize: (line) => logger.sanitize(line),
    sanitizeStreamLine: (line, runId, phase, stream) => {
      const key = keyFor(runId, phase, stream);
      let redactor = redactors.get(key);
      if (!redactor) {
        if (redactors.size >= CLI_TRANSPORT_MAX_TRACKED_STREAMS) evictOne();
        redactor = new KeyBlockLineRedactor((input) => logger.sanitize(input));
        redactors.set(key, redactor);
      }
      return redactor.sanitizeLine(line);
    },
    logger
  });
}
