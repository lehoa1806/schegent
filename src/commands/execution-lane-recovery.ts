/**
 * FR-R8-01 (01-07) — Guarded installed-editor execution-lane inspection and recovery commands:
 *   - `schegent.inspectExecutionLanes` (read-only; non-blocking with zero args; zero Git subprocesses
 *     in Restricted Mode);
 *   - `schegent.recoverExecutionLane` (mutating + owner-only; QuickPick + optional structured args;
 *     mandatory pre-mutation disclosure modal; never auto-replays `uncertain` landings).
 *
 * UI prompts are injected as ports so every interactive and structured flow is deterministically
 * testable without VS Code. Zero `vscode` imports (docs/hard-rules.md rule 13); zero raw workspace
 * or storage paths or raw Git stderr in UI/logs (docs/hard-rules.md rule 22).
 */

import {
  LANE_DISCLOSURE,
  LANE_PAGE_LIMIT_MAX,
  type CandidateView,
  type CleanupReport,
  type IntegrationRequestView,
  type IntegrationState,
  type LaneRefusalReason,
  type LaneResult,
  type LaneState,
  type LaneView,
  type ReconcileReport
} from '../contracts/execution-lanes';
import { SanitizedLogger } from '../lib/logger';
import {
  JOURNAL_COLUMNS,
  RECEIPT_COLUMNS,
  REQUEST_COLUMNS,
  journalFromRow,
  receiptFromRow,
  requestFromRow,
  type JournalRow,
  type ReceiptRow,
  type RequestRow
} from '../services/execution-lanes/integration-store-rows';
import { requestViewOf } from '../services/execution-lanes/integration-views';
import {
  FREEZE_FAILURE_REASON_PREFIX,
  type LaneGitObservation,
  type LaneJournalEntryView,
  type LaneService
} from '../services/execution-lanes/lane-service';
import {
  CANDIDATE_COLUMNS,
  LANE_COLUMNS,
  candidateFromRow,
  laneFromRow,
  laneViewOf,
  type CandidateRow,
  type LaneRow
} from '../services/execution-lanes/lane-store-rows';
import type { SqliteConnectionPort } from '../state/sqlite-operational-port';

export const INSPECT_EXECUTION_LANES_COMMAND = 'schegent.inspectExecutionLanes';
export const RECOVER_EXECUTION_LANE_COMMAND = 'schegent.recoverExecutionLane';

export const LANE_RECOVERY_ACTIONS = Object.freeze([
  'retry-freeze', 'acknowledge-uncertain', 'cancel-request', 'complete-and-retain',
  'pin', 'unpin', 'mark-cleanup-eligible', 'cleanup', 'reconcile'
] as const);

export type LaneRecoveryAction = (typeof LANE_RECOVERY_ACTIONS)[number];

export interface RecoverExecutionLaneArgs {
  readonly action?: LaneRecoveryAction | undefined;
  readonly laneId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly laneIds?: readonly string[] | undefined;
  readonly completeAfterFreeze?: boolean | undefined;
  readonly pin?: boolean | undefined;
}

export interface LaneRecoveryPickerItem {
  readonly label: string;
  readonly description: string;
  readonly detail: string;
  readonly value: string;
}

export interface LaneRecoveryCommandUi {
  pickItem(items: readonly LaneRecoveryPickerItem[], title: string, placeHolder: string): Promise<LaneRecoveryPickerItem | undefined>;
  confirmModal(summary: string, detail: string, confirmLabel: string): Promise<boolean>;
  openMarkdownReport(markdown: string): Promise<void>;
  info(message: string): unknown;
  warn(message: string): unknown;
  error(message: string): unknown;
}

export interface LaneRecoveryLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface ReadOnlyLaneSnapshot {
  readonly lanes: readonly LaneView[];
  readonly requests: readonly IntegrationRequestView[];
  readonly journalsByRequestId: Readonly<Record<string, readonly LaneJournalEntryView[] | undefined>>;
  readonly gitByLaneId: Readonly<Record<string, LaneGitObservation | undefined>>;
  readonly targetTips: Readonly<Record<string, string | null | undefined>>;
  readonly gitProbed: boolean;
  readonly modeNote: string;
}

export interface InspectExecutionLanesDeps {
  readonly isWorkspaceTrusted: () => boolean;
  readonly readSnapshot: (options: { readonly allowLiveGit: boolean }) => Promise<ReadOnlyLaneSnapshot>;
  readonly ui: Pick<LaneRecoveryCommandUi, 'openMarkdownReport' | 'info' | 'warn'>;
  readonly logger: LaneRecoveryLogger;
  readonly now?: () => number;
}

export interface RecoverExecutionLaneDeps {
  readonly getLaneService: () => Promise<LaneService | null> | LaneService | null;
  readonly verifyPrimaryAndTrusted?: () => Promise<boolean> | boolean;
  readonly ui: LaneRecoveryCommandUi;
  readonly logger: LaneRecoveryLogger;
}

export interface LaneRecoveryDisclosure {
  readonly action: LaneRecoveryAction;
  readonly summary: string;
  readonly detail: string;
  readonly confirmLabel: string;
}

export interface InspectExecutionLanesOutcome {
  readonly status: 'opened' | 'empty' | 'error';
  readonly laneCount: number;
  readonly requestCount: number;
  readonly gitProbed: boolean;
  readonly markdown?: string;
}

export type RecoverExecutionLaneOutcome =
  | {
      readonly status: 'completed';
      readonly action: LaneRecoveryAction;
      readonly disclosure: LaneRecoveryDisclosure;
      readonly lane?: LaneView;
      readonly candidate?: CandidateView;
      readonly request?: IntegrationRequestView;
      readonly cleanupReport?: CleanupReport;
      readonly reconcileReport?: ReconcileReport;
      readonly completedAfterFreeze?: boolean;
      readonly candidateEmpty?: boolean;
    }
  | { readonly status: 'refused'; readonly action: LaneRecoveryAction; readonly reason: LaneRefusalReason; readonly disclosure: LaneRecoveryDisclosure }
  | { readonly status: 'canceled'; readonly action?: LaneRecoveryAction; readonly disclosure?: LaneRecoveryDisclosure }
  | { readonly status: 'empty'; readonly action: LaneRecoveryAction }
  | { readonly status: 'unavailable' }
  | { readonly status: 'invalid-args' }
  | { readonly status: 'error'; readonly action?: LaneRecoveryAction; readonly errorCode: string; readonly disclosure?: LaneRecoveryDisclosure };

const OPEN_REQUEST_STATES: ReadonlySet<IntegrationState> = new Set([
  'queued', 'verifying', 'awaiting-review', 'landing', 'blocked', 'uncertain'
]);
const CANCELABLE_NON_UNCERTAIN_STATES: ReadonlySet<IntegrationState> = new Set(['queued', 'awaiting-review', 'blocked']);
const COMPLETE_AND_RETAIN_STATES: ReadonlySet<LaneState> = new Set(['active', 'paused', 'completed']);
const CLEANUP_ELIGIBLE_SOURCE_STATES: ReadonlySet<LaneState> = new Set(['completed', 'retained', 'preparation-failed']);

const HEX_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;
const MAX_DISPLAY_TOKEN_CHARS = 128;
const MAX_REPORT_ITEMS = 200;

/** Formats a commit/tree hex SHA to a short 12-char lowercase token or `'none'`. */
export function shortSha(sha: string | null | undefined): string {
  return typeof sha === 'string' && HEX_SHA_PATTERN.test(sha) ? sha.slice(0, 12).toLowerCase() : 'none';
}

function stripControlChars(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    out += code <= 0x1f || code === 0x7f ? ' ' : raw[i];
  }
  return out.replace(/\s+/g, ' ').trim();
}

const DISPLAY_REDACTOR = new SanitizedLogger();
const UNC_PATH_RE = /\\\\(?:(?:\[REDACTED\])|[^\s)'"\]`,;])+/g;
const WIN_DRIVE_PATH_RE = /\b[A-Za-z]:[\\/](?:(?:\[REDACTED\])|[^\s)'"\]`,;])+/g;
const POSIX_PATH_RE = /(^|[\s(=:[`,'"])\/(?:(?:\[REDACTED\])|[^\s)'"\]`,;])+/g;

/** Strips control characters and redacts secrets and absolute paths (hard rules 1, 22, 23). */
export function sanitizeDisplayToken(raw: string | null | undefined, fallback = 'none'): string {
  if (typeof raw !== 'string') return fallback;
  const singleLine = stripControlChars(DISPLAY_REDACTOR.sanitize(raw));
  if (singleLine.length === 0) return fallback;
  const cleaned = singleLine
    .replace(UNC_PATH_RE, '<redacted-path>')
    .replace(WIN_DRIVE_PATH_RE, '<redacted-path>')
    .replace(POSIX_PATH_RE, '$1<redacted-path>')
    .slice(0, MAX_DISPLAY_TOKEN_CHARS)
    .trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

function sanitizeMarkdownToken(raw: string | null | undefined, fallback = 'none'): string {
  const cleaned = sanitizeDisplayToken(raw, fallback).replace(/[|`]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

/** Extracts a sanitized short branch name from `refs/heads/<name>`. */
export function branchNameFromRef(ref: string | null | undefined): string {
  if (typeof ref !== 'string' || ref.length === 0) return 'none';
  return sanitizeDisplayToken(ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref, 'none');
}

function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { code, name } = error as { code?: unknown; name?: unknown };
    if (typeof code === 'string' && code.length > 0) {
      return sanitizeDisplayToken(code, 'unknown').replace(/[\\/].*$/, '<redacted-path>');
    }
    if (typeof name === 'string' && name.length > 0) {
      return sanitizeDisplayToken(name, 'Error').replace(/[\\/].*$/, '<redacted-path>');
    }
  }
  return 'unknown';
}

function isFreezeFailedLane(lane: LaneView): boolean {
  return lane.state === 'active' && lane.stateReason !== null && lane.stateReason.startsWith(FREEZE_FAILURE_REASON_PREFIX);
}

function collectPaged<T>(
  fetchPage: (cursor: string | undefined) => LaneResult<{ readonly items: readonly T[]; readonly nextCursor: string | null }>
): readonly T[] {
  const items: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = fetchPage(cursor);
    if (!page.ok) break;
    items.push(...page.value.items);
    if (page.value.nextCursor === null || page.value.nextCursor === cursor) break;
    cursor = page.value.nextCursor;
  }
  return items;
}

/** Builds a read-only lane snapshot from a live `LaneService` (probing Git only when `allowLiveGit`). */
export async function readLaneSnapshotFromService(
  service: LaneService,
  options: { readonly allowLiveGit: boolean; readonly modeNote?: string }
): Promise<ReadOnlyLaneSnapshot> {
  const lanes = collectPaged((cursor) =>
    service.listLanes({ limit: LANE_PAGE_LIMIT_MAX, ...(cursor === undefined ? {} : { cursor }) })
  );
  const requests = collectPaged((cursor) =>
    service.listRequests({ limit: LANE_PAGE_LIMIT_MAX, ...(cursor === undefined ? {} : { cursor }) })
  );
  const journalsByRequestId: Record<string, readonly LaneJournalEntryView[]> = {};
  for (const request of requests.slice(-MAX_REPORT_ITEMS)) {
    const journal = service.listRequestJournal({ requestId: request.requestId });
    if (journal.ok) journalsByRequestId[request.requestId] = journal.value;
  }

  const gitByLaneId: Record<string, LaneGitObservation> = {};
  let targetTips: Readonly<Record<string, string | null>> = {};
  if (options.allowLiveGit) {
    const refsByLane = new Map<string, string[]>();
    const allRefs: string[] = [];
    for (const req of requests) {
      allRefs.push(req.targetRef);
      const list = refsByLane.get(req.laneId) ?? [];
      list.push(req.targetRef);
      refsByLane.set(req.laneId, list);
    }
    try {
      targetTips = await service.resolveTargetRefTips(allRefs);
    } catch {
      // Git unavailable in workspace; preserve persisted SQLite facts with unavailable Git markers.
      targetTips = {};
    }
    for (const lane of lanes) {
      if (lane.state === 'removed') continue;
      try {
        const obs = await service.inspectLaneGitState({ laneId: lane.laneId, targetRefs: refsByLane.get(lane.laneId) ?? [] });
        if (obs.ok) gitByLaneId[lane.laneId] = obs.value;
      } catch {
        // Individual lane Git probe failure must not hide persisted lane state.
      }
    }
  }

  return {
    lanes,
    requests,
    journalsByRequestId,
    gitByLaneId,
    targetTips,
    gitProbed: options.allowLiveGit,
    modeNote:
      options.modeNote ??
      (options.allowLiveGit
        ? 'Live read-only Git observations collected from the trusted primary workspace.'
        : 'Live Git inspection skipped in Restricted Mode (untrusted workspace).')
  };
}

/**
 * Reads persisted execution lanes, candidates, integration requests, receipts, and journals from a
 * zero-mutation read-only `SqliteConnectionPort` without creating tables or spawning Git.
 */
export function readLaneSnapshotFromSqlitePort(
  conn: SqliteConnectionPort,
  workspaceId: string,
  modeNote: string
): ReadOnlyLaneSnapshot {
  const empty: ReadOnlyLaneSnapshot = {
    lanes: [], requests: [], journalsByRequestId: {}, gitByLaneId: {}, targetTips: {}, gitProbed: false, modeNote
  };
  const hasLanesTable = conn.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_lanes'"
  );
  if (hasLanesTable === undefined) return empty;

  const lanes = conn
    .all<LaneRow & Record<string, unknown>>(
      `SELECT ${LANE_COLUMNS} FROM execution_lanes WHERE workspace_id = ? ORDER BY created_at, lane_id`,
      workspaceId
    )
    .map((row) => {
      const lane = laneFromRow(row);
      const candRow = conn.get<CandidateRow & Record<string, unknown>>(
        `SELECT ${CANDIDATE_COLUMNS} FROM lane_candidates WHERE lane_id = ? ORDER BY candidate_seq DESC LIMIT 1`,
        lane.laneId
      );
      return laneViewOf(lane, candRow === undefined ? null : candidateFromRow(candRow));
    });

  const requests: IntegrationRequestView[] = [];
  const journalsByRequestId: Record<string, readonly LaneJournalEntryView[]> = {};
  const reqRows = conn.all<RequestRow & Record<string, unknown>>(
    `SELECT ${REQUEST_COLUMNS} FROM lane_integration_requests WHERE workspace_id = ? ORDER BY created_at, request_id`,
    workspaceId
  );
  for (const row of reqRows) {
    const req = requestFromRow(row);
    const receiptRow = conn.get<ReceiptRow & Record<string, unknown>>(
      `SELECT ${RECEIPT_COLUMNS} FROM lane_review_receipts WHERE request_id = ?`,
      req.requestId
    );
    const journals = conn
      .all<JournalRow & Record<string, unknown>>(
        `SELECT ${JOURNAL_COLUMNS} FROM lane_integration_journal WHERE request_id = ? ORDER BY entry_seq ASC`,
        req.requestId
      )
      .map(journalFromRow);
    const priorBlockedReasons = journals.flatMap((e) =>
      e.kind === 'reconcile' && e.outcome === 'blocked' && e.observedTip === null && e.reason !== null && e.reason !== 'review-stale'
        ? [e.reason]
        : []
    );
    requests.push(requestViewOf(req, receiptRow === undefined ? null : receiptFromRow(receiptRow), priorBlockedReasons));
    journalsByRequestId[req.requestId] = journals.map(
      ({ entryId, seq, kind, method, candidateCommit, expectedCommit, observedTip, outcome, reason, recordedAt }) => ({
        entryId, seq, kind, method, candidateCommit, expectedCommit, observedTip, outcome, reason, recordedAt
      })
    );
  }
  return { ...empty, lanes, requests, journalsByRequestId };
}

function latestObservedTip(journals: readonly LaneJournalEntryView[] | undefined): string | null {
  if (journals === undefined) return null;
  for (let i = journals.length - 1; i >= 0; i -= 1) {
    const tip = journals.at(i)?.observedTip ?? null;
    if (tip !== null) return tip;
  }
  return null;
}

function formatDirtyStatus(obs: LaneGitObservation | undefined): string {
  if (obs === undefined) return 'not probed';
  if (obs.rootStatus === 'absent') return 'worktree absent';
  if (obs.rootStatus === 'not-contained') return 'containment refused';
  if (obs.statusProbe === 'timeout') return 'status-timeout';
  if (obs.statusProbe === 'buffer-exceeded') return 'status-buffer-exceeded';
  if (obs.statusProbe === 'unavailable' || obs.dirtyCount === null) return 'unavailable';
  return obs.dirtyCount === 0 ? 'clean (0 changes)' : `dirty (${obs.dirtyCount} path(s))`;
}

function formatBool(value: boolean | null | undefined): string {
  return value === true ? 'yes' : value === false ? 'no' : 'unknown';
}

function formatWorktreeBranch(obs: LaneGitObservation | undefined): string {
  if (obs === undefined) return 'unknown';
  if (obs.worktreeBranch !== null && obs.worktreeBranch.length > 0) return branchNameFromRef(obs.worktreeBranch);
  return obs.worktreeDetached === true ? 'detached HEAD' : 'unknown';
}

function formatWorktreeCell(lane: LaneView, obs: LaneGitObservation | undefined, gitProbed: boolean, trusted: boolean): string {
  if (obs !== undefined) return `${obs.rootStatus}${obs.worktreeLocked === true ? ' (locked)' : ''}`;
  if (!gitProbed) return !trusted ? 'skipped (Restricted Mode)' : 'skipped (read-only snapshot)';
  return lane.state === 'removed' ? 'removed' : 'not probed';
}

function formatHeadCell(lane: LaneView, obs: LaneGitObservation | undefined, gitProbed: boolean): string {
  if (!gitProbed) return 'skipped';
  if (obs?.headCommit !== null && obs?.headCommit !== undefined) return `\`${shortSha(obs.headCommit)}\``;
  return lane.state === 'removed' ? 'n/a' : 'unknown';
}

/** Renders the sanitized Markdown inspection report (never includes raw paths or Git stderr). */
export function renderLaneInspectionMarkdown(
  snapshot: ReadOnlyLaneSnapshot,
  options: { readonly trusted: boolean; readonly generatedAtIso: string }
): string {
  const openCount = snapshot.requests.filter((r) => OPEN_REQUEST_STATES.has(r.state)).length;
  const uncertainCount = snapshot.requests.filter((r) => r.state === 'uncertain').length;
  const freezeFailedCount = snapshot.lanes.filter(isFreezeFailedLane).length;

  const lines: string[] = [
    '# Schegent Execution Lanes Inspection',
    '',
    `- **Generated**: \`${sanitizeMarkdownToken(options.generatedAtIso)}\``,
    `- **Trust posture**: ${options.trusted ? 'Trusted workspace' : 'Restricted Mode (untrusted workspace)'}`,
    `- **Git probe**: ${sanitizeMarkdownToken(snapshot.modeNote)}`,
    `- **Counts**: ${snapshot.lanes.length} lane(s), ${freezeFailedCount} freeze-failed active lane(s), ${openCount} open request(s), ${uncertainCount} uncertain request(s)`,
    '',
    `> ${LANE_DISCLOSURE}`,
    '',
    '## Lanes',
    ''
  ];

  if (snapshot.lanes.length === 0) {
    lines.push('No execution lanes are recorded for this workspace.');
  } else {
    lines.push(
      '| Lane ID | State | State Reason | Pinned | Candidate | Source | Worktree | Dirty | HEAD |',
      '|---|---|---|---|---|---|---|---|---|'
    );
    for (const lane of snapshot.lanes) {
      const obs = snapshot.gitByLaneId[lane.laneId];
      const candCell = lane.currentCandidate === null ? 'none' : `\`${shortSha(lane.currentCandidate.commit)}\` (#${lane.currentCandidate.seq})`;
      const dirtyCell = !snapshot.gitProbed ? 'skipped' : lane.state === 'removed' ? 'n/a' : formatDirtyStatus(obs);
      lines.push(
        `| \`${sanitizeMarkdownToken(lane.laneId)}\` | \`${lane.state}\` | \`${sanitizeMarkdownToken(lane.stateReason)}\` | ${lane.pinned ? 'yes' : 'no'} | ${candCell} | \`${shortSha(lane.sourceCommit)}\` | ${formatWorktreeCell(lane, obs, snapshot.gitProbed, options.trusted)} | ${dirtyCell} | ${formatHeadCell(lane, obs, snapshot.gitProbed)} |`
      );
    }
    lines.push('', '### Lane Details', '');
    for (const lane of snapshot.lanes) {
      const obs = snapshot.gitByLaneId[lane.laneId];
      const candLabel = lane.currentCandidate === null ? 'none' : `\`${shortSha(lane.currentCandidate.commit)}\` (seq ${lane.currentCandidate.seq})`;
      lines.push(
        `- **Lane \`${sanitizeMarkdownToken(lane.laneId)}\`** (\`${lane.state}\`)`,
        `  - Root Execution ID: \`${sanitizeMarkdownToken(lane.rootExecutionId)}\``,
        `  - State Reason: \`${sanitizeMarkdownToken(lane.stateReason)}\``,
        `  - Pinned: ${lane.pinned ? 'yes' : 'no'}`,
        `  - Candidate Ref: \`${sanitizeMarkdownToken(lane.candidateRef)}\``,
        `  - Source Commit: \`${shortSha(lane.sourceCommit)}\``,
        `  - Current Candidate: ${candLabel}`
      );
      if (snapshot.gitProbed && lane.state !== 'removed') {
        lines.push(
          `  - Live Git: root=\`${obs?.rootStatus ?? 'unknown'}\`, registered=${formatBool(obs?.worktreeRegistered)}, locked=${formatBool(obs?.worktreeLocked)}, branch=\`${sanitizeMarkdownToken(formatWorktreeBranch(obs))}\`, status=${formatDirtyStatus(obs)}, HEAD=\`${shortSha(obs?.headCommit)}\` (matches recorded: ${formatBool(obs?.headMatchesRecorded)})`
        );
      }
    }
  }

  lines.push('', '## Integration Requests and Journals', '');
  if (snapshot.requests.length === 0) {
    lines.push('No integration requests are recorded for this workspace.');
  } else {
    lines.push(
      '| Request ID | Lane ID | State | Reason | Target Branch | Expected | Candidate | Journal Observed Tip | Live Target Tip |',
      '|---|---|---|---|---|---|---|---|---|'
    );
    for (const req of snapshot.requests) {
      const observedTip = latestObservedTip(snapshot.journalsByRequestId[req.requestId]);
      const liveTip = snapshot.gitProbed ? (snapshot.targetTips[req.targetRef] ?? null) : null;
      const liveTipCell = snapshot.gitProbed ? `\`${shortSha(liveTip)}\`` : 'skipped';
      lines.push(
        `| \`${sanitizeMarkdownToken(req.requestId)}\` | \`${sanitizeMarkdownToken(req.laneId)}\` | \`${req.state}\` | \`${sanitizeMarkdownToken(req.reason)}\` | \`${sanitizeMarkdownToken(branchNameFromRef(req.targetRef))}\` | \`${shortSha(req.expectedTargetCommit)}\` | \`${shortSha(req.candidateCommit)}\` | \`${shortSha(observedTip)}\` | ${liveTipCell} |`
      );
    }
  }

  lines.push(
    '',
    '## Operator Recovery Commands',
    '',
    '- Run **Schegent: Recover Execution Lane** (`schegent.recoverExecutionLane`) in a trusted primary window to retry a failed candidate freeze, inspect and explicitly acknowledge an `uncertain` request (never auto-replayed), complete/retain or pin a lane, mark a lane cleanup-eligible, run safe cleanup, or reconcile interrupted operations.',
    '- Mutating recovery actions are refused in Restricted Mode and secondary windows.'
  );
  return `${lines.join('\n')}\n`;
}

/**
 * Runs `schegent.inspectExecutionLanes`. Non-blocking with zero arguments: opens an unsaved
 * Markdown report (or shows a non-blocking info toast when no lanes are recorded).
 */
export async function runInspectExecutionLanes(deps: InspectExecutionLanesDeps): Promise<InspectExecutionLanesOutcome> {
  const trusted = deps.isWorkspaceTrusted();
  let snapshot: ReadOnlyLaneSnapshot;
  try {
    snapshot = await deps.readSnapshot({ allowLiveGit: trusted });
  } catch (error) {
    deps.logger.warn('execution-lane inspect failed', { code: errorCodeOf(error) });
    deps.ui.warn('Schegent: could not inspect execution lanes.');
    return { status: 'error', laneCount: 0, requestCount: 0, gitProbed: false };
  }

  if (snapshot.lanes.length === 0 && snapshot.requests.length === 0) {
    deps.ui.info(`Schegent: no execution lanes recorded for this workspace.${trusted ? '' : ' (Restricted Mode: live Git probe skipped)'}`);
    return { status: 'empty', laneCount: 0, requestCount: 0, gitProbed: snapshot.gitProbed };
  }

  const markdown = renderLaneInspectionMarkdown(snapshot, {
    trusted,
    generatedAtIso: new Date((deps.now ?? Date.now)()).toISOString()
  });
  try {
    await deps.ui.openMarkdownReport(markdown);
  } catch (error) {
    deps.logger.warn('execution-lane inspect: failed to open report', { code: errorCodeOf(error) });
    deps.ui.warn('Schegent: could not open the execution lanes inspection report.');
    return { status: 'error', laneCount: snapshot.lanes.length, requestCount: snapshot.requests.length, gitProbed: snapshot.gitProbed };
  }

  return { status: 'opened', laneCount: snapshot.lanes.length, requestCount: snapshot.requests.length, gitProbed: snapshot.gitProbed, markdown };
}

function buildLaneDisclosureLines(
  lane: LaneView,
  obs: LaneGitObservation | undefined,
  relatedRequests: readonly IntegrationRequestView[],
  snapshot: ReadOnlyLaneSnapshot
): string[] {
  const targetBranches = [...new Set(relatedRequests.map((r) => branchNameFromRef(r.targetRef)))];
  const branchSummary = targetBranches.length > 0 ? targetBranches.join(', ') : formatWorktreeBranch(obs);
  const candSummary = lane.currentCandidate === null ? 'none' : `${shortSha(lane.currentCandidate.commit)} (seq ${lane.currentCandidate.seq})`;
  const lines: string[] = [
    'Recorded lane state:',
    `  laneId: ${sanitizeDisplayToken(lane.laneId)}`,
    `  state: ${lane.state}`,
    `  stateReason: ${sanitizeDisplayToken(lane.stateReason)}`,
    `  pinned: ${lane.pinned ? 'yes' : 'no'}`,
    `  candidate: ${candSummary}`,
    `  sourceCommit: ${shortSha(lane.sourceCommit)}`,
    `  branchName: ${branchSummary}`,
    `  candidateRef: ${sanitizeDisplayToken(lane.candidateRef)}`,
    'Live observed Git state:',
    `  worktree: ${obs?.rootStatus ?? 'unavailable'} (registered=${formatBool(obs?.worktreeRegistered)}, locked=${formatBool(obs?.worktreeLocked)})`,
    `  dirty: ${formatDirtyStatus(obs)}`,
    `  HEAD: ${shortSha(obs?.headCommit)} (matches recorded: ${formatBool(obs?.headMatchesRecorded)})`
  ];
  if (relatedRequests.length > 0) {
    lines.push('Integration / journal state:');
    for (const req of relatedRequests) {
      const observedTip = latestObservedTip(snapshot.journalsByRequestId[req.requestId]);
      const liveTip = obs?.targetTips[req.targetRef] ?? snapshot.targetTips[req.targetRef] ?? null;
      lines.push(
        `  requestId: ${sanitizeDisplayToken(req.requestId)} (state=${req.state}, reason=${sanitizeDisplayToken(req.reason)})`,
        `  targetRef: ${sanitizeDisplayToken(req.targetRef)} (branch=${branchNameFromRef(req.targetRef)})`,
        `  expectedCommit: ${shortSha(req.expectedTargetCommit)}, candidateCommit: ${shortSha(req.candidateCommit)}, observedTip: ${shortSha(observedTip)}`,
        `  liveTargetTip: ${shortSha(liveTip)}`
      );
    }
  }
  return lines;
}

function buildActionDisclosure(params: {
  readonly action: LaneRecoveryAction;
  readonly lane?: LaneView;
  readonly request?: IntegrationRequestView;
  readonly targetLanes?: readonly LaneView[];
  readonly snapshot: ReadOnlyLaneSnapshot;
  readonly pin?: boolean;
}): LaneRecoveryDisclosure {
  const { action, lane, request, targetLanes, snapshot } = params;
  const lines: string[] = [];

  if (lane !== undefined) {
    const related = request !== undefined ? [request] : snapshot.requests.filter((r) => r.laneId === lane.laneId && OPEN_REQUEST_STATES.has(r.state));
    lines.push(...buildLaneDisclosureLines(lane, snapshot.gitByLaneId[lane.laneId], related, snapshot));
  } else if (request !== undefined) {
    lines.push(
      'Integration / journal state:',
      `  requestId: ${sanitizeDisplayToken(request.requestId)} (state=${request.state}, reason=${sanitizeDisplayToken(request.reason)})`,
      `  laneId: ${sanitizeDisplayToken(request.laneId)}`,
      `  targetRef: ${sanitizeDisplayToken(request.targetRef)} (branch=${branchNameFromRef(request.targetRef)})`,
      `  expectedCommit: ${shortSha(request.expectedTargetCommit)}`,
      `  candidateCommit: ${shortSha(request.candidateCommit)}`,
      `  observedTip: ${shortSha(latestObservedTip(snapshot.journalsByRequestId[request.requestId]))}`,
      'Live observed Git state:',
      `  liveTargetTip: ${shortSha(snapshot.targetTips[request.targetRef] ?? null)}`
    );
  }

  const laneToken = sanitizeDisplayToken(lane?.laneId);
  const reqToken = sanitizeDisplayToken(request?.requestId);
  const finalize = (summary: string, confirmLabel: string, effect: string): LaneRecoveryDisclosure => {
    lines.push('', `Effect: ${effect}`);
    return { action, summary, detail: lines.join('\n'), confirmLabel };
  };

  if (action === 'cleanup') {
    const scoped = targetLanes ?? snapshot.lanes.filter((l) => l.state === 'cleanup-eligible');
    lines.push(`Target lanes inspected for safe cleanup (${scoped.length}):`);
    for (const candidateLane of scoped) {
      const obs = snapshot.gitByLaneId[candidateLane.laneId];
      const openCount = snapshot.requests.filter((r) => r.laneId === candidateLane.laneId && OPEN_REQUEST_STATES.has(r.state)).length;
      lines.push(
        `  - ${sanitizeDisplayToken(candidateLane.laneId)}: state=${candidateLane.state}, stateReason=${sanitizeDisplayToken(candidateLane.stateReason)}, pinned=${candidateLane.pinned ? 'yes' : 'no'}, candidate=${shortSha(candidateLane.currentCandidate?.commit)}, branch=${formatWorktreeBranch(obs)}, worktree=${obs?.rootStatus ?? 'unavailable'}, dirty=${formatDirtyStatus(obs)}, HEAD=${shortSha(obs?.headCommit)}, openRequests=${openCount}`
      );
    }
    return finalize(
      `Run safe cleanup for ${scoped.length} execution lane(s)?`,
      'Run Safe Cleanup',
      'removes only clean, unpinned, unlocked, contained, registered cleanup-eligible worktrees with zero open requests. Dirty, pinned, live, locked, open-request, and unrelated worktrees are preserved, and frozen candidate refs remain intact.'
    );
  }

  if (action === 'reconcile') {
    const liveCount = snapshot.lanes.filter((l) => l.state === 'preparing' || l.state === 'active' || l.state === 'paused').length;
    const openReqs = snapshot.requests.filter((r) => OPEN_REQUEST_STATES.has(r.state));
    lines.push(`Recorded workspace lane summary: ${snapshot.lanes.length} total lane(s), ${liveCount} live lane(s), ${openReqs.length} open request(s).`);
    for (const entry of snapshot.lanes.filter((l) => l.state !== 'removed').slice(0, 12)) {
      const obs = snapshot.gitByLaneId[entry.laneId];
      lines.push(
        `  - ${sanitizeDisplayToken(entry.laneId)}: state=${entry.state}, reason=${sanitizeDisplayToken(entry.stateReason)}, pinned=${entry.pinned ? 'yes' : 'no'}, worktree=${obs?.rootStatus ?? 'unavailable'}, dirty=${formatDirtyStatus(obs)}, HEAD=${shortSha(obs?.headCommit)}`
      );
    }
    for (const req of openReqs.slice(0, 12)) {
      lines.push(
        `  - req ${sanitizeDisplayToken(req.requestId)}: state=${req.state}, target=${branchNameFromRef(req.targetRef)}, expected=${shortSha(req.expectedTargetCommit)}, candidate=${shortSha(req.candidateCommit)}, liveTip=${shortSha(snapshot.targetTips[req.targetRef] ?? null)}`
      );
    }
    return finalize(
      'Reconcile execution lanes for this workspace?',
      'Reconcile Lanes',
      'settles interrupted preparing/verifying/landing/cleanup operations from persisted state and read-only Git observations without replaying interrupted landings.'
    );
  }

  const copy: Record<Exclude<LaneRecoveryAction, 'cleanup' | 'reconcile'>, readonly [string, string, string]> = {
    'retry-freeze': [`Retry candidate freeze for lane ${laneToken}?`, 'Retry Candidate Freeze', 'retries Git plumbing candidate freezing on this active lane without invoking repository hooks or discarding worktree files.'],
    'acknowledge-uncertain': [`Acknowledge and close uncertain request ${reqToken}?`, 'Acknowledge Uncertain Request', 'marks this uncertain integration request canceled and appends an acknowledged-uncertain journal entry. Schegent NEVER automatically replays or retries an uncertain landing.'],
    'cancel-request': [`Cancel integration request ${reqToken}?`, 'Cancel Request', 'cancels this open integration request without altering Git branches or worktrees.'],
    'complete-and-retain': [`Complete and retain lane ${laneToken}?`, 'Complete & Retain Lane', `transitions the lane to completed (if active/paused) and retained${params.pin === true ? ' and pins it' : ''} so cleanup preserves its worktree.`],
    pin: [`Pin execution lane ${laneToken}?`, 'Pin Lane', 'pins this lane so cleanup will keep its worktree until unpinned.'],
    unpin: [`Unpin execution lane ${laneToken}?`, 'Unpin Lane', 'unpins this lane so future cleanup may remove it once cleanup-eligible and clean.'],
    'mark-cleanup-eligible': [`Mark execution lane ${laneToken} cleanup-eligible?`, 'Mark Cleanup-Eligible', 'marks this lane cleanup-eligible without immediately deleting its worktree. Safe cleanup later verifies unpinned, clean, unlocked, contained, and zero-open-request guards.']
  };
  const [summary, confirmLabel, effect] = copy[action];
  return finalize(summary, confirmLabel, effect);
}

function parseRecoverArgs(raw: unknown): RecoverExecutionLaneArgs | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { action, laneId, requestId, laneIds, completeAfterFreeze, pin } = raw as Record<string, unknown>;
  if (action !== undefined && (typeof action !== 'string' || !(LANE_RECOVERY_ACTIONS as readonly string[]).includes(action))) return null;
  if (laneId !== undefined && typeof laneId !== 'string') return null;
  if (requestId !== undefined && typeof requestId !== 'string') return null;
  if (laneIds !== undefined && (!Array.isArray(laneIds) || laneIds.some((id) => typeof id !== 'string'))) return null;
  if (completeAfterFreeze !== undefined && typeof completeAfterFreeze !== 'boolean') return null;
  if (pin !== undefined && typeof pin !== 'boolean') return null;
  return { action: action as LaneRecoveryAction | undefined, laneId, requestId, laneIds: laneIds as readonly string[] | undefined, completeAfterFreeze, pin };
}

function pickerItem(value: string, label: string, description: string, detail: string): LaneRecoveryPickerItem {
  return { value, label, description, detail };
}

function buildActionPickerItems({ lanes, requests }: ReadOnlyLaneSnapshot): readonly LaneRecoveryPickerItem[] {
  return [
    pickerItem('retry-freeze', 'Retry Failed Candidate Freeze', `${lanes.filter(isFreezeFailedLane).length} freeze-failed · ${lanes.filter((l) => l.state === 'active').length} active lane(s)`, 'Retry freezing an active lane worktree into a candidate commit and optionally complete the lane.'),
    pickerItem('acknowledge-uncertain', 'Acknowledge Uncertain Integration Request', `${requests.filter((r) => r.state === 'uncertain').length} uncertain request(s)`, 'Inspect expected/candidate/observed/live Git tips and cancel the uncertain request (never replays landing).'),
    pickerItem('cancel-request', 'Cancel Open Integration Request', `${requests.filter((r) => CANCELABLE_NON_UNCERTAIN_STATES.has(r.state)).length} queued/awaiting-review/blocked request(s)`, 'Cancel a queued, awaiting-review, or blocked integration request without changing Git.'),
    pickerItem('complete-and-retain', 'Complete and Retain Lane', `${lanes.filter((l) => COMPLETE_AND_RETAIN_STATES.has(l.state)).length} active/paused/completed lane(s)`, 'Complete an active or paused lane and move it to retained so cleanup keeps its worktree.'),
    pickerItem('pin', 'Pin Lane (Protect from Cleanup)', `${lanes.filter((l) => !l.pinned && l.state !== 'removed').length} unpinned lane(s)`, 'Pin a lane so safe cleanup never removes its worktree.'),
    pickerItem('unpin', 'Unpin Lane', `${lanes.filter((l) => l.pinned).length} pinned lane(s)`, 'Remove the cleanup pin from a pinned lane.'),
    pickerItem('mark-cleanup-eligible', 'Mark Lane Cleanup-Eligible', `${lanes.filter((l) => CLEANUP_ELIGIBLE_SOURCE_STATES.has(l.state)).length} completed/retained/preparation-failed lane(s)`, 'Transition a completed, retained, or preparation-failed lane to cleanup-eligible.'),
    pickerItem('cleanup', 'Safe Cleanup Eligible Lanes', `${lanes.filter((l) => l.state === 'cleanup-eligible').length} cleanup-eligible lane(s)`, 'Remove clean, unpinned, unlocked cleanup-eligible worktrees while preserving dirty/pinned/live/unrelated trees.'),
    pickerItem('reconcile', 'Reconcile Execution Lanes', `${lanes.length} lane(s) · ${requests.length} request(s)`, 'Settle interrupted preparing, verifying, landing, and cleanup operations from persisted state and Git.')
  ];
}

function lanePickerItem(lane: LaneView, obs: LaneGitObservation | undefined): LaneRecoveryPickerItem {
  const reasonPart = lane.stateReason !== null ? ` · ${sanitizeDisplayToken(lane.stateReason)}` : '';
  return pickerItem(
    lane.laneId,
    sanitizeDisplayToken(lane.laneId),
    `${lane.state}${reasonPart}${lane.pinned ? ' · pinned' : ''}`,
    `candidate=${shortSha(lane.currentCandidate?.commit)} · worktree=${obs?.rootStatus ?? 'unavailable'} · ${formatDirtyStatus(obs)} · HEAD=${shortSha(obs?.headCommit)}`
  );
}

function requestPickerItem(req: IntegrationRequestView, snapshot: ReadOnlyLaneSnapshot): LaneRecoveryPickerItem {
  const observed = latestObservedTip(snapshot.journalsByRequestId[req.requestId]);
  const liveTip = snapshot.targetTips[req.targetRef] ?? null;
  return pickerItem(
    req.requestId,
    sanitizeDisplayToken(req.requestId),
    `${req.state} · ${branchNameFromRef(req.targetRef)} · lane ${sanitizeDisplayToken(req.laneId).slice(0, 12)}`,
    `expected=${shortSha(req.expectedTargetCommit)} · candidate=${shortSha(req.candidateCommit)} · observed=${shortSha(observed)} · liveTip=${shortSha(liveTip)}`
  );
}

async function confirmBeforeMutation(ui: LaneRecoveryCommandUi, disclosure: LaneRecoveryDisclosure): Promise<boolean> {
  return await ui.confirmModal(disclosure.summary, disclosure.detail, disclosure.confirmLabel);
}

async function assertPrimaryAndTrustedBeforeMutation(
  deps: RecoverExecutionLaneDeps,
  action: LaneRecoveryAction,
  disclosure: LaneRecoveryDisclosure
): Promise<RecoverExecutionLaneOutcome | null> {
  if (deps.verifyPrimaryAndTrusted === undefined) return null;
  let allowed = false;
  try {
    allowed = await deps.verifyPrimaryAndTrusted();
  } catch (error) {
    deps.logger.warn('execution-lane recovery: authority re-check failed', { action, code: errorCodeOf(error) });
  }
  if (allowed) return null;
  deps.logger.warn('execution-lane recovery refused: lost trust or primacy before mutation', { action });
  return refuseOutcome(deps, action, 'ownership-superseded', disclosure, 'Schegent: recovery refused because this window is no longer the trusted primary owner.');
}

async function runAuthorizedLaneStep(
  deps: RecoverExecutionLaneDeps,
  action: LaneRecoveryAction,
  disclosure: LaneRecoveryDisclosure,
  refusalPrefix: string,
  mutate: () => LaneResult<LaneView>
): Promise<{ readonly ok: true; readonly value: LaneView } | { readonly ok: false; readonly outcome: RecoverExecutionLaneOutcome }> {
  const lost = await assertPrimaryAndTrustedBeforeMutation(deps, action, disclosure);
  if (lost !== null) return { ok: false, outcome: lost };
  const result = mutate();
  if (!result.ok) return { ok: false, outcome: refuseOutcome(deps, action, result.refusal.reason, disclosure, `${refusalPrefix} (${result.refusal.reason}).`) };
  return { ok: true, value: result.value };
}

function refuseOutcome(deps: RecoverExecutionLaneDeps, action: LaneRecoveryAction, reason: LaneRefusalReason, disclosure: LaneRecoveryDisclosure, message: string): RecoverExecutionLaneOutcome {
  deps.ui.warn(message);
  return { status: 'refused', action, reason, disclosure };
}

function errorOutcome(
  deps: RecoverExecutionLaneDeps,
  action: LaneRecoveryAction | undefined,
  error: unknown,
  disclosure: LaneRecoveryDisclosure | undefined,
  logEvent: string,
  userPrefix: string,
  context?: Record<string, unknown>
): RecoverExecutionLaneOutcome {
  const code = errorCodeOf(error);
  deps.logger.warn(logEvent, { ...(action !== undefined ? { action } : {}), ...context, code });
  deps.ui.error(`${userPrefix} (${code}).`);
  return { status: 'error', errorCode: code, ...(action !== undefined ? { action } : {}), ...(disclosure !== undefined ? { disclosure } : {}) };
}

async function executeReconcileAction(
  deps: RecoverExecutionLaneDeps,
  service: LaneService,
  snapshot: ReadOnlyLaneSnapshot
): Promise<RecoverExecutionLaneOutcome> {
  const disclosure = buildActionDisclosure({ action: 'reconcile', snapshot });
  if (!(await confirmBeforeMutation(deps.ui, disclosure))) return { status: 'canceled', action: 'reconcile', disclosure };
  const lost = await assertPrimaryAndTrustedBeforeMutation(deps, 'reconcile', disclosure);
  if (lost !== null) return lost;
  try {
    const reconciled = await service.reconcile();
    if (!reconciled.ok) {
      return refuseOutcome(deps, 'reconcile', reconciled.refusal.reason, disclosure, `Schegent: lane reconciliation refused (${reconciled.refusal.reason}).`);
    }
    deps.logger.info('execution-lane recovery: reconcile completed', {
      lanes: reconciled.value.lanes.length, requests: reconciled.value.requests.length, unknownWorktrees: reconciled.value.unknownWorktrees
    });
    deps.ui.info(
      `Schegent: reconciled execution lanes (${reconciled.value.lanes.length} lane update(s), ${reconciled.value.requests.length} request update(s), ${reconciled.value.unknownWorktrees} unrelated worktree(s) preserved).`
    );
    return { status: 'completed', action: 'reconcile', disclosure, reconcileReport: reconciled.value };
  } catch (error) {
    return errorOutcome(deps, 'reconcile', error, disclosure, 'execution-lane recovery: reconcile failed', 'Schegent: lane reconciliation failed');
  }
}

async function executeCleanupAction(
  deps: RecoverExecutionLaneDeps,
  service: LaneService,
  snapshot: ReadOnlyLaneSnapshot,
  args: RecoverExecutionLaneArgs
): Promise<RecoverExecutionLaneOutcome> {
  let selectedIds: readonly string[] | undefined = args.laneIds ?? (args.laneId !== undefined ? [args.laneId] : undefined);
  if (selectedIds === undefined && args.action === undefined) {
    const eligible = snapshot.lanes.filter((l) => l.state === 'cleanup-eligible');
    if (eligible.length === 0) {
      deps.ui.info('Schegent: no cleanup-eligible execution lanes found.');
      return { status: 'empty', action: 'cleanup' };
    }
    const items: LaneRecoveryPickerItem[] = [
      pickerItem('__all__', `All cleanup-eligible lanes (${eligible.length})`, 'Safe workspace-wide sweep', 'Preserves dirty, pinned, live, locked, open-request, and unrelated worktrees.'),
      ...eligible.map((l) => lanePickerItem(l, snapshot.gitByLaneId[l.laneId]))
    ];
    const picked = await deps.ui.pickItem(items, 'Schegent: Safe Cleanup Execution Lanes', 'Select cleanup-eligible lane(s) for safe removal');
    if (picked === undefined) return { status: 'canceled', action: 'cleanup' };
    selectedIds = picked.value === '__all__' ? undefined : [picked.value];
  }

  const targetLanes =
    selectedIds === undefined
      ? snapshot.lanes.filter((l) => l.state === 'cleanup-eligible')
      : selectedIds.flatMap((id) => {
          const match = snapshot.lanes.find((l) => l.laneId === id);
          return match === undefined ? [] : [match];
        });
  const disclosure = buildActionDisclosure({ action: 'cleanup', targetLanes, snapshot });
  if (!(await confirmBeforeMutation(deps.ui, disclosure))) return { status: 'canceled', action: 'cleanup', disclosure };
  const lost = await assertPrimaryAndTrustedBeforeMutation(deps, 'cleanup', disclosure);
  if (lost !== null) return lost;

  try {
    const cleaned = await service.cleanupLanes(selectedIds === undefined ? {} : { laneIds: selectedIds });
    if (!cleaned.ok) {
      return refuseOutcome(deps, 'cleanup', cleaned.refusal.reason, disclosure, `Schegent: lane cleanup refused (${cleaned.refusal.reason}).`);
    }
    const keptSummary = cleaned.value.kept
      .map((k) => `${sanitizeDisplayToken(k.laneId).slice(0, 12)}:${sanitizeDisplayToken(k.observation)}`)
      .join(', ');
    deps.logger.info('execution-lane recovery: cleanup completed', { removed: cleaned.value.removed.length, kept: cleaned.value.kept.length });
    const keptSuffix = keptSummary.length > 0 ? ` (${keptSummary})` : '';
    deps.ui.info(
      `Schegent: safe lane cleanup finished — removed ${cleaned.value.removed.length}, kept ${cleaned.value.kept.length}${keptSuffix}.`
    );
    return { status: 'completed', action: 'cleanup', disclosure, cleanupReport: cleaned.value };
  } catch (error) {
    return errorOutcome(deps, 'cleanup', error, disclosure, 'execution-lane recovery: cleanup failed', 'Schegent: lane cleanup failed');
  }
}

async function executeRequestAction(
  deps: RecoverExecutionLaneDeps,
  service: LaneService,
  snapshot: ReadOnlyLaneSnapshot,
  action: 'acknowledge-uncertain' | 'cancel-request',
  args: RecoverExecutionLaneArgs
): Promise<RecoverExecutionLaneOutcome> {
  const isUncertain = action === 'acknowledge-uncertain';
  let targetRequestId = args.requestId;
  if (targetRequestId === undefined) {
    const eligible = snapshot.requests.filter((r) => (isUncertain ? r.state === 'uncertain' : CANCELABLE_NON_UNCERTAIN_STATES.has(r.state)));
    if (eligible.length === 0) {
      deps.ui.info(isUncertain ? 'Schegent: no uncertain integration requests found.' : 'Schegent: no open cancelable integration requests found.');
      return { status: 'empty', action };
    }
    const picked = await deps.ui.pickItem(
      eligible.map((r) => requestPickerItem(r, snapshot)),
      isUncertain ? 'Schegent: Acknowledge Uncertain Integration Request' : 'Schegent: Cancel Open Integration Request',
      'Select the integration request to settle'
    );
    if (picked === undefined) return { status: 'canceled', action };
    targetRequestId = picked.value;
  }

  const request = snapshot.requests.find((r) => r.requestId === targetRequestId);
  const lane = request !== undefined ? snapshot.lanes.find((l) => l.laneId === request.laneId) : undefined;
  const disclosure = buildActionDisclosure({
    action,
    snapshot,
    ...(lane !== undefined ? { lane } : {}),
    ...(request !== undefined ? { request } : {})
  });
  if (request === undefined) return refuseOutcome(deps, action, 'request-not-found', disclosure, 'Schegent: integration request not found.');
  if (isUncertain && request.state !== 'uncertain') {
    return refuseOutcome(deps, action, 'request-state-invalid', disclosure, `Schegent: request ${sanitizeDisplayToken(request.requestId)} is '${request.state}', not 'uncertain'.`);
  }
  if (!(await confirmBeforeMutation(deps.ui, disclosure))) return { status: 'canceled', action, disclosure };
  const lost = await assertPrimaryAndTrustedBeforeMutation(deps, action, disclosure);
  if (lost !== null) return lost;

  const reqToken = sanitizeDisplayToken(targetRequestId);
  try {
    // Cancels request (writing `acknowledged-uncertain` when uncertain); NEVER replays uncertain landings.
    const canceled = service.cancelRequest({ requestId: targetRequestId });
    if (!canceled.ok) {
      return refuseOutcome(deps, action, canceled.refusal.reason, disclosure, `Schegent: request settlement refused (${canceled.refusal.reason}).`);
    }
    deps.logger.info('execution-lane recovery: request settled', { action, requestId: reqToken, state: canceled.value.state });
    deps.ui.info(
      isUncertain
        ? `Schegent: acknowledged and closed uncertain request ${reqToken} (journaled acknowledged-uncertain; landing was not replayed).`
        : `Schegent: canceled integration request ${reqToken}.`
    );
    return { status: 'completed', action, disclosure, request: canceled.value };
  } catch (error) {
    return errorOutcome(deps, action, error, disclosure, 'execution-lane recovery: request settlement failed', 'Schegent: request settlement failed', { requestId: reqToken });
  }
}

type LaneScopedAction = 'retry-freeze' | 'complete-and-retain' | 'pin' | 'unpin' | 'mark-cleanup-eligible';

function eligibleLanesForAction(snapshot: ReadOnlyLaneSnapshot, action: LaneScopedAction): LaneView[] {
  switch (action) {
    case 'retry-freeze':
      return [...snapshot.lanes.filter((l) => l.state === 'active')].sort((a, b) => (isFreezeFailedLane(a) ? 0 : 1) - (isFreezeFailedLane(b) ? 0 : 1));
    case 'complete-and-retain':
      return snapshot.lanes.filter((l) => COMPLETE_AND_RETAIN_STATES.has(l.state));
    case 'pin':
      return snapshot.lanes.filter((l) => !l.pinned && l.state !== 'removed');
    case 'unpin':
      return snapshot.lanes.filter((l) => l.pinned);
    case 'mark-cleanup-eligible':
      return snapshot.lanes.filter((l) => CLEANUP_ELIGIBLE_SOURCE_STATES.has(l.state));
  }
}

async function executeRetryFreeze(
  deps: RecoverExecutionLaneDeps,
  service: LaneService,
  targetLane: LaneView,
  disclosure: LaneRecoveryDisclosure,
  args: RecoverExecutionLaneArgs
): Promise<RecoverExecutionLaneOutcome> {
  const laneToken = sanitizeDisplayToken(targetLane.laneId);
  const lostBeforeFreeze = await assertPrimaryAndTrustedBeforeMutation(deps, 'retry-freeze', disclosure);
  if (lostBeforeFreeze !== null) return lostBeforeFreeze;
  try {
    const frozen = await service.freezeCandidate({ laneId: targetLane.laneId });
    if (!frozen.ok && frozen.refusal.reason !== 'candidate-empty') {
      try {
        service.recordFreezeFailure({ laneId: targetLane.laneId, reason: frozen.refusal.reason });
      } catch {
        // Keep lane active even if updating state_reason fails.
      }
      return refuseOutcome(deps, 'retry-freeze', frozen.refusal.reason, disclosure, `Schegent: candidate freeze retry refused (${frozen.refusal.reason}). Lane remains active.`);
    }
    const candidateEmpty = !frozen.ok;
    let shouldComplete = false;
    if (args.completeAfterFreeze !== false) {
      const prompt = candidateEmpty
        ? `No new changes to freeze for lane ${laneToken}. Complete lane now?`
        : `Candidate ${shortSha(frozen.value.commit)} frozen for lane ${laneToken}. Complete lane now?`;
      shouldComplete = await deps.ui.confirmModal(
        prompt,
        'Completing transitions the lane from active to completed and clears any prior freeze failure reason. Declining keeps the lane active.',
        'Complete Lane'
      );
    }
    let completedAfterFreeze = false;
    if (shouldComplete) {
      const lostBeforeComplete = await assertPrimaryAndTrustedBeforeMutation(deps, 'retry-freeze', disclosure);
      if (lostBeforeComplete !== null) return lostBeforeComplete;
      const completed = service.completeLane({ laneId: targetLane.laneId });
      if (!completed.ok) {
        return refuseOutcome(deps, 'retry-freeze', completed.refusal.reason, disclosure, `Schegent: candidate freeze succeeded, but completing lane refused (${completed.refusal.reason}).`);
      }
      completedAfterFreeze = true;
    }
    const refreshed = service.getLane({ laneId: targetLane.laneId });
    deps.logger.info('execution-lane recovery: retry-freeze completed', { laneId: laneToken, candidateEmpty, completedAfterFreeze });
    deps.ui.info(
      candidateEmpty
        ? `Schegent: lane ${laneToken} has no new changes to freeze${completedAfterFreeze ? ' and is now completed' : ''}.`
        : `Schegent: froze candidate ${shortSha(frozen.value.commit)} for lane ${laneToken}${completedAfterFreeze ? ' and marked lane completed' : ''}.`
    );
    return {
      status: 'completed',
      action: 'retry-freeze',
      disclosure,
      lane: refreshed.ok ? refreshed.value : targetLane,
      ...(frozen.ok ? { candidate: frozen.value } : {}),
      completedAfterFreeze,
      candidateEmpty
    };
  } catch (error) {
    const code =
      error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string'
        ? (error as NodeJS.ErrnoException).code!
        : 'freeze-exception';
    try {
      service.recordFreezeFailure({ laneId: targetLane.laneId, reason: code });
    } catch {
      // Keep lane active even if updating state_reason fails.
    }
    return errorOutcome(deps, 'retry-freeze', error, disclosure, 'execution-lane recovery: retry-freeze failed', 'Schegent: candidate freeze retry failed; lane remains active', { laneId: laneToken });
  }
}

async function executeLaneAction(
  deps: RecoverExecutionLaneDeps,
  service: LaneService,
  snapshot: ReadOnlyLaneSnapshot,
  action: LaneScopedAction,
  args: RecoverExecutionLaneArgs
): Promise<RecoverExecutionLaneOutcome> {
  let targetLaneId = args.laneId;
  if (targetLaneId === undefined) {
    const candidates = eligibleLanesForAction(snapshot, action);
    if (candidates.length === 0) {
      deps.ui.info(`Schegent: no eligible execution lanes found for '${action}'.`);
      return { status: 'empty', action };
    }
    const picked = await deps.ui.pickItem(
      candidates.map((l) => lanePickerItem(l, snapshot.gitByLaneId[l.laneId])),
      `Schegent: Recover Execution Lane (${action})`,
      'Select an execution lane'
    );
    if (picked === undefined) return { status: 'canceled', action };
    targetLaneId = picked.value;
  }

  const targetLane = snapshot.lanes.find((l) => l.laneId === targetLaneId);
  const disclosure = buildActionDisclosure({
    action,
    snapshot,
    ...(targetLane !== undefined ? { lane: targetLane } : {}),
    ...(args.pin !== undefined ? { pin: args.pin } : {})
  });
  if (targetLane === undefined) return refuseOutcome(deps, action, 'lane-not-found', disclosure, 'Schegent: execution lane not found.');
  if (!(await confirmBeforeMutation(deps.ui, disclosure))) return { status: 'canceled', action, disclosure };
  if (action === 'retry-freeze') return executeRetryFreeze(deps, service, targetLane, disclosure, args);

  const laneToken = sanitizeDisplayToken(targetLaneId);
  try {
    if (action === 'complete-and-retain') {
      let latestLane = targetLane;
      if (latestLane.state === 'active' || latestLane.state === 'paused') {
        const completed = await runAuthorizedLaneStep(deps, action, disclosure, 'Schegent: completing lane refused', () => service.completeLane({ laneId: targetLaneId }));
        if (!completed.ok) return completed.outcome;
        latestLane = completed.value;
      }
      const retained = await runAuthorizedLaneStep(deps, action, disclosure, 'Schegent: retaining lane refused', () => service.releaseLane({ laneId: targetLaneId, disposition: 'retain' }));
      if (!retained.ok) return retained.outcome;
      latestLane = retained.value;
      if (args.pin === true && !latestLane.pinned) {
        const pinned = await runAuthorizedLaneStep(deps, action, disclosure, 'Schegent: lane retained, but pinning refused', () => service.setLanePinned({ laneId: targetLaneId, pinned: true }));
        if (!pinned.ok) return pinned.outcome;
        latestLane = pinned.value;
      }
      deps.logger.info('execution-lane recovery: complete-and-retain completed', { laneId: laneToken, pinned: latestLane.pinned });
      deps.ui.info(`Schegent: lane ${laneToken} is now retained${latestLane.pinned ? ' and pinned' : ''}.`);
      return { status: 'completed', action, disclosure, lane: latestLane };
    }

    if (action === 'pin' || action === 'unpin') {
      const pinned = action === 'pin';
      const result = await runAuthorizedLaneStep(deps, action, disclosure, 'Schegent: updating lane pin refused', () => service.setLanePinned({ laneId: targetLaneId, pinned }));
      if (!result.ok) return result.outcome;
      deps.logger.info('execution-lane recovery: pin state updated', { laneId: laneToken, pinned });
      deps.ui.info(`Schegent: lane ${laneToken} is now ${pinned ? 'pinned' : 'unpinned'}.`);
      return { status: 'completed', action, disclosure, lane: result.value };
    }

    const released = await runAuthorizedLaneStep(deps, action, disclosure, 'Schegent: marking lane cleanup-eligible refused', () => service.releaseLane({ laneId: targetLaneId, disposition: 'eligible' }));
    if (!released.ok) return released.outcome;
    deps.logger.info('execution-lane recovery: marked cleanup-eligible', { laneId: laneToken });
    deps.ui.info(`Schegent: lane ${laneToken} is now cleanup-eligible.`);
    return { status: 'completed', action, disclosure, lane: released.value };
  } catch (error) {
    return errorOutcome(deps, action, error, disclosure, `execution-lane recovery: ${action} failed`, `Schegent: lane recovery (${action}) failed`, { laneId: laneToken });
  }
}

/**
 * Runs `schegent.recoverExecutionLane`. Must be registered through `registerGuardedCommand` so
 * Restricted Mode and secondary windows refuse at the point of effect before reaching this handler.
 */
export async function runRecoverExecutionLane(deps: RecoverExecutionLaneDeps, rawArgs?: unknown): Promise<RecoverExecutionLaneOutcome> {
  const args = parseRecoverArgs(rawArgs);
  if (args === null) {
    deps.ui.warn('Schegent: invalid execution lane recovery arguments.');
    return { status: 'invalid-args' };
  }

  let service: LaneService | null;
  try {
    service = await deps.getLaneService();
  } catch (error) {
    return errorOutcome(deps, args.action, error, undefined, 'execution-lane recovery: lane service unavailable', 'Schegent: could not access execution lane service');
  }
  if (service === null) {
    deps.ui.warn('Schegent: execution lane service is unavailable in this window.');
    return { status: 'unavailable' };
  }

  let snapshot: ReadOnlyLaneSnapshot;
  try {
    snapshot = await readLaneSnapshotFromService(service, { allowLiveGit: true });
  } catch (error) {
    return errorOutcome(deps, args.action, error, undefined, 'execution-lane recovery: snapshot read failed', 'Schegent: could not read execution lane state');
  }

  let action = args.action;
  if (action === undefined) {
    const pickedAction = await deps.ui.pickItem(
      buildActionPickerItems(snapshot),
      'Schegent: Recover Execution Lane',
      'Select a guarded execution-lane recovery action'
    );
    if (pickedAction === undefined) return { status: 'canceled' };
    action = pickedAction.value as LaneRecoveryAction;
  }

  if (action === 'reconcile') return executeReconcileAction(deps, service, snapshot);
  if (action === 'cleanup') return executeCleanupAction(deps, service, snapshot, args);
  if (action === 'acknowledge-uncertain' || action === 'cancel-request') {
    return executeRequestAction(deps, service, snapshot, action, args);
  }
  return executeLaneAction(deps, service, snapshot, action, args);
}
