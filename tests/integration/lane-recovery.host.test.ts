import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { waitForCondition } from '../wait-for-condition';
import {
  INSPECT_EXECUTION_LANES_COMMAND,
  RECOVER_EXECUTION_LANE_COMMAND,
  readLaneSnapshotFromService,
  readLaneSnapshotFromSqlitePort,
  renderLaneInspectionMarkdown,
  runInspectExecutionLanes,
  runRecoverExecutionLane,
  sanitizeDisplayToken,
  type LaneRecoveryCommandUi
} from '../../src/commands/execution-lane-recovery';
import {
  OWNER_ONLY_COMMAND_IDS,
  lookupDisposition
} from '../../src/contracts/entry-point-dispositions';
import type { VerificationProfile } from '../../src/contracts/execution-lanes';
import { createExecFileGitRunner } from '../../src/services/execution-lanes/git-runner';
import { IntegrationStore } from '../../src/services/execution-lanes/integration-store';
import { LaneService, type LaneServiceDeps } from '../../src/services/execution-lanes/lane-service';
import { LaneStore } from '../../src/services/execution-lanes/lane-store';
import { createRunLaneCoordinator } from '../../src/services/execution-lanes/run-lane-binding';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../src/services/sqlite-store';
import { decideEntry } from '../../src/state/entry-trust-decision';
import { withZeroMutationReadOnlySqliteConnection } from '../../src/state/sqlite-operational-port';
import { createFixtureRepo } from '../unit/execution-lanes/fixture-repo';

const EXTENSION_ID = 'schegent.schegent';
const ACTIVATION_BUDGET_MS = 20_000;
const WS_ID = 'ws-host-lane-recovery';
const NOW_MS = Date.UTC(2026, 10, 24, 16, 0, 0);

const PROFILE: VerificationProfile = {
  profileId: 'host-recovery',
  revision: 1,
  checks: [{ name: 'ok', argv: ['git', 'rev-parse', '--is-inside-work-tree'], timeoutMs: 30_000 }]
};

async function waitForExtensionActive(): Promise<vscode.Extension<unknown>> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `extension '${EXTENSION_ID}' not found in test host`);
  if (!ext.isActive) {
    await ext.activate();
  }
  await waitForCondition(() => ext.isActive, {
    timeoutMs: ACTIVATION_BUDGET_MS,
    label: 'extension did not become active in host leg'
  });
  return ext;
}

/**
 * FR-R8-01 (01-07) — Real extension-host verification of installed-editor execution-lane
 * inspection and recovery commands (`schegent.inspectExecutionLanes` and
 * `schegent.recoverExecutionLane`):
 *   1. Both commands are contributed in the resolved VSIX manifest and registered in VS Code.
 *   2. `schegent.inspectExecutionLanes` executes cleanly with zero arguments without blocking.
 *   3. Real VS Code unsaved Markdown inspection report opens in trusted mode (with live Git) and in
 *      Restricted Mode (zero-mutation read-only SQLite, zero Git subprocesses) with zero raw paths.
 *   4. Guarded recovery (`retry-freeze`, `acknowledge-uncertain`, `complete-and-retain`, `pin`,
 *      `mark-cleanup-eligible`, `cleanup`) discloses full sanitized lane/target/Git state before
 *      any mutation, never replays uncertain landings, and preserves dirty/pinned/live/unrelated
 *      worktrees.
 *   5. Trust and owner-only dispositions refuse mutating lane recovery in Restricted Mode and
 *      secondary windows while permitting read-only inspection.
 */
export async function run(): Promise<void> {
  const ext = await waitForExtensionActive();

  // 1. Verify manifest contribution and live VS Code command registration.
  const pkg = ext.packageJSON as {
    contributes?: { commands?: readonly { readonly command?: string; readonly title?: string }[] };
  };
  const declared = new Map(
    (pkg.contributes?.commands ?? [])
      .filter((entry): entry is { command: string; title: string } => typeof entry.command === 'string' && typeof entry.title === 'string')
      .map((entry) => [entry.command, entry.title])
  );
  assert.equal(declared.get(INSPECT_EXECUTION_LANES_COMMAND), 'Schegent: Inspect Execution Lanes');
  assert.equal(declared.get(RECOVER_EXECUTION_LANE_COMMAND), 'Schegent: Recover Execution Lane');

  const registered = await vscode.commands.getCommands(true);
  assert.ok(
    registered.includes(INSPECT_EXECUTION_LANES_COMMAND),
    `'${INSPECT_EXECUTION_LANES_COMMAND}' is contributed but not registered`
  );
  assert.ok(
    registered.includes(RECOVER_EXECUTION_LANE_COMMAND),
    `'${RECOVER_EXECUTION_LANE_COMMAND}' is contributed but not registered`
  );

  // Verify trust & owner-only disposition parity.
  assert.equal(lookupDisposition(INSPECT_EXECUTION_LANES_COMMAND)?.disposition, 'read-only');
  assert.equal(lookupDisposition(RECOVER_EXECUTION_LANE_COMMAND)?.disposition, 'mutating');
  assert.equal(Object.prototype.hasOwnProperty.call(OWNER_ONLY_COMMAND_IDS, RECOVER_EXECUTION_LANE_COMMAND), true);
  assert.equal(decideEntry({ disposition: 'mutating', workspaceTrusted: false }).allowed, false);
  assert.equal(decideEntry({ disposition: 'read-only', workspaceTrusted: false }).allowed, true);

  // 2. Drive the live registered read-only inspection command with zero arguments (must not block).
  await vscode.commands.executeCommand(INSPECT_EXECUTION_LANES_COMMAND);

  // 3. Rehearse full freeze-failure -> inspect -> retry-freeze -> uncertain-ack -> safe-cleanup
  //    inside the live VS Code extension host against a disposable Git repo & WAL SQLite DB.
  const fixture = createFixtureRepo('host-lane-recovery');
  let conn: NodeSqliteConnection | null = null;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'schegent-host-lane-'));
  try {
    fixture.write('src/app.txt', 'host-seed-v1\n');
    fixture.commit('seed');
    const unrelatedWorktree = path.join(tempRoot, 'unrelated-worktree');
    fixture.git(['worktree', 'add', '--detach', unrelatedWorktree, 'HEAD']);

    const storageDir = fixture.sibling('storage');
    const isolatedHome = fixture.sibling('home');
    const dbPath = path.join(storageDir, 'sqlite', WS_ID, 'schegent-state.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    conn = new NodeSqliteConnection({ databasePath: dbPath, journalMode: 'wal' });
    SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW_MS);

    let gitCallCount = 0;
    let crashBeforeLanding = false;
    const realGit = createExecFileGitRunner({
      baseEnv: {
        ...process.env,
        HOME: isolatedHome,
        XDG_CONFIG_HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        GIT_CEILING_DIRECTORIES: path.dirname(fixture.root),
        GIT_CONFIG_NOSYSTEM: '1'
      }
    });
    const trackedGit = {
      run: async (args: readonly string[], opts: Parameters<typeof realGit.run>[1]) => {
        gitCallCount += 1;
        const isLanding =
          args.includes('--ff-only') ||
          (args.at(0) === 'update-ref' && (args.at(1) ?? '').startsWith('refs/heads/'));
        if (crashBeforeLanding && isLanding) {
          crashBeforeLanding = false;
          throw new Error('simulated host landing crash');
        }
        return realGit.run(args, opts);
      }
    };

    let counter = 0;
    const baseDeps: LaneServiceDeps = {
      connection: conn,
      workspaceRoot: fixture.root,
      storageDir,
      workspaceId: WS_ID,
      liveLaneCap: 8,
      git: trackedGit,
      clock: () => NOW_MS,
      random: (size) => {
        counter += 1;
        const buf = Buffer.alloc(size);
        if (size >= 4) buf.writeUInt32BE(counter, size - 4);
        else buf.writeUIntBE(counter & ((1 << (size * 8)) - 1), 0, size);
        return buf;
      },
      authorizeApproval: () => true
    };
    const service = LaneService.open(baseDeps);
    const lanes = new LaneStore(conn);
    const integrations = new IntegrationStore(conn);

    // 3a. Trigger freeze failure on run terminal (`git-identity-missing`) -> stays active & retryable.
    const coord = createRunLaneCoordinator({
      getLaneService: () => service,
      isLanesEnabled: () => true,
      primaryWorkspaceRoot: fixture.root
    });
    const bound = await coord.provisionForRun('host-run-freeze-fail');
    assert.ok(bound !== null, 'expected provisioned lane binding');
    const laneRoot = await coord.resolveExecutionRoot({ runId: 'host-run-freeze-fail', laneId: bound.laneId });
    fs.writeFileSync(path.join(laneRoot, 'src', 'distinctive.txt'), 'host-distinctive-change\n');
    fixture.git(['config', '--unset', 'user.email']);

    await coord.onRunTerminal({ runId: 'host-run-freeze-fail', laneId: bound.laneId, status: 'completed' });
    const afterFail = service.getLane({ laneId: bound.laneId });
    assert.ok(afterFail.ok);
    assert.equal(afterFail.value.state, 'active');
    assert.equal(afterFail.value.stateReason, 'freeze-failed:git-identity-missing');

    // 3b. Open real VS Code unsaved Markdown document for trusted inspection.
    const openedMarkdowns: string[] = [];
    const modals: { summary: string; detail: string; confirmLabel: string }[] = [];
    const logger = { info: () => undefined, warn: () => undefined };
    const createHostUi = (confirmAnswer: boolean): LaneRecoveryCommandUi => ({
      pickItem: async () => undefined,
      confirmModal: async (summary, detail, confirmLabel) => {
        // Capture modal text rather than invoking native macOS modal dialog (which hangs headless Electron).
        modals.push({ summary, detail, confirmLabel });
        return confirmAnswer;
      },
      openMarkdownReport: async (markdown) => {
        openedMarkdowns.push(markdown);
        const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: markdown });
        await vscode.window.showTextDocument(doc, { preview: false });
        assert.equal(doc.languageId, 'markdown');
        assert.equal(doc.getText(), markdown);
      },
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    });

    const trustedInspect = await runInspectExecutionLanes({
      isWorkspaceTrusted: () => true,
      readSnapshot: ({ allowLiveGit }) => readLaneSnapshotFromService(service, { allowLiveGit }),
      ui: createHostUi(true),
      logger,
      now: () => NOW_MS
    });
    assert.equal(trustedInspect.status, 'opened');
    assert.equal(trustedInspect.gitProbed, true);
    assert.ok(openedMarkdowns[0]?.includes(bound.laneId));
    assert.ok(openedMarkdowns[0]?.includes('freeze-failed:git-identity-missing'));
    assert.ok(!openedMarkdowns[0]?.includes(fixture.root), 'report leaked workspaceRoot');
    assert.ok(!openedMarkdowns[0]?.includes(storageDir), 'report leaked storageDir');

    // 3c. Restricted Mode inspection reads SQLite read-only with ZERO Git subprocesses!
    gitCallCount = 0;
    const untrustedInspect = await runInspectExecutionLanes({
      isWorkspaceTrusted: () => false,
      readSnapshot: async ({ allowLiveGit }) => {
        assert.equal(allowLiveGit, false);
        const modeNote = 'Live Git inspection skipped in Restricted Mode (untrusted workspace).';
        const res = await withZeroMutationReadOnlySqliteConnection(
          storageDir,
          ['sqlite', WS_ID],
          'schegent-state.db',
          (roConn) => readLaneSnapshotFromSqlitePort(roConn, WS_ID, modeNote)
        );
        assert.equal(res.outcome, 'ok');
        return res.value;
      },
      ui: createHostUi(true),
      logger,
      now: () => NOW_MS
    });
    assert.equal(untrustedInspect.status, 'opened');
    assert.equal(untrustedInspect.gitProbed, false);
    assert.equal(gitCallCount, 0, 'Restricted Mode inspection must spawn zero Git subprocesses');
    assert.ok(openedMarkdowns[1]?.includes('Live Git inspection skipped in Restricted Mode'));

    // 3d. Fix identity, verify `confirm: true` cannot bypass modal, primacy-loss TOCTOU aborts with zero mutation,
    //     and `completeAfterFreeze: true` still requires explicit second modal confirmation.
    fixture.git(['config', 'user.email', 'host@example.invalid']);
    modals.length = 0;
    const declinedWithConfirmBypass = await runRecoverExecutionLane(
      { getLaneService: () => service, ui: createHostUi(false), logger },
      { action: 'retry-freeze', laneId: bound.laneId, completeAfterFreeze: true, confirm: true } as unknown
    );
    assert.equal(declinedWithConfirmBypass.status, 'canceled');
    assert.equal(modals.length, 1);
    assert.equal(lanes.currentCandidate(bound.laneId), null);

    // Primacy lost while modal is displayed -> refused before any mutation.
    let hostPrimacy = true;
    const primacyLossUi: LaneRecoveryCommandUi = {
      ...createHostUi(true),
      confirmModal: async (summary, detail, confirmLabel) => {
        modals.push({ summary, detail, confirmLabel });
        hostPrimacy = false;
        return true;
      }
    };
    const lostPrimacyOutcome = await runRecoverExecutionLane(
      { getLaneService: () => service, verifyPrimaryAndTrusted: async () => hostPrimacy, ui: primacyLossUi, logger },
      { action: 'retry-freeze', laneId: bound.laneId, completeAfterFreeze: true }
    );
    assert.equal(lostPrimacyOutcome.status, 'refused');
    assert.equal(lostPrimacyOutcome.reason, 'ownership-superseded');
    assert.equal(lanes.currentCandidate(bound.laneId), null);

    // Approve both modals (`retry-freeze` + follow-up `Complete Lane`).
    modals.length = 0;
    const retried = await runRecoverExecutionLane(
      { getLaneService: () => service, verifyPrimaryAndTrusted: async () => true, ui: createHostUi(true), logger },
      { action: 'retry-freeze', laneId: bound.laneId, completeAfterFreeze: true }
    );
    assert.equal(retried.status, 'completed');
    assert.equal(modals.length, 2, 'completeAfterFreeze: true must still require second modal confirmation');
    assert.ok(retried.lane);
    assert.equal(retried.lane.state, 'completed');
    assert.equal(retried.lane.stateReason, null);
    assert.ok(retried.candidate);
    assert.equal(
      fixture.git(['show', `${retried.candidate.commit}:src/distinctive.txt`]),
      'host-distinctive-change\n'
    );

    // Verify trusted secondary-window wording, SQLite inspect error surfacing, secret/path redaction,
    // and caught getLaneService throws in host runtime.
    const secondaryMd = renderLaneInspectionMarkdown(
      await readLaneSnapshotFromService(service, { allowLiveGit: false, modeNote: 'Read-only SQLite snapshot' }),
      { trusted: true, generatedAtIso: new Date(NOW_MS).toISOString() }
    );
    assert.ok(secondaryMd.includes('skipped (read-only snapshot)'));
    assert.ok(!secondaryMd.includes('skipped (Restricted Mode)'));

    for (const errCode of ['refused', 'unreadable', 'sqlite-error'] as const) {
      const errInspect = await runInspectExecutionLanes({
        isWorkspaceTrusted: () => false,
        readSnapshot: async () => {
          throw Object.assign(new Error('Execution lane inspection failed'), { code: errCode });
        },
        ui: createHostUi(true),
        logger
      });
      assert.equal(errInspect.status, 'error');
    }

    assert.equal(sanitizeDisplayToken('ref=/Users/alice/secret'), 'ref=<redacted-path>');
    assert.equal(sanitizeDisplayToken('C:/Users/alice/repo'), '<redacted-path>');
    assert.equal(sanitizeDisplayToken('\\\\server\\share\\x'), '<redacted-path>');
    const fakeGh = ['ghp', '_', '1234567890'.repeat(3), '123456'].join('');
    const fakeAnt = ['sk', '-ant-', '1234567890'.repeat(3)].join('');
    const fakeBearer = ['Bearer ', 'abcdefghijklmnopqrstuvwxyz123456'].join('');
    assert.ok(sanitizeDisplayToken(fakeGh).includes('[REDACTED]'));
    assert.ok(sanitizeDisplayToken(fakeAnt).includes('[REDACTED]'));
    assert.ok(sanitizeDisplayToken(fakeBearer).includes('[REDACTED]'));

    const caughtSvcErr = await runRecoverExecutionLane(
      {
        getLaneService: async () => {
          throw Object.assign(new Error('boom'), { code: 'SQLITE_BUSY' });
        },
        ui: createHostUi(true),
        logger
      },
      { action: 'reconcile' }
    );
    assert.equal(caughtSvcErr.status, 'error');
    assert.equal(caughtSvcErr.errorCode, 'SQLITE_BUSY');

    // 3e. Uncertain integration request -> disclose commit triple + live tip -> acknowledge without replay.
    fixture.git(['branch', 'host-uncertain']);
    const uLane = await service.provisionLane({
      rootExecutionId: 'host-run-uncertain',
      sourceRevision: 'HEAD',
      dependencyRecipe: 'none'
    });
    assert.ok(uLane.ok);
    const uRoot = (await service.resolveLaneRoot(lanes.getLane(WS_ID, uLane.value.laneId)!.rootRef))!;
    fs.writeFileSync(path.join(uRoot, 'src', 'app.txt'), 'host-uncertain-edit\n');
    const uFrozen = await service.freezeCandidate({ laneId: uLane.value.laneId });
    assert.ok(uFrozen.ok);
    const uReq = await service.requestIntegration({
      laneId: uLane.value.laneId,
      targetBranch: 'host-uncertain',
      profile: PROFILE
    });
    assert.ok(uReq.ok);
    const uVer = await service.verifyRequest({ requestId: uReq.value.requestId });
    assert.ok(uVer.ok);
    assert.equal(uVer.value.state, 'awaiting-review');
    assert.ok(
      service.approveRequest({
        requestId: uVer.value.requestId,
        candidateCommit: uVer.value.candidateCommit,
        targetCommit: uVer.value.expectedTargetCommit,
        profileRevision: uVer.value.profile.revision,
        profileDigest: uVer.value.profile.digest
      }).ok
    );
    crashBeforeLanding = true;
    await assert.rejects(service.landRequest({ requestId: uVer.value.requestId }), /simulated host landing crash/);
    const divergedTip = fixture
      .git(['commit-tree', `${uVer.value.expectedTargetCommit}^{tree}`, '-m', 'host-diverged'])
      .trim();
    fixture.git(['update-ref', 'refs/heads/host-uncertain', divergedTip]);

    const host2 = LaneService.open({ ...baseDeps, git: realGit });
    const recRes = await runRecoverExecutionLane(
      { getLaneService: () => host2, ui: createHostUi(true), logger },
      { action: 'reconcile' }
    );
    assert.equal(recRes.status, 'completed');

    modals.length = 0;
    const ackRes = await runRecoverExecutionLane(
      { getLaneService: () => host2, ui: createHostUi(true), logger },
      { action: 'acknowledge-uncertain', requestId: uVer.value.requestId }
    );
    assert.equal(ackRes.status, 'completed');
    assert.equal(ackRes.request?.state, 'canceled');
    assert.ok(modals[0]?.detail.includes(`observedTip: ${divergedTip.slice(0, 12)}`));
    assert.ok(modals[0]?.detail.includes(`liveTargetTip: ${divergedTip.slice(0, 12)}`));
    assert.equal(fixture.git(['rev-parse', 'refs/heads/host-uncertain']).trim(), divergedTip);
    assert.equal(integrations.listJournal(uVer.value.requestId).at(-1)?.reason, 'acknowledged-uncertain');

    // 3f. Safe cleanup removes clean eligible lane while preserving dirty, pinned, and unrelated worktrees.
    const eligRes = await runRecoverExecutionLane(
      { getLaneService: () => host2, ui: createHostUi(true), logger },
      { action: 'mark-cleanup-eligible', laneId: bound.laneId }
    );
    assert.equal(eligRes.status, 'completed');

    fs.writeFileSync(path.join(uRoot, 'dirty-host.txt'), 'keep-me\n');
    await runRecoverExecutionLane(
      { getLaneService: () => host2, ui: createHostUi(true), logger },
      { action: 'complete-and-retain', laneId: uLane.value.laneId, pin: true }
    );
    await runRecoverExecutionLane(
      { getLaneService: () => host2, ui: createHostUi(true), logger },
      { action: 'mark-cleanup-eligible', laneId: uLane.value.laneId }
    );

    const cleaned = await runRecoverExecutionLane(
      { getLaneService: () => host2, ui: createHostUi(true), logger },
      { action: 'cleanup', laneIds: [bound.laneId, uLane.value.laneId] }
    );
    assert.equal(cleaned.status, 'completed');
    assert.ok(cleaned.cleanupReport);
    assert.deepEqual(cleaned.cleanupReport.removed, [bound.laneId]);
    assert.deepEqual(cleaned.cleanupReport.kept, [{ laneId: uLane.value.laneId, observation: 'lane-pinned' }]);
    assert.equal(fs.existsSync(path.join(unrelatedWorktree, 'src', 'app.txt')), true);

    console.log(
      '[lane-recovery] verified manifest/registration, trusted & Restricted Mode inspection, ' +
        'freeze retry, uncertain ack (zero replay), and safe cleanup in real VS Code host.'
    );
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    try {
      conn?.close();
    } catch {
      // Already closed.
    }
    fixture.dispose();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
