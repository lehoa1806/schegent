// Feature 218 (FR-R3-191) — The runtime log writer's release, on real files
// (T1858b, research R8):
//   US1-1. The descriptor a written line left open is closed by the release, and
//          the count goes from 1 to 0 (FR-001, FR-009).
//   US1-2. An append open still in flight when the close step runs is closed when
//          it completes, and its line is not written (FR-004, SC-006).
//   US1-3. A line that never reaches a descriptor holds the release for the grace
//          and no longer, and the release says so once, naming no path and no
//          count (FR-003, FR-008, SC-007).
//   US1-4. A released writer refuses a later line without reading its settings,
//          calling a port or opening a file (FR-002).
//   US1-5. Repeated and concurrent calls receive the same promise, and the drain
//          runs once (FR-006).
//   US1-6. The release waits for a close that a settings correction began
//          (FR-005).
//   Edge cases: a writer with no containment roots refuses later lines too, and a
//   close that rejects still lets the release resolve (FR-002, FR-007).
//   Checks 2, 2b and 6, each on a writer with no roots so that its ports can be
//   counted: a line queued behind the close step, a line that resumes after it,
//   and an append that fails after it touch nothing more (FR-004).
//
// Each case writes under its own `mkdtemp` in `os.tmpdir()`, which the global
// setup points at the run's temp root, and removes nothing: that root goes at
// teardown. The capture list is cleared after every case, so no case leaves a
// handle reachable (research R12). This file does not opt in to the descriptor
// detector (FR-022).

import * as nodeFs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SanitizedLogger } from '../../../../src/lib/logger';
import {
  RuntimeLogSink,
  type RuntimeLogSinkDeps
} from '../../../../src/lib/runtime-log/runtime-log-sink';
import type { RuntimeLogAccessor } from '../../../../src/lib/runtime-log/runtime-log-settings';

// The capture: every handle the writer's rooted opens produced, in order. A plain
// function, never a `vi.fn`: a spy's recorded results would keep each handle
// reachable after its close, and feature 217's probe lists a reachable handle as
// still open (research R12).
const capture = vi.hoisted(() => ({ opened: [] as nodeFs.FileHandle[] }));
vi.mock('../../../../src/lib/safe-open', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/lib/safe-open')>();
  return {
    ...actual,
    openWithinRootByPath: async (
      ...args: Parameters<typeof actual.openWithinRootByPath>
    ): ReturnType<typeof actual.openWithinRootByPath> => {
      const result = await actual.openWithinRootByPath(...args);
      if (result.outcome === 'opened') capture.opened.push(result.handle);
      return result;
    }
  };
});

const LINE = '[2026-10-19T00:00:00.000Z] INFO runtime-log-sink-release';

/** An injected grace, short enough to read and distinct from the default. */
const GRACE_MS = 50;

/** Large enough that no case's lines roll the file over. The check 2 case seeds a size near it. */
const MAX_BYTES = 65_536;
const MAX_GENERATIONS = 3;

/** The writer's own prefix, which the release's warning carries. */
const PREFIX = /^runtime-log-sink: /;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Whether `promise` has settled, observed without awaiting it. */
function watch(promise: Promise<unknown>): () => boolean {
  let settled = false;
  const mark = (): void => {
    settled = true;
  };
  void promise.then(mark, mark);
  return () => settled;
}

/** One full turn of the event loop, so every microtask already queued has run. */
function turn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * The one handle the case's writer has opened. The case fails unless there is
 * exactly one. Read through `at`, so the handle is narrowed, not asserted
 * (`tests/lint/compiler-strictness-ratchet.test.ts`).
 */
function onlyOpened(): nodeFs.FileHandle {
  expect(capture.opened).toHaveLength(1);
  const handle = capture.opened.at(0);
  if (handle === undefined) throw new Error('the writer opened no handle');
  return handle;
}

/** The writer's optional ports, without the two it requires. */
type Ports = Omit<RuntimeLogSinkDeps, 'accessor' | 'fallbackLogger'>;

interface Built {
  readonly sink: RuntimeLogSink;
  /** The case's own folder, which every path the writer touches sits under. */
  readonly root: string;
  readonly target: string;
  /** Every WARN the writer sent to its fallback, in order. */
  readonly warnings: readonly string[];
  /** How many times the writer has read its settings. */
  readonly reads: () => number;
}

/** Every writer the current case built. `afterEach` releases them, passed or failed. */
const live: RuntimeLogSink[] = [];

afterEach(async () => {
  try {
    // A case that failed under fake timers can leave its release waiting on a
    // faked grace. Fire it first, or the release below waits out the hook's
    // timeout and the writer is never released.
    if (vi.isFakeTimers()) await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    await Promise.all(live.splice(0).map((sink) => sink.flushAndDispose()));
  } finally {
    capture.opened.length = 0;
    vi.useRealTimers();
  }
});

/**
 * A writer over a fresh folder, rooted there unless `rooted` is false. `logs/` is
 * not created first: the rooted open creates it owner-only, so nothing is
 * narrowed, and the only WARN a case sees is the release's.
 */
async function build(ports: Ports = {}, rooted = true): Promise<Built> {
  const root = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'runtime-log-release-'));
  const target = path.join(root, 'logs', 'runtime.log');
  let reads = 0;
  const accessor: RuntimeLogAccessor = {
    read: () => {
      reads += 1;
      return { level: 'INFO', path: target, maxBytes: MAX_BYTES, maxGenerations: MAX_GENERATIONS };
    }
  };
  const warnings: string[] = [];
  const fallbackLogger = new SanitizedLogger();
  fallbackLogger.warn = (message: string) => {
    warnings.push(message);
  };
  const sink = new RuntimeLogSink({
    accessor,
    fallbackLogger,
    ...(rooted ? { containmentRoots: () => [root] } : {}),
    ...ports
  });
  live.push(sink);
  return { sink, root, target, warnings, reads: () => reads };
}

/**
 * The writer's filesystem ports over the real filesystem, each counted by a plain
 * wrapper. An unchanged count is what shows a refused line touched nothing.
 */
function countingPorts(): { readonly ports: Ports; readonly calls: () => number } {
  let calls = 0;
  function counted<A extends unknown[], R>(
    port: (...args: A) => Promise<R>
  ): (...args: A) => Promise<R> {
    return (...args: A): Promise<R> => {
      calls += 1;
      return port(...args);
    };
  }
  return {
    ports: {
      appendFile: counted((target: string, data: string) => nodeFs.appendFile(target, data)),
      mkdir: counted((target: string, opts: { recursive: true; mode?: number }) =>
        nodeFs.mkdir(target, opts)
      ),
      rename: counted((from: string, to: string) => nodeFs.rename(from, to)),
      unlink: counted((target: string) => nodeFs.unlink(target)),
      stat: counted(async (target: string) => ({ size: (await nodeFs.stat(target)).size })),
      writeFile: counted((target: string, data: string) => nodeFs.writeFile(target, data)),
      readdir: counted((target: string) => nodeFs.readdir(target)),
      realpath: counted((target: string) => nodeFs.realpath(target))
    },
    calls: () => calls
  };
}

/**
 * A size check that holds the first line until the case lets it go, then
 * answers `size`. The hold is before the line can reach the filesystem.
 */
function gatedStat(size: number): {
  readonly stat: (target: string) => Promise<{ size: number }>;
  readonly entered: Promise<void>;
  readonly letGo: () => void;
} {
  const entered = deferred<void>();
  const gate = deferred<void>();
  return {
    stat: async () => {
      entered.resolve();
      await gate.promise;
      return { size };
    },
    entered: entered.promise,
    letGo: () => {
      gate.resolve();
    }
  };
}

/** Releases `sink` once its grace has expired, so the close step runs while a line is held. */
async function releasePastTheGrace(sink: RuntimeLogSink): Promise<void> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const release = sink.flushAndDispose();
  await vi.advanceTimersByTimeAsync(GRACE_MS);
  await release;
  vi.useRealTimers();
}

describe('RuntimeLogSink.flushAndDispose — the writer gives its descriptors back', () => {
  it('US1-1: the release closes the descriptor a written line left open (FR-001, FR-009)', async () => {
    const { sink, target } = await build();
    sink.appendLine(LINE);
    await sink.flushPendingWrites();
    expect(sink.openDescriptorCount).toBe(1);
    const handle = onlyOpened();

    await sink.flushAndDispose();

    expect(sink.openDescriptorCount).toBe(0);
    expect(handle.fd).toBe(-1);
    expect(await nodeFs.readFile(target, 'utf8')).toBe(`${LINE}\n`);
  });

  it('US1-2: an open still in flight at the close step is closed when it completes (FR-004, SC-006)', async () => {
    // The stall sits between `openWithinRootByPath` returning and `openRooted`
    // returning: `narrowGenerationsOnce` lists the folder in between. So the
    // descriptor exists, and the writer has not been handed it yet.
    const entered = deferred<void>();
    const gate = deferred<void>();
    const { sink, target, warnings } = await build({
      drainGraceMs: GRACE_MS,
      readdir: async (dir: string) => {
        entered.resolve();
        await gate.promise;
        return nodeFs.readdir(dir);
      }
    });
    let handle: nodeFs.FileHandle;
    try {
      sink.appendLine(LINE);
      await entered.promise;
      handle = onlyOpened();

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const release = sink.flushAndDispose();
      await vi.advanceTimersByTimeAsync(GRACE_MS);
      await release;

      expect(sink.openDescriptorCount).toBe(0);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(PREFIX);
    } finally {
      // Opened even when a step above fails: the open waits on this gate, and
      // only once it completes can the writer close the descriptor it made.
      gate.resolve();
    }
    await sink.flushPendingWrites();

    // The count first: with check 5 removed, this is the assertion that fails, at 1.
    expect(sink.openDescriptorCount).toBe(0);
    expect(handle.fd).toBe(-1);
    expect(await nodeFs.readFile(target, 'utf8')).not.toContain(LINE);
  });

  it('US1-3: a stalled line holds the release for the grace and no longer (FR-003, FR-008, SC-007)', async () => {
    // A size check that never answers: the line stops before any write reaches a
    // descriptor, so the drain cannot finish and only the grace ends the wait.
    const entered = deferred<void>();
    const never = deferred<{ size: number }>();
    const { sink, root, warnings } = await build({
      drainGraceMs: GRACE_MS,
      stat: () => {
        entered.resolve();
        return never.promise;
      }
    });
    sink.appendLine(LINE);
    await entered.promise;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const release = sink.flushAndDispose();
    const settled = watch(release);
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    await turn();
    expect(settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await turn();
    expect(settled()).toBe(true);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(PREFIX);
    expect(warnings[0]).not.toContain(root);
    expect(warnings[0]).not.toMatch(/\d/);
    expect(sink.openDescriptorCount).toBe(0);
    expect(capture.opened).toHaveLength(0);
  });

  it('US1-4: a released writer refuses a line without reading settings or touching a file (FR-002)', async () => {
    const counting = countingPorts();
    const { sink, target, reads } = await build(counting.ports);
    sink.appendLine(LINE);
    await sink.flushPendingWrites();
    // The control: before the release a line does reach the ports, so the
    // unchanged counts below are a refusal and not a writer that never wrote.
    expect(counting.calls()).toBeGreaterThan(0);
    await sink.flushAndDispose();
    const before = { reads: reads(), calls: counting.calls(), opened: capture.opened.length };

    sink.appendLine(LINE);
    await sink.flushPendingWrites();

    expect({ reads: reads(), calls: counting.calls(), opened: capture.opened.length }).toEqual(
      before
    );
    expect(await nodeFs.readFile(target, 'utf8')).toBe(`${LINE}\n`);
  });

  it('US1-5: every call receives the same promise, and the drain runs once (FR-006)', async () => {
    const { sink, target } = await build();
    let drains = 0;
    const flush = sink.flushPendingWrites.bind(sink);
    sink.flushPendingWrites = (): Promise<void> => {
      drains += 1;
      return flush();
    };
    sink.appendLine(LINE);

    const first = sink.flushAndDispose();
    const second = sink.flushAndDispose();
    expect(second).toBe(first);
    await first;
    expect(sink.flushAndDispose()).toBe(first);

    expect(drains).toBe(1);
    expect(sink.openDescriptorCount).toBe(0);
    // The line accepted before the release was let finish (FR-003).
    expect(await nodeFs.readFile(target, 'utf8')).toBe(`${LINE}\n`);
  });

  it('US1-6: the release waits for a close that a settings correction began (FR-005)', async () => {
    const { sink, target } = await build();
    sink.appendLine(LINE);
    await sink.flushPendingWrites();
    const handle = onlyOpened();
    // Node 24 gives each handle its own `close` (research R5), so replacing it
    // gates this handle's close and no other.
    const gate = deferred<void>();
    const close = handle.close.bind(handle);
    handle.close = async (): Promise<void> => {
      await gate.promise;
      return close();
    };

    let release: Promise<void>;
    try {
      sink.clearSuppression(target);
      release = sink.flushAndDispose();
      const settled = watch(release);
      await turn();
      expect(settled()).toBe(false);
    } finally {
      // Opened even when a step above fails: the close waits on this gate.
      gate.resolve();
    }
    await release;

    expect(handle.fd).toBe(-1);
    expect(sink.openDescriptorCount).toBe(0);
  });

  it('a writer with no containment roots refuses later lines too (FR-002)', async () => {
    const { sink, target, reads } = await build({}, false);
    sink.appendLine(LINE);
    await sink.flushPendingWrites();
    expect(await nodeFs.readFile(target, 'utf8')).toBe(`${LINE}\n`);
    expect(sink.openDescriptorCount).toBe(0);

    await sink.flushAndDispose();
    const readsBefore = reads();
    sink.appendLine(LINE);
    await sink.flushPendingWrites();

    expect(reads()).toBe(readsBefore);
    expect(await nodeFs.readFile(target, 'utf8')).toBe(`${LINE}\n`);
    expect(capture.opened).toHaveLength(0);
  });

  it("the release resolves, holding nothing, when a descriptor's close rejects (FR-007)", async () => {
    const { sink } = await build();
    sink.appendLine(LINE);
    await sink.flushPendingWrites();
    const handle = onlyOpened();
    const close = handle.close.bind(handle);
    handle.close = async (): Promise<void> => {
      await close();
      throw new Error('EIO');
    };

    await expect(sink.flushAndDispose()).resolves.toBeUndefined();

    expect(sink.openDescriptorCount).toBe(0);
    expect(handle.fd).toBe(-1);
  });
});

describe('RuntimeLogSink — a line the close step overtakes touches nothing more (FR-004)', () => {
  it('check 2: a line queued behind one held at the close step is refused before it can rotate', async () => {
    // The held line seeds a size it fits exactly, so the longer line queued
    // behind it would overflow and rotate. The writer has no roots and checks
    // no containment: only check 2 stands before the rename.
    const counting = countingPorts();
    const held = gatedStat(MAX_BYTES - Buffer.byteLength(`${LINE}\n`));
    const { sink } = await build(
      { ...counting.ports, stat: held.stat, drainGraceMs: GRACE_MS },
      false
    );
    sink.appendLine(LINE);
    sink.appendLine(`${LINE} and a longer line queued behind it`);
    await held.entered;
    await releasePastTheGrace(sink);
    const before = counting.calls();

    held.letGo();
    await sink.flushPendingWrites();

    expect(counting.calls()).toBe(before);
  });

  it('check 2b: a line that resumes after the close step appends nothing', async () => {
    const counting = countingPorts();
    const held = gatedStat(0);
    const { sink } = await build(
      { ...counting.ports, stat: held.stat, drainGraceMs: GRACE_MS },
      false
    );
    sink.appendLine(LINE);
    await held.entered;
    await releasePastTheGrace(sink);
    const before = counting.calls();

    held.letGo();
    await sink.flushPendingWrites();

    expect(counting.calls()).toBe(before);
  });

  it('check 6: an append that fails after the close step does not create its folder', async () => {
    // The append is issued before the close step and fails after it: `logs/`
    // does not exist. The rootless recovery would create it and append again.
    const entered = deferred<void>();
    const gate = deferred<void>();
    let appends = 0;
    let mkdirs = 0;
    const { sink, target } = await build(
      {
        drainGraceMs: GRACE_MS,
        appendFile: async (file: string, data: string) => {
          appends += 1;
          entered.resolve();
          await gate.promise;
          return nodeFs.appendFile(file, data);
        },
        mkdir: (dir: string, opts: { recursive: true; mode?: number }) => {
          mkdirs += 1;
          return nodeFs.mkdir(dir, opts);
        }
      },
      false
    );
    sink.appendLine(LINE);
    await entered.promise;
    await releasePastTheGrace(sink);

    gate.resolve();
    await sink.flushPendingWrites();

    expect({ appends, mkdirs }).toEqual({ appends: 1, mkdirs: 0 });
    await expect(nodeFs.stat(path.dirname(target))).rejects.toThrow();
  });
});
