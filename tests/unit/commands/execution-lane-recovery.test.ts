// FR-R8-01 (01-07) — Unit tests for `schegent.inspectExecutionLanes` and `schegent.recoverExecutionLane`.
//
// WHAT THIS PINS:
//   - `runInspectExecutionLanes`: non-blocking with zero args, opens sanitized Markdown report in
//     trusted mode with live Git observations and zero raw workspace/storage paths, skips Git
//     subprocesses completely in Restricted Mode using read-only SQLite snapshot, and shows an
//     informational toast when no lanes exist;
//   - `runRecoverExecutionLane`: keyboard-accessible QuickPick flow AND structured args across
//     every action (`retry-freeze`, `acknowledge-uncertain`, `cancel-request`, `complete-and-retain`,
//     `pin`, `unpin`, `mark-cleanup-eligible`, `cleanup`, `reconcile`);
//   - mandatory pre-mutation modal disclosure naming recorded lane state, integration/journal
//     commits, and live observed Git state with zero raw paths or Git stderr;
//   - declining confirmation leaves SQLite and Git completely untouched;
//   - `acknowledge-uncertain` writes `acknowledged-uncertain` via `cancelRequest` and NEVER replays
//     an uncertain landing;
//   - `cleanup` preserves dirty, pinned, live, locked, open-request, and unrelated worktrees;
//   - trust & owner-only disposition parity (`READ_ONLY_COMMAND_IDS`, `MUTATING_COMMAND_IDS`,
//     `OWNER_ONLY_COMMAND_IDS`, `decideEntry`).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const registeredVscodeCommands = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock('vscode', () => ({
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      registeredVscodeCommands.set(id, handler);
      return { dispose: () => registeredVscodeCommands.delete(id) };
    }
  },
  workspace: {
    isTrusted: true,
    openTextDocument: async (opts: { content: string }) => ({ languageId: 'markdown', getText: () => opts.content })
  },
  window: {
    showQuickPick: async () => undefined,
    showWarningMessage: async () => undefined,
    showTextDocument: async () => undefined
  }
}));

import { registerLaneRecoveryCommands } from '../../../src/activation/lane-recovery-commands-wiring';
import { deriveWorkspaceScopeId } from '../../../src/activation/sqlite-cutover-wiring';
import {
  INSPECT_EXECUTION_LANES_COMMAND,
  RECOVER_EXECUTION_LANE_COMMAND,
  readLaneSnapshotFromService,
  readLaneSnapshotFromSqlitePort,
  renderLaneInspectionMarkdown,
  runInspectExecutionLanes,
  runRecoverExecutionLane,
  sanitizeDisplayToken,
  type LaneRecoveryCommandUi,
  type LaneRecoveryPickerItem
} from '../../../src/commands/execution-lane-recovery';
import {
  OWNER_ONLY_COMMAND_IDS,
  lookupDisposition
} from '../../../src/contracts/entry-point-dispositions';
import { LANE_DISCLOSURE, type VerificationProfile } from '../../../src/contracts/execution-lanes';
import { createExecFileGitRunner, type LaneGitRunner } from '../../../src/services/execution-lanes/git-runner';
import { IntegrationStore } from '../../../src/services/execution-lanes/integration-store';
import { LaneService, type LaneServiceDeps } from '../../../src/services/execution-lanes/lane-service';
import { LaneStore } from '../../../src/services/execution-lanes/lane-store';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import { decideEntry } from '../../../src/state/entry-trust-decision';
import { withZeroMutationReadOnlySqliteConnection } from '../../../src/state/sqlite-operational-port';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import { Notifier } from '../../../src/ui/notifications';
import { removeTempRoot } from '../../temp-root-cleanup';
import { createFixtureRepo, type FixtureRepo } from '../execution-lanes/fixture-repo';

const NOW_MS = Date.UTC(2026, 10, 24, 15, 0, 0);
const WS_ID = 'ws-recovery-unit';

const PROFILE: VerificationProfile = {
  profileId: 'recovery-unit',
  revision: 1,
  checks: [{ name: 'ok', argv: [process.execPath, '-e', 'process.exitCode = 0'], timeoutMs: 30_000 }]
};

const tempDirs: string[] = [];
const fixtures: FixtureRepo[] = [];
const conns: NodeSqliteConnection[] = [];

afterEach(async () => {
  for (const conn of conns.splice(0)) {
    try {
      conn.close();
    } catch {
      // Connection already closed by test.
    }
  }
  for (const fixture of fixtures.splice(0)) fixture.dispose();
  for (const dir of tempDirs.splice(0)) await removeTempRoot(dir);
});

interface RecoveryFixture {
  readonly fixture: FixtureRepo;
  readonly storageDir: string;
  readonly dbPath: string;
  readonly conn: NodeSqliteConnection;
  readonly service: LaneService;
  readonly lanes: LaneStore;
  readonly integrations: IntegrationStore;
  readonly realGit: LaneGitRunner;
  readonly reopen: (overrides?: Partial<LaneServiceDeps>) => LaneService;
}

function createRecoveryFixture(label: string, wrapGit?: (real: LaneGitRunner) => LaneGitRunner): RecoveryFixture {
  const fixture = createFixtureRepo(label);
  fixtures.push(fixture);
  fixture.write('src/app.txt', 'seed-v1\n');
  fixture.commit('seed');

  const storageDir = fixture.sibling('storage');
  const isolatedHome = fixture.sibling('home');
  const dbPath = path.join(storageDir, 'sqlite', WS_ID, 'schegent-state.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const conn = new NodeSqliteConnection({ databasePath: dbPath, journalMode: 'wal' });
  conns.push(conn);
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW_MS);

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
  let counter = 0;
  const baseDeps: LaneServiceDeps = {
    connection: conn,
    workspaceRoot: fixture.root,
    storageDir,
    workspaceId: WS_ID,
    liveLaneCap: 8,
    git: wrapGit ? wrapGit(realGit) : realGit,
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
  const reopen = (overrides: Partial<LaneServiceDeps> = {}): LaneService =>
    LaneService.open({ ...baseDeps, git: realGit, ...overrides });

  return {
    fixture,
    storageDir,
    dbPath,
    conn,
    service,
    lanes: new LaneStore(conn),
    integrations: new IntegrationStore(conn),
    realGit,
    reopen
  };
}

interface RecordedUi {
  readonly ui: LaneRecoveryCommandUi;
  readonly picks: { readonly title: string; readonly items: readonly LaneRecoveryPickerItem[] }[];
  readonly modals: { readonly summary: string; readonly detail: string; readonly confirmLabel: string }[];
  readonly reports: string[];
  readonly infos: string[];
  readonly warns: string[];
  readonly errors: string[];
}

function createFakeUi(options: {
  readonly pickValues?: readonly (string | undefined)[];
  readonly modalAnswers?: readonly boolean[];
} = {}): RecordedUi {
  const pickQueue = [...(options.pickValues ?? [])];
  const modalQueue = [...(options.modalAnswers ?? [true])];
  const picks: { title: string; items: readonly LaneRecoveryPickerItem[] }[] = [];
  const modals: { summary: string; detail: string; confirmLabel: string }[] = [];
  const reports: string[] = [];
  const infos: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];

  const ui: LaneRecoveryCommandUi = {
    async pickItem(items, title) {
      picks.push({ title, items });
      const nextValue = pickQueue.shift();
      if (nextValue === undefined) return undefined;
      return items.find((item) => item.value === nextValue);
    },
    async confirmModal(summary, detail, confirmLabel) {
      modals.push({ summary, detail, confirmLabel });
      const next = modalQueue.shift();
      return next ?? true;
    },
    async openMarkdownReport(markdown) {
      reports.push(markdown);
    },
    info: (message) => {
      infos.push(message);
    },
    warn: (message) => {
      warns.push(message);
    },
    error: (message) => {
      errors.push(message);
    }
  };

  return { ui, picks, modals, reports, infos, warns, errors };
}

function createLogger() {
  const entries: { readonly level: 'info' | 'warn'; readonly message: string; readonly context?: Record<string, unknown> }[] = [];
  return {
    entries,
    logger: {
      info: (message: string, context?: Record<string, unknown>) =>
        entries.push({ level: 'info', message, ...(context !== undefined ? { context } : {}) }),
      warn: (message: string, context?: Record<string, unknown>) =>
        entries.push({ level: 'warn', message, ...(context !== undefined ? { context } : {}) })
    }
  };
}

function assertNoRawPaths(text: string, f: RecoveryFixture): void {
  expect(text).not.toContain(f.fixture.root);
  expect(text).not.toContain(f.storageDir);
  expect(text).not.toContain(f.dbPath);
}

describe('FR-R8-01 (01-07) command dispositions & sanitization', () => {
  it('classifies inspect as read-only and recover as mutating + owner-only', () => {
    expect(lookupDisposition(INSPECT_EXECUTION_LANES_COMMAND)).toEqual({
      disposition: 'read-only',
      reason: 'execution lane read-only inspection'
    });
    expect(lookupDisposition(RECOVER_EXECUTION_LANE_COMMAND)).toEqual({
      disposition: 'mutating',
      reason: 'execution lane recovery'
    });
    expect(Object.prototype.hasOwnProperty.call(OWNER_ONLY_COMMAND_IDS, RECOVER_EXECUTION_LANE_COMMAND)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(OWNER_ONLY_COMMAND_IDS, INSPECT_EXECUTION_LANES_COMMAND)).toBe(false);

    expect(decideEntry({ disposition: 'read-only', workspaceTrusted: false }).allowed).toBe(true);
    expect(decideEntry({ disposition: 'mutating', workspaceTrusted: false }).allowed).toBe(false);
    expect(decideEntry({ disposition: 'mutating', workspaceTrusted: true }).allowed).toBe(true);
  });

  it('redacts secrets and POSIX/Windows/UNC paths from display tokens and Markdown table cells while preserving Git refs', () => {
    expect(sanitizeDisplayToken('refs/heads/main')).toBe('refs/heads/main');
    expect(sanitizeDisplayToken('freeze-failed:git-identity-missing')).toBe('freeze-failed:git-identity-missing');
    expect(sanitizeDisplayToken('failed at /Users/operator/secret/repo')).toBe('failed at <redacted-path>');
    expect(sanitizeDisplayToken('ref=/Users/alice/secret')).toBe('ref=<redacted-path>');
    expect(sanitizeDisplayToken('err:/Users/alice/secret')).toBe('err:<redacted-path>');
    expect(sanitizeDisplayToken('[/Users/alice/secret]')).toBe('[<redacted-path>]');
    expect(sanitizeDisplayToken('`/Users/alice/secret`')).toBe('`<redacted-path>`');
    expect(sanitizeDisplayToken('a,/Users/alice/secret')).toBe('a,<redacted-path>');
    expect(sanitizeDisplayToken('failed at C:\\Users\\operator\\repo')).toBe('failed at <redacted-path>');
    expect(sanitizeDisplayToken('C:/Users/alice/repo')).toBe('<redacted-path>');
    expect(sanitizeDisplayToken('\\\\server\\share\\x')).toBe('<redacted-path>');

    const ghToken = ['ghp', '_', '1234567890'.repeat(3), '123456'].join('');
    const antKey = ['sk', '-ant-', '1234567890'.repeat(3)].join('');
    const bearer = ['Bearer ', 'abcdefghijklmnopqrstuvwxyz123456'].join('');
    for (const secret of [ghToken, antKey, bearer]) {
      const sanitized = sanitizeDisplayToken(`prefix ${secret}`);
      expect(sanitized).toContain('[REDACTED]');
      expect(sanitized).not.toContain('1234567890');
      expect(sanitized).not.toContain('abcdefghijklmnopqrstuvwxyz');
    }

    const md = renderLaneInspectionMarkdown(
      {
        lanes: [
          {
            laneId: 'lane|evil`id',
            workspaceId: WS_ID,
            repositoryId: 'repo-1',
            rootExecutionId: 'exec|1`2',
            state: 'active',
            stateReason: 'bad|reason`here',
            pinned: false,
            sourceCommit: 'a'.repeat(40),
            baseRef: 'refs/schegent/lanes/x/base',
            candidateRef: 'refs/schegent/lanes/x/candidate',
            currentCandidate: null,
            ownerGeneration: 1,
            createdAt: new Date(NOW_MS).toISOString(),
            updatedAt: new Date(NOW_MS).toISOString(),
            disclosure: LANE_DISCLOSURE
          }
        ],
        requests: [],
        journalsByRequestId: {},
        gitByLaneId: {},
        targetTips: {},
        gitProbed: false,
        modeNote: 'Read-only SQLite snapshot (primary lane service is inactive in this window); live Git probe skipped.'
      },
      { trusted: true, generatedAtIso: new Date(NOW_MS).toISOString() }
    );
    expect(md).toContain('skipped (read-only snapshot)');
    expect(md).not.toContain('skipped (Restricted Mode)');
    expect(md).not.toContain('lane|evil`id');
    expect(md).not.toContain('bad|reason`here');
    const laneRow = md.split('\n').find((line) => line.includes('lane evil id'));
    expect(laneRow).toBeDefined();
    expect(laneRow!.split('|').length - 1).toBe(10);
  });
});

describe('FR-R8-01 (01-07) schegent.inspectExecutionLanes', () => {
  it('shows non-blocking info toast when no lanes exist', async () => {
    const f = createRecoveryFixture('inspect-empty');
    const rec = createFakeUi();
    const { logger } = createLogger();

    const outcome = await runInspectExecutionLanes({
      isWorkspaceTrusted: () => true,
      readSnapshot: ({ allowLiveGit }) => readLaneSnapshotFromService(f.service, { allowLiveGit }),
      ui: rec.ui,
      logger,
      now: () => NOW_MS
    });

    expect(outcome).toEqual({ status: 'empty', laneCount: 0, requestCount: 0, gitProbed: true });
    expect(rec.picks).toHaveLength(0);
    expect(rec.modals).toHaveLength(0);
    expect(rec.reports).toHaveLength(0);
    expect(rec.infos[0]).toContain('no execution lanes recorded');
  });

  it('opens a sanitized Markdown report with live Git state in trusted windows and skips Git in Restricted Mode', async () => {
    const gitCalls: string[][] = [];
    const f = createRecoveryFixture('inspect-report', (real) => ({
      run: async (args, opts) => {
        gitCalls.push([...args]);
        return real.run(args, opts);
      }
    }));

    const prov = await f.service.provisionLane({
      rootExecutionId: 'exec-inspect-1',
      sourceRevision: 'HEAD',
      dependencyRecipe: 'none'
    });
    if (!prov.ok) throw new Error(prov.refusal.reason);
    const laneId = prov.value.laneId;
    const laneRoot = (await f.service.resolveLaneRoot(f.lanes.getLane(WS_ID, laneId)!.rootRef))!;
    fs.writeFileSync(path.join(laneRoot, 'src', 'app.txt'), 'unfrozen-edit\n');
    expect(f.service.recordFreezeFailure({ laneId, reason: 'git-identity-missing' }).ok).toBe(true);

    // Trusted inspection: probes Git and opens sanitized Markdown without QuickPick or modal.
    gitCalls.length = 0;
    const trustedUi = createFakeUi();
    const trustedLog = createLogger();
    const trustedOutcome = await runInspectExecutionLanes({
      isWorkspaceTrusted: () => true,
      readSnapshot: ({ allowLiveGit }) => readLaneSnapshotFromService(f.service, { allowLiveGit }),
      ui: trustedUi.ui,
      logger: trustedLog.logger,
      now: () => NOW_MS
    });

    expect(trustedOutcome.status).toBe('opened');
    expect(trustedOutcome.gitProbed).toBe(true);
    expect(gitCalls.length).toBeGreaterThan(0);
    expect(trustedUi.picks).toHaveLength(0);
    expect(trustedUi.modals).toHaveLength(0);
    expect(trustedUi.reports).toHaveLength(1);
    const trustedMd = trustedUi.reports[0]!;
    expect(trustedMd).toContain(laneId);
    expect(trustedMd).toContain('freeze-failed:git-identity-missing');
    expect(trustedMd).toContain('dirty (1 path(s))');
    expect(trustedMd).toContain('Schegent: Recover Execution Lane');
    assertNoRawPaths(trustedMd, f);

    // Restricted Mode (untrusted): reads SQLite via zero-mutation read-only connection and spawns ZERO Git!
    gitCalls.length = 0;
    const untrustedUi = createFakeUi();
    const untrustedLog = createLogger();
    const untrustedOutcome = await runInspectExecutionLanes({
      isWorkspaceTrusted: () => false,
      readSnapshot: async ({ allowLiveGit }) => {
        expect(allowLiveGit).toBe(false);
        const modeNote = 'Live Git inspection skipped in Restricted Mode (untrusted workspace).';
        const res = await withZeroMutationReadOnlySqliteConnection(
          f.storageDir,
          ['sqlite', WS_ID],
          'schegent-state.db',
          (conn) => readLaneSnapshotFromSqlitePort(conn, WS_ID, modeNote)
        );
        if (res.outcome !== 'ok') throw new Error(`unexpected readonly inspect outcome: ${res.outcome}`);
        return res.value;
      },
      ui: untrustedUi.ui,
      logger: untrustedLog.logger,
      now: () => NOW_MS
    });

    expect(untrustedOutcome.status).toBe('opened');
    expect(untrustedOutcome.gitProbed).toBe(false);
    expect(gitCalls).toHaveLength(0);
    expect(untrustedUi.picks).toHaveLength(0);
    expect(untrustedUi.modals).toHaveLength(0);
    const untrustedMd = untrustedUi.reports[0]!;
    expect(untrustedMd).toContain(laneId);
    expect(untrustedMd).toContain('freeze-failed:git-identity-missing');
    expect(untrustedMd).toContain('Restricted Mode (untrusted workspace)');
    expect(untrustedMd).toContain('Live Git inspection skipped in Restricted Mode');
    assertNoRawPaths(untrustedMd, f);
  });
});

describe('FR-R8-01 (01-07) schegent.recoverExecutionLane interactive & structured flows', () => {
  it('supports keyboard QuickPick retry-freeze with pre-mutation disclosure, decline safety, and optional completion', async () => {
    const f = createRecoveryFixture('recover-retry-freeze');
    const prov = await f.service.provisionLane({
      rootExecutionId: 'exec-retry-ui',
      sourceRevision: 'HEAD',
      dependencyRecipe: 'none'
    });
    if (!prov.ok) throw new Error(prov.refusal.reason);
    const laneId = prov.value.laneId;
    const laneRoot = (await f.service.resolveLaneRoot(f.lanes.getLane(WS_ID, laneId)!.rootRef))!;
    fs.writeFileSync(path.join(laneRoot, 'src', 'recovered.txt'), 'keyboard-recovered-payload\n');
    expect(f.service.recordFreezeFailure({ laneId, reason: 'git-identity-missing' }).ok).toBe(true);

    // 1. Declining the mandatory pre-mutation modal changes nothing.
    const declinedUi = createFakeUi({
      pickValues: ['retry-freeze', laneId],
      modalAnswers: [false]
    });
    const declined = await runRecoverExecutionLane({
      getLaneService: () => f.service,
      ui: declinedUi.ui,
      logger: createLogger().logger
    });
    expect(declined.status).toBe('canceled');
    expect(declinedUi.modals).toHaveLength(1);
    const detail = declinedUi.modals[0]!.detail;
    expect(detail).toContain(`laneId: ${laneId}`);
    expect(detail).toContain('state: active');
    expect(detail).toContain('stateReason: freeze-failed:git-identity-missing');
    expect(detail).toContain('dirty: dirty (1 path(s))');
    expect(detail).toContain(`HEAD: ${prov.value.sourceCommit.slice(0, 12)}`);
    assertNoRawPaths(declinedUi.modals[0]!.summary, f);
    assertNoRawPaths(detail, f);
    expect(f.lanes.currentCandidate(laneId)).toBeNull();
    expect(f.lanes.getLane(WS_ID, laneId)?.stateReason).toBe('freeze-failed:git-identity-missing');

    // 2. Approving retry-freeze + approving optional follow-up completion freezes exact file and completes once.
    const approvedUi = createFakeUi({
      pickValues: ['retry-freeze', laneId],
      modalAnswers: [true, true]
    });
    const approved = await runRecoverExecutionLane({
      getLaneService: () => f.service,
      ui: approvedUi.ui,
      logger: createLogger().logger
    });
    expect(approved.status).toBe('completed');
    if (approved.status !== 'completed') throw new Error('expected completed');
    expect(approved.completedAfterFreeze).toBe(true);
    expect(approved.candidate).toBeDefined();
    expect(approved.lane?.state).toBe('completed');
    expect(approved.lane?.stateReason).toBeNull();
    expect(f.fixture.git(['show', `${approved.candidate!.commit}:src/recovered.txt`])).toBe(
      'keyboard-recovered-payload\n'
    );
  });

  it('discloses expected/candidate/observed/live commits for uncertain requests and acknowledges without ever replaying', async () => {
    let crashBeforeLanding = false;
    const f = createRecoveryFixture('recover-uncertain', (real) => ({
      run: async (args, opts) => {
        const isLanding =
          args.includes('--ff-only') ||
          (args.at(0) === 'update-ref' && (args.at(1) ?? '').startsWith('refs/heads/'));
        if (crashBeforeLanding && isLanding) {
          crashBeforeLanding = false;
          throw new Error('simulated crash');
        }
        return real.run(args, opts);
      }
    }));

    f.fixture.git(['branch', 'release-uncertain']);
    const prov = await f.service.provisionLane({
      rootExecutionId: 'exec-uncertain',
      sourceRevision: 'HEAD',
      dependencyRecipe: 'none'
    });
    if (!prov.ok) throw new Error(prov.refusal.reason);
    const laneId = prov.value.laneId;
    const laneRoot = (await f.service.resolveLaneRoot(f.lanes.getLane(WS_ID, laneId)!.rootRef))!;
    fs.writeFileSync(path.join(laneRoot, 'src', 'app.txt'), 'uncertain-edit\n');
    const frozen = await f.service.freezeCandidate({ laneId });
    if (!frozen.ok) throw new Error(frozen.refusal.reason);
    const req = await f.service.requestIntegration({
      laneId,
      targetBranch: 'release-uncertain',
      profile: PROFILE
    });
    if (!req.ok) throw new Error(req.refusal.reason);
    const ver = await f.service.verifyRequest({ requestId: req.value.requestId });
    if (!ver.ok) throw new Error(ver.refusal.reason);
    expect(
      f.service.approveRequest({
        requestId: ver.value.requestId,
        candidateCommit: ver.value.candidateCommit,
        targetCommit: ver.value.expectedTargetCommit,
        profileRevision: ver.value.profile.revision,
        profileDigest: ver.value.profile.digest
      }).ok
    ).toBe(true);

    crashBeforeLanding = true;
    await expect(f.service.landRequest({ requestId: ver.value.requestId })).rejects.toThrow('simulated crash');

    // Diverge target branch to an unrelated orphan commit so reconcile classifies it `uncertain`.
    const orphanCommit = f.fixture
      .git(['commit-tree', `${ver.value.expectedTargetCommit}^{tree}`, '-m', 'unrelated-tip'])
      .trim();
    f.fixture.git(['update-ref', 'refs/heads/release-uncertain', orphanCommit]);

    const host2 = f.reopen();
    const reconcileUi = createFakeUi({ modalAnswers: [true] });
    const recRes = await runRecoverExecutionLane(
      { getLaneService: () => host2, ui: reconcileUi.ui, logger: createLogger().logger },
      { action: 'reconcile' }
    );
    expect(recRes.status).toBe('completed');
    expect(host2.getRequest({ requestId: ver.value.requestId })).toMatchObject({
      ok: true,
      value: { state: 'uncertain' }
    });

    // Acknowledge uncertain request through guarded recovery command.
    const ackUi = createFakeUi({ modalAnswers: [true] });
    const ackRes = await runRecoverExecutionLane(
      { getLaneService: () => host2, ui: ackUi.ui, logger: createLogger().logger },
      { action: 'acknowledge-uncertain', requestId: ver.value.requestId }
    );
    expect(ackRes.status).toBe('completed');
    if (ackRes.status !== 'completed') throw new Error('expected completed');
    expect(ackRes.request?.state).toBe('canceled');

    // Verify full commit triple + live tip disclosure and NEVER-replay invariant.
    const modalDetail = ackUi.modals[0]!.detail;
    expect(modalDetail).toContain(`requestId: ${ver.value.requestId}`);
    expect(modalDetail).toContain('targetRef: refs/heads/release-uncertain');
    expect(modalDetail).toContain(`expectedCommit: ${ver.value.expectedTargetCommit.slice(0, 12)}`);
    expect(modalDetail).toContain(`candidateCommit: ${ver.value.candidateCommit.slice(0, 12)}`);
    expect(modalDetail).toContain(`observedTip: ${orphanCommit.slice(0, 12)}`);
    expect(modalDetail).toContain(`liveTargetTip: ${orphanCommit.slice(0, 12)}`);
    expect(modalDetail).toContain('NEVER automatically replays');
    assertNoRawPaths(modalDetail, f);

    // Target branch tip was NEVER altered/replayed and journal carries `acknowledged-uncertain`.
    expect(f.fixture.git(['rev-parse', 'refs/heads/release-uncertain']).trim()).toBe(orphanCommit);
    expect(f.integrations.listJournal(ver.value.requestId).at(-1)).toMatchObject({
      kind: 'cancel',
      outcome: 'canceled',
      reason: 'acknowledged-uncertain'
    });
  });

  it('supports complete-and-retain, pin/unpin, mark-cleanup-eligible, and safe cleanup preserving dirty/pinned/live/unrelated worktrees', async () => {
    const f = createRecoveryFixture('recover-cleanup');
    const unrelatedDir = path.join(f.fixture.sibling('unrelated'), 'operator-wt');
    f.fixture.git(['worktree', 'add', '--detach', unrelatedDir, 'HEAD']);

    const provision = async (execId: string) => {
      const res = await f.service.provisionLane({
        rootExecutionId: execId,
        sourceRevision: 'HEAD',
        dependencyRecipe: 'none'
      });
      if (!res.ok) throw new Error(res.refusal.reason);
      return res.value;
    };

    const cleanLane = await provision('exec-clean');
    const dirtyLane = await provision('exec-dirty');
    const pinnedLane = await provision('exec-pinned');
    const liveLane = await provision('exec-live');

    // Make cleanLane frozen + completed + retained + cleanup-eligible via command flows.
    const cleanRoot = (await f.service.resolveLaneRoot(f.lanes.getLane(WS_ID, cleanLane.laneId)!.rootRef))!;
    fs.writeFileSync(path.join(cleanRoot, 'src', 'app.txt'), 'clean-frozen\n');
    const retryRes = await runRecoverExecutionLane(
      { getLaneService: () => f.service, ui: createFakeUi({ modalAnswers: [true] }).ui, logger: createLogger().logger },
      { action: 'retry-freeze', laneId: cleanLane.laneId, completeAfterFreeze: false }
    );
    expect(retryRes.status).toBe('completed');

    const retainClean = await runRecoverExecutionLane(
      { getLaneService: () => f.service, ui: createFakeUi({ modalAnswers: [true] }).ui, logger: createLogger().logger },
      { action: 'complete-and-retain', laneId: cleanLane.laneId }
    );
    expect(retainClean.status).toBe('completed');
    expect(retainClean.status === 'completed' && retainClean.lane?.state).toBe('retained');

    const eligClean = await runRecoverExecutionLane(
      { getLaneService: () => f.service, ui: createFakeUi({ modalAnswers: [true] }).ui, logger: createLogger().logger },
      { action: 'mark-cleanup-eligible', laneId: cleanLane.laneId }
    );
    expect(eligClean.status).toBe('completed');
    expect(eligClean.status === 'completed' && eligClean.lane?.state).toBe('cleanup-eligible');

    // Prepare dirtyLane: complete-and-retain -> mark-cleanup-eligible, leave dirty untracked file.
    const dirtyRoot = (await f.service.resolveLaneRoot(f.lanes.getLane(WS_ID, dirtyLane.laneId)!.rootRef))!;
    await runRecoverExecutionLane(
      { getLaneService: () => f.service, ui: createFakeUi({ modalAnswers: [true] }).ui, logger: createLogger().logger },
      { action: 'complete-and-retain', laneId: dirtyLane.laneId }
    );
    await runRecoverExecutionLane(
      { getLaneService: () => f.service, ui: createFakeUi({ modalAnswers: [true] }).ui, logger: createLogger().logger },
      { action: 'mark-cleanup-eligible', laneId: dirtyLane.laneId }
    );
    fs.writeFileSync(path.join(dirtyRoot, 'unsaved.txt'), 'keep-dirty\n');

    // Prepare pinnedLane: complete-and-retain with pin=true -> mark-cleanup-eligible -> still pinned!
    const pinRetain = await runRecoverExecutionLane(
      { getLaneService: () => f.service, ui: createFakeUi({ modalAnswers: [true] }).ui, logger: createLogger().logger },
      { action: 'complete-and-retain', laneId: pinnedLane.laneId, pin: true }
    );
    expect(pinRetain.status === 'completed' && pinRetain.lane?.pinned).toBe(true);
    await runRecoverExecutionLane(
      { getLaneService: () => f.service, ui: createFakeUi({ modalAnswers: [true] }).ui, logger: createLogger().logger },
      { action: 'mark-cleanup-eligible', laneId: pinnedLane.laneId }
    );

    // Run safe cleanup across all four lanes (including liveLane explicitly).
    const cleanupUi = createFakeUi({ modalAnswers: [true] });
    const cleanupRes = await runRecoverExecutionLane(
      { getLaneService: () => f.service, ui: cleanupUi.ui, logger: createLogger().logger },
      {
        action: 'cleanup',
        laneIds: [cleanLane.laneId, dirtyLane.laneId, pinnedLane.laneId, liveLane.laneId]
      }
    );
    expect(cleanupRes.status).toBe('completed');
    if (cleanupRes.status !== 'completed') throw new Error('expected completed');
    expect(cleanupRes.cleanupReport).toEqual({
      removed: [cleanLane.laneId],
      kept: [
        { laneId: dirtyLane.laneId, observation: 'lane-dirty' },
        { laneId: pinnedLane.laneId, observation: 'lane-pinned' },
        { laneId: liveLane.laneId, observation: 'lane-live' }
      ]
    });
    assertNoRawPaths(cleanupUi.modals[0]!.detail, f);

    // Dirty, pinned, live, and unrelated worktrees + clean candidate ref all survived!
    expect(fs.existsSync(cleanRoot)).toBe(false);
    expect(fs.existsSync(path.join(dirtyRoot, 'unsaved.txt'))).toBe(true);
    expect(fs.existsSync(path.join(unrelatedDir, 'src', 'app.txt'))).toBe(true);
    expect(f.fixture.git(['for-each-ref', '--format=%(refname)', cleanLane.candidateRef]).trim()).toBe(
      cleanLane.candidateRef
    );

    // Unpin pinnedLane and confirm unpin works cleanly.
    const unpinned = await runRecoverExecutionLane(
      { getLaneService: () => f.service, ui: createFakeUi({ modalAnswers: [true] }).ui, logger: createLogger().logger },
      { action: 'unpin', laneId: pinnedLane.laneId }
    );
    expect(unpinned.status === 'completed' && unpinned.lane?.pinned).toBe(false);
  });

  it('handles unavailable service, invalid structured args, and prevents confirm=true / completeAfterFreeze=true modal bypasses', async () => {
    const f = createRecoveryFixture('recover-guards');
    const unavailableUi = createFakeUi();
    const unavailable = await runRecoverExecutionLane(
      { getLaneService: () => null, ui: unavailableUi.ui, logger: createLogger().logger },
      { action: 'reconcile' }
    );
    expect(unavailable).toEqual({ status: 'unavailable' });

    const invalid = await runRecoverExecutionLane(
      { getLaneService: () => f.service, ui: createFakeUi().ui, logger: createLogger().logger },
      { action: 'not-a-real-action' }
    );
    expect(invalid).toEqual({ status: 'invalid-args' });

    // `confirm: true` passed by an external caller MUST NOT bypass `ui.confirmModal`.
    const bypassUi = createFakeUi({ modalAnswers: [false] });
    const reconcileSpy = vi.spyOn(f.service, 'reconcile');
    const blockedBypass = await runRecoverExecutionLane(
      { getLaneService: () => f.service, ui: bypassUi.ui, logger: createLogger().logger },
      { action: 'reconcile', confirm: true } as unknown
    );
    expect(blockedBypass.status).toBe('canceled');
    expect(bypassUi.modals).toHaveLength(1);
    expect(reconcileSpy).not.toHaveBeenCalled();

    // `completeAfterFreeze: true` MUST still invoke a second `ui.confirmModal` before `completeLane`.
    const prov = await f.service.provisionLane({
      rootExecutionId: 'exec-complete-modal-guard',
      sourceRevision: 'HEAD',
      dependencyRecipe: 'none'
    });
    if (!prov.ok) throw new Error(prov.refusal.reason);
    const laneRoot = (await f.service.resolveLaneRoot(f.lanes.getLane(WS_ID, prov.value.laneId)!.rootRef))!;
    fs.writeFileSync(path.join(laneRoot, 'src', 'app.txt'), 'guard-freeze-payload\n');

    const retryUi = createFakeUi({ modalAnswers: [true, false] });
    const retryRes = await runRecoverExecutionLane(
      { getLaneService: () => f.service, ui: retryUi.ui, logger: createLogger().logger },
      { action: 'retry-freeze', laneId: prov.value.laneId, completeAfterFreeze: true }
    );
    expect(retryRes.status).toBe('completed');
    expect(retryUi.modals).toHaveLength(2);
    if (retryRes.status !== 'completed') throw new Error('expected completed');
    expect(retryRes.candidate).toBeDefined();
    expect(retryRes.completedAfterFreeze).toBe(false);
    expect(retryRes.lane?.state).toBe('active');
  });

  it('refuses with zero LaneService mutations when primacy or trust is lost while modal is open (TOCTOU guard)', async () => {
    const f = createRecoveryFixture('recover-toctou');
    const prov = await f.service.provisionLane({
      rootExecutionId: 'exec-toctou',
      sourceRevision: 'HEAD',
      dependencyRecipe: 'none'
    });
    if (!prov.ok) throw new Error(prov.refusal.reason);
    const laneId = prov.value.laneId;
    const laneRoot = (await f.service.resolveLaneRoot(f.lanes.getLane(WS_ID, laneId)!.rootRef))!;
    fs.writeFileSync(path.join(laneRoot, 'src', 'app.txt'), 'toctou-change\n');
    const frozen = await f.service.freezeCandidate({ laneId });
    if (!frozen.ok) throw new Error(frozen.refusal.reason);
    const req = await f.service.requestIntegration({ laneId, targetBranch: 'main', profile: PROFILE });
    if (!req.ok) throw new Error(req.refusal.reason);

    const spies = [
      vi.spyOn(f.service, 'reconcile'),
      vi.spyOn(f.service, 'cleanupLanes'),
      vi.spyOn(f.service, 'cancelRequest'),
      vi.spyOn(f.service, 'freezeCandidate'),
      vi.spyOn(f.service, 'completeLane'),
      vi.spyOn(f.service, 'releaseLane'),
      vi.spyOn(f.service, 'setLanePinned')
    ];

    const actionsToCheck: readonly Record<string, unknown>[] = [
      { action: 'reconcile' },
      { action: 'cleanup', laneIds: [laneId] },
      { action: 'cancel-request', requestId: req.value.requestId },
      { action: 'retry-freeze', laneId },
      { action: 'complete-and-retain', laneId, pin: true },
      { action: 'pin', laneId }
    ];

    for (const args of actionsToCheck) {
      let isPrimary = true;
      const base = createFakeUi({ modalAnswers: [true, true] });
      const ui: LaneRecoveryCommandUi = {
        ...base.ui,
        confirmModal: async (summary, detail, confirmLabel) => {
          const answer = await base.ui.confirmModal(summary, detail, confirmLabel);
          // Simulate primacy loss while the operator is reading the modal dialog.
          isPrimary = false;
          return answer;
        }
      };
      const outcome = await runRecoverExecutionLane(
        {
          getLaneService: () => f.service,
          verifyPrimaryAndTrusted: async () => isPrimary,
          ui,
          logger: createLogger().logger
        },
        args
      );
      expect(outcome.status).toBe('refused');
      if (outcome.status === 'refused') {
        expect(outcome.reason).toBe('ownership-superseded');
      }
    }

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(f.lanes.getLane(WS_ID, laneId)?.state).toBe('active');
    expect(f.lanes.getLane(WS_ID, laneId)?.pinned).toBe(false);
    expect(f.integrations.getRequest(WS_ID, req.value.requestId)?.state).toBe('queued');
  });

  it('catches throws from getLaneService, snapshot reads, and synchronous LaneService mutations with sanitized error outcomes', async () => {
    const f = createRecoveryFixture('recover-throws');
    const prov = await f.service.provisionLane({
      rootExecutionId: 'exec-throw',
      sourceRevision: 'HEAD',
      dependencyRecipe: 'none'
    });
    if (!prov.ok) throw new Error(prov.refusal.reason);
    const laneId = prov.value.laneId;
    const laneRoot = (await f.service.resolveLaneRoot(f.lanes.getLane(WS_ID, laneId)!.rootRef))!;
    fs.writeFileSync(path.join(laneRoot, 'src', 'app.txt'), 'throw-change\n');
    const frozen = await f.service.freezeCandidate({ laneId });
    if (!frozen.ok) throw new Error(frozen.refusal.reason);
    const req = await f.service.requestIntegration({ laneId, targetBranch: 'main', profile: PROFILE });
    if (!req.ok) throw new Error(req.refusal.reason);

    // 1. `getLaneService()` throws
    const ui1 = createFakeUi();
    const log1 = createLogger();
    const res1 = await runRecoverExecutionLane(
      {
        getLaneService: async () => {
          throw Object.assign(new Error('secret /Users/alice/private'), { code: 'ERR_SVC_/Users/alice/private' });
        },
        ui: ui1.ui,
        logger: log1.logger
      },
      { action: 'reconcile' }
    );
    expect(res1.status).toBe('error');
    if (res1.status === 'error') {
      expect(res1.errorCode).not.toContain('/Users/alice');
    }
    expect(ui1.errors[0]).not.toContain('/Users/alice');

    // 2. `readLaneSnapshotFromService` (`listLanes`) throws
    const listSpy = vi.spyOn(f.service, 'listLanes').mockImplementationOnce(() => {
      throw Object.assign(new Error('sqlite boom'), { code: 'SQLITE_CORRUPT' });
    });
    const ui2 = createFakeUi();
    const res2 = await runRecoverExecutionLane(
      { getLaneService: () => f.service, ui: ui2.ui, logger: createLogger().logger },
      { action: 'reconcile' }
    );
    expect(res2).toMatchObject({ status: 'error', action: 'reconcile', errorCode: 'SQLITE_CORRUPT' });
    expect(ui2.errors[0]).toContain('SQLITE_CORRUPT');
    listSpy.mockRestore();

    // 3. `cancelRequest`, `completeLane`, `setLanePinned`, and `releaseLane` throws
    vi.spyOn(f.service, 'cancelRequest').mockImplementationOnce(() => {
      throw Object.assign(new Error('cancel boom'), { code: 'SQLITE_BUSY' });
    });
    expect(
      await runRecoverExecutionLane(
        { getLaneService: () => f.service, ui: createFakeUi({ modalAnswers: [true] }).ui, logger: createLogger().logger },
        { action: 'cancel-request', requestId: req.value.requestId }
      )
    ).toMatchObject({ status: 'error', action: 'cancel-request', errorCode: 'SQLITE_BUSY' });

    vi.spyOn(f.service, 'completeLane').mockImplementationOnce(() => {
      throw Object.assign(new Error('complete boom'), { code: 'SQLITE_IOERR' });
    });
    expect(
      await runRecoverExecutionLane(
        { getLaneService: () => f.service, ui: createFakeUi({ modalAnswers: [true] }).ui, logger: createLogger().logger },
        { action: 'complete-and-retain', laneId }
      )
    ).toMatchObject({ status: 'error', action: 'complete-and-retain', errorCode: 'SQLITE_IOERR' });

    vi.spyOn(f.service, 'setLanePinned').mockImplementationOnce(() => {
      throw Object.assign(new Error('pin boom'), { code: 'SQLITE_READONLY' });
    });
    expect(
      await runRecoverExecutionLane(
        { getLaneService: () => f.service, ui: createFakeUi({ modalAnswers: [true] }).ui, logger: createLogger().logger },
        { action: 'pin', laneId }
      )
    ).toMatchObject({ status: 'error', action: 'pin', errorCode: 'SQLITE_READONLY' });

    // Transition lane to completed so `mark-cleanup-eligible` reaches `releaseLane`.
    expect(f.service.completeLane({ laneId }).ok).toBe(true);
    vi.spyOn(f.service, 'releaseLane').mockImplementationOnce(() => {
      throw Object.assign(new Error('release boom'), { code: 'SQLITE_LOCKED' });
    });
    expect(
      await runRecoverExecutionLane(
        { getLaneService: () => f.service, ui: createFakeUi({ modalAnswers: [true] }).ui, logger: createLogger().logger },
        { action: 'mark-cleanup-eligible', laneId }
      )
    ).toMatchObject({ status: 'error', action: 'mark-cleanup-eligible', errorCode: 'SQLITE_LOCKED' });
  });
});

describe('FR-R8-01 (01-07) SQLite inspection error surfacing through wiring', () => {
  function createMemoryStore(): WorkspaceStateStore {
    const map = new Map<string, unknown>();
    const memento: Memento = {
      get: <T>(key: string, defaultValue?: T) => (map.has(key) ? (map.get(key) as T) : defaultValue),
      update: async (key: string, value: unknown) => {
        if (value === undefined) map.delete(key);
        else map.set(key, value);
      }
    };
    return new WorkspaceStateStore(memento);
  }

  it('returns empty only on absent SQLite DB and surfaces refused, sqlite-error, and unreadable as error outcomes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schegent-wiring-inspect-'));
    tempDirs.push(root);
    const wsRoot = path.join(root, 'workspace');
    const storageRoot = path.join(root, 'storage');
    fs.mkdirSync(wsRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
    const scopeId = deriveWorkspaceScopeId(wsRoot);
    const dbDir = path.join(storageRoot, 'sqlite', scopeId);
    const dbFile = path.join(dbDir, 'schegent-state.db');

    const store = createMemoryStore();
    const recUi = createFakeUi();
    const recLog = createLogger();
    const disposables = registerLaneRecoveryCommands(
      {
        isWorkspaceTrusted: () => false,
        isOwner: async () => true,
        notifier: { warn: (msg) => recUi.warns.push(msg) },
        logger: recLog.logger
      },
      {
        workspaceRoot: wsRoot,
        globalStorageRoot: storageRoot,
        store,
        notifier: new Notifier({
          showInformationMessage: async () => undefined,
          showWarningMessage: async () => undefined,
          showErrorMessage: async () => undefined
        }),
        logger: recLog.logger,
        ui: recUi.ui
      }
    );

    try {
      const inspectHandler = registeredVscodeCommands.get(INSPECT_EXECUTION_LANES_COMMAND);
      expect(inspectHandler).toBeDefined();

      // 1. Absent DB -> `'empty'`
      const absentRes = await inspectHandler!();
      expect(absentRes).toEqual({ status: 'empty', laneCount: 0, requestCount: 0, gitProbed: false });

      // 2. Symlink DB -> `'refused'` surfaced as `'error'`
      fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
      const outside = path.join(root, 'outside.db');
      fs.writeFileSync(outside, 'not-a-db');
      fs.symlinkSync(outside, dbFile);
      recLog.entries.length = 0;
      const refusedRes = await inspectHandler!();
      expect(refusedRes).toEqual({ status: 'error', laneCount: 0, requestCount: 0, gitProbed: false });
      expect(recLog.entries.at(-1)).toMatchObject({ level: 'warn', context: { code: 'refused' } });
      fs.unlinkSync(dbFile);

      // 3. Corrupt non-SQLite DB file -> surfaced as `'error'` (never silent `'empty'`)
      fs.writeFileSync(dbFile, 'corrupted-not-sqlite-header');
      recLog.entries.length = 0;
      const corruptRes = await inspectHandler!();
      expect(corruptRes).toEqual({ status: 'error', laneCount: 0, requestCount: 0, gitProbed: false });
      expect(recLog.entries.at(-1)?.level).toBe('warn');
      expect(String(recLog.entries.at(-1)?.context?.['code'])).toMatch(/^(?:sqlite-error|ERR_SQLITE_ERROR)$/);

      // 4. Unreadable DB (chmod 0o000 on POSIX non-root, plus direct coded error check)
      if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
        fs.chmodSync(dbFile, 0o000);
        try {
          recLog.entries.length = 0;
          const unreadableRes = await inspectHandler!();
          expect(unreadableRes).toEqual({ status: 'error', laneCount: 0, requestCount: 0, gitProbed: false });
          expect(recLog.entries.at(-1)).toMatchObject({ level: 'warn', context: { code: 'unreadable' } });
        } finally {
          fs.chmodSync(dbFile, 0o600);
        }
      }

      const directUnreadableLog = createLogger();
      const directUnreadable = await runInspectExecutionLanes({
        isWorkspaceTrusted: () => false,
        readSnapshot: async () => {
          throw Object.assign(new Error('Execution lane inspection failed'), { code: 'unreadable' });
        },
        ui: createFakeUi().ui,
        logger: directUnreadableLog.logger
      });
      expect(directUnreadable).toEqual({ status: 'error', laneCount: 0, requestCount: 0, gitProbed: false });
      expect(directUnreadableLog.entries.at(-1)).toMatchObject({ level: 'warn', context: { code: 'unreadable' } });
    } finally {
      for (const d of disposables) d.dispose();
    }
  });
});

describe('FR-R8-01 (01-07) read-only SQLite snapshot without execution_lanes table', () => {
  it('returns empty snapshot gracefully when database lacks lane tables', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schegent-ro-empty-'));
    tempDirs.push(root);
    const dbDir = path.join(root, 'sqlite', WS_ID);
    fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
    const dbFile = path.join(dbDir, 'schegent-state.db');
    const conn = new NodeSqliteConnection({ databasePath: dbFile, journalMode: 'wal' });
    conn.exec('CREATE TABLE dummy (id INTEGER PRIMARY KEY)');
    conn.close();

    const inspected = await withZeroMutationReadOnlySqliteConnection(
      root,
      ['sqlite', WS_ID],
      'schegent-state.db',
      (roConn) => readLaneSnapshotFromSqlitePort(roConn, WS_ID, 'Restricted Mode test')
    );
    expect(inspected.outcome).toBe('ok');
    if (inspected.outcome !== 'ok') throw new Error('expected ok');
    expect(inspected.value.lanes).toEqual([]);
    expect(inspected.value.requests).toEqual([]);
    expect(inspected.value.gitProbed).toBe(false);
  });
});
