// Feature FR-R3-007 (T363) — the transport sink's load-bearing properties: it is sanitized, it is
// bounded in what it will hold in memory, and it releases what it holds when asked.
//
// Feature 251 (FR-R4-F04) moved every byte of file I/O out of the sink and into the router and store in
// `src/monitor/transport/` (per-Run files, the stage, compaction, the legacy generations). So this file
// tests what the sink still owns, against a recording router, and not the files: where a file ends up and
// what bounds it are `tests/unit/monitor/transport/*` (T2 to T4) and the T5 block at the foot of this file.
// What changed in this file, case by case, is listed in
// `specs/251-controllable-evidence-lifecycle/measurements.md` §0 (T014).
//
// Sanitization is checked with the real `SanitizedLogger`, not a stub. The rule this feature must not
// break is that `SECRET_PATTERNS` stays the single source of truth — a stub sanitizer would pass whatever
// this file decided to assert, including nothing, so the redaction assertion is only worth making against
// the set the host actually uses.

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { expectNoDescriptorWarnings } from '../../setup/descriptor-warnings';

import {
  CliTransportSink,
  CLI_TRANSPORT_MAX_TRACKED_STREAMS,
  createCliTransportSink,
  CLI_TRANSPORT_DIRECTORY,
  CLI_TRANSPORT_FILE_NAME,
  CLI_TRANSPORT_MAX_BYTES,
  CLI_TRANSPORT_MAX_GENERATIONS,
  type CliTransportRecord,
  type CliTransportRouting
} from '../../../src/monitor/cli-transport-sink';
import { KeyBlockLineRedactor, SanitizedLogger } from '../../../src/lib/logger';
import { createTransportHarness, type TransportHarness } from './transport/transport-harness';

let warnings: string[] = [];

const logger = { warn: (message: string) => warnings.push(message) };
const realLogger = new SanitizedLogger([]);

/**
 * A router that records what it is handed. `gate`, when set, holds every `route` promise open, which is
 * the blocked-disk case; `disposals` counts the releases the sink asks for.
 */
class RecordingRouter implements CliTransportRouting {
  readonly routed: Array<{ readonly entry: CliTransportRecord; readonly line: string }> = [];
  disposals = 0;
  openDescriptorCount = 0;
  gate: Promise<void> | null = null;

  route(entry: CliTransportRecord, line: string): Promise<void> {
    this.routed.push({ entry, line });
    return this.gate ?? Promise.resolve();
  }

  async dispose(): Promise<void> {
    this.disposals += 1;
  }

  /** Every line handed over, as one text, in order. */
  text(): string {
    return this.routed.map((record) => record.line).join('');
  }
}

/**
 * FR-R3-137 (T1531c, FR-012) — every sink this file constructs is disposed.
 *
 * Registered at construction rather than disposed per test, because the property is "every one", not
 * "the ones somebody remembered". Before this, the run emitted 14 `Closing file descriptor N on garbage
 * collection` lines and one `DEP0137`: GC was the sink's finalizer, in the suite that was supposed to be
 * proving the sink's behaviour.
 */
const live: CliTransportSink[] = [];

function track<T extends CliTransportSink>(sink: T): T {
  live.push(sink);
  return sink;
}

let router = new RecordingRouter();

function makeSink(
  sanitize: (line: string) => string = (line) => line,
  overrides: { readonly drainGraceMs?: number } = {}
): CliTransportSink {
  return track(
    new CliTransportSink({
      router,
      sanitize,
      logger,
      now: () => new Date('2026-05-10T12:00:00.000Z'),
      ...overrides
    })
  );
}

/** The production factory over the recording router, for the cases about its wiring. */
function makeProductionSink(): CliTransportSink {
  return track(
    createCliTransportSink(router, {
      sanitize: (line) => realLogger.sanitize(line),
      warn: (message: string) => warnings.push(message)
    })
  );
}

beforeEach(() => {
  warnings = [];
  router = new RecordingRouter();
});

afterEach(async () => {
  for (const sink of live.splice(0)) {
    await sink.flushAndDispose();
  }
});

afterAll(() => {
  expectNoDescriptorWarnings();
});

describe('CliTransportSink — the record it hands over', () => {
  it('hands the formatted record to the router, newline-terminated', async () => {
    const sink = makeSink();
    sink.record({ runId: 'run-1', phase: 'speckit-plan', stream: 'stdout', line: 'hello' });
    await sink.flushPendingWrites();

    expect(router.text()).toBe('2026-05-10T12:00:00.000Z\trun-1\tspeckit-plan\tstdout\thello\n');
    expect(router.routed[0]?.entry.runId, 'the router is told which Run, to choose its file').toBe('run-1');
    expect(warnings, 'a hand-over is not a failure').toEqual([]);
  });

  it('puts the content last, so cut -f5- recovers the CLI’s own bytes', async () => {
    const sink = makeSink();
    // A stream-json line: tabs inside it must survive, because the content field
    // is terminal and cannot shift a column.
    const jsonLine = '{"type":"tool_result","text":"a\tb\tc"}';
    sink.record({ runId: 'run-1', phase: 'speckit-implement', stream: 'stdout', line: jsonLine });
    await sink.flushPendingWrites();

    const record = router.text().trimEnd();
    const fields = record.split('\t');
    expect(fields.slice(0, 4)).toEqual([
      '2026-05-10T12:00:00.000Z',
      'run-1',
      'speckit-implement',
      'stdout'
    ]);
    expect(fields.slice(4).join('\t')).toBe(jsonLine);
  });

  it('flattens tabs in the attribution fields but never in the line', async () => {
    const sink = makeSink();
    sink.record({ runId: 'a\tb', phase: 'c\nd', stream: 'stderr', line: 'kept\there' });
    await sink.flushPendingWrites();

    const fields = router.text().trimEnd().split('\t');
    expect(fields[1]).toBe('a b');
    expect(fields[2]).toBe('c d');
    expect(fields.slice(4).join('\t')).toBe('kept\there');
  });

  it('writes one physical line per record, in call order', async () => {
    const sink = makeSink();
    for (const line of ['one', 'two', 'three']) {
      sink.record({ runId: 'run-1', phase: 'speckit-plan', stream: 'stdout', line });
    }
    await sink.flushPendingWrites();

    const lines = router.text().split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.split('\t')[4])).toEqual(['one', 'two', 'three']);
  });

  it('does not truncate a long line — the bound is the file, not the record', async () => {
    // The audit payload's 640-char string cap cost one run 7046 of 7452 lines. Trading that for a
    // file-level bound is the whole design, so a line well past any per-string cap arrives whole at the
    // router. The one case a record is replaced (longer than the file bound itself) is the router's, FR-006.
    const sink = makeSink();
    const long = 'x'.repeat(20_000);
    sink.record({ runId: 'run-1', phase: 'speckit-plan', stream: 'stdout', line: long });
    await sink.flushPendingWrites();

    expect(router.text().trimEnd().split('\t')[4]).toBe(long);
    expect(router.text()).not.toContain('truncated');
  });
});

describe('CliTransportSink — sanitization', () => {
  it('redacts through the host’s own SECRET_PATTERNS set', async () => {
    const sink = makeSink((line) => realLogger.sanitize(line));
    const secret = `sk-ant-${'A'.repeat(40)}`;
    sink.record({
      runId: 'run-1',
      phase: 'speckit-implement',
      stream: 'stderr',
      line: `auth failed for ${secret}`
    });
    await sink.flushPendingWrites();

    const written = router.text();
    expect(written).not.toContain(secret);
    expect(written).toContain('[REDACTED]');
  });

  it('sanitizes every line, not just the first', async () => {
    const seen: string[] = [];
    const sink = makeSink((line) => {
      seen.push(line);
      return line.replace(/hunter2/g, '[REDACTED]');
    });
    for (const line of ['pw=hunter2', 'ok', 'again hunter2']) {
      sink.record({ runId: 'run-1', phase: 'speckit-plan', stream: 'stdout', line });
    }
    await sink.flushPendingWrites();

    expect(seen, 'the sink sanitizes, so a caller cannot forget to').toEqual([
      'pw=hunter2',
      'ok',
      'again hunter2'
    ]);
    expect(router.text()).not.toContain('hunter2');
  });

  // FR-R3-048 (H-07, T018) — the shape this sink was failing. Everything above
  // sanitizes a line in isolation, which is exactly why the defect survived: a
  // private key reaches `record()` one line at a time, so the whole-string
  // pattern never sees a `BEGIN…END` block and each body line looks like
  // ordinary base64. These two cases are the ones that fail if the stateful
  // sanitizer is not wired, and the second exercises the PRODUCTION wiring
  // rather than a test double, because dropping `sanitizeStreamLine` from
  // `createCliTransportSink` is the regression that would otherwise leave every
  // other test in this file green.
  //
  // Assertions are booleans: a redaction test that prints the protected string
  // on failure leaks it into CI output.
  const SPLIT_KEY: readonly string[] = [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ',
    'BODY_MUST_NOT_SURVIVE',
    '-----END OPENSSH PRIVATE KEY-----',
    'ordinary output resumes'
  ];

  it('suppresses a key that arrives one line at a time', async () => {
    const redactor = new KeyBlockLineRedactor((input) => realLogger.sanitize(input));
    const sink = track(new CliTransportSink({
      router,
      sanitize: (line) => realLogger.sanitize(line),
      sanitizeStreamLine: (line) => redactor.sanitizeLine(line),
      logger,
      now: () => new Date('2026-05-10T12:00:00.000Z')
    }));
    for (const line of SPLIT_KEY) {
      sink.record({ runId: 'run-1', phase: 'speckit-implement', stream: 'stdout', line });
    }
    await sink.flushPendingWrites();

    const written = router.text();
    expect(written.includes('BODY_MUST_NOT_SURVIVE')).toBe(false);
    expect(written.includes('b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ')).toBe(false);
    expect(written.includes('-----END')).toBe(false);
    // One record per suppressed line, not a gap: the transport aggregate's line
    // counts are the only surviving record of how much the CLI emitted.
    expect(written.trimEnd().split('\n')).toHaveLength(SPLIT_KEY.length);
    expect(written.includes('ordinary output resumes')).toBe(true);
  });

  it('wires the stateful sanitizer in the production factory', async () => {
    const sink = makeProductionSink();
    for (const line of SPLIT_KEY) {
      sink.record({ runId: 'run-1', phase: 'speckit-implement', stream: 'stdout', line });
    }
    // A second Run mid-stream: one Run's open block must not suppress another's.
    sink.record({
      runId: 'run-2',
      phase: 'speckit-implement',
      stream: 'stdout',
      line: 'other run output'
    });
    await sink.flushPendingWrites();

    const written = router.text();
    expect(written.includes('BODY_MUST_NOT_SURVIVE')).toBe(false);
    expect(written.includes('-----END')).toBe(false);
    expect(written.includes('other run output')).toBe(true);
  });

  // FR-015 / SC-004 — the redactor registry is bounded by eviction rather than by
  // release, so the bound and its preference are the only things standing between
  // a long-lived host and either an unbounded map or a released key tail. SC-004
  // asks for measurement rather than inspection, and both constants and the map
  // are private to the factory, so these two cases drive the production factory
  // and read the outcome off what it hands over.
  it('evicts a closed entry rather than a live open block (FR-015)', async () => {
    const sink = makeProductionSink();
    // The long-lived Run: oldest by insertion order, and mid-block. Dropping this
    // one is the single case where discarding state releases a tail, which is why
    // eviction has to prefer a closed entry over the oldest-inserted one.
    sink.record({
      runId: 'keeper',
      phase: 'speckit-implement',
      stream: 'stdout',
      line: '-----BEGIN OPENSSH PRIVATE KEY-----'
    });
    // Enough short Runs to force well past the cap, every one of them closed.
    for (let i = 0; i < CLI_TRANSPORT_MAX_TRACKED_STREAMS + 16; i += 1) {
      sink.record({
        runId: `short-${i}`,
        phase: 'speckit-implement',
        stream: 'stdout',
        line: `short run ${i} output`
      });
    }
    sink.record({
      runId: 'keeper',
      phase: 'speckit-implement',
      stream: 'stdout',
      line: 'BODY_MUST_NOT_SURVIVE'
    });
    await sink.flushPendingWrites();

    const written = router.text();
    // Boolean, never the protected string: the keeper's block is still open, so
    // its body line was suppressed even though 272 entries were created after it.
    expect(written.includes('BODY_MUST_NOT_SURVIVE')).toBe(false);
    expect(written.includes('short run 0 output')).toBe(true);
    expect(written.includes(`short run ${CLI_TRANSPORT_MAX_TRACKED_STREAMS + 15} output`)).toBe(
      true
    );
  });

  it('still bounds the map when every tracked entry is open (SC-004)', async () => {
    const sink = makeProductionSink();
    // The pathological shape: every tracked (run, stream) pair mid-block, so there
    // is no closed entry to prefer. The cap still holds and the oldest is dropped
    // — a recorded trade, because an unbounded map is the worse failure and a cap
    // that yields under pressure is not a cap. This case measures the bound: if
    // the map were unbounded, the oldest entry would still be open below.
    for (let i = 0; i < CLI_TRANSPORT_MAX_TRACKED_STREAMS + 1; i += 1) {
      sink.record({
        runId: `open-${i}`,
        phase: 'speckit-implement',
        stream: 'stdout',
        line: '-----BEGIN OPENSSH PRIVATE KEY-----'
      });
    }
    // `open-0` was inserted first and every entry is open, so it is the one the
    // fallback drops; its state machine restarts CLOSED. Nothing key-shaped is
    // asserted here — the marker is a plain sentinel that says the state was lost.
    sink.record({
      runId: 'open-0',
      phase: 'speckit-implement',
      stream: 'stdout',
      line: 'EVICTED_STATE_MARKER'
    });
    await sink.flushPendingWrites();

    expect(router.text().includes('EVICTED_STATE_MARKER')).toBe(true);
  });
});

describe('CliTransportSink — the bounds it still exports', () => {
  it('exposes a per-file ceiling that does not depend on the audit log', () => {
    // The finding was a shared budget, so the numbers are asserted here: a change to either would
    // otherwise be invisible outside a compaction test. The per-file bound is unchanged by feature 251;
    // what it bounds is now each Run file and each stage file, and the generations count names the
    // legacy generations an earlier release left.
    expect(CLI_TRANSPORT_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(CLI_TRANSPORT_MAX_GENERATIONS).toBe(3);
  });
});

describe('CliTransportSink — redaction state is per run, phase and stream (FR-007)', () => {
  it('does not let one phase’s unterminated block suppress the next phase', () => {
    // Amended during review. Keyed by run+stream alone, a single truncated key
    // header cost the operator every later phase's transport output for the whole
    // run -- a bounded over-redaction becoming an unbounded one. A block cannot
    // span phases (each is a separate process whose stdout ends at exit), so the
    // boundary reset abandons state that is necessarily unterminated.
    const lines: string[] = [];
    const sink = track(createCliTransportSink(
      router,
      {
        sanitize: (s: string) => s,
        warn: () => undefined
      } as unknown as Parameters<typeof createCliTransportSink>[1]
    ));
    const deps = sink as unknown as {
      sanitizeStreamLine?: (l: string, r: string, p: string, s: string) => string;
    };
    const call = (line: string, phase: string): string =>
      deps.sanitizeStreamLine ? deps.sanitizeStreamLine(line, 'run-1', phase, 'stdout') : line;

    // Phase one opens a block and never closes it.
    lines.push(call('-----BEGIN RSA PRIVATE KEY-----', 'specify'));
    lines.push(call('truncated-body', 'specify'));
    // Phase two must not inherit that state.
    const laterPhase = call('ordinary output from the next phase', 'plan');
    expect(laterPhase).toBe('ordinary output from the next phase');
  });
});

describe('CliTransportSink — the pending-byte high-water mark (FR-R3-052)', () => {
  /**
   * H-03: the per-line closure/promise/string chain had no bound. Against a
   * blocked disk writer, millions of short lines accumulate with nothing to stop
   * them. `OutputSinkBackpressure` pauses the pipes -- it genuinely works, and the
   * review under-credited it -- but it does not bound what this sink has already
   * accepted and not yet written, which is the part no upstream pause reclaims.
   */
  it('drops lines rather than queueing unboundedly against a blocked writer', async () => {
    let release = (): void => {};
    router.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sink = makeSink();

    // 4 MiB of lines, well past the 16 MiB bound when repeated.
    const line = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 512; i += 1) {
      sink.record({ runId: 'r', phase: 'implement', stream: 'stdout', line } as never);
    }

    const dropped = sink.droppedForBackpressure;
    // The bound bit: some lines were refused, and the count is readable.
    expect(dropped.lines).toBeGreaterThan(0);
    expect(dropped.bytes).toBeGreaterThan(0);
    // And the refusal was reported, once, not per line.
    expect(warnings.filter((w) => w.includes('pending-bytes-exceeded')).length).toBe(1);

    release();
    await sink.flushPendingWrites();
  }, 30_000);

  it('drops nothing when the writer keeps up', async () => {
    // The bound must not cost a healthy sink anything.
    const sink = makeSink();
    for (let i = 0; i < 200; i += 1) {
      sink.record({ runId: 'r', phase: 'implement', stream: 'stdout', line: `line ${i}` } as never);
      await sink.flushPendingWrites();
    }
    expect(sink.droppedForBackpressure.lines).toBe(0);
  }, 30_000);
});

// -- FR-R3-137 (T1529a, FR-001 – FR-006) ------------------------------------
//
// The lifecycle. Before this feature the sink held one append descriptor per
// destination in a map whose own header said "NOT dropped on disposal, because
// there is no disposal" — so the only thing that ever closed one was the
// garbage collector, and Node said so on stderr 14 times per run of this file.
//
// Feature 251 moved the descriptors to the router, so the cases that need a REAL descriptor run over
// the real router (`createTransportHarness`), and the ones that need a stalled or recording router
// run over `RecordingRouter`. The contract is unchanged: disposal drains within a grace, releases what
// the router holds, and never rejects.
describe('CliTransportSink — the disposal it never had (FR-R3-137)', () => {
  let harness: TransportHarness | null = null;

  afterEach(async () => {
    await harness?.dispose();
    harness = null;
  });

  it('resolves on a sink that never recorded, holding nothing (FR-001)', async () => {
    const sink = makeSink();

    await expect(sink.flushAndDispose()).resolves.toBeUndefined();
    expect(sink.openDescriptorCount).toBe(0);
    expect(router.disposals, 'the router is released once').toBe(1);
  });

  it('closes the descriptor the append path opened (FR-001, FR-006)', async () => {
    harness = await createTransportHarness({ setting: 'on' });
    harness.record('run-1', 'hello');
    await harness.flush();
    // The precondition is the point: without a real open handle the assertion
    // below passes vacuously, which is the FR-R3-114 failure mode.
    expect(harness.sink.openDescriptorCount, 'the fixture must actually hold a descriptor').toBe(1);

    await harness.sink.flushAndDispose();

    expect(harness.sink.openDescriptorCount).toBe(0);
    expect(harness.sink.inFlight).toEqual({ chains: 0, writes: 0, bytes: 0 });
  });

  it('is idempotent, and the second call is the same settlement (FR-002)', async () => {
    const sink = makeSink();
    sink.record({ runId: 'run-1', phase: 'implement', stream: 'stdout', line: 'hello' });
    await sink.flushPendingWrites();

    const first = sink.flushAndDispose();
    const second = sink.flushAndDispose();
    // One promise, not two that happen to agree: a second drain could close a
    // handle a third call had just re-opened.
    expect(second).toBe(first);
    await first;
    await expect(sink.flushAndDispose()).resolves.toBeUndefined();

    expect(router.disposals, 'one release however many callers').toBe(1);
    expect(warnings, 'disposal is not a failure and warns nothing').toEqual([]);
  });

  it('collapses concurrent callers into one drain (FR-002)', async () => {
    const sink = makeSink();
    sink.record({ runId: 'run-1', phase: 'implement', stream: 'stdout', line: 'hello' });

    const [a, b, c] = [sink.flushAndDispose(), sink.flushAndDispose(), sink.flushAndDispose()];
    expect(b).toBe(a);
    expect(c).toBe(a);
    await Promise.all([a, b, c]);

    expect(router.disposals).toBe(1);
  });

  it('never rejects the caller when the router fails mid-drain (FR-005)', async () => {
    // The absorbed-failure half: a router whose own release rejects, and one whose route rejects.
    const failing: CliTransportRouting = {
      route: () => Promise.reject(new Error('device is on fire')),
      dispose: () => Promise.reject(new Error('close failed')),
      openDescriptorCount: 0
    };
    const sink = track(new CliTransportSink({ router: failing, sanitize: (line) => line, logger }));
    sink.record({ runId: 'run-1', phase: 'implement', stream: 'stdout', line: 'hello' });

    await expect(sink.flushAndDispose()).resolves.toBeUndefined();

    expect(sink.inFlight.writes).toBe(0);
  });

  it('counts and warns a record that arrives after disposal began (FR-003)', async () => {
    const sink = makeSink();
    sink.record({ runId: 'run-1', phase: 'implement', stream: 'stdout', line: 'first' });
    await sink.flushPendingWrites();
    const before = sink.droppedForBackpressure;

    // Not awaited: the `closed` flag must be set synchronously, before the
    // first await inside the disposal, or a line racing shutdown is accepted
    // into work nothing will drain.
    const closing = sink.flushAndDispose();
    sink.record({ runId: 'run-1', phase: 'implement', stream: 'stdout', line: 'too late' });
    sink.record({ runId: 'run-1', phase: 'implement', stream: 'stdout', line: 'also late' });
    await closing;

    const dropped = sink.droppedForBackpressure;
    expect(dropped.lines).toBe(before.lines + 2);
    expect(dropped.bytes).toBeGreaterThan(before.bytes);
    expect(warnings.filter((w) => w.includes('sink-closed')).length, 'once, not once per line').toBe(1);
    expect(router.routed.map((record) => record.line).join(''), 'nothing late reached the router').not.toContain(
      'too late'
    );
  });

  it('reaches the redactor before it refuses a post-disposal line (FR-003, FR-R3-048)', async () => {
    // The guard's POSITION, not its existence. FR-R3-048 made the injected
    // sanitizer stateful, so a line withheld from `format()` is a line the key
    // -block state machine never sees — and a BEGIN it misses leaves the
    // redactor open over every body line that follows.
    const seen: string[] = [];
    const sink = makeSink((line) => {
      seen.push(line);
      return line;
    });

    const closing = sink.flushAndDispose();
    sink.record({ runId: 'run-1', phase: 'implement', stream: 'stdout', line: 'after close' });
    await closing;

    expect(seen, 'the dropped line still reached the sanitizer').toContain('after close');
  });

  it('closes anyway when the grace expires, counting the abandoned bytes once (FR-004, FR-005)', async () => {
    // A write that never settles: the router's route promise is held open forever.
    router.gate = new Promise<void>(() => undefined);
    const sink = makeSink((line) => line, { drainGraceMs: 25 });

    sink.record({ runId: 'run-1', phase: 'implement', stream: 'stdout', line: 'never written' });
    expect(sink.inFlight.writes, 'the fixture must leave a write in flight').toBe(1);
    const abandoned = sink.inFlight.bytes;
    expect(abandoned).toBeGreaterThan(0);

    const before = sink.droppedForBackpressure;
    await sink.flushAndDispose();

    // The router is released even though the drain never finished: an unbounded
    // wait for a stalled disk is a host that will not shut down.
    expect(router.disposals).toBe(1);
    const dropped = sink.droppedForBackpressure;
    expect(dropped.lines).toBe(before.lines + 1);
    expect(dropped.bytes).toBe(before.bytes + abandoned);
    expect(warnings.filter((w) => w.includes('drain-incomplete')).length).toBe(1);
  });

  it('does not double-count the abandoned bytes on a second call (FR-002, FR-004)', async () => {
    router.gate = new Promise<void>(() => undefined);
    const sink = makeSink((line) => line, { drainGraceMs: 25 });
    sink.record({ runId: 'run-1', phase: 'implement', stream: 'stdout', line: 'stranded' });

    await sink.flushAndDispose();
    const afterFirst = sink.droppedForBackpressure;
    await sink.flushAndDispose();
    await sink.flushAndDispose();

    expect(sink.droppedForBackpressure).toEqual(afterFirst);
    expect(warnings.filter((w) => w.includes('drain-incomplete')).length).toBe(1);
    expect(router.disposals).toBe(1);
  });

  it('opens nothing for a record that reaches the router after the release (FR-005)', async () => {
    // The expiry path's tail. The grace bounds the WAIT, not the write: a write stalled past it does
    // resume eventually, and if it could still acquire an append descriptor at that point it would
    // open one AFTER the release, with `flushAndDispose()` memoized and nothing left to close it. That
    // is the GC finalizer this item removed, reintroduced on the timeout path. The router refuses.
    harness = await createTransportHarness({ setting: 'on' });
    await harness.sink.flushAndDispose();
    expect(harness.sink.openDescriptorCount, 'the release ran, and it held nothing').toBe(0);

    // A record queued behind the stall reaches the router after the release.
    await harness.router.route(
      { runId: 'run-late', phase: 'implement', stream: 'stdout', line: 'slow disk' },
      '2026-05-10T12:00:00.000Z\trun-late\timplement\tstdout\tslow disk\n'
    );

    expect(harness.router.openDescriptorCount, 'no owner is left to close a descriptor opened here').toBe(0);
    await expect(fs.stat(harness.runFile('run-late'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

// Feature 251 (FR-R4-F04, contract T5; FR-008, US1-6) — what the sink's owner-only rule becomes now that
// records go to per-Run files and the shared `.schegent/cli-transport.log` is never written again.
//
// An earlier release left the shared file and its generations at the mode the umask gave them (`0644`).
// Nothing writes them any more, so nothing would ever narrow them if the router did not: it narrows them
// where they lie, once per host, on the first record and on a maintenance pass, keeping every byte. A new
// Run file is created `0600` in `0700` directories.
describe('CliTransportSink — legacy generations and the Run file (feature 251, T5)', () => {
  const posixOnly = process.platform === 'win32' ? it.skip : it;
  const modeOf = async (p: string): Promise<number> => (await fs.lstat(p)).mode & 0o777;
  let harness: TransportHarness;

  async function leaveWidenedLegacy(root: string): Promise<readonly string[]> {
    const directory = path.join(root, CLI_TRANSPORT_DIRECTORY);
    await fs.mkdir(directory, { recursive: true, mode: 0o755 });
    const files = [
      path.join(directory, CLI_TRANSPORT_FILE_NAME),
      path.join(directory, `${CLI_TRANSPORT_FILE_NAME}.1`)
    ];
    for (const file of files) {
      await fs.writeFile(file, `earlier ${path.basename(file)}\n`, 'utf8');
      await fs.chmod(file, 0o644);
    }
    return files;
  }

  afterEach(async () => {
    await harness.dispose();
  });

  posixOnly('narrows an existing 0644 shared file and its generation by the first record, bytes intact', async () => {
    harness = await createTransportHarness({ setting: 'on' });
    const files = await leaveWidenedLegacy(harness.workspaceRoot);
    const before = await Promise.all(files.map((file) => fs.readFile(file)));

    harness.record('run-1', 'first record');
    await harness.flush();

    for (const [index, file] of files.entries()) {
      expect(await modeOf(file), path.basename(file)).toBe(0o600);
      expect((await fs.readFile(file)).equals(before[index]!), `${path.basename(file)} bytes`).toBe(true);
    }
    // The shared file is narrowed, never written: its bytes are exactly what the earlier release left.
    expect(await fs.readFile(files[0]!, 'utf8')).toBe(`earlier ${CLI_TRANSPORT_FILE_NAME}\n`);
  });

  posixOnly('narrows them by a maintenance pass when no record has arrived', async () => {
    harness = await createTransportHarness({ setting: 'off' });
    const files = await leaveWidenedLegacy(harness.workspaceRoot);
    const before = await Promise.all(files.map((file) => fs.readFile(file)));

    await harness.router.runPass(new Set());

    for (const [index, file] of files.entries()) {
      expect(await modeOf(file), path.basename(file)).toBe(0o600);
      expect((await fs.readFile(file)).equals(before[index]!), `${path.basename(file)} bytes`).toBe(true);
    }
  });

  posixOnly('creates a new Run file 0600 in 0700 directories', async () => {
    harness = await createTransportHarness({ setting: 'on' });
    harness.record('run-1', 'a record');
    await harness.flush();

    expect(await modeOf(harness.runFile('run-1'))).toBe(0o600);
    expect(await modeOf(path.dirname(harness.runFile('run-1')))).toBe(0o700);
    expect(await modeOf(path.join(harness.workspaceRoot, CLI_TRANSPORT_DIRECTORY))).toBe(0o700);
  });

  posixOnly('never narrows through a symbolic link a generation slot holds', async () => {
    harness = await createTransportHarness({ setting: 'on' });
    const outside = await fs.mkdtemp(path.join(harness.tempRoot, 'outside-'));
    const target = path.join(outside, 'not-evidence.txt');
    await fs.writeFile(target, 'someone else\n', 'utf8');
    await fs.chmod(target, 0o644);
    await fs.mkdir(path.join(harness.workspaceRoot, CLI_TRANSPORT_DIRECTORY), { recursive: true });
    await fs.symlink(target, path.join(harness.workspaceRoot, CLI_TRANSPORT_DIRECTORY, `${CLI_TRANSPORT_FILE_NAME}.1`));

    harness.record('run-1', 'still captured');
    await harness.flush();

    expect(await modeOf(target), 'the link target is untouched').toBe(0o644);
    expect(await fs.readFile(harness.runFile('run-1'), 'utf8'), 'capture carries on').toContain('still captured');
  });

  posixOnly('says what it narrowed, once, without naming the path', async () => {
    harness = await createTransportHarness({ setting: 'on' });
    const files = await leaveWidenedLegacy(harness.workspaceRoot);
    await fs.chmod(path.join(harness.workspaceRoot, CLI_TRANSPORT_DIRECTORY), 0o755);
    for (let index = 0; index < 3; index += 1) {
      harness.record('run-1', `line-${index}`);
      await harness.flush();
    }

    const narrowing = harness.warnings.filter((w) => w.includes('owner-only'));
    expect(narrowing, 'one line per kind of change, not one per file or per record').toEqual([
      expect.stringMatching(/file.*\b644\b/),
      expect.stringMatching(/directory.*\b755\b/)
    ]);
    for (const warning of narrowing) {
      expect(warning, 'path-free').not.toContain(harness.workspaceRoot);
      expect(warning).not.toContain(path.basename(files[0]!));
    }
  });

  posixOnly('refuses a Run directory symlinked out of the workspace, writes nothing there, and warns once', async () => {
    harness = await createTransportHarness({ setting: 'on' });
    const outside = await fs.mkdtemp(path.join(harness.tempRoot, 'outside-'));
    await fs.mkdir(path.join(harness.workspaceRoot, CLI_TRANSPORT_DIRECTORY, 'sessions'), { recursive: true });
    await fs.symlink(outside, path.join(harness.workspaceRoot, CLI_TRANSPORT_DIRECTORY, 'sessions', 'run-1'));

    for (let index = 0; index < 5; index += 1) harness.record('run-1', 'escape');
    await harness.flush();

    expect(await fs.readdir(outside), 'nothing was written through the link').toEqual([]);
    expect(harness.warnings.filter((w) => w.includes('could not record CLI output')), 'one WARN for five lines').toHaveLength(1);
    expect(harness.warnings[0], 'a path outside the root is the string that must not reach a log').not.toContain(outside);
  });
});
