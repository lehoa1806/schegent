import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkspaceFolder } from 'vscode';
import {
  runOpenDashboard,
  STATIC_MESSAGE,
  STATIC_TEXT,
  _resetWarningInFlightForTests,
  type OpenDashboardCtx
} from '../../../src/commands/open-dashboard';
import type { Notifier } from '../../../src/ui/notifications';
import type { SanitizedLogger } from '../../../src/lib/logger';
import type { DashboardBridge } from '../../../src/ui/dashboard/dashboard-bridge';

type WarnReturn = Thenable<string | undefined>;

function makeBridge(impl?: () => unknown): DashboardBridge {
  return {
    openDashboard: vi.fn(impl ?? (() => ({}) as unknown))
  } as unknown as DashboardBridge;
}

function makeNotifier(warnReturn?: WarnReturn): Notifier {
  return {
    info: vi.fn(),
    warn: vi.fn(() => warnReturn ?? Promise.resolve(undefined)),
    error: vi.fn()
  } as unknown as Notifier;
}

function makeLogger(): SanitizedLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  } as unknown as SanitizedLogger;
}

function fakeFolder(name = 'fake', index = 0): WorkspaceFolder {
  return { uri: { fsPath: '/tmp/' + name }, name, index } as unknown as WorkspaceFolder;
}

function makeCtx(
  opts: {
    folders?: readonly WorkspaceFolder[] | undefined;
    accessor?: () => readonly WorkspaceFolder[] | undefined;
    bridge?: DashboardBridge;
    notifier?: Notifier;
    logger?: SanitizedLogger;
  } = {}
): OpenDashboardCtx & { bridge: DashboardBridge; notifier: Notifier; logger: SanitizedLogger } {
  const bridge = opts.bridge ?? makeBridge();
  const notifier = opts.notifier ?? makeNotifier();
  const logger = opts.logger ?? makeLogger();
  const getWorkspaceFolders = opts.accessor ?? (() => opts.folders);
  return { bridge, notifier, logger, getWorkspaceFolders };
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  _resetWarningInFlightForTests();
});

describe('runOpenDashboard — US1 gated path', () => {
  it('T007: gated cold path (accessor returns undefined) — no bridge call, exact static text + log', async () => {
    const ctx = makeCtx({ folders: undefined });

    await runOpenDashboard(undefined, ctx);

    expect(ctx.bridge.openDashboard).not.toHaveBeenCalled();
    expect(ctx.notifier.warn).toHaveBeenCalledTimes(1);
    expect((ctx.notifier.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(STATIC_TEXT);
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
    expect((ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(STATIC_MESSAGE);
  });

  it('T008: empty array parity — same behavior as undefined', async () => {
    const ctx = makeCtx({ folders: [] });

    await runOpenDashboard(undefined, ctx);

    expect(ctx.bridge.openDashboard).not.toHaveBeenCalled();
    expect(ctx.notifier.warn).toHaveBeenCalledTimes(1);
    expect((ctx.notifier.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(STATIC_TEXT);
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
    expect((ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(STATIC_MESSAGE);
  });

  it('T009: dedup — repeated rapid calls during in-flight toast emit one toast + one log; fresh after resolve', async () => {
    const deferred = createDeferred<string | undefined>();
    const notifier = makeNotifier(deferred.promise);
    const ctx = makeCtx({ folders: undefined, notifier });

    await runOpenDashboard(undefined, ctx);
    await runOpenDashboard(undefined, ctx);
    await runOpenDashboard(undefined, ctx);

    expect(notifier.warn).toHaveBeenCalledTimes(1);
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
    expect(ctx.bridge.openDashboard).not.toHaveBeenCalled();

    deferred.resolve(undefined);
    await flush();

    await runOpenDashboard(undefined, ctx);

    expect(notifier.warn).toHaveBeenCalledTimes(2);
    expect(ctx.logger.warn).toHaveBeenCalledTimes(2);
    expect(ctx.bridge.openDashboard).not.toHaveBeenCalled();
  });

  it('T009b: dedup — flag also clears when toast promise rejects', async () => {
    const deferred = createDeferred<string | undefined>();
    const notifier = makeNotifier(deferred.promise);
    const ctx = makeCtx({ folders: undefined, notifier });

    await runOpenDashboard(undefined, ctx);
    expect(notifier.warn).toHaveBeenCalledTimes(1);

    deferred.reject(new Error('toast surface failure'));
    await flush();

    await runOpenDashboard(undefined, ctx);
    expect(notifier.warn).toHaveBeenCalledTimes(2);
  });

  it('T010: live read — accessor return value is observed on every call (FR-002)', async () => {
    const folder = fakeFolder();
    let toReturn: readonly WorkspaceFolder[] | undefined = undefined;
    const accessor = vi.fn(() => toReturn);
    const ctx = makeCtx({ accessor });

    await runOpenDashboard(undefined, ctx);
    expect(ctx.bridge.openDashboard).not.toHaveBeenCalled();
    expect(ctx.notifier.warn).toHaveBeenCalledTimes(1);

    toReturn = [folder];
    await runOpenDashboard(undefined, ctx);

    expect(accessor).toHaveBeenCalledTimes(2);
    expect(ctx.bridge.openDashboard).toHaveBeenCalledTimes(1);
  });

  it('T011: defense-in-depth — the handler module does not import or call appendAudit', async () => {
    const mod = await import('../../../src/commands/open-dashboard.js');
    expect(Object.keys(mod)).not.toContain('appendAudit');

    const ctx = makeCtx({ folders: undefined });
    await runOpenDashboard(undefined, ctx);

    expect(ctx.bridge.openDashboard).not.toHaveBeenCalled();
    expect((ctx.notifier as Notifier & { info: ReturnType<typeof vi.fn> }).info).not.toHaveBeenCalled();
    expect((ctx.notifier as Notifier & { error: ReturnType<typeof vi.fn> }).error).not.toHaveBeenCalled();
  });
});

describe('runOpenDashboard — US2 happy path', () => {
  it('T015: single folder — bridge opens, no warning', async () => {
    const ctx = makeCtx({ folders: [fakeFolder('only', 0)] });

    await runOpenDashboard(undefined, ctx);

    expect(ctx.bridge.openDashboard).toHaveBeenCalledTimes(1);
    expect(ctx.notifier.warn).not.toHaveBeenCalled();
    expect(ctx.logger.warn).not.toHaveBeenCalled();
    expect(ctx.notifier.error).not.toHaveBeenCalled();
  });

  it('T016: multi-root — bridge opens, no warning', async () => {
    const ctx = makeCtx({ folders: [fakeFolder('a', 0), fakeFolder('b', 1)] });

    await runOpenDashboard(undefined, ctx);

    expect(ctx.bridge.openDashboard).toHaveBeenCalledTimes(1);
    expect(ctx.notifier.warn).not.toHaveBeenCalled();
    expect(ctx.logger.warn).not.toHaveBeenCalled();
    expect(ctx.notifier.error).not.toHaveBeenCalled();
  });

  it('T017: happy path does not consult warningInFlight', async () => {
    const deferred = createDeferred<string | undefined>();
    const notifier = makeNotifier(deferred.promise);
    const folder = fakeFolder();
    let toReturn: readonly WorkspaceFolder[] | undefined = undefined;
    const accessor = vi.fn(() => toReturn);
    const ctx = makeCtx({ accessor, notifier });

    await runOpenDashboard(undefined, ctx);
    expect(notifier.warn).toHaveBeenCalledTimes(1);
    expect(ctx.bridge.openDashboard).not.toHaveBeenCalled();

    toReturn = [folder];
    await runOpenDashboard(undefined, ctx);

    expect(ctx.bridge.openDashboard).toHaveBeenCalledTimes(1);
    expect(notifier.warn).toHaveBeenCalledTimes(1);

    deferred.resolve(undefined);
    await flush();
  });

  it('T018: bridge throws — logger.error + notifier.error, function resolves', async () => {
    const bridge = makeBridge(() => {
      throw new Error('boom');
    });
    const ctx = makeCtx({ folders: [fakeFolder()], bridge });

    await expect(runOpenDashboard(undefined, ctx)).resolves.toBeUndefined();

    expect(bridge.openDashboard).toHaveBeenCalledTimes(1);
    expect(ctx.logger.error).toHaveBeenCalledTimes(1);
    const errMsg = (ctx.logger.error as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(errMsg).toMatch(/runOpenDashboard failed/);
    expect(errMsg).toMatch(/boom/);
    expect(ctx.notifier.error).toHaveBeenCalledTimes(1);
    expect(ctx.notifier.warn).not.toHaveBeenCalled();
  });
});
