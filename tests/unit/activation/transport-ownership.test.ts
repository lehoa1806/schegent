import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * FR-R3-137 — who closes the transport sink, on both paths out of `wireStage2`.
 *
 * The sink opens one append descriptor per destination and, until this item, the
 * only thing that ever closed one was the garbage collector. Two of the
 * obligations that came out of that live at the wiring boundary rather than inside
 * the sink, and this file holds those two:
 *
 *   FR-009 / C5 — a `wireStage2` that throws AFTER the sink exists must still
 *   close it. C5 is explicit that this is a requirement about registration order:
 *   "the closure is registered at the moment the sink is created, not at the end
 *   of a successful `wireStage2`, and the failure path runs the same closure the
 *   success path does."
 *
 *   FR-011 — reset and workspace-folder change reach that same closure through the
 *   existing `tearDownStage2`, with no second stop path added.
 */

vi.mock('vscode', () => {
  const disposable = { dispose: () => undefined };
  return {
    workspace: {
      workspaceFolders: undefined as readonly { uri: { fsPath: string } }[] | undefined,
      onDidChangeWorkspaceFolders: () => disposable,
      onDidGrantWorkspaceTrust: () => disposable,
      onDidChangeConfiguration: () => disposable,
      isTrusted: true,
      getConfiguration: () => ({
        get: <T>(_key: string, def?: T): T | undefined => def,
        inspect: () => ({ workspaceValue: undefined, globalValue: undefined })
      })
    },
    window: {
      showErrorMessage: () => Promise.resolve(undefined),
      showWarningMessage: () => Promise.resolve(undefined),
      showInformationMessage: () => Promise.resolve(undefined)
    },
    Uri: { file: (p: string) => ({ fsPath: p, scheme: 'file', path: p }) },
    StatusBarAlignment: { Left: 1, Right: 2 }
  };
});

/**
 * The sink instances the wiring creates, captured. Needed because the failure case
 * below never gets a return value to read the transport off — which is the whole
 * shape of the defect: on a throw, the only reference to the sink was the one
 * inside the monitor.
 */
const captured = vi.hoisted(() => ({ sinks: [] as unknown[] }));

vi.mock('../../../src/monitor/cli-transport-sink', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/monitor/cli-transport-sink')>();
  return {
    ...actual,
    createCliTransportSink: (
      ...args: Parameters<typeof actual.createCliTransportSink>
    ): ReturnType<typeof actual.createCliTransportSink> => {
      const sink = actual.createCliTransportSink(...args);
      captured.sinks.push(sink);
      return sink;
    }
  };
});

import type * as vscode from 'vscode';
import {
  wireBackendExecution,
  type BackendExecutionWiringDeps
} from '../../../src/activation/backend-execution-wiring';
import type { CliTransportSink } from '../../../src/monitor/cli-transport-sink';
import { EvidenceHealthMonitor } from '../../../src/services/evidence-health/evidence-health-monitor';

const WORKSPACE_ROOT = '/tmp/schegent-transport-ownership';

/**
 * The wiring's bindings, only three of which this file has an opinion about:
 * `disposables` and `hostSubscriptions` (the two lists, and which one the net has
 * to be on) and `evidenceHealth` (real, because the transport wrapper reports to
 * it). Everything else is constructed and never called — the wiring builds a graph
 * and spawns nothing, which is what its own trust classification records.
 *
 * `breakStore` removes `subscribe` from the store, which makes `new HistoryStore`
 * throw. That is not a contrived seam: it is a real construction step, it runs
 * ~180 lines after the sink is created, and it is the last thing in the wiring
 * that can fail. A wiring step that throws is exactly FR-009's scenario.
 */
function buildDeps(options: { breakStore?: boolean } = {}): {
  deps: BackendExecutionWiringDeps;
  disposables: vscode.Disposable[];
  hostSubscriptions: { dispose(): unknown }[];
} {
  const disposables: vscode.Disposable[] = [];
  const hostSubscriptions: { dispose(): unknown }[] = [];
  const store = options.breakStore
    ? {}
    : { subscribe: () => ({ dispose: () => undefined }), get: () => undefined };
  const deps = {
    workspaceRoot: WORKSPACE_ROOT,
    cliPath: '/usr/local/bin/claude',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    store,
    auditWriter: { append: vi.fn(async () => undefined) },
    disposables,
    hostSubscriptions,
    evidenceHealth: new EvidenceHealthMonitor(),
    processEnvironmentPolicy: { mode: 'allowlist' }
  } as unknown as BackendExecutionWiringDeps;
  return { deps, disposables, hostSubscriptions };
}

/** The sink the most recent wiring created. */
function lastSink(): CliTransportSink {
  const sink = captured.sinks.at(-1);
  expect(sink, 'the wiring must have created a sink').toBeDefined();
  return sink as CliTransportSink;
}

describe('FR-R3-137 — the partial-construction net (T1530f, FR-009, C5)', () => {
  it('a wiring step that throws after the sink exists still leaves something to close it', async () => {
    const { deps, hostSubscriptions } = buildDeps({ breakStore: true });

    expect(() => wireBackendExecution(deps)).toThrow(/subscribe is not a function/);

    // No return value, so no `backend.transport`, so nothing the composition root
    // could have closed. The net is the only reference that outlived the throw.
    const sink = lastSink();
    expect(hostSubscriptions).toHaveLength(1);

    const closed = vi.spyOn(sink, 'flushAndDispose');
    for (const entry of hostSubscriptions) entry.dispose();
    expect(closed).toHaveBeenCalledTimes(1);
    await sink.flushAndDispose();
    expect(sink.openDescriptorCount).toBe(0);
  });

  it('registers the close at the moment the sink is created, not at a successful return', () => {
    const { deps, hostSubscriptions } = buildDeps();

    const wiring = wireBackendExecution(deps);

    // Same single entry on the success path — one registration, two paths, which
    // is C5's "the failure path runs the same closure the success path does".
    expect(hostSubscriptions).toHaveLength(1);
    const closed = vi.spyOn(lastSink(), 'flushAndDispose');
    for (const entry of hostSubscriptions) entry.dispose();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(wiring.transport).toBeDefined();
  });

  it('the net is NOT on `disposables`, because a throw never sweeps that array', () => {
    // THE MUTATION THIS PINS. `disposables` is the obvious place to push a
    // teardown and it is the wrong one: it is private to `wireStage2`, swept only
    // by the ordered teardown and by the one `store.initialize()` failure path
    // that sits ABOVE the sink. A net pushed there passes a success-path test and
    // closes nothing on the path FR-009 is about.
    const { deps, disposables } = buildDeps();

    wireBackendExecution(deps);
    const closed = vi.spyOn(lastSink(), 'flushAndDispose');

    for (const entry of disposables) entry.dispose();
    expect(
      closed,
      'sweeping the private array must not be what closes the sink'
    ).not.toHaveBeenCalled();
  });

  it('firing after the ordered teardown is free, because the drain is memoised', async () => {
    // Both paths run in a normal shutdown: `hostTeardown` first (it is pushed
    // during stage 1, before any of this wiring exists), then this entry. The
    // second call must not start a second drain.
    const { deps, hostSubscriptions } = buildDeps();

    const wiring = wireBackendExecution(deps);
    const sink = lastSink();
    const first = sink.flushAndDispose();
    for (const entry of hostSubscriptions) entry.dispose();

    await expect(first).resolves.toBeUndefined();
    await expect(wiring.transport.flushAndDispose()).resolves.toBeUndefined();
    expect(sink.openDescriptorCount).toBe(0);
  });
});

describe('FR-R3-137 — one stop path (T1530g, FR-011)', () => {
  const extension = readFileSync(resolve(__dirname, '../../../src/extension.ts'), 'utf8');
  /** Comment lines stripped, so a quoted defect is not mistaken for the defect. */
  const code = extension
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  /**
   * These read the composition root rather than driving it, and that is the point:
   * FR-011 is a claim about how many stop paths EXIST, and a behavioural test can
   * only ever show that the paths it knows about work. FR-R3-006 put the same
   * constraint on reset and it is asserted the same way.
   */
  it('reset stops producers through `tearDownStage2`, not through a path of its own', () => {
    expect(code).toContain('stopProducers: tearDownStage2');
  });

  it('the resource teardown has exactly one call site', () => {
    expect(code.match(/closeStage2Resources\(/g) ?? []).toHaveLength(1);
  });

  it('the host teardown is assigned once and awaited by `deactivate`', () => {
    const assignments = code.match(/^\s*hostTeardown = async/gm) ?? [];
    expect(assignments, 'a second assignment is a second teardown').toHaveLength(1);
    expect(code).toContain('await hostTeardown?.();');
    expect(code).toMatch(/export async function deactivate\(\): Promise<void>/);
  });

  it('the discarded-promise defect cannot return in the shape it had', () => {
    // The defect verbatim: `void stage2?.dispose()` inside a synchronous
    // `Disposable.dispose()`. What it discarded was the transport flush, the lease
    // release and the lock release.
    expect(code).not.toContain('void stage2?.dispose()');
  });

  it('the one surviving `void` is the fallback, and it is safe because it self-nulls', () => {
    // This test used to be called "no path discards the teardown promise", which
    // was not true of the code that fixed the defect. One `void` remains and has
    // to: `Disposable.dispose()` is synchronous, so the subscription entry cannot
    // await anything. It is the fallback for a host that unloads without calling
    // `deactivate`; `deactivate` is the awaited path. Pinned in this shape so the
    // remaining `void` does not get "fixed" by deleting the entry — that would
    // leave a partially wired host with nothing to close the sink at all, which is
    // FR-009 exactly.
    expect(code).toContain('context.subscriptions.push({ dispose: () => void hostTeardown?.() });');
    expect(
      code,
      'the closure must null itself, or whichever path runs second drains twice'
    ).toContain('hostTeardown = null;');
  });
});
