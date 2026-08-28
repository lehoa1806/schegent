// Feature FR-R3-007 (T364) — a transport write that fails does not fail a phase.
//
// This is the property that makes the tier split safe to ship. The audit writer
// is allowed to fail a phase, because an unrecorded outcome is a real loss; the
// transport sink is not, because a line of stdout the operator could also read
// in the phase diagnostics is not worth ending three hours of work over. The
// model is `verbose-diagnostic-writer`, not `audit-writer`.
//
// "Does not fail a phase" has three parts, and each is a separate way the same
// promise gets broken:
//
//   1. `record()` does not throw. The monitor calls it from a synchronous stream
//      handler, so a throw here lands inside `onStdoutChunk` — which is on the
//      phase's own call stack.
//   2. Nothing rejects unobserved. `record()` is fire-and-forget by design, so a
//      rejected chain has no `await` to surface at; under Node's default
//      `--unhandled-rejections=throw` that ends the extension host, which is a
//      louder failure than the one being reported.
//   3. The warning is bounded. A phase emits tens of thousands of lines. An
//      unsuppressed WARN per line would bury the runtime log in the report of
//      its own failure, and the runtime log is where an operator would go to
//      find out why transport capture stopped.
//
// The failure injection is per-call rather than per-suite: each errno reaches a
// different branch (`ENOENT` is recovered, `EACCES` is not, a `stat` failure
// drops the record without marking the path seeded), and a single always-throws
// double would collapse them into one assertion.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as realFs from 'node:fs/promises';

import {
  CliTransportSink,
  CLI_TRANSPORT_DIRECTORY,
  CLI_TRANSPORT_FILE_NAME,
  type CliTransportRecord,
  type CliTransportSettings
} from '../../../src/monitor/cli-transport-sink';
import { expectNoDescriptorWarnings } from '../../setup/descriptor-warnings';

/**
 * FR-R3-137 (T1531c, FR-012) — every sink this file builds is disposed, and the
 * run is asserted to have produced no descriptor warning.
 *
 * This file emitted zero warnings before the item, because its sinks inject
 * `appendFile` and so never reach `appendHandleFor`. That is an accident of the
 * doubles, not a property of the code: FR-012 is a property of every construction
 * site, and a file that leaks nothing only because of its injected ports is one
 * refactor away from leaking.
 */
const live: CliTransportSink[] = [];
function track<T extends CliTransportSink>(sink: T): T {
  live.push(sink);
  return sink;
}
afterEach(async () => {
  // Descriptors before any temp tree the case removes: a handle outliving its
  // file is how the warning gets attributed to the wrong test.
  await Promise.all(live.splice(0).map((sink) => sink.flushAndDispose()));
});
afterAll(() => {
  expectNoDescriptorWarnings();
});

const ROOT = path.join(os.tmpdir(), 'schegent-transport-failure-root');
const TARGET = path.join(ROOT, CLI_TRANSPORT_DIRECTORY, CLI_TRANSPORT_FILE_NAME);

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

const LINE: CliTransportRecord = {
  runId: 'run-1',
  phase: 'speckit-implement',
  stream: 'stdout',
  line: 'a line of CLI output'
};

interface Harness {
  readonly sink: CliTransportSink;
  readonly warnings: string[];
  readonly appended: string[];
  readonly created: string[];
  readonly mkdirs: string[];
  readonly renames: Array<[string, string]>;
}

/**
 * Containment is stubbed to identity here rather than run against a real tree.
 * The real containment behaviour is `cli-transport-sink.test.ts`'s subject; what
 * this suite needs is for every record to reach the write branch so the injected
 * errno is the only thing under test.
 */
function harness(
  overrides: Partial<CliTransportSettings> = {},
  injections: {
    appendFile?: (target: string, data: string) => Promise<void>;
    writeFile?: (target: string, data: string) => Promise<void>;
    mkdir?: (target: string) => Promise<void>;
    rename?: (from: string, to: string) => Promise<void>;
    unlink?: (target: string) => Promise<void>;
    stat?: (target: string) => Promise<{ size: number }>;
    sanitize?: (line: string) => string;
    warn?: (message: string) => void;
  } = {}
): Harness {
  const warnings: string[] = [];
  const appended: string[] = [];
  const created: string[] = [];
  const mkdirs: string[] = [];
  const renames: Array<[string, string]> = [];
  const sink = track(new CliTransportSink({
    settings: {
      read: (): CliTransportSettings => ({
        root: ROOT,
        path: TARGET,
        maxBytes: 1024,
        maxGenerations: 2,
        ...overrides
      })
    },
    sanitize: injections.sanitize ?? ((line) => line),
    logger: {
      warn: (message: string) => {
        warnings.push(message);
        injections.warn?.(message);
      }
    },
    now: () => new Date('2026-05-10T12:00:00.000Z'),
    realpath: async (target: string) => target,
    appendFile:
      injections.appendFile ??
      (async (_target, data) => {
        appended.push(data);
      }),
    writeFile:
      injections.writeFile ??
      (async (_target, data) => {
        created.push(data);
      }),
    mkdir: async (target: string) => {
      mkdirs.push(target);
      if (injections.mkdir) await injections.mkdir(target);
      return undefined;
    },
    rename: async (from: string, to: string) => {
      renames.push([from, to]);
      if (injections.rename) await injections.rename(from, to);
    },
    unlink: injections.unlink ?? (async () => {}),
    stat: injections.stat ?? (async () => ({ size: 0 })),
    readdir: async () => []
  }));
  return { sink, warnings, appended, created, mkdirs, renames };
}

/** Any unhandled rejection during a test is a failure of property 2. */
let unhandled: unknown[] = [];
beforeEach(() => {
  unhandled = [];
  process.on('unhandledRejection', (reason) => unhandled.push(reason));
});

async function settle(h: Harness): Promise<void> {
  await h.sink.flushPendingWrites();
  // One extra macrotask turn: an unhandled rejection is reported after the
  // microtask queue drains, so flushing alone would miss it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  process.removeAllListeners('unhandledRejection');
  expect(unhandled, 'a fire-and-forget write must not reject unobserved').toEqual([]);
}

describe('CliTransportSink — a failed write does not fail the phase', () => {
  it('swallows EACCES, warns once, and keeps the path open for a retry', async () => {
    let calls = 0;
    const h = harness(
      {},
      {
        appendFile: async () => {
          calls += 1;
          throw errno('EACCES');
        }
      }
    );

    for (let index = 0; index < 50; index += 1) {
      expect(() => h.sink.record(LINE), 'record() is called from a phase’s stack').not.toThrow();
    }
    await settle(h);

    expect(h.warnings, 'fifty failures, one WARN').toHaveLength(1);
    expect(h.warnings[0]).toContain('the phase is unaffected');
    expect(
      calls,
      'EACCES can clear, so the path is not closed the way a containment refusal is'
    ).toBe(50);
  });

  it('never puts the destination path in the warning text', async () => {
    const h = harness({}, { appendFile: async () => { throw errno('ENOSPC'); } });
    h.sink.record(LINE);
    await settle(h);

    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('ENOSPC');
    expect(h.warnings[0], 'the runtime log is not where a workspace path belongs').not.toContain(
      ROOT
    );
  });

  it('warns separately for each distinct cause', async () => {
    let call = 0;
    const codes = ['ENOSPC', 'EIO', 'ENOSPC', 'EIO', 'EROFS'];
    const h = harness(
      {},
      {
        appendFile: async () => {
          throw errno(codes[call++] ?? 'EIO');
        }
      }
    );

    for (let index = 0; index < codes.length; index += 1) h.sink.record(LINE);
    await settle(h);

    expect(
      h.warnings,
      'three causes, three warnings — a repeat of a known cause is silent'
    ).toHaveLength(3);
  });

  it('recovers a missing parent directory once, without warning', async () => {
    let attempts = 0;
    const h = harness(
      {},
      {
        appendFile: async () => {
          attempts += 1;
          if (attempts === 1) throw errno('ENOENT');
        }
      }
    );

    h.sink.record(LINE);
    await settle(h);

    expect(h.mkdirs).toEqual([path.dirname(TARGET)]);
    expect(attempts, 'one retry after the mkdir').toBe(2);
    expect(h.warnings, 'a first-phase workspace has no .schegent yet; that is not a failure').toEqual(
      []
    );
  });

  it('warns once when the parent cannot be created either', async () => {
    const h = harness(
      {},
      {
        appendFile: async () => {
          throw errno('ENOENT');
        },
        mkdir: async () => {
          throw errno('EACCES');
        }
      }
    );

    for (let index = 0; index < 3; index += 1) h.sink.record(LINE);
    await settle(h);

    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('ENOENT-parent');
  });

  it('drops a record it cannot size, then recovers when stat does', async () => {
    let statCalls = 0;
    const h = harness(
      {},
      {
        stat: async () => {
          statCalls += 1;
          if (statCalls === 1) throw errno('EIO');
          return { size: 0 };
        }
      }
    );

    h.sink.record(LINE);
    await h.sink.flushPendingWrites();
    expect(h.appended, 'writing with no size in hand cannot honour the bound').toEqual([]);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('stat-failed');

    h.sink.record(LINE);
    await settle(h);
    expect(
      h.appended,
      'the path is not marked seeded on failure, so a transient error recovers'
    ).toHaveLength(1);
  });

  it('treats a missing file as zero bytes rather than a failure', async () => {
    const h = harness({}, { stat: async () => { throw errno('ENOENT'); } });
    h.sink.record(LINE);
    await settle(h);

    expect(h.appended).toHaveLength(1);
    expect(h.warnings).toEqual([]);
  });

  it('abandons a rotation it cannot perform, and does not lose the phase with it', async () => {
    const h = harness(
      { maxBytes: 1 },
      {
        rename: async () => {
          throw errno('EACCES');
        }
      }
    );

    expect(() => h.sink.record(LINE)).not.toThrow();
    await settle(h);

    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('rotation-failed');
    expect(h.created, 'the post-rotation create is skipped, not attempted blind').toEqual([]);
  });

  it('completes a rotation whose oldest-generation unlink fails', async () => {
    const h = harness(
      { maxBytes: 1 },
      {
        unlink: async () => {
          throw errno('EACCES');
        }
      }
    );

    h.sink.record(LINE);
    await settle(h);

    expect(h.created, 'the rotation itself succeeded; the sweep is a courtesy').toHaveLength(1);
    expect(h.warnings).toEqual([]);
  });

  it('does not throw out of record() when the sanitizer throws', async () => {
    // Sanitization runs synchronously inside `record()`, so this is the one
    // failure that lands directly on the monitor's stream handler.
    const h = harness(
      {},
      {
        sanitize: () => {
          throw new Error('regex blew up');
        }
      }
    );

    expect(() => h.sink.record(LINE)).not.toThrow();
    await settle(h);

    expect(h.appended, 'an unformattable record is dropped').toEqual([]);
    expect(h.warnings).toHaveLength(1);
  });

  it('does not let a throwing logger escalate a dropped line', async () => {
    // The warn path is the last thing standing between a failed write and the
    // phase. If it throws, the sink must still absorb it.
    const h = harness(
      {},
      {
        appendFile: async () => {
          throw errno('EIO');
        },
        warn: () => {
          throw new Error('sink is closed');
        }
      }
    );

    expect(() => h.sink.record(LINE)).not.toThrow();
    await settle(h);
  });

  it('reports nothing and writes nothing when there is no destination', async () => {
    const sink = track(new CliTransportSink({
      settings: { read: () => null },
      sanitize: (line) => line,
      logger: {
        warn: () => {
          throw new Error('no destination is not a failure');
        }
      },
      appendFile: async () => {
        throw new Error('must not be reached');
      },
      realpath: async (target: string) => target
    }));

    expect(() => sink.record(LINE)).not.toThrow();
    await sink.flushPendingWrites();
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.removeAllListeners('unhandledRejection');
    expect(unhandled).toEqual([]);
  });

  it('leaves no pending work behind, so a flush always settles', async () => {
    const h = harness({}, { appendFile: async () => { throw errno('EIO'); } });
    for (let index = 0; index < 10; index += 1) h.sink.record(LINE);
    await settle(h);
    // A second flush with nothing pending must return rather than spin.
    await expect(h.sink.flushPendingWrites()).resolves.toBeUndefined();
  });
});

describe('CliTransportSink — real filesystem, real permissions', () => {
  it('warns once and continues when the destination is read-only', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const root = await realFs.mkdtemp(path.join(os.tmpdir(), 'schegent-transport-ro-'));
    try {
      const directory = path.join(root, CLI_TRANSPORT_DIRECTORY);
      await realFs.mkdir(directory, { recursive: true });
      const target = path.join(directory, CLI_TRANSPORT_FILE_NAME);
      await realFs.writeFile(target, '', 'utf8');
      await realFs.chmod(target, 0o444);

      const warnings: string[] = [];
      const sink = track(new CliTransportSink({
        settings: {
          read: () => ({ root, path: target, maxBytes: 1024, maxGenerations: 2 })
        },
        sanitize: (line) => line,
        logger: { warn: (message: string) => warnings.push(message) }
      }));

      for (let index = 0; index < 5; index += 1) sink.record(LINE);
      await sink.flushPendingWrites();

      expect(await realFs.readFile(target, 'utf8')).toBe('');
      expect(warnings, 'an unwritable destination is one WARN, not five').toHaveLength(1);
    } finally {
      await realFs.chmod(path.join(root, CLI_TRANSPORT_DIRECTORY, CLI_TRANSPORT_FILE_NAME), 0o644)
        .catch(() => {});
      await realFs.rm(root, { recursive: true, force: true });
    }
  });
});
