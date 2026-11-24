/**
 * FR-R6-F12, F10, F13, F14, F15 — host integration test for execution visibility, immutable
 * candidate change review (`schegent-review` editor opening, staleness classification, paging,
 * cancellation), runtime OTLP/lane posture, and manual phase-context handoff edit/approve through
 * `MessageRouter`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AcpObservation } from '../../../src/contracts/acp-runtime';
import type { ChangeEntry, ReviewOpened } from '../../../src/contracts/change-review';
import { TELEMETRY_EXPORT_BOUNDS, type TelemetryTransport } from '../../../src/contracts/telemetry-export';
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
import { createSqliteAcpDurableRuntimeStore } from '../../../src/services/acp-runtime/acp-durable-runtime-store';
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
import { createTelemetryHostService } from '../../../src/services/telemetry-host/telemetry-host-service';
import { SECONDARY_REJECT, UNTRUSTED_REJECT } from '../../../src/ui/sidebar/commands/constants';
import type { RouterDeps } from '../../../src/ui/sidebar/commands/router-types';
import { MessageRouter } from '../../../src/ui/sidebar/message-router';
import type { CommandAckMessage, SidebarCommand } from '../../../src/ui/sidebar/messages';
import { openReviewInEditor, type EditorPort } from '../../../src/ui/change-review/review-opener';

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

  it('scopes multi-attempt runs by attemptId and invocationId without SQL LIKE prefix or wildcard bleed (R7-17-03)', async () => {
    const multiRunId = 'run_vis_multi';
    // Seed target multi-attempt run + sibling wildcard/prefix collision runs (`runXvis_multi`, `run_vis_multi2`)
    for (const [id, status] of [
      [multiRunId, 'running'],
      ['runXvis_multi', 'succeeded'],
      ['run_vis_multi2', 'succeeded']
    ] as const) {
      conn.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
          current_step_id, started_at_ms, completed_at_ms, terminal_reason,
          created_at_ms, updated_at_ms, backend_kind, model_id, profile_id, lane_id, invocation_count
        ) VALUES (?, ?, 'wf-multi', 'fc-multi', ?, 1, NULL, ?, NULL, NULL, ?, ?, 'claude', 'claude-sonnet-4-6', 'claude-acp', NULL, 2)`,
        id,
        SCOPE_ID,
        status,
        NOW_MS - 10_000,
        NOW_MS - 10_000,
        NOW_MS - 1_000
      );
    }

    conn.run(
      `INSERT INTO steps (step_id, run_id, step_index, phase_id, status, revision, current_attempt_id, updated_at_ms)
       VALUES ('step-m-0', ?, 0, 'plan', 'succeeded', 1, 'att-m-1', ?),
              ('step-m-1', ?, 1, 'implement', 'running', 1, 'att-m-2', ?)`,
      multiRunId,
      NOW_MS - 5_000,
      multiRunId,
      NOW_MS - 1_000
    );
    conn.run(
      `INSERT INTO attempts (
        attempt_id, run_id, step_id, attempt_number, status, exit_code,
        started_at_ms, completed_at_ms, backend_kind, model_id, profile_id, lane_id, failure_cause
      ) VALUES
        ('att-m-1', ?, 'step-m-0', 1, 'succeeded', 0, ?, ?, 'claude', 'claude-sonnet-4-6', 'claude-acp', NULL, NULL),
        ('att-m-2', ?, 'step-m-1', 1, 'running', NULL, ?, NULL, 'codex', 'gpt-5-codex', 'codex-acp', NULL, NULL)`,
      multiRunId,
      NOW_MS - 9_000,
      NOW_MS - 5_000,
      multiRunId,
      NOW_MS - 4_000
    );

    // Distinct evidence per attempt
    conn.run(
      `INSERT INTO artifacts (artifact_id, content_sha256, byte_length, media_type, kind, created_by_run_id, created_by_attempt_id, created_at_ms)
       VALUES ('art-m-1', ?, 128, 'text/plain', 'diagnostic', ?, 'att-m-1', ?),
              ('art-m-2', ?, 256, 'text/plain', 'transcript', ?, 'att-m-2', ?)`,
      '1'.repeat(64),
      multiRunId,
      NOW_MS - 6_000,
      '2'.repeat(64),
      multiRunId,
      NOW_MS - 2_000
    );
    conn.run(
      `INSERT INTO artifact_lifecycle (
        artifact_id, lifecycle_revision, owner_run_id, owner_attempt_id, sensitivity,
        retention_class, store_kind, immutability, digest_algorithm, digest_value,
        generation, extent_bytes, byte_size, availability, producer_identity,
        display_name, created_at_ms, terminal_settled_at_ms, expires_at_ms, updated_at_ms
      ) VALUES
        ('art-m-1', 1, ?, 'att-m-1', 'metadata', 'transcripts-diagnostics-checkpoints-audit-catalog', 'diagnostic', 'immutable', 'sha256', ?, NULL, NULL, 128, 'present', 'runner', 'plan.json', ?, NULL, NULL, ?),
        ('art-m-2', 1, ?, 'att-m-2', 'content', 'transcripts-diagnostics-checkpoints-audit-catalog', 'transcript', 'immutable', 'sha256', ?, NULL, NULL, 256, 'missing', 'runner', 'impl.log', ?, NULL, NULL, ?)`,
      multiRunId,
      '1'.repeat(64),
      NOW_MS - 6_000,
      NOW_MS - 6_000,
      multiRunId,
      '2'.repeat(64),
      NOW_MS - 2_000,
      NOW_MS - 2_000
    );

    // Exact live log streams + decoy wildcard/prefix streams that MUST NOT match `run_vis_multi`
    conn.run(
      `INSERT INTO live_log_streams (stream_key, generation, capture_mode, created_at_ms, updated_at_ms)
       VALUES (?, 'g1', 'captured', ?, ?),
              (?, 'g1', 'captured', ?, ?),
              ('runXvis_multi:att-decoy', 'g1', 'captured', ?, ?),
              ('run_vis_multi2:att-decoy', 'g1', 'captured', ?, ?)`,
      `${multiRunId}:att-m-1`,
      NOW_MS - 8_000,
      NOW_MS - 5_000,
      `${multiRunId}:att-m-2`,
      NOW_MS - 4_000,
      NOW_MS - 1_000,
      NOW_MS - 3_000,
      NOW_MS - 3_000,
      NOW_MS - 3_000,
      NOW_MS - 3_000
    );
    conn.run(
      `INSERT INTO live_log_segments (segment_id, stream_key, generation, segment_seq, artifact_ref, start_offset, end_offset, record_count, durable)
       VALUES (?, ?, 'g1', 0, 's1', 0, 100, 2, 1),
              (?, ?, 'g1', 0, 's2', 0, 100, 2, 1),
              (?, 'runXvis_multi:att-decoy', 'g1', 0, 'sd1', 0, 100, 1, 1),
              (?, 'run_vis_multi2:att-decoy', 'g1', 0, 'sd2', 0, 100, 1, 1)`,
      'a'.repeat(64),
      `${multiRunId}:att-m-1`,
      'b'.repeat(64),
      `${multiRunId}:att-m-2`,
      'c'.repeat(64),
      'd'.repeat(64)
    );
    conn.run(
      `INSERT INTO live_log_coverage (coverage_id, stream_key, generation, reason, from_offset, to_offset, count, recorded_at_ms)
       VALUES ('cov-m-2', ?, 'g1', 'transport-gap', 100, 200, 1, ?),
              ('cov-decoy', 'runXvis_multi:att-decoy', 'g1', 'transport-gap', 0, 50, 9, ?)`,
      `${multiRunId}:att-m-2`,
      NOW_MS - 1_000,
      NOW_MS - 1_000
    );

    // Distinct production ACP observations per attempt via AcpDurableRuntimeStore
    const acpStore = createSqliteAcpDurableRuntimeStore(conn, SCOPE_ID, () => NOW_MS);
    const g1 = acpStore.allocateConnectionGeneration();
    acpStore.recordObservation(
      {
        profileId: 'claude-acp',
        attemptId: 'att-m-1',
        observation: {
          kind: 'turn-completed',
          requestId: 1,
          stopReason: 'end_turn',
          generation: g1,
          hostReceiveSeq: 1,
          observedAtUtc: '2026-11-23T00:00:00.000Z',
          origin: 'live',
          acpSessionId: 'sess-m-1',
          turnId: 'turn-m-1',
          attemptId: 'att-m-1',
          binding: null
        }
      },
      NOW_MS - 5_000
    );
    acpStore.recordObservation(
      {
        profileId: 'codex-acp',
        attemptId: 'att-m-2',
        observation: {
          kind: 'permission-requested',
          permissionRequestId: 'perm-m-2',
          generation: g1,
          hostReceiveSeq: 2,
          observedAtUtc: '2026-11-23T00:00:05.000Z',
          origin: 'live',
          acpSessionId: 'sess-m-2',
          turnId: 'turn-m-2',
          attemptId: 'att-m-2',
          binding: null
        }
      },
      NOW_MS - 1_000
    );

    // Distinct phase handoffs for att-m-1 vs att-m-2
    const handoffStore = createSqliteHandoffStore(conn, () => NOW_MS);
    const seedHandoff = (
      sourceInvocationId: string,
      attemptId: string,
      targetNodePath: string
    ): string => {
      const producerRef = { nodePath: 'plan', occurrenceId: `occ-${attemptId}`, attemptId };
      const manifest = buildManifest({
        revision: 1,
        previousRevision: null,
        origin: 'selected',
        identity: {
          workspaceId: SCOPE_ID,
          rootExecutionId: multiRunId,
          sourceInvocationId,
          targetNodePath,
          targetOccurrenceId: `occ-target-${attemptId}`,
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
            selectedBy: { kind: 'selector', id: `sel-${attemptId}` },
            outcomes: ['ok'],
            decisions: [],
            constraints: [],
            unresolvedIssues: [],
            summary: `summary ${attemptId}`,
            artifacts: []
          }
        ],
        omissions: [],
        omissionsUnlisted: 0
      });
      handoffStore.bindRunMetadata(manifest.handoffId, {
        runId: multiRunId,
        sourceAttemptId: attemptId,
        targetPhaseId: targetNodePath,
        laneId: null
      });
      const ser = serializeManifest(manifest);
      const res = createAcceptanceService(handoffStore).accept({
        manifest,
        serialized: ser,
        manifestDigest: manifestDigestOf(ser),
        rendered: renderContext(manifest)
      });
      if (!res.ok) throw new Error(`seed handoff failed: ${res.failure}`);
      return manifest.handoffId;
    };
    const h1 = seedHandoff('inv-m-0', 'att-m-1', 'implement');
    const h2 = seedHandoff('inv-m-1', 'att-m-2', 'verify');

    // 1. Default root-wide read: sees both attempts, both evidence refs, both handoffs, and ONLY
    //    the 2 real streams (decoy wildcard/prefix streams are excluded -> 2 segments, 1 gap).
    const rootAck = await dispatchVisibility({ op: 'attemptDetail', rootExecutionId: multiRunId });
    expect(rootAck.status).toBe('accepted');
    const rootDetail = (
      rootAck.result as Extract<ReadExecutionVisibilityResponse, { readonly op: 'attemptDetail' }>
    ).detail;
    expect(rootDetail.hierarchy.attempts.map((a) => a.attemptId)).toEqual(['att-m-1', 'att-m-2']);
    expect(rootDetail.evidence.map((e) => e.artifactId)).toEqual(['art-m-1', 'art-m-2']);
    expect(rootDetail.liveLog).toEqual({ streamState: 'partial', segmentCount: 2, gapCount: 1 });
    expect(rootDetail.handoffs.map((h) => h.handoffId).sort()).toEqual([h1, h2].sort());

    // 2. Scoped by attemptId='att-m-1': authoritative, captured (1 seg, 0 gaps), disconnected, h1 only
    const att1Ack = await dispatchVisibility({
      op: 'attemptDetail',
      rootExecutionId: multiRunId,
      attemptId: 'att-m-1'
    });
    expect(att1Ack.status).toBe('accepted');
    const att1 = (
      att1Ack.result as Extract<ReadExecutionVisibilityResponse, { readonly op: 'attemptDetail' }>
    ).detail;
    expect(att1.hierarchy.attempts.map((a) => a.attemptId)).toEqual(['att-m-1']);
    expect(att1.hierarchy.dataQuality).toBe('authoritative');
    expect(att1.evidence.map((e) => e.artifactId)).toEqual(['art-m-1']);
    expect(att1.liveLog).toEqual({ streamState: 'captured', segmentCount: 1, gapCount: 0 });
    expect(att1.acp.runtimeState).toBe('disconnected');
    expect(att1.acp.profileId).toBe('claude-acp');
    expect(att1.handoffs.map((h) => h.handoffId)).toEqual([h1]);

    // 3. Scoped by attemptId='att-m-2': partial, missing evidence, partial live log, awaiting-permission, h2 only
    const att2Ack = await dispatchVisibility({
      op: 'attemptDetail',
      rootExecutionId: multiRunId,
      attemptId: 'att-m-2'
    });
    expect(att2Ack.status).toBe('accepted');
    const att2 = (
      att2Ack.result as Extract<ReadExecutionVisibilityResponse, { readonly op: 'attemptDetail' }>
    ).detail;
    expect(att2.hierarchy.attempts.map((a) => a.attemptId)).toEqual(['att-m-2']);
    expect(att2.hierarchy.dataQuality).toBe('partial');
    expect(att2.evidence.map((e) => e.artifactId)).toEqual(['art-m-2']);
    expect(att2.liveLog).toEqual({ streamState: 'partial', segmentCount: 1, gapCount: 1 });
    expect(att2.acp.runtimeState).toBe('awaiting-permission');
    expect(att2.acp.pendingPermissions).toBe(1);
    expect(att2.handoffs.map((h) => h.handoffId)).toEqual([h2]);

    // 4. Scoped by invocationId='step-m-0' (step_id) and invocationId='inv-m-1' (sourceInvocationId)
    const stepInvAck = await dispatchVisibility({
      op: 'attemptDetail',
      rootExecutionId: multiRunId,
      invocationId: 'step-m-0'
    });
    const stepInv = (
      stepInvAck.result as Extract<ReadExecutionVisibilityResponse, { readonly op: 'attemptDetail' }>
    ).detail;
    expect(stepInv.hierarchy.attempts.map((a) => a.attemptId)).toEqual(['att-m-1']);
    expect(stepInv.evidence.map((e) => e.artifactId)).toEqual(['art-m-1']);
    expect(stepInv.handoffs.map((h) => h.handoffId)).toEqual([h1]);

    const handoffInvAck = await dispatchVisibility({
      op: 'attemptDetail',
      rootExecutionId: multiRunId,
      invocationId: 'inv-m-1'
    });
    const handoffInv = (
      handoffInvAck.result as Extract<
        ReadExecutionVisibilityResponse,
        { readonly op: 'attemptDetail' }
      >
    ).detail;
    expect(handoffInv.hierarchy.attempts.map((a) => a.attemptId)).toEqual(['att-m-2']);
    expect(handoffInv.evidence.map((e) => e.artifactId)).toEqual(['art-m-2']);
    expect(handoffInv.handoffs.map((h) => h.handoffId)).toEqual([h2]);
  });

  it('handles overlapping CMD_OPEN_CHANGE_REVIEW supersession, <= 1s cancelOpen on held Git, refresh, >200-file paging, and native + fallback editors (R7-17-03)', async () => {
    // Build a 240-file inventory (> 200 per-page bound)
    const fileCount = 240;
    const rawParts: string[] = [];
    const statParts: string[] = [];
    for (let i = 0; i < fileCount; i += 1) {
      const filePath = `src/mod-${String(i).padStart(3, '0')}.ts`;
      rawParts.push(`:000000 100644 ${NULL_SHA} ${BLOB_NEW} A${Z}${filePath}${Z}`);
      statParts.push(`1\t0\t${filePath}${Z}`);
    }
    const largeInventory = rawParts.join('') + statParts.join('');

    let holdDiff = false;
    const heldDiffResolvers: Array<(res: GitRunResult) => void> = [];
    let localTargetTip = TARGET_COMMIT;
    let editorHasNative = true;
    let lastNativeOpenedCount = 0;
    const fallbackNotices: string[] = [];
    const fallbackDiffCalls: Array<{ left: string; right: string; title: string }> = [];

    const controllableGit: LaneGitRunner = {
      run: (args): Promise<GitRunResult> => {
        const verb = args.at(0) ?? '';
        if (verb === 'rev-parse') {
          const rev = args.at(3) ?? '';
          if (rev.startsWith('refs/heads/')) {
            return Promise.resolve({ ok: true, stdout: `${localTargetTip}\n` });
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
          return Promise.resolve({ ok: true, stdout: largeInventory });
        }
        if (verb === 'cat-file') {
          return Promise.resolve({ ok: true, stdout: 'export const x = 1;\n' });
        }
        return Promise.resolve({ ok: false, exitCode: 128, code: 'exit' });
      }
    };

    const integrationStore = new IntegrationStore(conn);
    const reviewService = createChangeReviewService({
      source: integrationStoreSource(integrationStore, SCOPE_ID),
      git: controllableGit,
      cwd: '/workspace',
      clock: () => new Date(NOW_MS)
    });
    const reviewApi = createChangeReviewApi(reviewService, {
      isWorkspaceTrusted: () => true
    });

    const editorPort: EditorPort = {
      hasCommand: async () => editorHasNative,
      openChanges: async (_title, triples) => {
        lastNativeOpenedCount = triples.length;
      },
      showNotice: (text) => {
        fallbackNotices.push(text);
      },
      pick: async () => 0,
      openDiff: async (left, right, title) => {
        fallbackDiffCalls.push({ left, right, title });
      }
    };

    const customRouter = new MessageRouter({
      executeCommand: vi.fn(async () => undefined),
      isPrimary: () => true,
      isTrusted: () => true,
      notifyWarning: vi.fn(),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (s: string) => s
      },
      changeReviewApi: () => reviewApi,
      openReviewInEditor: (opened: ReviewOpened, entries: readonly ChangeEntry[]) =>
        openReviewInEditor(editorPort, opened, entries)
    } as unknown as RouterDeps);

    let seq = 0;
    const sendCr = async (payload: OpenChangeReviewRequest): Promise<CommandAckMessage> => {
      const acks: CommandAckMessage[] = [];
      seq += 1;
      await customRouter.dispatch(
        {
          type: CMD_OPEN_CHANGE_REVIEW,
          correlationId: `cr-ext-${payload.op}-${String(seq)}`,
          payload
        },
        async (ack) => {
          acks.push(ack);
          return true;
        }
      );
      const first = acks.at(0);
      if (first === undefined) throw new Error('missing ack');
      return first;
    };

    // 1. Overlapping open supersession (`superseded`) while Git diff-tree is held
    holdDiff = true;
    const firstOpenPromise = sendCr({ op: 'open', requestId: REQUEST_ID });
    await vi.waitFor(() => expect(heldDiffResolvers.length).toBe(1));

    const secondOpenPromise = sendCr({ op: 'open', requestId: REQUEST_ID, openInEditor: true });
    const firstOpenAck = await firstOpenPromise;
    expect(firstOpenAck.status).toBe('rejected');
    expect(firstOpenAck.reason).toBe('superseded');

    await vi.waitFor(() => expect(heldDiffResolvers.length).toBe(2));
    // Release both held Git calls: only the second succeeds; the first is dropped.
    heldDiffResolvers.splice(0).forEach((resolve) => resolve({ ok: true, stdout: largeInventory }));

    const secondOpenAck = await secondOpenPromise;
    expect(secondOpenAck.status).toBe('accepted');
    const secondOpenRes = secondOpenAck.result as Extract<
      OpenChangeReviewResponse,
      { readonly op: 'open' }
    >;
    if (!secondOpenRes.result.ok || secondOpenRes.result.value.state === 'unavailable') {
      throw new Error('expected opened review');
    }
    // Native editor received ALL 240 entries via `collectLoadedEntries` across pages!
    expect(secondOpenRes.editor).toEqual({ mode: 'native', opened: 240 });
    expect(lastNativeOpenedCount).toBe(240);
    expect(secondOpenRes.result.value.firstPage.entries).toHaveLength(200);
    expect(secondOpenRes.result.value.firstPage.nextCursor).not.toBeNull();
    const initialReviewId = secondOpenRes.result.value.review.reviewId;

    // 2. Multi-page `op: 'page'` loads remaining 40 entries
    const pageAck = await sendCr({
      op: 'page',
      cursor: secondOpenRes.result.value.firstPage.nextCursor!
    });
    expect(pageAck.status).toBe('accepted');
    const pageRes = pageAck.result as Extract<OpenChangeReviewResponse, { readonly op: 'page' }>;
    if (!pageRes.result.ok) throw new Error('expected page ok');
    expect(pageRes.result.value.entries).toHaveLength(40);
    expect(pageRes.result.value.nextCursor).toBeNull();

    // 3. `op: 'refresh'` with fallback editor (`hasCommand: () => false`)
    holdDiff = false;
    editorHasNative = false;
    localTargetTip = MOVED_TARGET;
    const refreshAck = await sendCr({
      op: 'refresh',
      reviewId: initialReviewId,
      openInEditor: true
    });
    expect(refreshAck.status).toBe('accepted');
    const refreshRes = refreshAck.result as Extract<
      OpenChangeReviewResponse,
      { readonly op: 'refresh' }
    >;
    if (!refreshRes.result.ok || refreshRes.result.value.state === 'unavailable') {
      throw new Error('expected refreshed review');
    }
    expect(refreshRes.result.value.review.reviewId).not.toBe(initialReviewId);
    expect(refreshRes.result.value.review.state).toBe('stale');
    expect(refreshRes.result.value.review.reason).toBe('target-advanced');
    expect(refreshRes.editor).toEqual({ mode: 'fallback', opened: 1 });
    expect(fallbackNotices).toHaveLength(1);
    expect(fallbackDiffCalls).toHaveLength(1);

    // 4. In-flight `cancelOpen` settles within <= 1s while Git diff-tree remains unresolved
    const liveBeforeCancel = reviewService.liveReviews();
    holdDiff = true;
    const thirdOpenPromise = sendCr({ op: 'open', requestId: REQUEST_ID });
    await vi.waitFor(() => expect(heldDiffResolvers.length).toBe(1));

    const cancelStarted = performance.now();
    const cancelAck = await sendCr({ op: 'cancelOpen' });
    const thirdOpenAck = await thirdOpenPromise;
    const cancelElapsedMs = performance.now() - cancelStarted;

    expect(cancelAck.status).toBe('accepted');
    const cancelRes = cancelAck.result as Extract<
      OpenChangeReviewResponse,
      { readonly op: 'cancelOpen' }
    >;
    expect(cancelRes.canceled).toBe(true);
    expect(thirdOpenAck.status).toBe('rejected');
    expect(thirdOpenAck.reason).toBe('canceled');
    expect(cancelElapsedMs).toBeLessThanOrEqual(1_000);

    // Releasing the stale held Git process afterward does not leak a new review
    heldDiffResolvers.splice(0).forEach((resolve) => resolve({ ok: true, stdout: largeInventory }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reviewService.liveReviews()).toBe(liveBeforeCancel);
  });

  it('wires real TelemetryHostService posture across disabled, refused content-export-unsupported, and authorized states (R7-17-03)', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'schegent-f12-tel-'));
    const fakeSqliteStore = { writerConnection: conn } as unknown as SqliteApplicationStore;
    const noopTransport: TelemetryTransport = {
      send: async () => ({
        kind: 'response',
        statusCode: 200,
        retryAfterSeconds: null,
        body: new Uint8Array(),
        bodyTruncated: false
      })
    };
    const telemetryHost = createTelemetryHostService({
      sqliteStore: fakeSqliteStore,
      storageRoot: tmpRoot,
      secrets: { availability: () => 'available', read: async () => null },
      isWorkspaceTrusted: () => true,
      transport: noopTransport
    });
    try {
      const api = createExecutionVisibilityApi({
        scopeId: SCOPE_ID,
        getSqliteStore: () => fakeSqliteStore,
        getPhaseContextApi: () => createPhaseContextApi(() => null),
        getTelemetryHost: () => telemetryHost,
        isLanesEnabled: () => true
      });

      // 1. Disabled by default
      const disabledPosture = api.readRuntimePosture();
      expect(disabledPosture.available).toBe(true);
      expect(disabledPosture.telemetry.enabled).toBe(false);
      expect(disabledPosture.telemetry.stateKind).toBe('disabled');
      expect(disabledPosture.telemetry.reasonCode).toBeNull();
      expect(disabledPosture.telemetry.spoolCeilingBytes).toBe(
        TELEMETRY_EXPORT_BOUNDS.diskSpoolBytes
      );
      expect(disabledPosture.telemetry.seriesCap).toBe(TELEMETRY_EXPORT_BOUNDS.attributeSetsMax);

      // 2. Refused when contentPolicy === 'content' (`content-export-unsupported`)
      const refusedEval = telemetryHost.configureFromUserSettings({
        enabled: true,
        endpoint: 'http://127.0.0.1:4318/v1/metrics',
        protocol: 'otlp-http-json',
        allowPlaintextLoopback: true,
        credentialSecretKey: '',
        credentialHeaderName: '',
        contentPolicy: 'content'
      });
      expect(refusedEval).toEqual({ kind: 'refused', reason: 'content-export-unsupported' });
      const refusedPosture = api.readRuntimePosture();
      expect(refusedPosture.telemetry.enabled).toBe(false);
      expect(refusedPosture.telemetry.stateKind).toBe('refused');
      expect(refusedPosture.telemetry.reasonCode).toBe('content-export-unsupported');
      expect(refusedPosture.telemetry.contentPolicyMode).toBe('content');

      // 3. Authorized metadata-only loopback OTLP metrics profile
      const authEval = telemetryHost.configureFromUserSettings({
        enabled: true,
        endpoint: 'http://127.0.0.1:4318/v1/metrics',
        protocol: 'otlp-http-json',
        allowPlaintextLoopback: true,
        credentialSecretKey: '',
        credentialHeaderName: '',
        contentPolicy: 'metadata-only'
      });
      expect(authEval.kind).toBe('authorized');
      const authPosture = api.readRuntimePosture();
      expect(authPosture.telemetry.enabled).toBe(true);
      expect(authPosture.telemetry.protocol).toBe('otlp-http-json');
      expect(authPosture.telemetry.reasonCode).toBeNull();
      expect(authPosture.telemetry.contentPolicyMode).toBe('metadata-only');
    } finally {
      await telemetryHost.shutdown();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('derives all NormalizedAcpActivityState values from real AcpDurableRuntimeStore.recordObservation writes (R7-17-03)', () => {
    const fakeSqliteStore = { writerConnection: conn } as unknown as SqliteApplicationStore;
    const acpStore = createSqliteAcpDurableRuntimeStore(conn, SCOPE_ID, () => NOW_MS);
    const vis = createExecutionVisibilityApi({
      scopeId: SCOPE_ID,
      getSqliteStore: () => fakeSqliteStore,
      getPhaseContextApi: () => createPhaseContextApi(() => null),
      getTelemetryHost: () => null,
      isLanesEnabled: () => false
    });

    const seedRunAttempt = (runId: string, attemptId: string): void => {
      conn.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
          current_step_id, started_at_ms, completed_at_ms, terminal_reason,
          created_at_ms, updated_at_ms, backend_kind, model_id, profile_id, lane_id, invocation_count
        ) VALUES (?, ?, 'wf-acp', 'fc-acp', 'running', 1, NULL, ?, NULL, NULL, ?, ?, 'claude', 'claude-sonnet-4-6', 'claude-acp', NULL, 1)`,
        runId,
        SCOPE_ID,
        NOW_MS - 5_000,
        NOW_MS - 5_000,
        NOW_MS - 1_000
      );
      conn.run(
        `INSERT INTO steps (step_id, run_id, step_index, phase_id, status, revision, current_attempt_id, updated_at_ms)
         VALUES (?, ?, 0, 'implement', 'running', 1, ?, ?)`,
        `step-${attemptId}`,
        runId,
        attemptId,
        NOW_MS - 1_000
      );
      conn.run(
        `INSERT INTO attempts (
          attempt_id, run_id, step_id, attempt_number, status, exit_code,
          started_at_ms, completed_at_ms, backend_kind, model_id, profile_id, lane_id, failure_cause
        ) VALUES (?, ?, ?, 1, 'running', NULL, ?, NULL, 'claude', 'claude-sonnet-4-6', 'claude-acp', NULL, NULL)`,
        attemptId,
        runId,
        `step-${attemptId}`,
        NOW_MS - 4_000
      );
    };

    const gen = acpStore.allocateConnectionGeneration();
    let seq = 0;
    const base = (attemptId: string) => ({
      generation: gen,
      hostReceiveSeq: ++seq,
      observedAtUtc: '2026-11-23T00:00:00.000Z',
      origin: 'live' as const,
      acpSessionId: `sess-${attemptId}`,
      turnId: `turn-${attemptId}`,
      attemptId,
      binding: null
    });

    const record = (attemptId: string, obs: AcpObservation, atMs: number): void => {
      acpStore.recordObservation({ profileId: 'claude-acp', attemptId, observation: obs }, atMs);
    };

    // 1. not-recorded (even when profile_id is set on run/attempt, 0 observations -> not-recorded)
    seedRunAttempt('run-acp-none', 'att-acp-none');
    expect(vis.readAttemptVisibility({ rootExecutionId: 'run-acp-none' }).acp.runtimeState).toBe(
      'not-recorded'
    );

    // 2. connected -> awaiting-permission -> resolved -> connected
    seedRunAttempt('run-acp-live', 'att-acp-live');
    record('att-acp-live', { ...base('att-acp-live'), kind: 'turn-started', requestId: 1 }, NOW_MS);
    expect(vis.readAttemptVisibility({ rootExecutionId: 'run-acp-live' }).acp.runtimeState).toBe(
      'connected'
    );

    record(
      'att-acp-live',
      { ...base('att-acp-live'), kind: 'permission-requested', permissionRequestId: 'perm-1' },
      NOW_MS + 10
    );
    const awaiting = vis.readAttemptVisibility({ rootExecutionId: 'run-acp-live' }).acp;
    expect(awaiting.runtimeState).toBe('awaiting-permission');
    expect(awaiting.pendingPermissions).toBe(1);

    record(
      'att-acp-live',
      {
        ...base('att-acp-live'),
        kind: 'permission-resolved',
        permissionRequestId: 'perm-1',
        granted: true
      },
      NOW_MS + 20
    );
    const afterResolve = vis.readAttemptVisibility({ rootExecutionId: 'run-acp-live' }).acp;
    expect(afterResolve.runtimeState).toBe('connected');
    expect(afterResolve.pendingPermissions).toBe(0);

    // 3. canceled (via turn-completed with stopReason: 'cancelled', mapped by T003 to 'turn-canceled')
    seedRunAttempt('run-acp-cancel', 'att-acp-cancel');
    record(
      'att-acp-cancel',
      {
        ...base('att-acp-cancel'),
        kind: 'turn-completed',
        requestId: 2,
        stopReason: 'cancelled'
      },
      NOW_MS + 30
    );
    expect(vis.readAttemptVisibility({ rootExecutionId: 'run-acp-cancel' }).acp.runtimeState).toBe(
      'canceled'
    );

    // 4. uncertain (via turn-uncertain)
    seedRunAttempt('run-acp-uncertain', 'att-acp-uncertain');
    record(
      'att-acp-uncertain',
      { ...base('att-acp-uncertain'), kind: 'turn-uncertain', reason: 'cancel-bound-elapsed' },
      NOW_MS + 40
    );
    expect(
      vis.readAttemptVisibility({ rootExecutionId: 'run-acp-uncertain' }).acp.runtimeState
    ).toBe('uncertain');

    // 5. disconnected (via transport-disconnected)
    seedRunAttempt('run-acp-disc', 'att-acp-disc');
    record(
      'att-acp-disc',
      { ...base('att-acp-disc'), kind: 'transport-disconnected', reason: 'transport-closed' },
      NOW_MS + 50
    );
    expect(vis.readAttemptVisibility({ rootExecutionId: 'run-acp-disc' }).acp.runtimeState).toBe(
      'disconnected'
    );
  });

  it('distinguishes all dataQuality, evidence.availability, liveLog.streamState, recovery.posture, and store-unavailable states (R7-17-03)', () => {
    const fakeSqliteStore = { writerConnection: conn } as unknown as SqliteApplicationStore;

    // 1. store-unavailable
    const unavailableApi = createExecutionVisibilityApi({
      scopeId: SCOPE_ID,
      getSqliteStore: () => null,
      getPhaseContextApi: () => createPhaseContextApi(() => null),
      getTelemetryHost: () => null,
      isLanesEnabled: () => false
    });
    const unavailable = unavailableApi.readAttemptVisibility({ rootExecutionId: 'run-any' });
    expect(unavailable.available).toBe(false);
    expect(unavailable.unavailableReason).toBe('store-unavailable');
    expect(unavailable.hierarchy.dataQuality).toBe('unknown');
    expect(unavailable.liveLog.streamState).toBe('unknown');
    expect(unavailable.recovery.posture).toBe('not-recorded');

    const vis = createExecutionVisibilityApi({
      scopeId: SCOPE_ID,
      getSqliteStore: () => fakeSqliteStore,
      getPhaseContextApi: () => createPhaseContextApi(() => null),
      getTelemetryHost: () => null,
      isLanesEnabled: () => false
    });

    // 2. unknown dataQuality + unknown liveLog + not-recorded recovery for absent root
    const unknownRun = vis.readAttemptVisibility({ rootExecutionId: 'run-does-not-exist' });
    expect(unknownRun.available).toBe(true);
    expect(unknownRun.hierarchy.dataQuality).toBe('unknown');
    expect(unknownRun.liveLog.streamState).toBe('unknown');
    expect(unknownRun.recovery.posture).toBe('not-recorded');

    // 3. authoritative + present evidence + captured liveLog + verified recovery
    conn.run(
      `INSERT INTO runs (
        run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
        current_step_id, started_at_ms, completed_at_ms, terminal_reason,
        created_at_ms, updated_at_ms, backend_kind, model_id, profile_id, lane_id, invocation_count
      ) VALUES ('run-auth', ?, 'wf-ok', 'fc-ok', 'succeeded', 1, NULL, ?, ?, NULL, ?, ?, 'claude', 'claude-sonnet-4-6', NULL, NULL, 1)`,
      SCOPE_ID,
      NOW_MS - 5_000,
      NOW_MS - 1_000,
      NOW_MS - 5_000,
      NOW_MS - 1_000
    );
    conn.run(
      `INSERT INTO artifacts (artifact_id, content_sha256, byte_length, media_type, kind, created_by_run_id, created_by_attempt_id, created_at_ms)
       VALUES ('art-ok', ?, 64, 'text/plain', 'diagnostic', 'run-auth', NULL, ?)`,
      '3'.repeat(64),
      NOW_MS - 2_000
    );
    conn.run(
      `INSERT INTO artifact_lifecycle (
        artifact_id, lifecycle_revision, owner_run_id, owner_attempt_id, sensitivity,
        retention_class, store_kind, immutability, digest_algorithm, digest_value,
        generation, extent_bytes, byte_size, availability, producer_identity,
        display_name, created_at_ms, terminal_settled_at_ms, expires_at_ms, updated_at_ms
      ) VALUES ('art-ok', 1, 'run-auth', NULL, 'metadata', 'transcripts-diagnostics-checkpoints-audit-catalog', 'diagnostic', 'immutable', 'sha256', ?, NULL, NULL, 64, 'present', 'runner', 'ok.json', ?, NULL, NULL, ?)`,
      '3'.repeat(64),
      NOW_MS - 2_000,
      NOW_MS - 2_000
    );
    conn.run(
      `INSERT INTO live_log_streams (stream_key, generation, capture_mode, created_at_ms, updated_at_ms)
       VALUES ('run-auth:step-0', 'g1', 'captured', ?, ?)`,
      NOW_MS - 3_000,
      NOW_MS - 1_000
    );
    conn.run(
      `INSERT INTO live_log_segments (segment_id, stream_key, generation, segment_seq, artifact_ref, start_offset, end_offset, record_count, durable)
       VALUES (?, 'run-auth:step-0', 'g1', 0, 'seg-ok', 0, 64, 2, 1)`,
      'e'.repeat(64)
    );
    const verifiedHandoffId = '7'.repeat(64);
    conn.run(
      `INSERT INTO recovery_handoffs (
        handoff_id, workspace_id, root_execution_id, invocation_id, source_attempt_id,
        state, paused, closed_reason, current_revision, pin_purpose, pin_purpose_target,
        legacy_provenance, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'run-auth', 'inv-ok', 'att-ok', 'acknowledged', 0, NULL, 1, NULL, NULL, NULL, ?, ?)`,
      verifiedHandoffId,
      SCOPE_ID,
      NOW_MS - 2_000,
      NOW_MS - 1_000
    );
    conn.run(
      `INSERT INTO recovery_handoff_revisions (
        handoff_id, revision_no, status, cutoff_key, execution_revision, usage_revision,
        fact_cutoff_ms, manifest_version, manifest_json, manifest_digest, certainty, coverage,
        issued_at_ms, superseded_at_ms
      ) VALUES (?, 1, 'issued', ?, 'exec-ok', 1, ?, 1, '{}', ?, 'safe', 'complete', ?, NULL)`,
      verifiedHandoffId,
      '6'.repeat(64),
      NOW_MS - 2_000,
      '5'.repeat(64),
      NOW_MS - 2_000
    );

    const authVis = vis.readAttemptVisibility({ rootExecutionId: 'run-auth' });
    expect(authVis.hierarchy.dataQuality).toBe('authoritative');
    expect(authVis.evidence.at(0)?.availability).toBe('present');
    expect(authVis.liveLog).toEqual({ streamState: 'captured', segmentCount: 1, gapCount: 0 });
    expect(authVis.recovery).toEqual({ posture: 'verified', reasonCode: null });

    // 4. not-captured liveLog + degraded recovery + deleted/unverified evidence -> partial dataQuality
    conn.run(
      `INSERT INTO runs (
        run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
        current_step_id, started_at_ms, completed_at_ms, terminal_reason,
        created_at_ms, updated_at_ms, backend_kind, model_id, profile_id, lane_id, invocation_count
      ) VALUES ('run-deg', ?, 'wf-deg', 'fc-deg', 'failed', 1, NULL, ?, ?, NULL, ?, ?, 'claude', 'claude-sonnet-4-6', NULL, NULL, 1)`,
      SCOPE_ID,
      NOW_MS - 5_000,
      NOW_MS - 1_000,
      NOW_MS - 5_000,
      NOW_MS - 1_000
    );
    conn.run(
      `INSERT INTO artifacts (artifact_id, content_sha256, byte_length, media_type, kind, created_by_run_id, created_by_attempt_id, created_at_ms)
       VALUES ('art-del', ?, 64, 'text/plain', 'transcript', 'run-deg', NULL, ?)`,
      '4'.repeat(64),
      NOW_MS - 2_000
    );
    conn.run(
      `INSERT INTO artifact_lifecycle (
        artifact_id, lifecycle_revision, owner_run_id, owner_attempt_id, sensitivity,
        retention_class, store_kind, immutability, digest_algorithm, digest_value,
        generation, extent_bytes, byte_size, availability, producer_identity,
        display_name, created_at_ms, terminal_settled_at_ms, expires_at_ms, updated_at_ms
      ) VALUES ('art-del', 1, 'run-deg', NULL, 'content', 'transcripts-diagnostics-checkpoints-audit-catalog', 'transcript', 'immutable', 'sha256', ?, NULL, NULL, 64, 'deleted', 'runner', 'del.log', ?, NULL, NULL, ?)`,
      '4'.repeat(64),
      NOW_MS - 2_000,
      NOW_MS - 2_000
    );
    conn.run(
      `INSERT INTO live_log_streams (stream_key, generation, capture_mode, created_at_ms, updated_at_ms)
       VALUES ('run-deg:step-0', 'g1', 'disabled', ?, ?)`,
      NOW_MS - 3_000,
      NOW_MS - 1_000
    );
    const degradedHandoffId = '4'.repeat(64);
    conn.run(
      `INSERT INTO recovery_handoffs (
        handoff_id, workspace_id, root_execution_id, invocation_id, source_attempt_id,
        state, paused, closed_reason, current_revision, pin_purpose, pin_purpose_target,
        legacy_provenance, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'run-deg', 'inv-deg', 'att-deg', 'unsupported', 0, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      degradedHandoffId,
      SCOPE_ID,
      NOW_MS - 2_000,
      NOW_MS - 1_000
    );

    const degVis = vis.readAttemptVisibility({ rootExecutionId: 'run-deg' });
    expect(degVis.hierarchy.dataQuality).toBe('partial');
    expect(degVis.evidence.at(0)?.availability).toBe('deleted');
    expect(degVis.liveLog).toEqual({ streamState: 'not-captured', segmentCount: 0, gapCount: 0 });
    expect(degVis.recovery).toEqual({ posture: 'degraded', reasonCode: 'unsupported' });
  });

  it('excludes downstream dispatched target attempts, evidence, live logs, and ACP state from upstream invocationId-scoped visibility (CR-311-2)', async () => {
    const runId = 'run-cr311-2';
    conn.run(
      `INSERT INTO runs (
        run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
        current_step_id, started_at_ms, completed_at_ms, terminal_reason,
        created_at_ms, updated_at_ms, backend_kind, model_id, profile_id, lane_id, invocation_count
      ) VALUES (?, ?, 'wf-handoff', 'fc-handoff', 'running', 1, NULL, ?, NULL, NULL, ?, ?, 'claude', 'claude-sonnet-4-6', 'claude-acp', NULL, 2)`,
      runId,
      SCOPE_ID,
      NOW_MS - 10_000,
      NOW_MS - 10_000,
      NOW_MS - 1_000
    );
    conn.run(
      `INSERT INTO steps (step_id, run_id, step_index, phase_id, status, revision, current_attempt_id, updated_at_ms)
       VALUES ('step-up-0', ?, 0, 'plan', 'succeeded', 1, 'att-up-1', ?),
              ('step-down-1', ?, 1, 'implement', 'running', 1, 'att-down-1', ?)`,
      runId,
      NOW_MS - 5_000,
      runId,
      NOW_MS - 1_000
    );
    conn.run(
      `INSERT INTO attempts (
        attempt_id, run_id, step_id, attempt_number, status, exit_code,
        started_at_ms, completed_at_ms, backend_kind, model_id, profile_id, lane_id, failure_cause
      ) VALUES
        ('att-up-1', ?, 'step-up-0', 1, 'succeeded', 0, ?, ?, 'claude', 'claude-sonnet-4-6', 'claude-acp', NULL, NULL),
        ('att-down-1', ?, 'step-down-1', 1, 'running', NULL, ?, NULL, 'codex', 'gpt-5-codex', 'codex-acp', NULL, NULL)`,
      runId,
      NOW_MS - 9_000,
      NOW_MS - 5_000,
      runId,
      NOW_MS - 4_000
    );

    // Distinct evidence for upstream vs downstream attempt
    conn.run(
      `INSERT INTO artifacts (artifact_id, content_sha256, byte_length, media_type, kind, created_by_run_id, created_by_attempt_id, created_at_ms)
       VALUES ('art-up-1', ?, 64, 'text/plain', 'diagnostic', ?, 'att-up-1', ?),
              ('art-down-1', ?, 128, 'text/plain', 'transcript', ?, 'att-down-1', ?)`,
      '1'.repeat(64),
      runId,
      NOW_MS - 6_000,
      '2'.repeat(64),
      runId,
      NOW_MS - 2_000
    );
    conn.run(
      `INSERT INTO artifact_lifecycle (
        artifact_id, lifecycle_revision, owner_run_id, owner_attempt_id, sensitivity,
        retention_class, store_kind, immutability, digest_algorithm, digest_value,
        generation, extent_bytes, byte_size, availability, producer_identity,
        display_name, created_at_ms, terminal_settled_at_ms, expires_at_ms, updated_at_ms
      ) VALUES
        ('art-up-1', 1, ?, 'att-up-1', 'metadata', 'transcripts-diagnostics-checkpoints-audit-catalog', 'diagnostic', 'immutable', 'sha256', ?, NULL, NULL, 64, 'present', 'runner', 'up.json', ?, NULL, NULL, ?),
        ('art-down-1', 1, ?, 'att-down-1', 'content', 'transcripts-diagnostics-checkpoints-audit-catalog', 'transcript', 'immutable', 'sha256', ?, NULL, NULL, 128, 'missing', 'runner', 'down.log', ?, NULL, NULL, ?)`,
      runId,
      '1'.repeat(64),
      NOW_MS - 6_000,
      NOW_MS - 6_000,
      runId,
      '2'.repeat(64),
      NOW_MS - 2_000,
      NOW_MS - 2_000
    );

    // Distinct live logs (downstream has a transport gap; upstream is clean)
    conn.run(
      `INSERT INTO live_log_streams (stream_key, generation, capture_mode, created_at_ms, updated_at_ms)
       VALUES (?, 'g1', 'captured', ?, ?), (?, 'g1', 'captured', ?, ?)`,
      `${runId}:att-up-1`,
      NOW_MS - 8_000,
      NOW_MS - 5_000,
      `${runId}:att-down-1`,
      NOW_MS - 4_000,
      NOW_MS - 1_000
    );
    conn.run(
      `INSERT INTO live_log_segments (segment_id, stream_key, generation, segment_seq, artifact_ref, start_offset, end_offset, record_count, durable)
       VALUES (?, ?, 'g1', 0, 'su1', 0, 64, 1, 1), (?, ?, 'g1', 0, 'sd1', 0, 128, 1, 1)`,
      'a'.repeat(64),
      `${runId}:att-up-1`,
      'b'.repeat(64),
      `${runId}:att-down-1`
    );
    conn.run(
      `INSERT INTO live_log_coverage (coverage_id, stream_key, generation, reason, from_offset, to_offset, count, recorded_at_ms)
       VALUES ('cov-down-1', ?, 'g1', 'transport-gap', 128, 256, 3, ?)`,
      `${runId}:att-down-1`,
      NOW_MS - 1_000
    );

    // Distinct ACP observations: upstream completed cleanly, downstream is awaiting-permission
    const acpStore = createSqliteAcpDurableRuntimeStore(conn, SCOPE_ID, () => NOW_MS);
    const gen = acpStore.allocateConnectionGeneration();
    acpStore.recordObservation(
      {
        profileId: 'claude-acp',
        attemptId: 'att-up-1',
        observation: {
          kind: 'turn-completed',
          requestId: 1,
          stopReason: 'end_turn',
          generation: gen,
          hostReceiveSeq: 1,
          observedAtUtc: '2026-11-23T00:00:00.000Z',
          origin: 'live',
          acpSessionId: 'sess-up-1',
          turnId: 'turn-up-1',
          attemptId: 'att-up-1',
          binding: null
        }
      },
      NOW_MS - 5_000
    );
    acpStore.recordObservation(
      {
        profileId: 'codex-acp',
        attemptId: 'att-down-1',
        observation: {
          kind: 'permission-requested',
          permissionRequestId: 'perm-down-1',
          generation: gen,
          hostReceiveSeq: 2,
          observedAtUtc: '2026-11-23T00:00:05.000Z',
          origin: 'live',
          acpSessionId: 'sess-down-1',
          turnId: 'turn-down-1',
          attemptId: 'att-down-1',
          binding: null
        }
      },
      NOW_MS - 1_000
    );

    // Upstream invocation dispatches a handoff to downstream attempt `att-down-1`
    const handoffStore = createSqliteHandoffStore(conn, () => NOW_MS);
    const acceptance = createAcceptanceService(handoffStore);
    const producerRef = { nodePath: 'plan', occurrenceId: 'occ-up-1', attemptId: 'att-up-1' };
    const manifest = buildManifest({
      revision: 1,
      previousRevision: null,
      origin: 'selected',
      identity: {
        workspaceId: SCOPE_ID,
        rootExecutionId: runId,
        sourceInvocationId: 'inv-up-1',
        targetNodePath: 'implement',
        targetOccurrenceId: 'occ-down-1',
        inputEnvelopeRevision: 1,
        sourceAttempts: [producerRef]
      },
      policyDigest: 'a'.repeat(64),
      approval: 'automatic',
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
          selectedBy: { kind: 'selector', id: 'sel-up' },
          outcomes: ['Planned'],
          decisions: [],
          constraints: [],
          unresolvedIssues: [],
          summary: 'Upstream summary',
          artifacts: []
        }
      ],
      omissions: [],
      omissionsUnlisted: 0
    });
    handoffStore.bindRunMetadata(manifest.handoffId, {
      runId,
      sourceAttemptId: 'att-up-1',
      targetPhaseId: 'implement',
      laneId: null
    });
    const ser = serializeManifest(manifest);
    const accRes = acceptance.accept({
      manifest,
      serialized: ser,
      manifestDigest: manifestDigestOf(ser),
      rendered: renderContext(manifest)
    });
    if (!accRes.ok) throw new Error(`accept failed: ${accRes.failure}`);
    const intentRes = acceptance.recordDispatchIntent(
      manifest.handoffId,
      1,
      'att-down-1',
      'c'.repeat(64)
    );
    if (!intentRes.ok) throw new Error(`dispatch intent failed: ${intentRes.failure}`);
    const settledRes = acceptance.settleDispatch(manifest.handoffId, 1, 'att-down-1', 'delivered');
    if (!settledRes.ok) throw new Error(`settle dispatch failed: ${settledRes.failure}`);

    // Scope by upstream invocationId='inv-up-1': MUST NOT pull downstream `att-down-1`
    const upstreamAck = await dispatchVisibility({
      op: 'attemptDetail',
      rootExecutionId: runId,
      invocationId: 'inv-up-1'
    });
    expect(upstreamAck.status).toBe('accepted');
    const upstream = (
      upstreamAck.result as Extract<ReadExecutionVisibilityResponse, { readonly op: 'attemptDetail' }>
    ).detail;
    expect(upstream.hierarchy.attempts.map((a) => a.attemptId)).toEqual(['att-up-1']);
    expect(upstream.hierarchy.dataQuality).toBe('authoritative');
    expect(upstream.evidence.map((e) => e.artifactId)).toEqual(['art-up-1']);
    expect(upstream.liveLog).toEqual({ streamState: 'captured', segmentCount: 1, gapCount: 0 });
    expect(upstream.acp.profileId).toBe('claude-acp');
    expect(upstream.acp.runtimeState).toBe('disconnected');
    expect(upstream.acp.pendingPermissions).toBe(0);
    expect(upstream.handoffs.map((h) => h.handoffId)).toEqual([manifest.handoffId]);
  });

  it('does not leave terminated, canceled, uncertain, or disconnected attempts stuck in awaiting-permission (CR-311-3)', () => {
    const fakeSqliteStore = { writerConnection: conn } as unknown as SqliteApplicationStore;
    const acpStore = createSqliteAcpDurableRuntimeStore(conn, SCOPE_ID, () => NOW_MS);
    const vis = createExecutionVisibilityApi({
      scopeId: SCOPE_ID,
      getSqliteStore: () => fakeSqliteStore,
      getPhaseContextApi: () => createPhaseContextApi(() => null),
      getTelemetryHost: () => null,
      isLanesEnabled: () => false
    });

    const seedAttempt = (
      runId: string,
      attemptId: string,
      status: string,
      completedAtMs: number | null
    ): void => {
      conn.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
          current_step_id, started_at_ms, completed_at_ms, terminal_reason,
          created_at_ms, updated_at_ms, backend_kind, model_id, profile_id, lane_id, invocation_count
        ) VALUES (?, ?, 'wf-term', 'fc-term', ?, 1, NULL, ?, ?, NULL, ?, ?, 'claude', 'claude-sonnet-4-6', 'claude-acp', NULL, 1)`,
        runId,
        SCOPE_ID,
        status,
        NOW_MS - 5_000,
        completedAtMs,
        NOW_MS - 5_000,
        NOW_MS - 1_000
      );
      conn.run(
        `INSERT INTO steps (step_id, run_id, step_index, phase_id, status, revision, current_attempt_id, updated_at_ms)
         VALUES (?, ?, 0, 'implement', ?, 1, ?, ?)`,
        `step-${attemptId}`,
        runId,
        status,
        attemptId,
        NOW_MS - 1_000
      );
      conn.run(
        `INSERT INTO attempts (
          attempt_id, run_id, step_id, attempt_number, status, exit_code,
          started_at_ms, completed_at_ms, backend_kind, model_id, profile_id, lane_id, failure_cause
        ) VALUES (?, ?, ?, 1, ?, NULL, ?, ?, 'claude', 'claude-sonnet-4-6', 'claude-acp', NULL, NULL)`,
        attemptId,
        runId,
        `step-${attemptId}`,
        status,
        NOW_MS - 4_000,
        completedAtMs
      );
    };

    const gen = acpStore.allocateConnectionGeneration();
    let seq = 0;
    const obsBase = (attemptId: string) => ({
      generation: gen,
      hostReceiveSeq: ++seq,
      observedAtUtc: '2026-11-23T00:00:00.000Z',
      origin: 'live' as const,
      acpSessionId: `sess-${attemptId}`,
      turnId: `turn-${attemptId}`,
      attemptId,
      binding: null
    });
    const record = (attemptId: string, obs: AcpObservation, atMs: number): void => {
      acpStore.recordObservation({ profileId: 'claude-acp', attemptId, observation: obs }, atMs);
    };

    // 1. permission-requested followed by turn-canceled -> canceled + pendingPermissions: 0
    seedAttempt('run-perm-cancel', 'att-perm-cancel', 'running', null);
    record(
      'att-perm-cancel',
      { ...obsBase('att-perm-cancel'), kind: 'permission-requested', permissionRequestId: 'p-1' },
      NOW_MS + 1
    );
    record(
      'att-perm-cancel',
      { ...obsBase('att-perm-cancel'), kind: 'turn-canceled', reason: 'cancelled' },
      NOW_MS + 2
    );
    const canceledAcp = vis.readAttemptVisibility({ rootExecutionId: 'run-perm-cancel' }).acp;
    expect(canceledAcp.runtimeState).toBe('canceled');
    expect(canceledAcp.pendingPermissions).toBe(0);

    // 2. permission-requested followed by turn-uncertain -> uncertain + pendingPermissions: 0
    seedAttempt('run-perm-uncertain', 'att-perm-uncertain', 'running', null);
    record(
      'att-perm-uncertain',
      { ...obsBase('att-perm-uncertain'), kind: 'permission-requested', permissionRequestId: 'p-2' },
      NOW_MS + 3
    );
    record(
      'att-perm-uncertain',
      { ...obsBase('att-perm-uncertain'), kind: 'turn-uncertain', reason: 'cancel-bound-elapsed' },
      NOW_MS + 4
    );
    const uncertainAcp = vis.readAttemptVisibility({ rootExecutionId: 'run-perm-uncertain' }).acp;
    expect(uncertainAcp.runtimeState).toBe('uncertain');
    expect(uncertainAcp.pendingPermissions).toBe(0);

    // 3. permission-requested followed by transport-disconnected -> disconnected + pendingPermissions: 0
    seedAttempt('run-perm-disc', 'att-perm-disc', 'running', null);
    record(
      'att-perm-disc',
      { ...obsBase('att-perm-disc'), kind: 'permission-requested', permissionRequestId: 'p-3' },
      NOW_MS + 5
    );
    record(
      'att-perm-disc',
      { ...obsBase('att-perm-disc'), kind: 'transport-disconnected', reason: 'transport-closed' },
      NOW_MS + 6
    );
    const discAcp = vis.readAttemptVisibility({ rootExecutionId: 'run-perm-disc' }).acp;
    expect(discAcp.runtimeState).toBe('disconnected');
    expect(discAcp.pendingPermissions).toBe(0);

    // 4. permission-requested with terminal attempt status='cancelled' (no follow-up ACP event)
    seedAttempt('run-perm-term-cancel', 'att-perm-term-cancel', 'cancelled', NOW_MS - 500);
    record(
      'att-perm-term-cancel',
      { ...obsBase('att-perm-term-cancel'), kind: 'permission-requested', permissionRequestId: 'p-4' },
      NOW_MS + 7
    );
    const termCancelAcp = vis.readAttemptVisibility({ rootExecutionId: 'run-perm-term-cancel' }).acp;
    expect(termCancelAcp.runtimeState).toBe('canceled');
    expect(termCancelAcp.pendingPermissions).toBe(0);

    // 5. permission-requested with terminal attempt completedAtMs !== null (no follow-up ACP event)
    seedAttempt('run-perm-term-done', 'att-perm-term-done', 'failed', NOW_MS - 500);
    record(
      'att-perm-term-done',
      { ...obsBase('att-perm-term-done'), kind: 'permission-requested', permissionRequestId: 'p-5' },
      NOW_MS + 8
    );
    const termDoneAcp = vis.readAttemptVisibility({ rootExecutionId: 'run-perm-term-done' }).acp;
    expect(termDoneAcp.runtimeState).toBe('disconnected');
    expect(termDoneAcp.pendingPermissions).toBe(0);
  });

  it('clamps arbitrary, secret-like, and bidi requestedContentPolicy values to "invalid" in readRuntimePosture (SR-313-3)', () => {
    const fakeSqliteStore = { writerConnection: conn } as unknown as SqliteApplicationStore;
    const fakeSecret = ['ghp', 'A'.repeat(36)].join('_');
    const maliciousPolicies = [
      '',
      'arbitrary-mode',
      `secret-${fakeSecret}`,
      '\u202emetadata-only\u202c',
      '\u001b[31mcontent\u001b[0m'
    ];

    for (const rawPolicy of maliciousPolicies) {
      const stubHost = {
        getStatus: () => ({
          evaluation: { kind: 'refused', reason: 'content-export-unsupported' },
          health: { state: 'refused', lastError: null, coverage: { overflow: 0 } },
          spooledBatches: 0,
          spooledBytes: 0,
          preview: {
            requestedContentPolicy: rawPolicy,
            redactionLimitsDisclosure: 'Metrics only.'
          }
        })
      };
      const api = createExecutionVisibilityApi({
        scopeId: SCOPE_ID,
        getSqliteStore: () => fakeSqliteStore,
        getPhaseContextApi: () => createPhaseContextApi(() => null),
        getTelemetryHost: () => stubHost as unknown as ReturnType<typeof createTelemetryHostService>,
        isLanesEnabled: () => false
      });

      const posture = api.readRuntimePosture();
      expect(posture.telemetry.contentPolicyMode).toBe('invalid');
    }
  });
});
