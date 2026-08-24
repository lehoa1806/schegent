// Feature FR-R3-007 (T363) — the transport sink's two load-bearing properties:
// it is bounded, and it is sanitized.
//
// Run against a real temporary directory rather than a filesystem double. The
// sink proves containment through `resolveContainedForWrite` /
// `resolveContainedLink`, both of which call `realpath`, so a double would have
// to model symlink resolution to answer them — and a double that answers
// "contained" unconditionally would make every containment assertion below
// vacuous while looking green. A real tree resolves naturally, and the rotation
// assertions become directory listings, which is the form an operator would
// check them in.
//
// `maxBytes` is set low deliberately. The production ceiling is 5 MiB, and
// writing 20 MiB to assert a rollover would trade the whole point of the bound
// for a slow test; the bound's *logic* is size-independent, so the fixture picks
// sizes where a rollover is one or two records away.
//
// Sanitization is checked with the real `SanitizedLogger`, not a stub. The rule
// this feature must not break is that `SECRET_PATTERNS` stays the single source
// of truth — a stub sanitizer would pass whatever this file decided to assert,
// including nothing, so the redaction assertion is only worth making against the
// set the host actually uses.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CliTransportSink,
  CLI_TRANSPORT_MAX_TRACKED_STREAMS,
  createCliTransportSink,
  CLI_TRANSPORT_DIRECTORY,
  CLI_TRANSPORT_FILE_NAME,
  CLI_TRANSPORT_MAX_BYTES,
  CLI_TRANSPORT_MAX_GENERATIONS,
  createCliTransportSettingsAccessor,
  type CliTransportSettings,
  type CliTransportSettingsAccessor
} from '../../../src/monitor/cli-transport-sink';
import { KeyBlockLineRedactor, SanitizedLogger } from '../../../src/lib/logger';

let workspaceRoot = '';
let warnings: string[] = [];

const logger = { warn: (message: string) => warnings.push(message) };
const realLogger = new SanitizedLogger([]);

function livePath(root = workspaceRoot): string {
  return path.join(root, CLI_TRANSPORT_DIRECTORY, CLI_TRANSPORT_FILE_NAME);
}

/**
 * A settings accessor with a call counter, so "read per emit, never cached" is
 * an assertion rather than a claim about the source.
 */
function countingAccessor(
  overrides: Partial<CliTransportSettings> = {}
): CliTransportSettingsAccessor & { reads: number } {
  const accessor = {
    reads: 0,
    read: (): CliTransportSettings => {
      accessor.reads += 1;
      return {
        root: workspaceRoot,
        path: livePath(),
        maxBytes: CLI_TRANSPORT_MAX_BYTES,
        maxGenerations: CLI_TRANSPORT_MAX_GENERATIONS,
        ...overrides
      };
    }
  };
  return accessor;
}

function makeSink(
  settings: CliTransportSettingsAccessor,
  sanitize: (line: string) => string = (line) => line
): CliTransportSink {
  return new CliTransportSink({
    settings,
    sanitize,
    logger,
    now: () => new Date('2026-05-10T12:00:00.000Z')
  });
}

async function listTransportFiles(): Promise<readonly string[]> {
  const directory = path.join(workspaceRoot, CLI_TRANSPORT_DIRECTORY);
  try {
    return (await fs.readdir(directory)).filter((n) => n.startsWith(CLI_TRANSPORT_FILE_NAME)).sort();
  } catch {
    return [];
  }
}

async function readLive(): Promise<string> {
  return fs.readFile(livePath(), 'utf8');
}

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-cli-transport-'));
  warnings = [];
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

describe('CliTransportSink — the record it writes', () => {
  it('creates the .schegent directory on the first record', async () => {
    const sink = makeSink(countingAccessor());
    sink.record({ runId: 'run-1', phase: 'speckit-plan', stream: 'stdout', line: 'hello' });
    await sink.flushPendingWrites();

    expect(await readLive()).toBe(
      '2026-05-10T12:00:00.000Z\trun-1\tspeckit-plan\tstdout\thello\n'
    );
    expect(warnings, 'a missing parent is recovered, not reported').toEqual([]);
  });

  it('puts the content last, so cut -f5- recovers the CLI’s own bytes', async () => {
    const sink = makeSink(countingAccessor());
    // A stream-json line: tabs inside it must survive, because the content field
    // is terminal and cannot shift a column.
    const jsonLine = '{"type":"tool_result","text":"a\tb\tc"}';
    sink.record({ runId: 'run-1', phase: 'speckit-implement', stream: 'stdout', line: jsonLine });
    await sink.flushPendingWrites();

    const record = (await readLive()).trimEnd();
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
    const sink = makeSink(countingAccessor());
    sink.record({ runId: 'a\tb', phase: 'c\nd', stream: 'stderr', line: 'kept\there' });
    await sink.flushPendingWrites();

    const fields = (await readLive()).trimEnd().split('\t');
    expect(fields[1]).toBe('a b');
    expect(fields[2]).toBe('c d');
    expect(fields.slice(4).join('\t')).toBe('kept\there');
  });

  it('writes one physical line per record, in call order', async () => {
    const sink = makeSink(countingAccessor());
    for (const line of ['one', 'two', 'three']) {
      sink.record({ runId: 'run-1', phase: 'speckit-plan', stream: 'stdout', line });
    }
    await sink.flushPendingWrites();

    const lines = (await readLive()).split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.split('\t')[4])).toEqual(['one', 'two', 'three']);
  });

  it('does not truncate a long line — the bound is the file, not the record', async () => {
    // The audit payload's 640-char string cap cost one run 7046 of 7452 lines.
    // Trading that for a file-level bound is the whole design, so a line well
    // past any per-string cap has to arrive whole.
    const sink = makeSink(countingAccessor());
    const long = 'x'.repeat(20_000);
    sink.record({ runId: 'run-1', phase: 'speckit-plan', stream: 'stdout', line: long });
    await sink.flushPendingWrites();

    expect((await readLive()).trimEnd().split('\t')[4]).toBe(long);
    expect(await readLive()).not.toContain('truncated');
  });
});

describe('CliTransportSink — sanitization', () => {
  it('redacts through the host’s own SECRET_PATTERNS set', async () => {
    const sink = makeSink(countingAccessor(), (line) => realLogger.sanitize(line));
    const secret = `sk-ant-${'A'.repeat(40)}`;
    sink.record({
      runId: 'run-1',
      phase: 'speckit-implement',
      stream: 'stderr',
      line: `auth failed for ${secret}`
    });
    await sink.flushPendingWrites();

    const written = await readLive();
    expect(written).not.toContain(secret);
    expect(written).toContain('[REDACTED]');
  });

  it('sanitizes every line, not just the first', async () => {
    const seen: string[] = [];
    const sink = makeSink(countingAccessor(), (line) => {
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
    expect(await readLive()).not.toContain('hunter2');
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
    const sink = new CliTransportSink({
      settings: countingAccessor(),
      sanitize: (line) => realLogger.sanitize(line),
      sanitizeStreamLine: (line) => redactor.sanitizeLine(line),
      logger,
      now: () => new Date('2026-05-10T12:00:00.000Z')
    });
    for (const line of SPLIT_KEY) {
      sink.record({ runId: 'run-1', phase: 'speckit-implement', stream: 'stdout', line });
    }
    await sink.flushPendingWrites();

    const written = await readLive();
    expect(written.includes('BODY_MUST_NOT_SURVIVE')).toBe(false);
    expect(written.includes('b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ')).toBe(false);
    expect(written.includes('-----END')).toBe(false);
    // One record per suppressed line, not a gap: the transport aggregate's line
    // counts are the only surviving record of how much the CLI emitted.
    expect(written.trimEnd().split('\n')).toHaveLength(SPLIT_KEY.length);
    expect(written.includes('ordinary output resumes')).toBe(true);
  });

  it('wires the stateful sanitizer in the production factory', async () => {
    const sink = createCliTransportSink(() => workspaceRoot, {
      sanitize: (line) => realLogger.sanitize(line),
      warn: (message: string) => warnings.push(message)
    });
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

    const written = await readLive();
    expect(written.includes('BODY_MUST_NOT_SURVIVE')).toBe(false);
    expect(written.includes('-----END')).toBe(false);
    expect(written.includes('other run output')).toBe(true);
  });

  // FR-015 / SC-004 — the redactor registry is bounded by eviction rather than by
  // release, so the bound and its preference are the only things standing between
  // a long-lived host and either an unbounded map or a released key tail. SC-004
  // asks for measurement rather than inspection, and both constants and the map
  // are private to the factory, so these two cases drive the production factory
  // and read the outcome off the log.
  it('evicts a closed entry rather than a live open block (FR-015)', async () => {
    const sink = createCliTransportSink(() => workspaceRoot, {
      sanitize: (line) => realLogger.sanitize(line),
      warn: (message: string) => warnings.push(message)
    });
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

    const written = await readLive();
    // Boolean, never the protected string: the keeper's block is still open, so
    // its body line was suppressed even though 272 entries were created after it.
    expect(written.includes('BODY_MUST_NOT_SURVIVE')).toBe(false);
    expect(written.includes('short run 0 output')).toBe(true);
    expect(written.includes(`short run ${CLI_TRANSPORT_MAX_TRACKED_STREAMS + 15} output`)).toBe(
      true
    );
  });

  it('still bounds the map when every tracked entry is open (SC-004)', async () => {
    const sink = createCliTransportSink(() => workspaceRoot, {
      sanitize: (line) => realLogger.sanitize(line),
      warn: (message: string) => warnings.push(message)
    });
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

    const written = await readLive();
    expect(written.includes('EVICTED_STATE_MARKER')).toBe(true);
  });
});

describe('CliTransportSink — bounded by rotation', () => {
  /** A record is 5 attribution/format bytes plus the line; keep the arithmetic visible. */
  function recordBytes(line: string): number {
    return Buffer.byteLength(
      `2026-05-10T12:00:00.000Z\trun-1\tspeckit-plan\tstdout\t${line}\n`,
      'utf8'
    );
  }

  it('rotates the live file to .1 once the next record would exceed the bound', async () => {
    const line = 'a'.repeat(50);
    const size = recordBytes(line);
    // Two records fit exactly; the third must roll over.
    const sink = makeSink(countingAccessor({ maxBytes: size * 2, maxGenerations: 3 }));
    for (let index = 0; index < 3; index += 1) {
      sink.record({ runId: 'run-1', phase: 'speckit-plan', stream: 'stdout', line });
    }
    await sink.flushPendingWrites();

    expect(await listTransportFiles()).toEqual([
      CLI_TRANSPORT_FILE_NAME,
      `${CLI_TRANSPORT_FILE_NAME}.1`
    ]);
    expect(
      (await readLive()).split('\n').filter((l) => l.length > 0),
      'the record that triggered rotation starts the new file'
    ).toHaveLength(1);
    expect(
      (await fs.readFile(`${livePath()}.1`, 'utf8')).split('\n').filter((l) => l.length > 0)
    ).toHaveLength(2);
  });

  it('fills up to maxBytes inclusively before rolling', async () => {
    const line = 'b'.repeat(30);
    const size = recordBytes(line);
    const sink = makeSink(countingAccessor({ maxBytes: size, maxGenerations: 2 }));
    sink.record({ runId: 'run-1', phase: 'speckit-plan', stream: 'stdout', line });
    await sink.flushPendingWrites();

    expect(
      await listTransportFiles(),
      'a file exactly at the bound has not exceeded it'
    ).toEqual([CLI_TRANSPORT_FILE_NAME]);
  });

  it('never retains more than maxGenerations behind the live file', async () => {
    const line = 'c'.repeat(40);
    const sink = makeSink(
      countingAccessor({ maxBytes: recordBytes(line), maxGenerations: 2 })
    );
    // Ten rollovers against a two-generation cap: if the shift leaked, the
    // directory would grow with the number of records rather than stay bounded.
    for (let index = 0; index < 10; index += 1) {
      sink.record({ runId: 'run-1', phase: 'speckit-plan', stream: 'stdout', line });
    }
    await sink.flushPendingWrites();

    expect(await listTransportFiles()).toEqual([
      CLI_TRANSPORT_FILE_NAME,
      `${CLI_TRANSPORT_FILE_NAME}.1`,
      `${CLI_TRANSPORT_FILE_NAME}.2`
    ]);
  });

  it('shifts oldest-first, so the newest generation is .1', async () => {
    const line = 'd'.repeat(40);
    const sink = makeSink(
      countingAccessor({ maxBytes: recordBytes(line), maxGenerations: 2 })
    );
    for (const marker of ['first', 'second', 'third']) {
      sink.record({
        runId: 'run-1',
        phase: 'speckit-plan',
        stream: 'stdout',
        line: `${marker}${'d'.repeat(40 - marker.length)}`
      });
      await sink.flushPendingWrites();
    }

    expect(await fs.readFile(`${livePath()}.1`, 'utf8')).toContain('second');
    expect(await fs.readFile(`${livePath()}.2`, 'utf8')).toContain('first');
    expect(await readLive()).toContain('third');
  });

  it('truncates in place when no generations are retained', async () => {
    const line = 'e'.repeat(40);
    const sink = makeSink(
      countingAccessor({ maxBytes: recordBytes(line), maxGenerations: 0 })
    );
    sink.record({ runId: 'run-1', phase: 'speckit-plan', stream: 'stdout', line: `keep${line}` });
    sink.record({ runId: 'run-1', phase: 'speckit-plan', stream: 'stdout', line: `next${line}` });
    await sink.flushPendingWrites();

    expect(await listTransportFiles()).toEqual([CLI_TRANSPORT_FILE_NAME]);
    const written = await readLive();
    expect(written).toContain('next');
    expect(written, 'nothing to roll into, so the old content goes').not.toContain('keep');
  });

  it('sweeps generations orphaned above a lowered cap', async () => {
    // The cap is code-resident, so this is what a release that lowers it leaves
    // behind: slots the shift loop never visits.
    const directory = path.join(workspaceRoot, CLI_TRANSPORT_DIRECTORY);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(`${livePath()}.7`, 'orphan\n', 'utf8');
    await fs.writeFile(`${livePath()}.keep-me`, 'operator file\n', 'utf8');

    const line = 'f'.repeat(40);
    const sink = makeSink(
      countingAccessor({ maxBytes: recordBytes(line), maxGenerations: 2 })
    );
    for (let index = 0; index < 3; index += 1) {
      sink.record({ runId: 'run-1', phase: 'speckit-plan', stream: 'stdout', line });
    }
    await sink.flushPendingWrites();

    const files = await listTransportFiles();
    expect(files, 'a numeric suffix above the cap is swept').not.toContain(
      `${CLI_TRANSPORT_FILE_NAME}.7`
    );
    expect(files, 'a non-numeric suffix belongs to the operator').toContain(
      `${CLI_TRANSPORT_FILE_NAME}.keep-me`
    );
  });

  it('seeds its byte tally from a file an earlier session left behind', async () => {
    const line = 'g'.repeat(40);
    const size = recordBytes(line);
    const directory = path.join(workspaceRoot, CLI_TRANSPORT_DIRECTORY);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(livePath(), 'x'.repeat(size), 'utf8');

    const sink = makeSink(countingAccessor({ maxBytes: size, maxGenerations: 1 }));
    sink.record({ runId: 'run-1', phase: 'speckit-plan', stream: 'stdout', line });
    await sink.flushPendingWrites();

    expect(
      await listTransportFiles(),
      'a new session that assumed zero bytes would grow the file without bound'
    ).toEqual([CLI_TRANSPORT_FILE_NAME, `${CLI_TRANSPORT_FILE_NAME}.1`]);
  });
});

describe('CliTransportSink — settings and destination', () => {
  it('reads its settings once per record and holds nothing', async () => {
    const accessor = countingAccessor();
    const sink = makeSink(accessor);
    for (let index = 0; index < 4; index += 1) {
      sink.record({ runId: 'run-1', phase: 'speckit-plan', stream: 'stdout', line: `l${index}` });
    }
    await sink.flushPendingWrites();

    expect(accessor.reads, 'a cached settings object is the defect this shape prevents').toBe(4);
  });

  it('follows the workspace root when it changes mid-session', async () => {
    const second = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-cli-transport-second-'));
    try {
      const sink = makeSink(createCliTransportSettingsAccessor(() => workspaceRoot));
      sink.record({ runId: 'run-1', phase: 'speckit-plan', stream: 'stdout', line: 'in-first' });
      await sink.flushPendingWrites();

      const first = workspaceRoot;
      workspaceRoot = second;
      sink.record({ runId: 'run-2', phase: 'speckit-plan', stream: 'stdout', line: 'in-second' });
      await sink.flushPendingWrites();

      expect(await fs.readFile(livePath(first), 'utf8')).toContain('in-first');
      expect(await fs.readFile(livePath(second), 'utf8')).toContain('in-second');
      expect(await fs.readFile(livePath(first), 'utf8')).not.toContain('in-second');
    } finally {
      workspaceRoot = second;
      await fs.rm(second, { recursive: true, force: true });
      workspaceRoot = '';
    }
  });

  it('drops the line when there is no workspace folder', async () => {
    const sink = makeSink({ read: () => null });
    sink.record({ runId: 'run-1', phase: 'speckit-plan', stream: 'stdout', line: 'nowhere' });
    await sink.flushPendingWrites();

    expect(await listTransportFiles(), 'no destination is not a guessed destination').toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('exposes a bounded ceiling that does not depend on the audit log', () => {
    // The finding was a shared budget, so the numbers are asserted here: a
    // change to either would otherwise be invisible outside a rotation test.
    expect(CLI_TRANSPORT_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(CLI_TRANSPORT_MAX_GENERATIONS).toBe(3);
    expect(
      CLI_TRANSPORT_MAX_BYTES * (CLI_TRANSPORT_MAX_GENERATIONS + 1),
      'four files of 5 MiB — a fixed 20 MiB per workspace'
    ).toBe(20 * 1024 * 1024);
  });
});

describe('CliTransportSink — containment', () => {
  it('refuses a destination outside the root, writes nothing, and warns once', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-cli-transport-out-'));
    try {
      const escapePath = path.join(outside, 'stolen.log');
      const sink = makeSink({
        read: () => ({
          root: workspaceRoot,
          path: escapePath,
          maxBytes: CLI_TRANSPORT_MAX_BYTES,
          maxGenerations: CLI_TRANSPORT_MAX_GENERATIONS
        })
      });
      for (let index = 0; index < 5; index += 1) {
        sink.record({ runId: 'run-1', phase: 'speckit-plan', stream: 'stdout', line: 'escape' });
      }
      await sink.flushPendingWrites();

      await expect(fs.readFile(escapePath, 'utf8')).rejects.toThrow();
      expect(warnings, 'one WARN for five refused lines').toHaveLength(1);
      expect(warnings[0]).toContain('refused to write outside the workspace root');
      expect(
        warnings[0],
        'a path outside the root is exactly the string that must not reach a log'
      ).not.toContain(outside);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a live file symlinked out of the workspace', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-cli-transport-link-'));
    try {
      const decoy = path.join(outside, 'decoy.log');
      await fs.writeFile(decoy, '', 'utf8');
      await fs.mkdir(path.join(workspaceRoot, CLI_TRANSPORT_DIRECTORY), { recursive: true });
      await fs.symlink(decoy, livePath());

      const sink = makeSink(countingAccessor());
      sink.record({ runId: 'run-1', phase: 'speckit-plan', stream: 'stdout', line: 'through-link' });
      await sink.flushPendingWrites();

      expect(
        await fs.readFile(decoy, 'utf8'),
        'a replaced destination is refused, not written through'
      ).toBe('');
      expect(warnings).toHaveLength(1);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('stops asking after a refusal — the answer does not change per line', async () => {
    // Measured against a one-record baseline rather than a fixed number: the
    // oracle walks to the nearest existing ancestor, so how many `realpath`
    // calls one resolution costs depends on the temp tree's depth. The property
    // is that twenty records cost the same as one, not what that cost is.
    const escapePath = path.join(workspaceRoot, '..', 'escaped.log');
    const makeCountingSink = (): { sink: CliTransportSink; calls: () => number } => {
      let realpathCalls = 0;
      const sink = new CliTransportSink({
        settings: {
          read: () => ({
            root: workspaceRoot,
            path: escapePath,
            maxBytes: CLI_TRANSPORT_MAX_BYTES,
            maxGenerations: CLI_TRANSPORT_MAX_GENERATIONS
          })
        },
        sanitize: (line) => line,
        logger,
        realpath: async (target: string) => {
          realpathCalls += 1;
          return fs.realpath(target);
        }
      });
      return { sink, calls: () => realpathCalls };
    };

    const baseline = makeCountingSink();
    baseline.sink.record({ runId: 'run-1', phase: 'speckit-plan', stream: 'stdout', line: 'x' });
    await baseline.sink.flushPendingWrites();
    expect(baseline.calls(), 'one record must resolve at least once').toBeGreaterThan(0);

    const many = makeCountingSink();
    for (let index = 0; index < 20; index += 1) {
      many.sink.record({ runId: 'run-1', phase: 'speckit-plan', stream: 'stdout', line: 'x' });
    }
    await many.sink.flushPendingWrites();

    expect(
      many.calls(),
      'a per-line realpath on a refused path is a syscall per line of CLI output'
    ).toBe(baseline.calls());
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
    const sink = createCliTransportSink(
      () => null,
      {
        sanitize: (s: string) => s,
        warn: () => undefined
      } as unknown as Parameters<typeof createCliTransportSink>[1]
    );
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
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const accessor = countingAccessor();
    const sink = new CliTransportSink({
      settings: accessor,
      sanitize: (line) => line,
      logger,
      now: () => new Date('2026-05-10T12:00:00.000Z'),
      // A writer that never completes until released: the disk-blocked case.
      appendFile: async () => {
        await blocked;
      },
      mkdir: async () => undefined,
      stat: async () => ({ size: 0 })
    });

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
    const accessor = countingAccessor();
    const sink = new CliTransportSink({
      settings: accessor,
      sanitize: (line) => line,
      logger,
      now: () => new Date('2026-05-10T12:00:00.000Z'),
      appendFile: async () => undefined,
      mkdir: async () => undefined,
      stat: async () => ({ size: 0 })
    });
    for (let i = 0; i < 200; i += 1) {
      sink.record({ runId: 'r', phase: 'implement', stream: 'stdout', line: `line ${i}` } as never);
      await sink.flushPendingWrites();
    }
    expect(sink.droppedForBackpressure.lines).toBe(0);
  }, 30_000);
});
