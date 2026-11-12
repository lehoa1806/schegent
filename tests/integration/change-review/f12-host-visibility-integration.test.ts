/**
 * FR-R6-F12, F10, F13, F14, F15 — host integration test for execution visibility, immutable
 * candidate change review (`schegent-review` editor opening, staleness classification, paging,
 * cancellation), runtime OTLP/lane posture, and manual phase-context handoff edit/approve through
 * `MessageRouter`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChangeEntry, ReviewOpened } from '../../../src/contracts/change-review';
import {
  CMD_DECIDE_PHASE_HANDOFF,
  CMD_OPEN_CHANGE_REVIEW,
  CMD_READ_EXECUTION_VISIBILITY,
  type DecidePhaseHandoffRequest,
  type DecidePhaseHandoffResponse,
  type OpenChangeReviewRequest,
  type OpenChangeReviewResponse,
  type ReadExecutionVisibilityRequest,
  type ReadExecutionVisibilityResponse
} from '../../../src/contracts/sidebar-ipc';
import {
  isValidDecidePhaseHandoffResponse,
  isValidOpenChangeReviewResponse,
  isValidReadExecutionVisibilityResponse
} from '../../../src/contracts/runtime-validators';
import { createChangeReviewApi } from '../../../src/headless/change-review-api';
import { createExecutionVisibilityApi } from '../../../src/headless/execution-visibility-api';
import { createPhaseContextApi } from '../../../src/headless/phase-context-api';
import {
  createChangeReviewService,
  integrationStoreSource
} from '../../../src/services/change-review';
import { comparisonRevision } from '../../../src/services/change-review/comparison-revision';
import type { GitRunResult, LaneGitRunner } from '../../../src/services/execution-lanes/git-runner';
import { IntegrationStore } from '../../../src/services/execution-lanes/integration-store';
import { createAcceptanceService } from '../../../src/services/phase-context/acceptance';
import {
  buildManifest,
  manifestDigestOf,
  serializeManifest
} from '../../../src/services/phase-context/manifest';
import { createPhaseHandoffCoordinator } from '../../../src/services/phase-context/phase-handoff-coordinator';
import { renderContext } from '../../../src/services/phase-context/renderer';
import { createSqliteHandoffStore } from '../../../src/services/phase-context/sqlite-handoff-store';
import {
  NodeSqliteConnection,
  SchemaBootstrapService,
  type SqliteApplicationStore
} from '../../../src/services/sqlite-store';
import { SECONDARY_REJECT, UNTRUSTED_REJECT } from '../../../src/ui/sidebar/commands/constants';
import type { RouterDeps } from '../../../src/ui/sidebar/commands/router-types';
import { MessageRouter } from '../../../src/ui/sidebar/message-router';
import type { CommandAckMessage, SidebarCommand } from '../../../src/ui/sidebar/messages';
import { openReviewInEditor } from '../../../src/ui/change-review/review-opener';

const SCOPE_ID = 'ws-f12-int';
const NOW_MS = 1_800_000_000_000;
const LANE_ID = '1'.repeat(32);
const REPO_ID = '2'.repeat(64);
const CANDIDATE_ID = '3'.repeat(32);
const REQUEST_ID = '4'.repeat(32);
const TARGET_COMMIT = 'a'.repeat(40);
const MOVED_TARGET = 'b'.repeat(40);
const CANDIDATE_COMMIT = 'c'.repeat(40);
const PROFILE_DIGEST = 'd'.repeat(64);
const BLOB_OLD = 'e'.repeat(40);
const BLOB_NEW = 'f'.repeat(40);
const NULL_SHA = '0'.repeat(40);
const Z = '\u0000';

const DIFF_INVENTORY =
  `:000000 100644 ${NULL_SHA} ${BLOB_NEW} A${Z}src/new-feature.ts${Z}` +
  `:100644 100644 ${BLOB_OLD} ${BLOB_NEW} M${Z}src/existing.ts${Z}` +
  `10\t0\tsrc/new-feature.ts${Z}3\t2\tsrc/existing.ts${Z}`;

describe('FR-R6-F12 & F15 host visibility, change review, and manual handoff integration', () => {
  let conn: NodeSqliteConnection;
  let trusted: boolean;
  let primary: boolean;
  let targetTip: string;
  let multiDiffCalls: number;
  let router: MessageRouter;
  let handoffId: string;
  let corrSeq: number;

  beforeEach(() => {
    conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW_MS);

    trusted = true;
    primary = true;
    targetTip = TARGET_COMMIT;
    multiDiffCalls = 0;
    corrSeq = 0;

    const fakeSqliteStore = {
      writerConnection: conn
    } as unknown as SqliteApplicationStore;

    // Seed run + attempt + isolated lane + integration request
    conn.run(
      `INSERT INTO runs (
        run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
        current_step_id, started_at_ms, completed_at_ms, terminal_reason,
        created_at_ms, updated_at_ms, backend_kind, model_id, profile_id, lane_id, invocation_count
      ) VALUES ('run-vis-1', ?, 'wf-review', 'fc-vis-1', 'paused', 1, NULL, ?, NULL, NULL, ?, ?, 'claude', 'claude-sonnet-4-6', 'claude-acp', ?, 1)`,
      SCOPE_ID,
      NOW_MS - 5_000,
      NOW_MS - 5_000,
      NOW_MS - 1_000,
      LANE_ID
    );
    conn.run(
      `INSERT INTO steps (step_id, run_id, step_index, phase_id, status, revision, current_attempt_id, updated_at_ms)
       VALUES ('step-vis-0', 'run-vis-1', 0, 'implement', 'succeeded', 1, 'att-vis-1', ?)`,
      NOW_MS - 1_000
    );
    conn.run(
      `INSERT INTO attempts (
        attempt_id, run_id, step_id, attempt_number, status, exit_code,
        started_at_ms, completed_at_ms, backend_kind, model_id, profile_id, lane_id, failure_cause
      ) VALUES ('att-vis-1', 'run-vis-1', 'step-vis-0', 1, 'running', NULL, ?, NULL, 'claude', 'claude-sonnet-4-6', 'claude-acp', ?, NULL)`,
      NOW_MS - 4_000,
      LANE_ID
    );

    // Seed F05 degraded evidence + F07 partial live log + F08 uncertain recovery handoff + F13 awaiting-permission ACP
    conn.run(
      `INSERT INTO artifacts (artifact_id, content_sha256, byte_length, media_type, kind, created_by_run_id, created_by_attempt_id, created_at_ms)
       VALUES ('art-vis-1', ?, 256, 'text/plain', 'transcript', 'run-vis-1', 'att-vis-1', ?)`,
      '1'.repeat(64),
      NOW_MS - 3_000
    );
    conn.run(
      `INSERT INTO artifact_lifecycle (
        artifact_id, lifecycle_revision, owner_run_id, owner_attempt_id, sensitivity,
        retention_class, store_kind, immutability, digest_algorithm, digest_value,
        generation, extent_bytes, byte_size, availability, producer_identity,
        display_name, created_at_ms, terminal_settled_at_ms, expires_at_ms, updated_at_ms
      ) VALUES (
        'art-vis-1', 1, 'run-vis-1', 'att-vis-1', 'content',
        'transcripts-diagnostics-checkpoints-audit-catalog', 'transcript', 'immutable', 'sha256', ?,
        NULL, NULL, 256, 'expired', 'runner', 'transcript.log', ?, NULL, ?, ?
      )`,
      '1'.repeat(64),
      NOW_MS - 3_000,
      NOW_MS - 100,
      NOW_MS - 100
    );

    conn.run(
      `INSERT INTO live_log_streams (stream_key, generation, capture_mode, created_at_ms, updated_at_ms)
       VALUES ('run-vis-1:step-0', 'gen-1', 'captured', ?, ?)`,
      NOW_MS - 3_000,
      NOW_MS - 1_000
    );
    conn.run(
      `INSERT INTO live_log_segments (segment_id, stream_key, generation, segment_seq, artifact_ref, start_offset, end_offset, record_count, durable)
       VALUES (?, 'run-vis-1:step-0', 'gen-1', 0, 'seg-0', 0, 128, 4, 1)`,
      '9'.repeat(64)
    );
    conn.run(
      `INSERT INTO live_log_coverage (coverage_id, stream_key, generation, reason, from_offset, to_offset, count, recorded_at_ms)
       VALUES ('cov-1', 'run-vis-1:step-0', 'gen-1', 'transport-gap', 128, 256, 2, ?)`,
      NOW_MS - 900
    );

    const recoveryHandoffId = '8'.repeat(64);
    conn.run(
      `INSERT INTO recovery_handoffs (
        handoff_id, workspace_id, root_execution_id, invocation_id, source_attempt_id,
        state, paused, closed_reason, current_revision, pin_purpose, pin_purpose_target,
        legacy_provenance, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'run-vis-1', 'inv-1', 'att-vis-1', 'uncertain', 1, NULL, 1, 'uncertain-recovery', NULL, NULL, ?, ?)`,
      recoveryHandoffId,
      SCOPE_ID,
      NOW_MS - 800,
      NOW_MS - 800
    );
    conn.run(
      `INSERT INTO recovery_handoff_revisions (
        handoff_id, revision_no, status, cutoff_key, execution_revision, usage_revision,
        fact_cutoff_ms, manifest_version, manifest_json, manifest_digest, certainty, coverage,
        issued_at_ms, superseded_at_ms
      ) VALUES (?, 1, 'issued', ?, 'exec-r1', 1, ?, 1, '{}', ?, 'uncertain', 'partial', ?, NULL)`,
      recoveryHandoffId,
      '7'.repeat(64),
      NOW_MS - 800,
      '6'.repeat(64),
      NOW_MS - 800
    );

    conn.run(
      `INSERT INTO acp_observation_ledger (
        observation_key, profile_id, connection_generation, host_receive_seq,
        acp_session_id, turn_id, attempt_id, origin, kind, payload_sha256, observed_at_ms
      ) VALUES ('obs-perm-1', 'claude-acp', 1, 1, 'sess-v1', 'turn-v1', 'att-vis-1', 'live', 'permission-requested', ?, ?)`,
      '5'.repeat(64),
      NOW_MS - 500
    );

    // Seed F10 lane + candidate + integration request
    conn.run(
      `INSERT INTO execution_lanes (
        lane_id, workspace_id, repository_id, root_execution_id, source_commit, base_ref,
        candidate_ref, root_ref, dependency_recipe, state, state_reason, pinned, owner_generation, created_at, updated_at
      ) VALUES (?, ?, ?, 'run-vis-1', ?, 'refs/heads/main', 'refs/schegent/cand-1', 'lanes/lane-1', 'none', 'completed', NULL, 0, 1, '2026-11-11T00:00:00.000Z', '2026-11-11T00:01:00.000Z')`,
      LANE_ID,
      SCOPE_ID,
      REPO_ID,
      TARGET_COMMIT
    );
    conn.run(
      `INSERT INTO lane_candidates (
        candidate_id, lane_id, candidate_seq, commit_sha, tree_sha, parent_sha, owner_generation, frozen_at
      ) VALUES (?, ?, 1, ?, ?, ?, 1, '2026-11-11T00:01:00.000Z')`,
      CANDIDATE_ID,
      LANE_ID,
      CANDIDATE_COMMIT,
      '9'.repeat(40),
      TARGET_COMMIT
    );
    conn.run(
      `INSERT INTO lane_integration_requests (
        request_id, lane_id, workspace_id, repository_id, candidate_id, candidate_commit,
        target_ref, expected_target_commit, profile_id, profile_revision, profile_digest,
        profile_json, state, reason, verification_attempt, owner_generation, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'refs/heads/main', ?, 'default', 1, ?, '{}', 'awaiting-review', NULL, 1, 1, '2026-11-11T00:02:00.000Z', '2026-11-11T00:02:00.000Z')`,
      REQUEST_ID,
      LANE_ID,
      SCOPE_ID,
      REPO_ID,
      CANDIDATE_ID,
      CANDIDATE_COMMIT,
      TARGET_COMMIT,
      PROFILE_DIGEST
    );

    // Seed F14 telemetry export ledger
    conn.run(
      `INSERT INTO telemetry_export_ledger (record_kind, record_id, revision, profile_id, mapping_revision, state, updated_at_ms)
       VALUES ('run', 'run-vis-1', 1, 'otlp-local', 1, 'exported', ?)`,
      NOW_MS - 200
    );

    // Seed F15 manual-approval handoff + review-loop ledger
    const handoffStore = createSqliteHandoffStore(conn, () => NOW_MS);
    const producerRef = {
      nodePath: 'implement',
      occurrenceId: 'occ-imp-1',
      attemptId: 'att-vis-1'
    };
    const manifest = buildManifest({
      revision: 1,
      previousRevision: null,
      origin: 'selected',
      identity: {
        workspaceId: SCOPE_ID,
        rootExecutionId: 'run-vis-1',
        sourceInvocationId: 'frame-vis-1',
        targetNodePath: 'verify',
        targetOccurrenceId: 'occ-verify-1',
        inputEnvelopeRevision: 1,
        sourceAttempts: [producerRef]
      },
      policyDigest: 'a'.repeat(64),
      approval: 'manual',
      session: 'fresh',
      cutoffSequence: 1,
      targetInstructionsDigest: 'b'.repeat(64),
      renderedBytesMax: 32 * 1024,
      sources: [
        {
          producer: producerRef,
          acceptedSequence: 1,
          coverage: 'complete',
          required: true,
          selectedBy: { kind: 'selector', id: 'sel-imp' },
          outcomes: ['Built candidate'],
          decisions: [],
          constraints: [],
          unresolvedIssues: [],
          summary: 'Initial automated implementation summary',
          artifacts: []
        }
      ],
      omissions: [],
      omissionsUnlisted: 0
    });
    handoffId = manifest.handoffId;
    handoffStore.bindRunMetadata(handoffId, {
      runId: 'run-vis-1',
      sourceAttemptId: 'att-vis-1',
      targetPhaseId: 'verify',
      laneId: LANE_ID
    });
    const serialized = serializeManifest(manifest);
    const acceptRes = createAcceptanceService(handoffStore).accept({
      manifest,
      serialized,
      manifestDigest: manifestDigestOf(serialized),
      rendered: renderContext(manifest)
    });
    if (!acceptRes.ok) throw new Error(`failed to seed handoff: ${acceptRes.failure}`);

    conn.run(
      `INSERT INTO phase_review_loop_ledgers (loop_id, run_id, node_id, iteration, verdict, ledger_json, updated_at_ms)
       VALUES ('loop-vis-1', 'run-vis-1', 'security-review', 1, 'needs-fixes', ?, ?)`,
      JSON.stringify({
        schemaVersion: 1,
        candidateRef: CANDIDATE_ID,
        snapshot: { findings: [{ status: 'open' }, { status: 'resolved' }] }
      }),
      NOW_MS - 100
    );

    const coordinator = createPhaseHandoffCoordinator({
      store: handoffStore,
      primaryWorkspaceRoot: '/workspace',
      workspaceId: SCOPE_ID
    });
    const phaseContextApi = createPhaseContextApi(() => coordinator);

    const scriptedGit: LaneGitRunner = {
      run: (args): Promise<GitRunResult> => {
        const verb = args.at(0) ?? '';
        if (verb === 'rev-parse') {
          const rev = args.at(3) ?? '';
          if (rev.startsWith('refs/heads/')) {
            return Promise.resolve({ ok: true, stdout: `${targetTip}\n` });
          }
          return Promise.resolve({ ok: true, stdout: `${rev.slice(0, -'^{commit}'.length)}\n` });
        }
        if (verb === 'merge-base') return Promise.resolve({ ok: true, stdout: '' });
        if (verb === 'diff-tree') return Promise.resolve({ ok: true, stdout: DIFF_INVENTORY });
        if (verb === 'cat-file') {
          return Promise.resolve({ ok: true, stdout: `content for ${args.at(2) ?? ''}\n` });
        }
        return Promise.resolve({ ok: false, exitCode: 128, code: 'exit' });
      }
    };

    const integrationStore = new IntegrationStore(conn);
    const changeReviewService = createChangeReviewService({
      source: integrationStoreSource(integrationStore, SCOPE_ID),
      git: scriptedGit,
      cwd: '/workspace',
      clock: () => new Date(NOW_MS)
    });
    const changeReviewApi = createChangeReviewApi(changeReviewService, {
      isWorkspaceTrusted: () => trusted
    });

    const executionVisibility = createExecutionVisibilityApi({
      scopeId: SCOPE_ID,
      getSqliteStore: () => fakeSqliteStore,
      getPhaseContextApi: () => phaseContextApi,
      getTelemetryHost: () => null,
      isLanesEnabled: () => true
    });

    const fakeEditorPort = {
      hasCommand: async (): Promise<boolean> => true,
      openChanges: async (): Promise<void> => {
        multiDiffCalls += 1;
      },
      showNotice: (): void => undefined,
      pick: async (): Promise<number | undefined> => undefined,
      openDiff: async (): Promise<void> => undefined
    };

    const deps = {
      executeCommand: vi.fn(async () => undefined),
      isPrimary: () => primary,
      isTrusted: () => trusted,
      notifyWarning: vi.fn(),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (s: string) => s
      },
      executionVisibility,
      changeReviewApi: () => changeReviewApi,
      openReviewInEditor: (opened: ReviewOpened, entries: readonly ChangeEntry[]) =>
        openReviewInEditor(fakeEditorPort, opened, entries),
      phaseContextApi: () => phaseContextApi
    } as unknown as RouterDeps;

    router = new MessageRouter(deps);
  });

  afterEach(() => {
    conn.close();
  });

  async function dispatchVisibility(
    payload: ReadExecutionVisibilityRequest
  ): Promise<CommandAckMessage> {
    const acks: CommandAckMessage[] = [];
    corrSeq += 1;
    const cmd: SidebarCommand = {
      type: CMD_READ_EXECUTION_VISIBILITY,
      correlationId: `vis-${payload.op}-${String(corrSeq)}`,
      payload
    };
    await router.dispatch(cmd, async (ack) => {
      acks.push(ack);
      return true;
    });
    const first = acks.at(0);
    if (first === undefined) throw new Error('missing ack');
    return first;
  }

  async function dispatchChangeReview(
    payload: OpenChangeReviewRequest
  ): Promise<CommandAckMessage> {
    const acks: CommandAckMessage[] = [];
    corrSeq += 1;
    const cmd: SidebarCommand = {
      type: CMD_OPEN_CHANGE_REVIEW,
      correlationId: `cr-${payload.op}-${String(corrSeq)}`,
      payload
    };
    await router.dispatch(cmd, async (ack) => {
      acks.push(ack);
      return true;
    });
    const first = acks.at(0);
    if (first === undefined) throw new Error('missing ack');
    return first;
  }

  async function dispatchHandoff(payload: DecidePhaseHandoffRequest): Promise<CommandAckMessage> {
    const acks: CommandAckMessage[] = [];
    corrSeq += 1;
    const cmd: SidebarCommand = {
      type: CMD_DECIDE_PHASE_HANDOFF,
      correlationId: `ho-${payload.op}-${String(corrSeq)}`,
      payload
    };
    await router.dispatch(cmd, async (ack) => {
      acks.push(ack);
      return true;
    });
    const first = acks.at(0);
    if (first === undefined) throw new Error('missing ack');
    return first;
  }

  it('projects execution visibility and runtime posture with separate evidence availability vs recovery certainty (F12-AC-01..04)', async () => {
    const detailAck = await dispatchVisibility({
      op: 'attemptDetail',
      rootExecutionId: 'run-vis-1'
    });
    expect(detailAck.status).toBe('accepted');
    expect(isValidReadExecutionVisibilityResponse(detailAck.result)).toBe(true);
    const detailRes = detailAck.result as Extract<
      ReadExecutionVisibilityResponse,
      { readonly op: 'attemptDetail' }
    >;
    const d = detailRes.detail;

    expect(d.available).toBe(true);
    expect(d.hierarchy.attemptCount).toBe(1);
    expect(d.hierarchy.dataQuality).toBe('partial');
    expect(d.evidence.at(0)?.availability).toBe('expired');
    expect(d.liveLog.streamState).toBe('partial');
    expect(d.liveLog.gapCount).toBe(1);
    expect(d.recovery.posture).toBe('uncertain');
    expect(d.acp.runtimeState).toBe('awaiting-permission');
    expect(d.acp.pendingPermissions).toBe(1);
    expect(d.lane.mode).toBe('isolated-lane');
    expect(d.lane.integrationRequestId).toBe(REQUEST_ID);
    expect(d.handoffs).toHaveLength(1);
    expect(d.reviewLoops.at(0)?.openFindings).toBe(1);
    expect(d.reviewLoops.at(0)?.resolvedFindings).toBe(1);

    const postureAck = await dispatchVisibility({ op: 'runtimePosture' });
    expect(postureAck.status).toBe('accepted');
    expect(isValidReadExecutionVisibilityResponse(postureAck.result)).toBe(true);
    const postureRes = postureAck.result as Extract<
      ReadExecutionVisibilityResponse,
      { readonly op: 'runtimePosture' }
    >;
    expect(postureRes.posture.available).toBe(true);
    expect(postureRes.posture.lanes.enabled).toBe(true);
    expect(postureRes.posture.lanes.pendingIntegrations).toBe(1);
    expect(postureRes.posture.telemetry.exportedCopyCount).toBe(1);
  });

  it('opens immutable candidate reviews at pinned revisions, launches editor diffs, detects stale targets, and closes cleanly (F12-AC-05..09)', async () => {
    const expectedRev = comparisonRevision({
      candidateCommit: CANDIDATE_COMMIT,
      targetRef: 'refs/heads/main',
      targetCommit: TARGET_COMMIT,
      profileRevision: 1,
      profileDigest: PROFILE_DIGEST
    });

    // Stale expectedRevision is refused before opening
    const mismatchAck = await dispatchChangeReview({
      op: 'open',
      requestId: REQUEST_ID,
      expectedRevision: `cr1-${'0'.repeat(64)}`
    });
    expect(mismatchAck.status).toBe('rejected');

    // Valid open with openInEditor: true opens VS Code multi-diff
    const openAck = await dispatchChangeReview({
      op: 'open',
      requestId: REQUEST_ID,
      expectedRevision: expectedRev,
      openInEditor: true
    });
    expect(openAck.status).toBe('accepted');
    expect(isValidOpenChangeReviewResponse(openAck.result)).toBe(true);
    expect(multiDiffCalls).toBe(1);

    const openRes = openAck.result as Extract<OpenChangeReviewResponse, { readonly op: 'open' }>;
    if (!openRes.result.ok || openRes.result.value.state === 'unavailable') {
      throw new Error('expected current review');
    }
    expect(openRes.editor.mode).toBe('native');
    expect(openRes.editor.opened).toBe(2);
    const reviewId = openRes.result.value.review.reviewId;
    expect(openRes.result.value.review.state).toBe('current');

    // Move target branch -> classify reports stale (`target-advanced`)
    targetTip = MOVED_TARGET;
    const classifyAck = await dispatchChangeReview({ op: 'classify', reviewId });
    expect(classifyAck.status).toBe('accepted');
    const classifyRes = classifyAck.result as Extract<
      OpenChangeReviewResponse,
      { readonly op: 'classify' }
    >;
    if (!classifyRes.result.ok) throw new Error('expected classify');
    expect(classifyRes.result.value.state).toBe('stale');
    expect(classifyRes.result.value.reason).toBe('target-advanced');

    // Close & cancelOpen release host state
    const closeAck = await dispatchChangeReview({ op: 'close', reviewId });
    expect(closeAck.status).toBe('accepted');
    const cancelAck = await dispatchChangeReview({ op: 'cancelOpen' });
    expect(cancelAck.status).toBe('accepted');

    // Untrusted & secondary window gating on CMD_OPEN_CHANGE_REVIEW
    trusted = false;
    const untrustedAck = await dispatchChangeReview({ op: 'open', requestId: REQUEST_ID });
    expect(untrustedAck.status).toBe('rejected');
    expect(untrustedAck.reason).toBe(UNTRUSTED_REJECT);

    trusted = true;
    primary = false;
    const secondaryAck = await dispatchChangeReview({ op: 'open', requestId: REQUEST_ID });
    expect(secondaryAck.status).toBe('rejected');
    expect(secondaryAck.reason).toBe(SECONDARY_REJECT);
  });

  it('edits and approves waiting manual phase-context handoffs with revision CAS (F15-FR-12, FR-15)', async () => {
    // Edit revision 1 -> creates revision 2 (superseding revision 1)
    const editAck = await dispatchHandoff({
      op: 'edit',
      handoffId,
      baseRevision: 1,
      replacementSources: [
        {
          producer: { nodePath: 'implement', occurrenceId: 'occ-imp-1', attemptId: 'att-vis-1' },
          acceptedSequence: 1,
          coverage: 'complete',
          required: true,
          selectedBy: { kind: 'selector', id: 'sel-imp' },
          outcomes: ['Curated outcome'],
          decisions: [],
          constraints: [],
          unresolvedIssues: [],
          summary: 'Operator-reviewed summary for verify phase',
          artifacts: []
        }
      ]
    });
    expect(editAck.status).toBe('accepted');
    expect(isValidDecidePhaseHandoffResponse(editAck.result)).toBe(true);
    const editRes = editAck.result as Extract<DecidePhaseHandoffResponse, { readonly op: 'edit' }>;
    if (!editRes.result.ok) throw new Error('expected edit ok');
    expect(editRes.result.revision.revision).toBe(2);

    // Approving stale revision 1 fails CAS
    const staleApproveAck = await dispatchHandoff({
      op: 'approve',
      handoffId,
      expectedRevision: 1,
      decisionId: 'dec-stale-1'
    });
    expect(staleApproveAck.status).toBe('rejected');

    // Approving active revision 2 succeeds
    const approveAck = await dispatchHandoff({
      op: 'approve',
      handoffId,
      expectedRevision: 2,
      decisionId: 'dec-valid-2'
    });
    expect(approveAck.status).toBe('accepted');
    expect(isValidDecidePhaseHandoffResponse(approveAck.result)).toBe(true);
  });
});
