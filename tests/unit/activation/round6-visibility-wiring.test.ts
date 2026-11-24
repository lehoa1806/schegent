// FR-R6-F12 / FR-R7-17 (R7-17-03) — host activation wiring for change review content provider,
// trust-revocation placeholder enforcement, and automatic active-review disposal on trust loss,
// primacy loss, or wiring disposal.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PLACEHOLDER_SENTENCES,
  placeholderRead,
  reviewRefused
} from '../../../src/contracts/change-review';
import { reportCancelled, reportOk, reportRefused } from '../../../src/contracts/reporting/report-outcomes';
import { CMD_OPEN_CHANGE_REVIEW, type OpenChangeReviewResponse } from '../../../src/contracts/sidebar-ipc';
import { createPhaseContextApi } from '../../../src/headless/phase-context-api';
import type { ChangeReviewService } from '../../../src/services/change-review';
import { createChangeReviewService } from '../../../src/services/change-review/change-review-service';
import { encodeCursor } from '../../../src/services/change-review/review-pages';
import type { GitRunResult, LaneGitRunner } from '../../../src/services/execution-lanes/git-runner';
import type { RequestRecord } from '../../../src/services/execution-lanes/integration-store-rows';
import type { ReportingService } from '../../../src/services/reporting';
import type { WorkspaceStateStore } from '../../../src/state/workspace-state';
import type { CommandAckMessage } from '../../../src/ui/sidebar/messages';
import { REVIEW_SCHEME, documentPath } from '../../../src/ui/change-review/review-uri';

interface MockProvider {
  provideTextDocumentContent(uri: { readonly scheme: string; readonly path: string }): Promise<string> | string;
}

let trusted = true;
const registeredProviders: Array<{ readonly scheme: string; readonly provider: MockProvider }> = [];
const providerDispose = vi.fn();
let currentChangeReviewService: ChangeReviewService | null = null;
let currentReportingService: ReportingService | null = null;
let capturedDynamicService: ChangeReviewService | null = null;
const showSaveDialogMock = vi.fn<
  () => Promise<{ readonly scheme: string; readonly fsPath: string } | undefined>
>(async () => undefined);

vi.mock('vscode', () => ({
  Uri: {
    from: (parts: { readonly scheme: string; readonly path: string }) => ({
      scheme: parts.scheme,
      path: parts.path
    }),
    file: (fsPath: string) => ({ scheme: 'file', fsPath, path: fsPath })
  },
  workspace: {
    get isTrusted(): boolean {
      return trusted;
    },
    registerTextDocumentContentProvider: (scheme: string, provider: MockProvider) => {
      registeredProviders.push({ scheme, provider });
      return { dispose: providerDispose };
    },
    getConfiguration: () => ({
      get: () => false
    })
  },
  commands: {
    getCommands: async () => [],
    executeCommand: async () => undefined
  },
  window: {
    showInformationMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showSaveDialog: () => showSaveDialogMock()
  }
}));

vi.mock('../../../src/activation/sqlite-cutover-wiring', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/activation/sqlite-cutover-wiring')>();
  return {
    ...actual,
    getSqliteCutoverCoordinator: () => ({
      scopeId: 'ws-wiring-test',
      getSqliteStore: () => null,
      getTelemetryHost: () => null,
      getReportingService: () => currentReportingService,
      getPhaseContextApi: () => createPhaseContextApi(() => null),
      getChangeReviewService: () => currentChangeReviewService
    })
  };
});

vi.mock('../../../src/ui/change-review/review-editor-binding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/ui/change-review/review-editor-binding')>();
  return {
    ...actual,
    registerChangeReviewProvider: (service: ChangeReviewService) => {
      capturedDynamicService = service;
      return actual.registerChangeReviewProvider(service);
    }
  };
});

import { createRound6VisibilityWiring } from '../../../src/activation/round6-visibility-wiring';
import {
  createSidebarRouter,
  type SidebarRouterWiringDeps
} from '../../../src/activation/sidebar-router-wiring';

const REQUEST_ID = '4'.repeat(32);
const TARGET_COMMIT = 'a'.repeat(40);
const CANDIDATE_COMMIT = 'c'.repeat(40);
const PROFILE_DIGEST = 'd'.repeat(64);
const BLOB_NEW = 'f'.repeat(40);
const NULL_SHA = '0'.repeat(40);
const Z = '\u0000';

const DIFF_INVENTORY =
  `:000000 100644 ${NULL_SHA} ${BLOB_NEW} A${Z}src/trusted-file.ts${Z}` +
  `2\t0\tsrc/trusted-file.ts${Z}`;

function makeRequestRecord(): RequestRecord {
  return {
    requestId: REQUEST_ID,
    laneId: '1'.repeat(32),
    workspaceId: 'ws-wiring-test',
    repositoryId: '2'.repeat(64),
    candidateId: '3'.repeat(32),
    candidateCommit: CANDIDATE_COMMIT,
    targetRef: 'refs/heads/main',
    expectedTargetCommit: TARGET_COMMIT,
    profileId: 'default',
    profileRevision: 1,
    profileDigest: PROFILE_DIGEST,
    profileJson: '{}',
    state: 'awaiting-review',
    reason: null,
    verificationAttempt: 1,
    ownerGeneration: 1,
    createdAt: '2026-11-23T00:00:00.000Z',
    updatedAt: '2026-11-23T00:00:00.000Z'
  };
}

function makeService(): ChangeReviewService {
  const record = makeRequestRecord();
  const git: LaneGitRunner = {
    run: (args): Promise<GitRunResult> => {
      const verb = args.at(0) ?? '';
      if (verb === 'rev-parse') {
        const rev = args.at(3) ?? '';
        if (rev.startsWith('refs/heads/')) {
          return Promise.resolve({ ok: true, stdout: `${TARGET_COMMIT}\n` });
        }
        return Promise.resolve({ ok: true, stdout: `${rev.slice(0, -'^{commit}'.length)}\n` });
      }
      if (verb === 'merge-base') return Promise.resolve({ ok: true, stdout: '' });
      if (verb === 'diff-tree') return Promise.resolve({ ok: true, stdout: DIFF_INVENTORY });
      if (verb === 'cat-file') {
        return Promise.resolve({ ok: true, stdout: 'export const secretFree = 42;\n' });
      }
      return Promise.resolve({ ok: false, exitCode: 128, code: 'exit' });
    }
  };
  return createChangeReviewService({
    source: {
      getRequest: (id) => (id === REQUEST_ID ? record : null),
      getReceipt: () => null
    },
    git,
    cwd: '/workspace'
  });
}

function makeFakeStore(isPrimary: () => boolean): WorkspaceStateStore {
  return {
    canCommitConnectedRun: async () => isPrimary()
  } as unknown as WorkspaceStateStore;
}

describe('createRound6VisibilityWiring (R7-17-03 trust-loss & primacy disposal)', () => {
  beforeEach(() => {
    trusted = true;
    registeredProviders.length = 0;
    providerDispose.mockClear();
    currentChangeReviewService = makeService();
    currentReportingService = null;
    capturedDynamicService = null;
    showSaveDialogMock.mockReset();
    showSaveDialogMock.mockResolvedValue(undefined);
  });

  it('serves real content while trusted and returns placeholderRead("unavailable") + closes active reviews immediately after trust is revoked', async () => {
    const wiring = createRound6VisibilityWiring({
      workspaceRoot: '/workspace',
      store: makeFakeStore(() => true),
      hasPrimacy: () => true
    });

    const opened = await wiring.changeReviewApi().openReview({ requestId: REQUEST_ID });
    expect(opened.ok).toBe(true);
    if (!opened.ok || opened.value.state === 'unavailable') {
      throw new Error('expected opened review');
    }
    const handle = opened.value.firstPage.entries.at(0)?.newHandle ?? null;
    expect(handle).not.toBeNull();
    if (handle === null) throw new Error('expected handle');
    expect(currentChangeReviewService?.liveReviews()).toBe(1);

    const providerEntry = registeredProviders.find((entry) => entry.scheme === REVIEW_SCHEME);
    expect(providerEntry).toBeDefined();
    expect(capturedDynamicService).not.toBeNull();

    // While trusted: both dynamicChangeReviewService.readContent and registered provider return real content
    const trustedRead = await capturedDynamicService!.readContent(handle);
    expect(trustedRead).toEqual({ kind: 'text', text: 'export const secretFree = 42;\n' });
    const uri = { scheme: REVIEW_SCHEME, path: documentPath(handle, 'src/trusted-file.ts') };
    expect(await providerEntry!.provider.provideTextDocumentContent(uri)).toBe(
      'export const secretFree = 42;\n'
    );

    // Revoke workspace trust mid-session (handle was already minted!)
    trusted = false;

    const untrustedRead = await capturedDynamicService!.readContent(handle);
    expect(untrustedRead).toEqual(placeholderRead('unavailable'));
    expect(await providerEntry!.provider.provideTextDocumentContent(uri)).toBe(
      PLACEHOLDER_SENTENCES.unavailable
    );
    // Active host review lease was automatically disposed on trust loss
    expect(currentChangeReviewService?.liveReviews()).toBe(0);

    // Even if trust is later re-granted, the previously minted handle stays closed/unavailable
    trusted = true;
    const afterRegrant = await capturedDynamicService!.readContent(handle);
    expect(afterRegrant).toEqual(placeholderRead('unavailable'));

    wiring.disposable.dispose();
  });

  it('automatically closes active change reviews when window primacy drops', async () => {
    let primary = true;
    const wiring = createRound6VisibilityWiring({
      workspaceRoot: '/workspace',
      store: makeFakeStore(() => primary),
      hasPrimacy: () => primary
    });

    const opened = await wiring.changeReviewApi().openReview({ requestId: REQUEST_ID });
    expect(opened.ok).toBe(true);
    if (!opened.ok || opened.value.state === 'unavailable') {
      throw new Error('expected opened review');
    }
    const handle = opened.value.firstPage.entries.at(0)?.newHandle;
    if (!handle) throw new Error('expected handle');
    expect(currentChangeReviewService?.liveReviews()).toBe(1);

    // Primacy lost mid-session
    primary = false;

    const readAfterPrimacyLoss = await capturedDynamicService!.readContent(handle);
    expect(readAfterPrimacyLoss).toEqual(placeholderRead('unavailable'));
    expect(currentChangeReviewService?.liveReviews()).toBe(0);

    wiring.disposable.dispose();
  });

  it('disposes all tracked active reviews on onTrustOrPrimacyLost callback and on wiring disposal', async () => {
    let fireLoss: (() => void) | null = null;
    const subDispose = vi.fn();
    const wiring = createRound6VisibilityWiring({
      workspaceRoot: '/workspace',
      store: makeFakeStore(() => true),
      hasPrimacy: () => true,
      onTrustOrPrimacyLost: (listener) => {
        fireLoss = listener;
        return { dispose: subDispose };
      }
    });

    const first = await wiring.changeReviewApi().openReview({ requestId: REQUEST_ID });
    expect(first.ok).toBe(true);
    const second = await wiring.changeReviewApi().openReview({ requestId: REQUEST_ID });
    expect(second.ok).toBe(true);
    expect(currentChangeReviewService?.liveReviews()).toBe(2);

    // Event-driven trust/primacy loss immediately disposes every active review
    expect(fireLoss).not.toBeNull();
    fireLoss!();
    expect(currentChangeReviewService?.liveReviews()).toBe(0);

    // Re-open one review and verify wiring.disposable.dispose() closes it and disposes provider
    const third = await wiring.changeReviewApi().openReview({ requestId: REQUEST_ID });
    expect(third.ok).toBe(true);
    expect(currentChangeReviewService?.liveReviews()).toBe(1);

    wiring.disposable.dispose();
    expect(currentChangeReviewService?.liveReviews()).toBe(0);
    expect(subDispose).toHaveBeenCalledTimes(1);
    expect(providerDispose).toHaveBeenCalledTimes(1);
  });

  it('fails closed when neither hasPrimacy nor store.canCommitConnectedRun is available (SR-311-1)', async () => {
    const bareStore = {} as unknown as WorkspaceStateStore;
    const wiring = createRound6VisibilityWiring({
      workspaceRoot: '/workspace',
      store: bareStore
    });

    const opened = await wiring.changeReviewApi().openReview({ requestId: REQUEST_ID });
    expect(opened).toEqual(reviewRefused('canceled'));
    expect(currentChangeReviewService?.liveReviews()).toBe(0);

    // Even if an underlying review + handle already exist, refresh/classify/readContent fail closed
    const directOpen = await currentChangeReviewService!.openReview({ requestId: REQUEST_ID });
    if (!directOpen.ok || directOpen.value.state === 'unavailable') {
      throw new Error('expected direct service open');
    }
    const existingReviewId = directOpen.value.review.reviewId;
    const handle = directOpen.value.firstPage.entries.at(0)?.newHandle;
    if (!handle) throw new Error('expected handle');

    const refreshed = await wiring.changeReviewApi().refreshReview({ reviewId: existingReviewId });
    expect(refreshed).toEqual(reviewRefused('canceled'));

    const classified = await wiring.changeReviewApi().classifyReview({ reviewId: existingReviewId });
    expect(classified).toEqual(reviewRefused('review-not-found'));

    expect(await capturedDynamicService!.readContent(handle)).toEqual(placeholderRead('unavailable'));

    wiring.disposable.dispose();
  });

  it('wires lock.hasPrimacy and lock.onFenceLost through createSidebarRouter so fence loss cancels in-flight opens and closes active reviews (CR-311-1)', async () => {
    let holdDiff = false;
    const heldDiffResolvers: Array<(res: GitRunResult) => void> = [];
    const record = makeRequestRecord();
    const controllableGit: LaneGitRunner = {
      run: (args): Promise<GitRunResult> => {
        const verb = args.at(0) ?? '';
        if (verb === 'rev-parse') {
          const rev = args.at(3) ?? '';
          if (rev.startsWith('refs/heads/')) {
            return Promise.resolve({ ok: true, stdout: `${TARGET_COMMIT}\n` });
          }
          return Promise.resolve({ ok: true, stdout: `${rev.slice(0, -'^{commit}'.length)}\n` });
        }
        if (verb === 'merge-base') return Promise.resolve({ ok: true, stdout: '' });
        if (verb === 'diff-tree') {
          if (holdDiff) {
            return new Promise<GitRunResult>((resolve) => {
              heldDiffResolvers.push(resolve);
            });
          }
          return Promise.resolve({ ok: true, stdout: DIFF_INVENTORY });
        }
        if (verb === 'cat-file') {
          return Promise.resolve({ ok: true, stdout: 'export const secretFree = 42;\n' });
        }
        return Promise.resolve({ ok: false, exitCode: 128, code: 'exit' });
      }
    };
    currentChangeReviewService = createChangeReviewService({
      source: {
        getRequest: (id) => (id === REQUEST_ID ? record : null),
        getReceipt: () => null
      },
      git: controllableGit,
      cwd: '/workspace'
    });

    let primaryHeld = true;
    let fireFenceLost: (() => void) | null = null;
    const fenceDispose = vi.fn();
    const disposables: Array<{ dispose(): void }> = [];

    const router = createSidebarRouter({
      workspaceRoot: '/workspace',
      store: {} as unknown as WorkspaceStateStore,
      lock: {
        hasPrimacy: async () => primaryHeld,
        onFenceLost: (listener: () => void) => {
          fireFenceLost = listener;
          return { dispose: fenceDispose };
        }
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (s: string) => s
      },
      ownerId: 'owner-1',
      phaseLogTail: { phaseLogTailService: {} },
      catalogSession: {
        storedLayer: () => ({ ok: true, entries: [], revision: 0 }),
        activeVersion: () => null,
        catalog: { phases: [], pipelines: [], workflows: [], models: [] }
      },
      metricsViewOpenedState: { emitted: false },
      registerDisposable: (d: { dispose(): void }) => {
        disposables.push(d);
      }
    } as unknown as SidebarRouterWiringDeps);

    expect(fireFenceLost).not.toBeNull();

    const dispatchOpen = async (correlationId: string): Promise<CommandAckMessage> => {
      const acks: CommandAckMessage[] = [];
      await router.dispatch(
        {
          type: CMD_OPEN_CHANGE_REVIEW,
          correlationId,
          payload: { op: 'open', requestId: REQUEST_ID }
        },
        async (ack) => {
          acks.push(ack);
          return true;
        }
      );
      const first = acks.at(0);
      if (!first) throw new Error('missing ack');
      return first;
    };

    // 1. Open one review while lock holds primacy (note bare store has NO canCommitConnectedRun,
    //    proving createSidebarRouter wired lock.hasPrimacy into createRound6VisibilityWiring!)
    const firstAck = await dispatchOpen('cr-router-1');
    expect(firstAck.status).toBe('accepted');
    const firstRes = firstAck.result as Extract<OpenChangeReviewResponse, { readonly op: 'open' }>;
    if (!firstRes.result.ok || firstRes.result.value.state === 'unavailable') {
      throw new Error('expected opened review');
    }
    const handle = firstRes.result.value.firstPage.entries.at(0)?.newHandle;
    if (!handle) throw new Error('expected handle');
    expect(currentChangeReviewService.liveReviews()).toBe(1);
    expect(await capturedDynamicService!.readContent(handle)).toEqual({
      kind: 'text',
      text: 'export const secretFree = 42;\n'
    });

    // 2. Start a second in-flight open while Git diff-tree is held
    holdDiff = true;
    const inFlightOpenPromise = dispatchOpen('cr-router-2');
    await vi.waitFor(() => expect(heldDiffResolvers.length).toBe(1));

    // 3. Fire lock.onFenceLost: MUST immediately cancel the in-flight open AND close active reviews
    primaryHeld = false;
    fireFenceLost!();

    const canceledAck = await inFlightOpenPromise;
    expect(canceledAck.status).toBe('rejected');
    expect(canceledAck.reason).toBe('canceled');
    expect(currentChangeReviewService.liveReviews()).toBe(0);
    expect(await capturedDynamicService!.readContent(handle)).toEqual(placeholderRead('unavailable'));

    // Releasing the stale held Git call afterwards must not leak a review
    heldDiffResolvers.splice(0).forEach((resolve) => resolve({ ok: true, stdout: DIFF_INVENTORY }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(currentChangeReviewService.liveReviews()).toBe(0);

    for (const d of disposables) d.dispose();
    expect(fenceDispose).toHaveBeenCalledTimes(1);
  });

  it('closes an opened review immediately when fence loss or dispose fires while openReview / checkPrimacy is settling (SR-A2 #3)', async () => {
    // Part A: onTrustOrPrimacyLost fires while the post-open checkPrimacy() is settling (and then resolves true!)
    let fireLoss: (() => void) | null = null;
    let primacyCalls = 0;
    let resolvePostOpenPrimacy!: (val: boolean) => void;
    const postOpenPrimacy = new Promise<boolean>((resolve) => {
      resolvePostOpenPrimacy = resolve;
    });

    const wiringA = createRound6VisibilityWiring({
      workspaceRoot: '/workspace',
      store: makeFakeStore(() => true),
      hasPrimacy: () => {
        primacyCalls += 1;
        if (primacyCalls === 2) return postOpenPrimacy;
        return true;
      },
      onTrustOrPrimacyLost: (listener) => {
        fireLoss = listener;
        return { dispose: vi.fn() };
      }
    });

    const openPromiseA = capturedDynamicService!.openReview({ requestId: REQUEST_ID });
    await vi.waitFor(() => {
      expect(primacyCalls).toBe(2);
      expect(currentChangeReviewService?.liveReviews()).toBe(1);
    });

    // Fence loss fires AFTER svc.openReview minted a handle but BEFORE post-open checkPrimacy() settled
    expect(fireLoss).not.toBeNull();
    fireLoss!();
    // Even if the in-flight primacy check subsequently resolves true, the bumped lifecycleEpoch closes openedId
    resolvePostOpenPrimacy(true);

    expect(await openPromiseA).toEqual(reviewRefused('canceled'));
    expect(currentChangeReviewService?.liveReviews()).toBe(0);
    wiringA.disposable.dispose();

    // Part B: dispose() fires while svc.openReview (and svc.refreshReview) is awaiting Git
    let resolveHeldDiff!: (res: GitRunResult) => void;
    let holdDiff = true;
    const record = makeRequestRecord();
    const heldGit: LaneGitRunner = {
      run: (args): Promise<GitRunResult> => {
        const verb = args.at(0) ?? '';
        if (verb === 'rev-parse') {
          const rev = args.at(3) ?? '';
          if (rev.startsWith('refs/heads/')) {
            return Promise.resolve({ ok: true, stdout: `${TARGET_COMMIT}\n` });
          }
          return Promise.resolve({ ok: true, stdout: `${rev.slice(0, -'^{commit}'.length)}\n` });
        }
        if (verb === 'merge-base') return Promise.resolve({ ok: true, stdout: '' });
        if (verb === 'diff-tree') {
          if (holdDiff) {
            return new Promise<GitRunResult>((resolve) => {
              resolveHeldDiff = resolve;
            });
          }
          return Promise.resolve({ ok: true, stdout: DIFF_INVENTORY });
        }
        if (verb === 'cat-file') {
          return Promise.resolve({ ok: true, stdout: 'export const secretFree = 42;\n' });
        }
        return Promise.resolve({ ok: false, exitCode: 128, code: 'exit' });
      }
    };
    currentChangeReviewService = createChangeReviewService({
      source: {
        getRequest: (id) => (id === REQUEST_ID ? record : null),
        getReceipt: () => null
      },
      git: heldGit,
      cwd: '/workspace'
    });

    const wiringB = createRound6VisibilityWiring({
      workspaceRoot: '/workspace',
      store: makeFakeStore(() => true),
      hasPrimacy: () => true
    });

    // Direct openReview without an AbortSignal ensures svc.openReview actually mints a handle on resolve
    const openPromiseB = capturedDynamicService!.openReview({ requestId: REQUEST_ID });
    await vi.waitFor(() => expect(resolveHeldDiff).toBeTypeOf('function'));

    wiringB.disposable.dispose();
    resolveHeldDiff({ ok: true, stdout: DIFF_INVENTORY });

    expect(await openPromiseB).toEqual(reviewRefused('canceled'));
    expect(currentChangeReviewService.liveReviews()).toBe(0);

    // Part C: fence loss during svc.refreshReview settling closes the refreshed handle too
    holdDiff = false;
    let fireLossC: (() => void) | null = null;
    const wiringC = createRound6VisibilityWiring({
      workspaceRoot: '/workspace',
      store: makeFakeStore(() => true),
      hasPrimacy: () => true,
      onTrustOrPrimacyLost: (listener) => {
        fireLossC = listener;
        return { dispose: vi.fn() };
      }
    });

    const seed = await capturedDynamicService!.openReview({ requestId: REQUEST_ID });
    if (!seed.ok || seed.value.state === 'unavailable') throw new Error('expected seed review');
    const seedId = seed.value.review.reviewId;
    expect(currentChangeReviewService.liveReviews()).toBe(1);

    holdDiff = true;
    resolveHeldDiff = undefined as unknown as (res: GitRunResult) => void;
    const refreshPromiseC = capturedDynamicService!.refreshReview(seedId);
    await vi.waitFor(() => expect(resolveHeldDiff).toBeTypeOf('function'));

    fireLossC!();
    resolveHeldDiff({ ok: true, stdout: DIFF_INVENTORY });

    expect(await refreshPromiseC).toEqual(reviewRefused('canceled'));
    expect(currentChangeReviewService.liveReviews()).toBe(0);
    wiringC.disposable.dispose();
  });

  it('refuses exportReportWithDialog without calling api.exportReport when trust or primacy drops while showSaveDialog is open (SR-A2 #3)', async () => {
    const exportReportSpy = vi.fn(async () =>
      reportOk({
        exportId: 'exp_1',
        reportId: 'rep_1',
        format: 'json' as const,
        fileName: 'out.json',
        manifestFileName: 'out.json.manifest.json',
        rowCount: 1,
        bytes: 12,
        sha256: 'a'.repeat(64),
        createdAt: '2026-11-23T00:00:00.000Z'
      })
    );
    currentReportingService = {
      exportReport: exportReportSpy
    } as unknown as ReportingService;

    let primary = true;
    let fireLoss: (() => void) | null = null;
    const wiring = createRound6VisibilityWiring({
      workspaceRoot: '/workspace',
      store: makeFakeStore(() => true),
      hasPrimacy: () => primary,
      onTrustOrPrimacyLost: (listener) => {
        fireLoss = listener;
        return { dispose: vi.fn() };
      }
    });

    // 1. Primacy drops while Save dialog is open
    let resolveDialog1!: (uri: { readonly scheme: string; readonly fsPath: string } | undefined) => void;
    showSaveDialogMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDialog1 = resolve;
        })
    );
    const p1 = wiring.exportReportWithDialog({ reportId: 'rep_1', format: 'json' });
    await vi.waitFor(() => expect(showSaveDialogMock).toHaveBeenCalledTimes(1));

    primary = false;
    resolveDialog1({ scheme: 'file', fsPath: '/workspace/out.json' });

    expect(await p1).toEqual({ outcome: 'completed', result: reportCancelled() });
    expect(exportReportSpy).not.toHaveBeenCalled();

    // 2. Transient fence loss via onTrustOrPrimacyLost while Save dialog is open (even if primary flips back true)
    primary = true;
    let resolveDialog2!: (uri: { readonly scheme: string; readonly fsPath: string } | undefined) => void;
    showSaveDialogMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDialog2 = resolve;
        })
    );
    const p2 = wiring.exportReportWithDialog({ reportId: 'rep_1', format: 'json' });
    await vi.waitFor(() => expect(showSaveDialogMock).toHaveBeenCalledTimes(2));

    fireLoss!();
    resolveDialog2({ scheme: 'file', fsPath: '/workspace/out-2.json' });

    expect(await p2).toEqual({ outcome: 'completed', result: reportCancelled() });
    expect(exportReportSpy).not.toHaveBeenCalled();

    // 3. Trust drops while Save dialog is open
    let resolveDialog3!: (uri: { readonly scheme: string; readonly fsPath: string } | undefined) => void;
    showSaveDialogMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDialog3 = resolve;
        })
    );
    const p3 = wiring.exportReportWithDialog({ reportId: 'rep_1', format: 'csv' });
    await vi.waitFor(() => expect(showSaveDialogMock).toHaveBeenCalledTimes(3));

    trusted = false;
    resolveDialog3({ scheme: 'file', fsPath: '/workspace/out.csv' });

    expect(await p3).toEqual({ outcome: 'completed', result: reportRefused('workspace-untrusted') });
    expect(exportReportSpy).not.toHaveBeenCalled();

    // 4. Positive control: when trust and primacy stay intact, api.exportReport IS called
    trusted = true;
    primary = true;
    showSaveDialogMock.mockResolvedValueOnce({ scheme: 'file', fsPath: '/workspace/ok.json' });
    const p4 = await wiring.exportReportWithDialog({ reportId: 'rep_1', format: 'json' });
    expect(p4.outcome).toBe('completed');
    if (p4.outcome === 'completed') {
      expect(p4.result.ok).toBe(true);
    }
    expect(exportReportSpy).toHaveBeenCalledTimes(1);

    wiring.disposable.dispose();
  });

  it('fails closed when hasPrimacy is omitted even if store.canCommitConnectedRun resolves true (SR-A2 #3)', async () => {
    const canCommitConnectedRun = vi.fn(async () => true);
    const exportReportSpy = vi.fn();
    currentReportingService = {
      exportReport: exportReportSpy
    } as unknown as ReportingService;

    const wiring = createRound6VisibilityWiring({
      workspaceRoot: '/workspace',
      store: { canCommitConnectedRun } as unknown as WorkspaceStateStore
    });

    // openReview refuses without consulting store.canCommitConnectedRun
    expect(await wiring.changeReviewApi().openReview({ requestId: REQUEST_ID })).toEqual(
      reviewRefused('canceled')
    );
    expect(currentChangeReviewService?.liveReviews()).toBe(0);

    // exportReportWithDialog refuses without opening Save dialog or calling exportReport
    expect(await wiring.exportReportWithDialog({ reportId: 'rep_1', format: 'json' })).toEqual({
      outcome: 'completed',
      result: reportCancelled()
    });
    expect(showSaveDialogMock).not.toHaveBeenCalled();
    expect(exportReportSpy).not.toHaveBeenCalled();

    // readContent also fails closed on an already-minted handle
    const directOpen = await currentChangeReviewService!.openReview({ requestId: REQUEST_ID });
    if (!directOpen.ok || directOpen.value.state === 'unavailable') {
      throw new Error('expected direct open');
    }
    const handle = directOpen.value.firstPage.entries.at(0)?.newHandle;
    if (!handle) throw new Error('expected handle');
    expect(await capturedDynamicService!.readContent(handle)).toEqual(placeholderRead('unavailable'));

    expect(canCommitConnectedRun).not.toHaveBeenCalled();
    wiring.disposable.dispose();
  });

  it('refuses classifyReview instead of returning a live ReviewDescriptor when fence loss, trust revocation, primacy drop, or dispose fires while svc.classifyReview is pending (SR-A3 #4)', async () => {
    let holdRevParse = false;
    const heldRevParseResolvers: Array<(res: GitRunResult) => void> = [];
    const record = makeRequestRecord();
    const controllableGit: LaneGitRunner = {
      run: (args): Promise<GitRunResult> => {
        const verb = args.at(0) ?? '';
        if (verb === 'rev-parse') {
          const rev = args.at(3) ?? '';
          if (rev.startsWith('refs/heads/')) {
            if (holdRevParse) {
              return new Promise<GitRunResult>((resolve) => {
                heldRevParseResolvers.push(resolve);
              });
            }
            return Promise.resolve({ ok: true, stdout: `${TARGET_COMMIT}\n` });
          }
          return Promise.resolve({ ok: true, stdout: `${rev.slice(0, -'^{commit}'.length)}\n` });
        }
        if (verb === 'merge-base') return Promise.resolve({ ok: true, stdout: '' });
        if (verb === 'diff-tree') return Promise.resolve({ ok: true, stdout: DIFF_INVENTORY });
        if (verb === 'cat-file') {
          return Promise.resolve({ ok: true, stdout: 'export const secretFree = 42;\n' });
        }
        return Promise.resolve({ ok: false, exitCode: 128, code: 'exit' });
      }
    };
    currentChangeReviewService = createChangeReviewService({
      source: {
        getRequest: (id) => (id === REQUEST_ID ? record : null),
        getReceipt: () => null
      },
      git: controllableGit,
      cwd: '/workspace'
    });

    let primary = true;
    let fireLoss: (() => void) | null = null;
    const wiring = createRound6VisibilityWiring({
      workspaceRoot: '/workspace',
      store: makeFakeStore(() => primary),
      hasPrimacy: () => primary,
      onTrustOrPrimacyLost: (listener) => {
        fireLoss = listener;
        return { dispose: vi.fn() };
      }
    });

    const openLiveReview = async (): Promise<string> => {
      holdRevParse = false;
      const opened = await wiring.changeReviewApi().openReview({ requestId: REQUEST_ID });
      expect(opened.ok).toBe(true);
      if (!opened.ok || opened.value.state === 'unavailable') {
        throw new Error('expected live opened review');
      }
      return opened.value.review.reviewId;
    };

    // Positive control: classifyReview succeeds while trusted, primary, and epoch intact
    const controlId = await openLiveReview();
    const okClassified = await wiring.changeReviewApi().classifyReview({ reviewId: controlId });
    expect(okClassified.ok).toBe(true);
    if (okClassified.ok) {
      expect(okClassified.value.reviewId).toBe(controlId);
      expect(okClassified.value.state).toBe('current');
    }

    // 1. Fence loss via onTrustOrPrimacyLost while svc.classifyReview is pending (even though hasPrimacy stays true)
    holdRevParse = true;
    const fenceClassify = wiring.changeReviewApi().classifyReview({ reviewId: controlId });
    await vi.waitFor(() => expect(heldRevParseResolvers.length).toBe(1));
    expect(fireLoss).not.toBeNull();
    fireLoss!();
    expect(currentChangeReviewService.liveReviews()).toBe(0);
    heldRevParseResolvers.splice(0).forEach((resolve) => resolve({ ok: true, stdout: `${TARGET_COMMIT}\n` }));
    expect(await fenceClassify).toEqual(reviewRefused('review-not-found'));

    // 2. Trust revocation (without onTrustOrPrimacyLost) while svc.classifyReview is pending
    const trustId = await openLiveReview();
    holdRevParse = true;
    const trustClassify = wiring.changeReviewApi().classifyReview({ reviewId: trustId });
    await vi.waitFor(() => expect(heldRevParseResolvers.length).toBe(1));
    trusted = false;
    heldRevParseResolvers.splice(0).forEach((resolve) => resolve({ ok: true, stdout: `${TARGET_COMMIT}\n` }));
    expect(await trustClassify).toEqual(reviewRefused('workspace-untrusted'));
    expect(currentChangeReviewService.liveReviews()).toBe(0);
    trusted = true;

    // 3. Primacy drops (without onTrustOrPrimacyLost) while svc.classifyReview is pending
    const primacyId = await openLiveReview();
    holdRevParse = true;
    const primacyClassify = wiring.changeReviewApi().classifyReview({ reviewId: primacyId });
    await vi.waitFor(() => expect(heldRevParseResolvers.length).toBe(1));
    primary = false;
    heldRevParseResolvers.splice(0).forEach((resolve) => resolve({ ok: true, stdout: `${TARGET_COMMIT}\n` }));
    expect(await primacyClassify).toEqual(reviewRefused('review-not-found'));
    expect(currentChangeReviewService.liveReviews()).toBe(0);
    primary = true;

    // 4. dispose() fires while svc.classifyReview is pending
    const disposeId = await openLiveReview();
    holdRevParse = true;
    const disposeClassify = wiring.changeReviewApi().classifyReview({ reviewId: disposeId });
    await vi.waitFor(() => expect(heldRevParseResolvers.length).toBe(1));
    wiring.disposable.dispose();
    heldRevParseResolvers.splice(0).forEach((resolve) => resolve({ ok: true, stdout: `${TARGET_COMMIT}\n` }));
    expect(await disposeClassify).toEqual(reviewRefused('review-not-found'));
    expect(currentChangeReviewService.liveReviews()).toBe(0);
  });

  it('fails readPage closed when hasPrimacy is omitted, primacy is unverified in the current epoch, or hasPrimacy flips false/throws (SR-A3 #4)', async () => {
    // Prepare a genuinely live review directly on the underlying service so svc.readPage(cursor) would succeed
    const directOpen = await currentChangeReviewService!.openReview({ requestId: REQUEST_ID });
    if (!directOpen.ok || directOpen.value.state === 'unavailable') {
      throw new Error('expected direct open');
    }
    const directCursor = encodeCursor(directOpen.value.review.reviewId, 0);
    expect(currentChangeReviewService!.readPage(directCursor).ok).toBe(true);

    // 1. deps.hasPrimacy omitted (undefined): readPage fails closed
    const omittedWiring = createRound6VisibilityWiring({
      workspaceRoot: '/workspace',
      store: makeFakeStore(() => true)
    });
    expect(omittedWiring.changeReviewApi().readPage({ cursor: directCursor })).toEqual(
      reviewRefused('review-not-found')
    );
    expect(capturedDynamicService!.readPage(directCursor)).toEqual(reviewRefused('review-not-found'));
    omittedWiring.disposable.dispose();

    // 2. deps.hasPrimacy provided, but primacy has never been verified in the current epoch
    let fireLoss: (() => void) | null = null;
    let primary = true;
    let throwOnPrimacy = false;
    const syncWiring = createRound6VisibilityWiring({
      workspaceRoot: '/workspace',
      store: makeFakeStore(() => primary),
      hasPrimacy: () => {
        if (throwOnPrimacy) throw new Error('lock probe failed');
        return primary;
      },
      onTrustOrPrimacyLost: (listener) => {
        fireLoss = listener;
        return { dispose: vi.fn() };
      }
    });
    expect(syncWiring.changeReviewApi().readPage({ cursor: directCursor })).toEqual(
      reviewRefused('review-not-found')
    );

    // Positive control: once openReview verifies primacy in this epoch, readPage succeeds
    const opened = await syncWiring.changeReviewApi().openReview({ requestId: REQUEST_ID });
    expect(opened.ok).toBe(true);
    if (!opened.ok || opened.value.state === 'unavailable') {
      throw new Error('expected opened review');
    }
    const liveCursor = encodeCursor(opened.value.review.reviewId, 0);
    const okPage = syncWiring.changeReviewApi().readPage({ cursor: liveCursor });
    expect(okPage.ok).toBe(true);

    // 3. After onTrustOrPrimacyLost bumps the epoch, readPage fails closed even if another review exists and hasPrimacy() returns true
    expect(fireLoss).not.toBeNull();
    fireLoss!();
    expect(syncWiring.changeReviewApi().readPage({ cursor: directCursor })).toEqual(
      reviewRefused('review-not-found')
    );

    // 4. Synchronous deps.hasPrimacy() flips to false without onTrustOrPrimacyLost firing: fails closed & closes active reviews
    const reopened = await syncWiring.changeReviewApi().openReview({ requestId: REQUEST_ID });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok || reopened.value.state === 'unavailable') {
      throw new Error('expected reopened review');
    }
    const reopenedCursor = encodeCursor(reopened.value.review.reviewId, 0);
    expect(syncWiring.changeReviewApi().readPage({ cursor: reopenedCursor }).ok).toBe(true);
    const liveBeforeFlip = currentChangeReviewService!.liveReviews();
    expect(liveBeforeFlip).toBeGreaterThanOrEqual(1);

    primary = false;
    expect(syncWiring.changeReviewApi().readPage({ cursor: reopenedCursor })).toEqual(
      reviewRefused('review-not-found')
    );
    // Tracked review opened via wiring was closed by closeAllActiveReviews()
    expect(currentChangeReviewService!.readPage(reopenedCursor)).toEqual(
      reviewRefused('cursor-invalid')
    );

    // 5. Synchronous deps.hasPrimacy() throws: fails closed & closes active reviews
    primary = true;
    const reopened2 = await syncWiring.changeReviewApi().openReview({ requestId: REQUEST_ID });
    if (!reopened2.ok || reopened2.value.state === 'unavailable') {
      throw new Error('expected reopened review 2');
    }
    const reopenedCursor2 = encodeCursor(reopened2.value.review.reviewId, 0);
    throwOnPrimacy = true;
    expect(syncWiring.changeReviewApi().readPage({ cursor: reopenedCursor2 })).toEqual(
      reviewRefused('review-not-found')
    );
    expect(currentChangeReviewService!.readPage(reopenedCursor2)).toEqual(
      reviewRefused('cursor-invalid')
    );
    throwOnPrimacy = false;
    syncWiring.disposable.dispose();

    // 6. Async deps.hasPrimacy() returning Promise<boolean>: succeeds while verified, and async false triggers teardown
    let asyncPrimary = true;
    const asyncWiring = createRound6VisibilityWiring({
      workspaceRoot: '/workspace',
      store: makeFakeStore(() => asyncPrimary),
      hasPrimacy: async () => asyncPrimary
    });
    const asyncOpened = await asyncWiring.changeReviewApi().openReview({ requestId: REQUEST_ID });
    if (!asyncOpened.ok || asyncOpened.value.state === 'unavailable') {
      throw new Error('expected async opened review');
    }
    const asyncCursor = encodeCursor(asyncOpened.value.review.reviewId, 0);
    expect(asyncWiring.changeReviewApi().readPage({ cursor: asyncCursor }).ok).toBe(true);

    asyncPrimary = false;
    // Trigger readPage while async hasPrimacy resolves false -> teardown closes active reviews & invalidates epoch
    asyncWiring.changeReviewApi().readPage({ cursor: asyncCursor });
    await vi.waitFor(() => {
      expect(currentChangeReviewService!.readPage(asyncCursor)).toEqual(
        reviewRefused('cursor-invalid')
      );
    });
    expect(asyncWiring.changeReviewApi().readPage({ cursor: asyncCursor })).toEqual(
      reviewRefused('review-not-found')
    );
    asyncWiring.disposable.dispose();
  });
});
