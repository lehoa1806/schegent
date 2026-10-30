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
//      rejected write has no `await` to surface at; under Node's default
//      `--unhandled-rejections=throw` that ends the extension host, which is a
//      louder failure than the one being reported.
//   3. The warning is bounded. A phase emits tens of thousands of lines. An
//      unsuppressed WARN per line would bury the runtime log in the report of
//      its own failure, and the runtime log is where an operator would go to
//      find out why transport capture stopped.
//
// Feature 251 (FR-R4-F04) moved the file I/O the failures happen in from the sink to the router's store,
// and with it the ports this file used to inject. A real filesystem cannot be made to fail with `ENOSPC`
// on demand, so the failure is injected where the file layer is: a store whose methods throw a chosen
// errno, passed to the real router, behind the real sink. The sink's own failures (a throwing sanitizer
// or logger) are unchanged. Each errno reaches a different report (a drop is per cause), and a single
// always-throws double would collapse them into one assertion.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as realFs from 'node:fs/promises';

import {
  CliTransportSink,
  createCliTransportSink,
  type CliTransportRecord
} from '../../../src/monitor/cli-transport-sink';
import { RunTransportStore, TransportStoreError } from '../../../src/monitor/transport/run-transport-store';
import { createTransportRouter, type TransportRouter } from '../../../src/monitor/transport/transport-router';
import { expectNoDescriptorWarnings } from '../../setup/descriptor-warnings';
import { removeTempRoot } from '../../temp-root-cleanup';

/**
 * FR-R3-137 (T1531c, FR-012) — every sink this file builds is disposed, and the run is asserted to have
 * produced no descriptor warning.
 */
const live: CliTransportSink[] = [];
function track<T extends CliTransportSink>(sink: T): T {
  live.push(sink);
  return sink;
}
afterEach(async () => {
  await Promise.all(live.splice(0).map((sink) => sink.flushAndDispose()));
});
afterAll(() => {
  expectNoDescriptorWarnings();
});

const LINE: CliTransportRecord = {
  runId: 'run-1',
  phase: 'speckit-implement',
  stream: 'stdout',
  line: 'a line of CLI output'
};

/** A store whose appends and reads fail with the errno a test sets, and succeed once it is cleared. */
class FailingStore extends RunTransportStore {
  failure: string | null = null;
  appended = 0;
  seedFailure: string | null = null;
  listFailure: string | null = null;

  override async listRunFiles(...args: Parameters<RunTransportStore['listRunFiles']>) {
    if (this.listFailure !== null) throw new TransportStoreError(this.listFailure);
    return super.listRunFiles(...args);
  }

  override async stateOf(...args: Parameters<RunTransportStore['stateOf']>) {
    if (this.seedFailure !== null) throw new TransportStoreError(this.seedFailure);
    return super.stateOf(...args);
  }

  override async append(...args: Parameters<RunTransportStore['append']>): Promise<void> {
    if (this.failure !== null) throw new TransportStoreError(this.failure);
    this.appended += 1;
    return super.append(...args);
  }
}

interface Harness {
  readonly sink: CliTransportSink;
  readonly router: TransportRouter;
  readonly store: FailingStore;
  readonly warnings: string[];
  readonly root: string;
}

async function harness(
  options: {
    readonly sanitize?: (line: string) => string;
    readonly warn?: (message: string) => void;
    readonly workspaceRoot?: string | null;
  } = {}
): Promise<Harness> {
  const root = await realFs.mkdtemp(path.join(os.tmpdir(), 'schegent-transport-failure-'));
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    options.warn?.(message);
  };
  const store = new FailingStore({ tempRoot: path.join(root, 'os-temp'), warn });
  const workspaceRoot = options.workspaceRoot === undefined ? path.join(root, 'workspace') : options.workspaceRoot;
  if (workspaceRoot !== null) await realFs.mkdir(workspaceRoot, { recursive: true });
  const router = createTransportRouter({
    workspaceRoot: () => workspaceRoot,
    readSetting: () => 'on',
    readRawTranscriptMode: () => 'errors-only',
    readMaxAgeDays: () => 30,
    tempRoot: path.join(root, 'os-temp'),
    runStatus: () => undefined,
    logger: { warn },
    store
  });
  const sink = track(
    createCliTransportSink(router, { sanitize: options.sanitize ?? ((line) => line), warn })
  );
  cleanup.push(root);
  return { sink, router, store, warnings, root };
}

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await removeTempRoot(dir);
});

/** Any unhandled rejection during a test is a failure of property 2. */
let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeEach(() => {
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
});

async function settle(h: Harness): Promise<void> {
  await h.sink.flushPendingWrites();
  // One extra macrotask turn: an unhandled rejection is reported after the
  // microtask queue drains, so flushing alone would miss it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled, 'a fire-and-forget write must not reject unobserved').toEqual([]);
}

describe('transport — a failed write does not fail the phase', () => {
  it('swallows EACCES, warns once, and keeps the Run open for a retry', async () => {
    const h = await harness();
    h.store.failure = 'EACCES';
    for (let index = 0; index < 5; index += 1) h.sink.record(LINE);
    await settle(h);

    expect(h.store.appended).toBe(0);
    expect(h.warnings.filter((w) => w.includes('EACCES')), 'one WARN for five failures').toHaveLength(1);

    // The failure clears; the next record lands. A failed write does not close the Run for good.
    h.store.failure = null;
    h.sink.record(LINE);
    await h.sink.flushPendingWrites();
    expect(h.store.appended).toBe(1);
  });

  it('never puts the destination path in the warning text', async () => {
    const h = await harness();
    h.store.failure = 'EACCES';
    h.sink.record(LINE);
    await settle(h);

    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).not.toContain(h.root);
    expect(h.warnings[0]).not.toContain('transport.log');
  });

  it('warns separately for each distinct cause', async () => {
    const h = await harness();
    for (const code of ['EACCES', 'ENOSPC', 'EIO']) {
      h.store.failure = code;
      h.sink.record(LINE);
      h.sink.record(LINE);
      await h.sink.flushPendingWrites();
    }
    await settle(h);

    expect(h.warnings.filter((w) => w.includes('EACCES'))).toHaveLength(1);
    expect(h.warnings.filter((w) => w.includes('ENOSPC'))).toHaveLength(1);
    expect(h.warnings.filter((w) => w.includes('EIO'))).toHaveLength(1);
  });

  it('drops a record it cannot size, then recovers when the read does', async () => {
    const h = await harness();
    h.store.seedFailure = 'EIO';
    h.sink.record(LINE);
    await h.sink.flushPendingWrites();
    expect(h.store.appended, 'a write with no size in hand cannot honour the bounds').toBe(0);

    h.store.seedFailure = null;
    h.sink.record(LINE);
    await settle(h);
    expect(h.store.appended).toBe(1);
  });

  it('does not throw out of record() when the sanitizer throws', async () => {
    const h = await harness({
      sanitize: () => {
        throw new Error('regex blew up');
      }
    });

    expect(() => h.sink.record(LINE)).not.toThrow();
    await settle(h);
    expect(h.warnings.filter((w) => w.includes('format-failed'))).toHaveLength(1);
    expect(h.store.appended).toBe(0);
  });

  it('does not let a throwing logger escalate a dropped line', async () => {
    const h = await harness({
      warn: () => {
        throw new Error('logger is broken');
      }
    });
    h.store.failure = 'EACCES';

    expect(() => h.sink.record(LINE)).not.toThrow();
    await settle(h);
  });

  it('reports nothing and writes nothing when there is no destination', async () => {
    const h = await harness({ workspaceRoot: null });
    for (let index = 0; index < 3; index += 1) h.sink.record(LINE);
    await settle(h);

    expect(h.store.appended).toBe(0);
    expect(h.warnings, 'no destination is not a guessed destination').toEqual([]);
  });

  it('leaves no pending work behind, so a flush always settles', async () => {
    const h = await harness();
    h.store.failure = 'ENOSPC';
    for (let index = 0; index < 10; index += 1) h.sink.record(LINE);

    await expect(h.sink.flushPendingWrites()).resolves.toBeUndefined();
    expect(h.sink.inFlight.writes).toBe(0);
    process.off('unhandledRejection', onUnhandled);
  });

  it('keeps a retention failure from failing the Run end, and reports it once', async () => {
    const h = await harness();
    h.sink.record(LINE);
    await h.sink.flushPendingWrites();
    // The Run's end promotes and enforces bounds through the store; a store that fails there is reported
    // by the router and the end still resolves (X5).
    h.store.listFailure = 'EIO';
    await expect(h.router.finalizeRun('run-1', 'failed', new Set())).resolves.toBeUndefined();
    await expect(h.router.finalizeRun('run-1', 'failed', new Set())).resolves.toBeUndefined();

    expect(h.warnings.filter((w) => w.includes('could not apply transport retention')), 'once').toHaveLength(1);
    process.off('unhandledRejection', onUnhandled);
  });
});

describe('transport — real filesystem, real permissions', () => {
  it('warns once and continues when the workspace is read-only', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const root = await realFs.mkdtemp(path.join(os.tmpdir(), 'schegent-transport-ro-'));
    try {
      await realFs.chmod(root, 0o500);

      const warnings: string[] = [];
      const router = createTransportRouter({
        workspaceRoot: () => root,
        readSetting: () => 'on',
        readRawTranscriptMode: () => 'errors-only',
        readMaxAgeDays: () => 30,
        tempRoot: path.join(root, 'os-temp'),
        runStatus: () => undefined,
        logger: { warn: (message: string) => warnings.push(message) }
      });
      const sink = track(
        createCliTransportSink(router, { sanitize: (line) => line, warn: (message) => warnings.push(message) })
      );

      for (let index = 0; index < 5; index += 1) sink.record(LINE);
      await sink.flushPendingWrites();

      expect(warnings.filter((w) => w.includes('EACCES')), 'an unwritable workspace is one WARN, not five').toHaveLength(1);
      await expect(realFs.stat(path.join(root, '.schegent'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await realFs.chmod(root, 0o700).catch(() => undefined);
      await realFs.rm(root, { recursive: true, force: true });
    }
  });
});
