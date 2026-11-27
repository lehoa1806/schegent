/**
 * FR-R7-18 (`N02`, FR-002, SC-002, Contract 2) — Comprehensive SQLite fault-matrix
 * verification suite on real on-disk WAL databases.
 *
 * Covers every previously uncovered cell of the SQLite fault matrix:
 * 1. Abrupt process death (`SIGKILL`):
 *    - All 7 `AtomicTransactionUnitsService` units (pre-commit vs post-commit)
 *    - `createOnlineBackup` mid-backup (post-reserve pre-VACUUM, post-VACUUM pre-manifest, truncated)
 *    - `validateAndRestoreBackupAsync` (pre-commit after DELETE, at pre-commit fence, post-commit)
 * 2. Failed writes / disk full (`SQLITE_FULL` via deterministic `PRAGMA max_page_count`, and
 *    `SQLITE_READONLY` via `PRAGMA query_only = ON` / read-only POSIX permissions):
 *    - `AtomicTransactionUnitsService` (`STORAGE_BUSY_OR_FULL` + 100% rollback + recovery)
 *    - `SqliteOperationalBacking.updateBatch` & `WorkspaceStateStore.admitRunAtomically`
 *      (SQL rollback + in-memory cache parity + disk reopen parity)
 *    - Migration 9 transactional DDL + backfill rollback to intact schema 8
 *    - `createOnlineBackup` & `validateAndRestoreBackup`/`validateAndRestoreBackupAsync`
 *      (live DB untouched, triggers/FKs intact, no selectable partial backup)
 * 3. Simultaneous windows (dual on-disk connections to one WAL database):
 *    - Dual writer contention (`SQLITE_BUSY` after `busy_timeout = 250 ms` -> `STORAGE_BUSY_OR_FULL`)
 *    - Concurrent WAL snapshot reader-writer isolation (`BoundedReadConnectionPool` + read-only handle)
 *    - Cross-connection ownership handoff
 * 4. Reopen & end-to-end fault-to-verified-backup recovery:
 *    - Uncheckpointed `-wal` replay after `SIGKILL` (committed kept, uncommitted discarded)
 *    - Live `.db` corruption -> detection -> offline verified-backup swap (`0600`, stale sidecars removed)
 *    - Openable live-DB divergence -> online `validateAndRestoreBackupAsync` recovery preserving
 *      FR-R7-14 deletion tombstones while refusing missing live external bytes
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildSync } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { createWorkspaceExternalDependencyInspector } from '../../src/headless/backup-restore-api';
import { narrowMode } from '../../src/lib/narrow-mode';
import type { FeatureRequest, QueueState } from '../../src/queue/feature-request';
import { QueueManager } from '../../src/queue/queue-manager';
import {
  BUILTIN_SCHEMA_MIGRATIONS,
  computeCanonicalSha256,
  listBackupsInRoot,
  NodeSqliteConnection,
  parseAndValidateBackupManifest,
  readOperationalQueueMapFromDb,
  readOperationalRunMapFromDb,
  SchemaBootstrapService,
  SqliteApplicationStore,
  verifyBackupStandalone,
  verifyBackupStandaloneAsync
} from '../../src/services/sqlite-store';
import { createSwitchableOperationalMemento } from '../../src/state/sqlite-operational-backing';
import type { WorkflowRun } from '../../src/state/workflow-run';
import { KEYS, WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { removeTempRoot } from '../temp-root-cleanup';
import type {
  FaultMatrixCrashBoundary,
  FaultMatrixWorkerPayload
} from '../unit/sqlite-store/helpers/fault-matrix-crash-worker';

const WORKER_SRC = path.resolve(
  __dirname,
  '..',
  'unit',
  'sqlite-store',
  'helpers',
  'fault-matrix-crash-worker.ts'
);
const MIGRATIONS_UP_TO_8 = BUILTIN_SCHEMA_MIGRATIONS.filter((m) => m.version <= 8);
const NOW = 1_764_000_000_000;
const FAULT_MATRIX_FENCE = Object.freeze({
  fenceScope: 'window_primacy',
  resourceId: 'ws-fm',
  ownerId: 'window-primary',
  epoch: 1
});
const LARGE_PAGE_OVERFLOW_TEXT = 'P'.repeat(64 * 1024);

function sha256Hex(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function createMemoryMemento(initial: Record<string, unknown> = {}): Memento {
  const map = new Map<string, unknown>(Object.entries(initial));
  return {
    get<T>(key: string): T | undefined {
      return map.get(key) as T | undefined;
    },
    update(key: string, value: unknown): Thenable<void> {
      if (value === undefined) map.delete(key);
      else map.set(key, value);
      return Promise.resolve();
    }
  };
}

async function restoreWritableTree(root: string): Promise<void> {
  const st = await fs.lstat(root).catch(() => null);
  if (!st || st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    await fs.chmod(root, 0o700).catch(() => undefined);
    const entries = await fs.readdir(root).catch(() => []);
    for (const entry of entries) {
      await restoreWritableTree(path.join(root, entry));
    }
  } else if (st.isFile()) {
    await fs.chmod(root, 0o600).catch(() => undefined);
  }
}

function assertIntegrityOk(conn: NodeSqliteConnection): void {
  expect(conn.runQuickCheck()).toEqual(['ok']);
  expect(conn.runForeignKeyCheck()).toEqual([]);
}

function makeWorkflowRun(featureId: string, runId: string, overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: runId,
    featureId,
    featureDir: 'specs/332-recovery-verification-gaps',
    status: 'running',
    currentPhase: 'implement',
    currentIteration: 1,
    startedAt: NOW,
    lastTransitionAt: NOW,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    creditPause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    pipeline: {
      id: 'wf-fault-matrix',
      name: 'Fault Matrix Workflow',
      phases: [{ id: 'implement', name: 'Implement', instruction: 'Implement change' }]
    },
    ...overrides
  };
}

function makeFeatureRequest(id: string, position: number, description = 'Fault matrix task'): FeatureRequest {
  return {
    id,
    description,
    enqueuedAt: NOW + position,
    createdAt: NOW + position,
    startedAt: null,
    updatedAt: NOW + position,
    completedAt: null,
    status: 'pending',
    queueId: DEFAULT_QUEUE_ID,
    position,
    runId: null,
    retryCount: 0,
    lastError: null,
    pausedReason: null,
    pipelineId: 'wf-fault-matrix'
  };
}

function seedFence(store: SqliteApplicationStore): void {
  store.transactions.acquireOrRenewLeaseFence({
    ...FAULT_MATRIX_FENCE,
    ttlMs: 600_000
  });
}

function seedAdmittedRun(store: SqliteApplicationStore): void {
  seedFence(store);
  const res = store.transactions.executeAdmission({
    idempotency: {
      scopeKind: 'run',
      scopeId: 'run-fm-1',
      idempotencyKey: 'seed-admit-1',
      requestSha256: 'sha-seed-admit-1'
    },
    fence: FAULT_MATRIX_FENCE,
    expectedRevision: 0,
    run: {
      runId: 'run-fm-1',
      workspaceId: 'ws-fm',
      workflowId: 'wf-fm',
      priority: 5,
      inputs: { seed: true },
      initialStep: {
        stepId: 'step-fm-1',
        stepIndex: 0,
        phaseId: 'specify',
        attemptId: 'att-fm-1'
      }
    }
  });
  expect(res.status).toBe('committed');
}

function seedHandoffPrereqs(store: SqliteApplicationStore): void {
  seedAdmittedRun(store);
  store.writerConnection.run(
    `INSERT INTO steps (step_id, run_id, step_index, phase_id, status, revision, current_attempt_id, updated_at_ms)
     VALUES ('step-fm-2', 'run-fm-1', 1, 'plan', 'pending', 1, NULL, ?)`,
    NOW
  );
  store.artifacts.registerArtifact({
    artifactId: 'art-fm-1',
    contentSha256: sha256Hex('handoff-artifact-content'),
    byteLength: 24,
    mediaType: 'text/markdown',
    kind: 'spec',
    createdByRunId: 'run-fm-1',
    createdByAttemptId: 'att-fm-1',
    location: {
      locationId: 'loc-fm-1',
      storageTier: 'inline_db',
      uriOrRelpath: 'inline://art-fm-1',
      inlineBytes: Buffer.from('handoff-artifact-content')
    }
  });
}

function seedRetentionPrereqs(store: SqliteApplicationStore): void {
  seedAdmittedRun(store);
  const term = store.transactions.executeTerminalAcceptance({
    idempotency: {
      scopeKind: 'run',
      scopeId: 'run-fm-1',
      idempotencyKey: 'seed-term-for-ret',
      requestSha256: 'sha-seed-term-for-ret'
    },
    fence: FAULT_MATRIX_FENCE,
    expectedRevision: 1,
    settlement: {
      runId: 'run-fm-1',
      terminalStatus: 'succeeded',
      terminalReason: 'done',
      stepSettlement: {
        stepId: 'step-fm-1',
        status: 'succeeded',
        attemptId: 'att-fm-1',
        attemptStatus: 'succeeded',
        exitCode: 0
      }
    }
  });
  expect(term.status).toBe('committed');

  store.artifacts.registerArtifact({
    artifactId: 'art-fm-ret',
    contentSha256: sha256Hex('retention-target'),
    byteLength: 16,
    mediaType: 'text/plain',
    kind: 'report',
    createdByRunId: 'run-fm-1',
    createdByAttemptId: 'att-fm-1',
    location: {
      locationId: 'loc-fm-ret',
      storageTier: 'inline_db',
      uriOrRelpath: 'inline://art-fm-ret',
      inlineBytes: Buffer.from('retention-target')
    }
  });
  store.writerConnection.run(
    `INSERT INTO report_manifests (report_id, scope_key, cutoff_revision, format, artifact_id, created_at_ms)
     VALUES ('rpt-fm-1', 'ws-fm', 1, 'json', NULL, ?)`,
    NOW
  );
  store.writerConnection.run(
    `INSERT INTO report_leases (lease_id, report_id, holder_id, cutoff_revision, acquired_at_ms, expires_at_ms, status)
     VALUES ('lease-fm-1', 'rpt-fm-1', 'holder-1', 1, ?, ?, 'active')`,
    NOW,
    NOW + 1_000
  );
  store.writerConnection.run(
    `UPDATE state_change_outbox SET delivered_at_ms = ?`,
    NOW + 500
  );
}

function seedImmutableTriggerRow(conn: NodeSqliteConnection, scopeId: string, handoffId: string): void {
  conn.run(
    `INSERT OR IGNORE INTO recovery_handoffs (
      handoff_id, workspace_id, root_execution_id, invocation_id, source_attempt_id,
      state, paused, closed_reason, current_revision, pin_purpose, pin_purpose_target,
      legacy_provenance, created_at_ms, updated_at_ms
    ) VALUES (?, ?, 'run-trig', 'inv-trig', 'att-trig', 'ready', 0, NULL, 1, 'pending-handoff', NULL, NULL, ?, ?)`,
    handoffId,
    scopeId,
    NOW,
    NOW
  );
  conn.run(
    `INSERT OR IGNORE INTO recovery_handoff_revisions (
      handoff_id, revision_no, status, cutoff_key, execution_revision, usage_revision,
      fact_cutoff_ms, manifest_version, manifest_json, manifest_digest, certainty, coverage,
      issued_at_ms, superseded_at_ms
    ) VALUES (?, 1, 'issued', ?, 'exec-1', 1, ?, 1, '{"v":1}', ?, 'safe', 'complete', ?, NULL)`,
    handoffId,
    'c'.repeat(64),
    NOW,
    'c'.repeat(64),
    NOW
  );
}

function assertImmutableTriggerEnforced(conn: NodeSqliteConnection, handoffId: string): void {
  expect(() =>
    conn.run(`DELETE FROM recovery_handoff_revisions WHERE handoff_id = ?`, handoffId)
  ).toThrow(/issued|immutable|abort/i);
}

describe('FR-R7-18 (N02) — Complete SQLite fault matrix on real on-disk WAL databases', () => {
  let bundleDir: string;
  let workerCjs: string;
  const tempDirs: string[] = [];

  beforeAll(() => {
    bundleDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'schegent-fm-worker-'));
    workerCjs = path.join(bundleDir, 'fault-matrix-crash-worker.cjs');
    buildSync({
      entryPoints: [WORKER_SRC],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['node:sqlite'],
      outfile: workerCjs
    });
  });

  afterAll(() => {
    fsSync.rmSync(bundleDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      await restoreWritableTree(dir).catch(() => undefined);
      await removeTempRoot(dir);
    }
  });

  async function makeTempDir(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function spawnAndExpectSigkill(payload: FaultMatrixWorkerPayload): void {
    const res = spawnSync(process.execPath, [workerCjs, JSON.stringify(payload)], {
      encoding: 'utf8',
      timeout: 15_000
    });
    expect(
      res.signal,
      `expected SIGKILL at ${payload.boundary}; status=${res.status} stderr=${res.stderr}`
    ).toBe('SIGKILL');
  }

  // ---------------------------------------------------------------------------
  // 1. Abrupt process death (SIGKILL)
  // ---------------------------------------------------------------------------
  describe('1. Abrupt process death (SIGKILL)', () => {
    const TX_UNITS: ReadonlyArray<{
      readonly label: string;
      readonly preBoundary: FaultMatrixCrashBoundary;
      readonly postBoundary: FaultMatrixCrashBoundary;
      readonly seed: (store: SqliteApplicationStore) => void;
      readonly assertPreState: (store: SqliteApplicationStore) => void;
      readonly assertPostState: (store: SqliteApplicationStore) => void;
      readonly executeUnit: (store: SqliteApplicationStore) => { readonly status: string; readonly replayed?: boolean };
    }> = [
      {
        label: 'Admission',
        preBoundary: 'tx-admission-pre-commit',
        postBoundary: 'tx-admission-post-commit',
        seed: (store) => seedFence(store),
        assertPreState: (store) => {
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM runs`)).toBe(0);
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM queue_entries`)).toBe(0);
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM steps`)).toBe(0);
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM attempts`)).toBe(0);
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM operation_receipts`)).toBe(0);
        },
        assertPostState: (store) => {
          expect(store.writerConnection.get(`SELECT run_id, status, revision FROM runs WHERE run_id = 'run-fm-1'`)).toEqual({
            run_id: 'run-fm-1',
            status: 'running',
            revision: 1
          });
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM queue_entries WHERE run_id = 'run-fm-1'`)).toBe(1);
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM steps WHERE step_id = 'step-fm-1'`)).toBe(1);
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM attempts WHERE attempt_id = 'att-fm-1'`)).toBe(1);
          expect(
            store.writerConnection.scalar(
              `SELECT COUNT(*) FROM operation_receipts WHERE idempotency_key = 'fm-admit-1'`
            )
          ).toBe(1);
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM state_change_outbox`)).toBe(1);
        },
        executeUnit: (store) =>
          store.transactions.executeAdmission({
            idempotency: {
              scopeKind: 'run',
              scopeId: 'run-fm-1',
              idempotencyKey: 'fm-admit-1',
              requestSha256: 'sha-fm-admit-1'
            },
            fence: FAULT_MATRIX_FENCE,
            expectedRevision: 0,
            run: {
              runId: 'run-fm-1',
              workspaceId: 'ws-fm',
              workflowId: 'wf-fm',
              priority: 5,
              inputs: { prompt: 'fault-matrix-admission' },
              initialStep: {
                stepId: 'step-fm-1',
                stepIndex: 0,
                phaseId: 'specify',
                attemptId: 'att-fm-1'
              }
            }
          })
      },
      {
        label: 'Terminal acceptance',
        preBoundary: 'tx-terminal-pre-commit',
        postBoundary: 'tx-terminal-post-commit',
        seed: (store) => seedAdmittedRun(store),
        assertPreState: (store) => {
          expect(store.writerConnection.get(`SELECT status, revision FROM runs WHERE run_id = 'run-fm-1'`)).toEqual({
            status: 'running',
            revision: 1
          });
          expect(store.writerConnection.scalar(`SELECT state FROM queue_entries WHERE run_id = 'run-fm-1'`)).toBe(
            'claimed'
          );
          expect(store.writerConnection.scalar(`SELECT status FROM steps WHERE step_id = 'step-fm-1'`)).toBe('running');
          expect(
            store.writerConnection.scalar(
              `SELECT COUNT(*) FROM operation_receipts WHERE idempotency_key = 'fm-term-1'`
            )
          ).toBe(0);
        },
        assertPostState: (store) => {
          expect(store.writerConnection.get(`SELECT status, revision FROM runs WHERE run_id = 'run-fm-1'`)).toEqual({
            status: 'succeeded',
            revision: 2
          });
          expect(store.writerConnection.scalar(`SELECT state FROM queue_entries WHERE run_id = 'run-fm-1'`)).toBe(
            'completed'
          );
          expect(store.writerConnection.scalar(`SELECT status FROM steps WHERE step_id = 'step-fm-1'`)).toBe(
            'succeeded'
          );
          expect(store.writerConnection.scalar(`SELECT status FROM attempts WHERE attempt_id = 'att-fm-1'`)).toBe(
            'succeeded'
          );
          expect(
            store.writerConnection.scalar(
              `SELECT COUNT(*) FROM operation_receipts WHERE idempotency_key = 'fm-term-1'`
            )
          ).toBe(1);
        },
        executeUnit: (store) =>
          store.transactions.executeTerminalAcceptance({
            idempotency: {
              scopeKind: 'run',
              scopeId: 'run-fm-1',
              idempotencyKey: 'fm-term-1',
              requestSha256: 'sha-fm-term-1'
            },
            fence: FAULT_MATRIX_FENCE,
            expectedRevision: 1,
            settlement: {
              runId: 'run-fm-1',
              terminalStatus: 'succeeded',
              terminalReason: 'workflow_completed',
              stepSettlement: {
                stepId: 'step-fm-1',
                status: 'succeeded',
                attemptId: 'att-fm-1',
                attemptStatus: 'succeeded',
                exitCode: 0
              }
            }
          })
      },
      {
        label: 'Handoff acceptance',
        preBoundary: 'tx-handoff-pre-commit',
        postBoundary: 'tx-handoff-post-commit',
        seed: (store) => seedHandoffPrereqs(store),
        assertPreState: (store) => {
          expect(store.writerConnection.scalar(`SELECT revision FROM runs WHERE run_id = 'run-fm-1'`)).toBe(1);
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM accepted_results`)).toBe(0);
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM handoffs`)).toBe(0);
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM input_envelopes`)).toBe(0);
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM artifact_pins`)).toBe(0);
        },
        assertPostState: (store) => {
          expect(store.writerConnection.scalar(`SELECT revision FROM runs WHERE run_id = 'run-fm-1'`)).toBe(2);
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM accepted_results WHERE result_id = 'res-fm-1'`)).toBe(1);
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM handoffs WHERE handoff_id = 'ho-fm-1'`)).toBe(1);
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM input_envelopes WHERE envelope_id = 'env-fm-1'`)).toBe(1);
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM artifact_pins WHERE artifact_id = 'art-fm-1'`)).toBe(1);
          expect(
            store.writerConnection.scalar(
              `SELECT COUNT(*) FROM operation_receipts WHERE idempotency_key = 'fm-ho-1'`
            )
          ).toBe(1);
        },
        executeUnit: (store) =>
          store.transactions.executeHandoffAcceptance({
            idempotency: {
              scopeKind: 'handoff',
              scopeId: 'ho-fm-1',
              idempotencyKey: 'fm-ho-1',
              requestSha256: 'sha-fm-ho-1'
            },
            fence: FAULT_MATRIX_FENCE,
            expectedRevision: 1,
            handoff: {
              runId: 'run-fm-1',
              resultId: 'res-fm-1',
              stepId: 'step-fm-1',
              attemptId: 'att-fm-1',
              schemaId: 'spec-output-v1',
              values: [
                {
                  fieldPath: 'specPath',
                  valueType: 'artifact_ref',
                  valueText: 'art-fm-1',
                  artifactId: 'art-fm-1'
                }
              ],
              handoffId: 'ho-fm-1',
              toStepId: 'step-fm-2',
              envelopeId: 'env-fm-1',
              envelopeDigestSha256: 'sha-env-fm-1',
              bindings: [
                {
                  paramName: 'spec',
                  boundValueJson: '"art-fm-1"',
                  sourceFieldPath: 'specPath'
                }
              ],
              pinArtifactIds: ['art-fm-1']
            }
          })
      },
      {
        label: 'Review acceptance',
        preBoundary: 'tx-review-pre-commit',
        postBoundary: 'tx-review-post-commit',
        seed: (store) => seedAdmittedRun(store),
        assertPreState: (store) => {
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM review_loops`)).toBe(0);
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM review_reports`)).toBe(0);
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM findings`)).toBe(0);
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM gates`)).toBe(0);
        },
        assertPostState: (store) => {
          expect(store.writerConnection.scalar(`SELECT status FROM review_loops WHERE review_loop_id = 'rl-fm-1'`)).toBe(
            'converged'
          );
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM review_reports WHERE report_id = 'rep-fm-1'`)).toBe(1);
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM findings WHERE finding_id = 'find-fm-1'`)).toBe(1);
          expect(store.writerConnection.scalar(`SELECT status FROM gates WHERE gate_id = 'gate-fm-1'`)).toBe('approved');
          expect(
            store.writerConnection.scalar(
              `SELECT COUNT(*) FROM operation_receipts WHERE idempotency_key = 'fm-rev-1'`
            )
          ).toBe(1);
        },
        executeUnit: (store) =>
          store.transactions.executeReviewAcceptance({
            idempotency: {
              scopeKind: 'review',
              scopeId: 'rl-fm-1',
              idempotencyKey: 'fm-rev-1',
              requestSha256: 'sha-fm-rev-1'
            },
            fence: FAULT_MATRIX_FENCE,
            expectedRevision: 0,
            review: {
              reviewLoopId: 'rl-fm-1',
              runId: 'run-fm-1',
              stepId: 'step-fm-1',
              iteration: 1,
              maxIterations: 3,
              loopStatus: 'converged',
              reportId: 'rep-fm-1',
              reviewerRole: 'security-reviewer',
              verdict: 'pass',
              findings: [
                {
                  findingId: 'find-fm-1',
                  severity: 'medium',
                  category: 'code',
                  filePath: 'src/index.ts',
                  lineNumber: 12,
                  summary: 'Resolved finding',
                  status: 'fixed',
                  disposition: {
                    dispositionId: 'disp-fm-1',
                    disposition: 'fixed',
                    actorId: 'agent-1',
                    rationale: 'Patched cleanly'
                  },
                  fixClaim: {
                    claimId: 'claim-fm-1',
                    claimantAttemptId: 'att-fm-1',
                    commitSha: 'deadbeef',
                    status: 'verified'
                  }
                }
              ],
              gateUpdate: {
                gateId: 'gate-fm-1',
                gateType: 'review',
                status: 'approved',
                decidedBy: 'reviewer',
                notes: 'Approved'
              }
            }
          })
      },
      {
        label: 'Usage/correction',
        preBoundary: 'tx-usage-pre-commit',
        postBoundary: 'tx-usage-post-commit',
        seed: (store) => seedAdmittedRun(store),
        assertPreState: (store) => {
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM usage_observations`)).toBe(0);
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM usage_accounting_applications`)).toBe(0);
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM attempt_usage_revisions`)).toBe(0);
        },
        assertPostState: (store) => {
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM usage_observations WHERE observation_id = 'obs-fm-1'`)).toBe(1);
          expect(
            store.writerConnection.scalar(
              `SELECT COUNT(*) FROM usage_accounting_applications WHERE application_id = 'app-fm-1'`
            )
          ).toBe(1);
          expect(
            store.writerConnection.get(
              `SELECT revision, total_cost_microdollars FROM attempt_usage_revisions WHERE attempt_id = 'att-fm-1'`
            )
          ).toEqual({ revision: 1, total_cost_microdollars: 9_500 });
          expect(
            store.writerConnection.scalar(
              `SELECT COUNT(*) FROM operation_receipts WHERE idempotency_key = 'fm-usage-1'`
            )
          ).toBe(1);
        },
        executeUnit: (store) =>
          store.transactions.executeUsageCorrection({
            idempotency: {
              scopeKind: 'usage',
              scopeId: 'att-fm-1',
              idempotencyKey: 'fm-usage-1',
              requestSha256: 'sha-fm-usage-1'
            },
            expectedRevision: 0,
            usage: {
              runId: 'run-fm-1',
              stepId: 'step-fm-1',
              attemptId: 'att-fm-1',
              applicationId: 'app-fm-1',
              completeness: 'exact',
              observation: {
                observationId: 'obs-fm-1',
                provider: 'anthropic',
                modelId: 'claude-sonnet-4-5',
                inputTokens: 1_200,
                outputTokens: 400,
                cachedTokens: 100,
                costMicrodollars: 9_500,
                sourceKind: 'provider_exact'
              }
            }
          })
      },
      {
        label: 'Catalog publication',
        preBoundary: 'tx-catalog-pre-commit',
        postBoundary: 'tx-catalog-post-commit',
        seed: () => undefined,
        assertPreState: (store) => {
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM definitions`)).toBe(0);
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM definition_versions`)).toBe(0);
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM catalog_heads`)).toBe(0);
          expect(store.writerConnection.scalar(`SELECT revision FROM catalog_revisions WHERE scope = 'workspace'`)).toBe(0);
        },
        assertPostState: (store) => {
          expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM definitions WHERE definition_id = 'def-fm-phase-1'`)).toBe(1);
          expect(
            store.writerConnection.scalar(
              `SELECT published_version_id FROM catalog_heads WHERE definition_id = 'def-fm-phase-1'`
            )
          ).toBe('def-fm-phase-1@v1');
          expect(store.writerConnection.scalar(`SELECT revision FROM catalog_revisions WHERE scope = 'workspace'`)).toBe(1);
          expect(store.writerConnection.scalar(`SELECT revision FROM catalog_revisions WHERE scope = 'combined'`)).toBe(1);
          expect(
            store.writerConnection.scalar(
              `SELECT COUNT(*) FROM operation_receipts WHERE idempotency_key = 'fm-cat-1'`
            )
          ).toBe(1);
        },
        executeUnit: (store) =>
          store.transactions.executeCatalogPublication({
            idempotency: {
              scopeKind: 'catalog',
              scopeId: 'def-fm-phase-1',
              idempotencyKey: 'fm-cat-1',
              requestSha256: 'sha-fm-cat-1'
            },
            expectedRevision: 0,
            publication: {
              scope: 'workspace',
              definitionId: 'def-fm-phase-1',
              layer: 'phase',
              slug: 'specify-fm',
              displayName: 'Fault Matrix Specify',
              definitionVersionId: 'def-fm-phase-1@v1',
              versionNumber: 1,
              status: 'published',
              canonicalYaml: 'id: specify-fm\nlayer: phase\n',
              digestSha256: 'sha256-specify-fm-v1',
              schemaVersion: 1,
              promoteAsPublished: true
            }
          })
      },
      {
        label: 'Retention',
        preBoundary: 'tx-retention-pre-commit',
        postBoundary: 'tx-retention-post-commit',
        seed: (store) => seedRetentionPrereqs(store),
        assertPreState: (store) => {
          expect(store.writerConnection.scalar(`SELECT status FROM report_leases WHERE lease_id = 'lease-fm-1'`)).toBe(
            'active'
          );
          expect(store.artifacts.getArtifactAvailability('art-fm-ret')?.state).toBe('available');
          expect(
            store.writerConnection.scalar(
              `SELECT COUNT(*) FROM state_change_outbox WHERE delivered_at_ms IS NOT NULL`
            )
          ).toBeGreaterThan(0);
          expect(
            store.writerConnection.scalar(
              `SELECT COUNT(*) FROM operation_receipts WHERE idempotency_key = 'fm-ret-1'`
            )
          ).toBe(0);
        },
        assertPostState: (store) => {
          expect(store.writerConnection.scalar(`SELECT status FROM report_leases WHERE lease_id = 'lease-fm-1'`)).toBe(
            'expired'
          );
          expect(store.artifacts.getArtifactAvailability('art-fm-ret')?.state).toBe('evicted');
          expect(
            store.writerConnection.scalar(
              `SELECT COUNT(*) FROM state_change_outbox WHERE delivered_at_ms IS NOT NULL`
            )
          ).toBe(0);
          expect(
            store.writerConnection.scalar(
              `SELECT COUNT(*) FROM operation_receipts WHERE idempotency_key = 'fm-ret-1'`
            )
          ).toBe(1);
        },
        executeUnit: (store) =>
          store.transactions.executeRetention({
            idempotency: {
              scopeKind: 'retention',
              scopeId: 'ws-fm',
              idempotencyKey: 'fm-ret-1',
              requestSha256: 'sha-fm-ret-1'
            },
            cutoffTimestampMs: NOW + 10_000
          })
      }
    ];

    for (const unit of TX_UNITS) {
      it(`preserves complete pre-state on pre-commit SIGKILL and complete post-state on post-commit SIGKILL for ${unit.label}`, async () => {
        const dir = await makeTempDir(`schegent-fm-tx-${unit.preBoundary}-`);

        // Pre-commit SIGKILL -> clean rollback + retry succeeds
        const preDbPath = path.join(dir, 'pre.db');
        const seedPre = new SqliteApplicationStore({ databasePath: preDbPath, journalMode: 'wal', nowMs: () => NOW });
        try {
          unit.seed(seedPre);
        } finally {
          seedPre.close();
        }

        spawnAndExpectSigkill({
          dbPath: preDbPath,
          scopeId: 'ws-fm',
          boundary: unit.preBoundary
        });

        const reopenPre = new SqliteApplicationStore({ databasePath: preDbPath, journalMode: 'wal', nowMs: () => NOW });
        try {
          assertIntegrityOk(reopenPre.writerConnection);
          unit.assertPreState(reopenPre);

          // Retry after pre-commit crash commits atomically.
          const retried = unit.executeUnit(reopenPre);
          expect(retried.status).toBe('committed');
          expect(retried.replayed).toBe(false);
          unit.assertPostState(reopenPre);
          assertIntegrityOk(reopenPre.writerConnection);
        } finally {
          reopenPre.close();
        }

        // Post-commit SIGKILL -> complete post-state + idempotent replay
        const postDbPath = path.join(dir, 'post.db');
        const seedPost = new SqliteApplicationStore({ databasePath: postDbPath, journalMode: 'wal', nowMs: () => NOW });
        try {
          unit.seed(seedPost);
        } finally {
          seedPost.close();
        }

        spawnAndExpectSigkill({
          dbPath: postDbPath,
          scopeId: 'ws-fm',
          boundary: unit.postBoundary
        });

        const reopenPost = new SqliteApplicationStore({ databasePath: postDbPath, journalMode: 'wal', nowMs: () => NOW });
        try {
          assertIntegrityOk(reopenPost.writerConnection);
          unit.assertPostState(reopenPost);

          const replayed = unit.executeUnit(reopenPost);
          expect(replayed.status).toBe('committed');
          expect(replayed.replayed).toBe(true);
        } finally {
          reopenPost.close();
        }
      });
    }

    it('keeps live DB intact and refuses partial/unmanifested backup images when createOnlineBackup is SIGKILLed mid-backup', async () => {
      const storageRoot = await makeTempDir('schegent-fm-bkp-kill-');
      const scopeId = 'scope-bkp-kill';
      const liveDir = path.join(storageRoot, 'sqlite', scopeId);
      await fs.mkdir(liveDir, { recursive: true, mode: 0o700 });
      const liveDbPath = path.join(liveDir, 'schegent-state.db');

      const store = new SqliteApplicationStore({ databasePath: liveDbPath, journalMode: 'wal', nowMs: () => NOW });
      try {
        seedAdmittedRun(store);
        seedImmutableTriggerRow(store.writerConnection, scopeId, 'a'.repeat(64));
      } finally {
        store.close();
      }

      // Case A: SIGKILL right after 0-byte reservation, before VACUUM INTO
      spawnAndExpectSigkill({
        dbPath: liveDbPath,
        scopeId,
        trustedRootDir: storageRoot,
        backupId: 'bkp-killed-reserve',
        boundary: 'backup-kill-after-reserve-before-vacuum'
      });

      // Case B: SIGKILL right after VACUUM INTO, before companion manifest publication
      spawnAndExpectSigkill({
        dbPath: liveDbPath,
        scopeId,
        trustedRootDir: storageRoot,
        backupId: 'bkp-killed-post-vacuum',
        boundary: 'backup-kill-after-vacuum-before-manifest'
      });

      // Live DB remains 100% intact with passing quick_check, FK check, and triggers
      const reopened = new SqliteApplicationStore({ databasePath: liveDbPath, journalMode: 'wal', nowMs: () => NOW });
      try {
        assertIntegrityOk(reopened.writerConnection);
        expect(reopened.writerConnection.scalar(`SELECT run_id FROM runs WHERE run_id = 'run-fm-1'`)).toBe('run-fm-1');
        assertImmutableTriggerEnforced(reopened.writerConnection, 'a'.repeat(64));

        // Both killed backups have manifestStatus === 'missing' (never selectable as valid backups)
        const listed = await listBackupsInRoot(storageRoot, ['sqlite', scopeId, 'backups']);
        expect(listed.map((e) => ({ id: e.backupId, status: e.manifestStatus }))).toEqual(
          expect.arrayContaining([
            { id: 'bkp-killed-reserve', status: 'missing' },
            { id: 'bkp-killed-post-vacuum', status: 'missing' }
          ])
        );

        // Partial 0-byte backup file is refused by verifyBackup
        const zeroBytePath = path.join(storageRoot, 'sqlite', scopeId, 'backups', 'bkp-killed-reserve.db');
        const zeroCheck = verifyBackupStandalone({
          backupDatabasePath: zeroBytePath,
          trustedRootDir: storageRoot,
          manifest: {
            backupId: 'bkp-killed-reserve',
            createdAtMs: NOW,
            schemaVersion: 9,
            sqliteVersion: '3.53.4',
            databaseSha256: sha256Hex(Buffer.alloc(0)),
            databaseBytes: 4096,
            cutoverAuthority: 'sqlite',
            externalDependencies: []
          }
        });
        expect(zeroCheck.status).toBe('rejected');

        // Truncated partial SQLite file (simulating mid-page-write kill) is refused by verifyBackup
        const truncatedPath = path.join(storageRoot, 'sqlite', scopeId, 'backups', 'bkp-truncated.db');
        const postVacPath = path.join(storageRoot, 'sqlite', scopeId, 'backups', 'bkp-killed-post-vacuum.db');
        const fullBytes = await fs.readFile(postVacPath);
        const halfBytes = fullBytes.subarray(0, Math.floor(fullBytes.byteLength / 2));
        await fs.writeFile(truncatedPath, halfBytes, { mode: 0o600 });
        await narrowMode(truncatedPath, 0o600);

        const truncatedCheck = await verifyBackupStandaloneAsync({
          backupDatabasePath: truncatedPath,
          trustedRootDir: storageRoot,
          manifest: {
            backupId: 'bkp-truncated',
            createdAtMs: NOW,
            schemaVersion: 9,
            sqliteVersion: '3.53.4',
            databaseSha256: sha256Hex(halfBytes),
            databaseBytes: halfBytes.byteLength,
            cutoverAuthority: 'sqlite',
            externalDependencies: []
          }
        });
        expect(truncatedCheck.status).toBe('rejected');
        if (truncatedCheck.status === 'rejected') {
          expect(['BACKUP_OPEN_FAILED', 'QUICK_CHECK_FAILED']).toContain(truncatedCheck.reasonCode);
        }
      } finally {
        reopened.close();
      }
    });

    it('preserves strictly complete pre-restore or post-restore state with triggers and FKs intact when validateAndRestoreBackupAsync is SIGKILLed', async () => {
      const storageRoot = await makeTempDir('schegent-fm-restore-kill-');
      const scopeId = 'scope-restore-kill';
      const liveDir = path.join(storageRoot, 'sqlite', scopeId);
      await fs.mkdir(liveDir, { recursive: true, mode: 0o700 });
      const backupHandoffId = 'b'.repeat(64);
      const liveHandoffId = 'd'.repeat(64);

      // Build a verified backup image containing `run-backup-only` + immutable handoff row
      const seedDbPath = path.join(storageRoot, 'seed-backup.db');
      const seedStore = new SqliteApplicationStore({ databasePath: seedDbPath, journalMode: 'wal', nowMs: () => NOW });
      let backupDatabasePath: string;
      let manifestPath: string;
      try {
        seedStore.writerConnection.run(
          `INSERT INTO runs (
            run_id, workspace_id, workflow_id, status, revision, created_at_ms, updated_at_ms
          ) VALUES ('run-backup-only', ?, 'wf-bkp', 'succeeded', 1, ?, ?)`,
          scopeId,
          NOW,
          NOW
        );
        seedImmutableTriggerRow(seedStore.writerConnection, scopeId, backupHandoffId);
        const created = await seedStore.backupRestore.createOnlineBackup({
          backupId: 'bkp-restore-kill',
          scopeId,
          trustedRootDir: storageRoot,
          relativeBackupDirSegments: ['sqlite', scopeId, 'backups']
        });
        backupDatabasePath = created.backupDatabasePath;
        manifestPath = created.manifestPath;
      } finally {
        seedStore.close();
      }

      const createDivergedLiveDb = (name: string): string => {
        const dbPath = path.join(liveDir, name);
        const s = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal', nowMs: () => NOW });
        try {
          s.writerConnection.run(
            `INSERT INTO runs (
              run_id, workspace_id, workflow_id, status, revision, created_at_ms, updated_at_ms
            ) VALUES ('run-live-pre-restore', ?, 'wf-live', 'succeeded', 3, ?, ?)`,
            scopeId,
            NOW + 50,
            NOW + 50
          );
          seedImmutableTriggerRow(s.writerConnection, scopeId, liveHandoffId);
        } finally {
          s.close();
        }
        return dbPath;
      };

      // Pre-commit SIGKILL 1: right after DELETE FROM main."runs" (after triggers were dropped)
      const preDeleteDb = createDivergedLiveDb('live-pre-delete.db');
      spawnAndExpectSigkill({
        dbPath: preDeleteDb,
        scopeId,
        trustedRootDir: storageRoot,
        backupDatabasePath,
        manifestPath,
        boundary: 'restore-kill-after-delete-before-insert'
      });

      const afterPreDelete = new SqliteApplicationStore({ databasePath: preDeleteDb, journalMode: 'wal', nowMs: () => NOW });
      try {
        assertIntegrityOk(afterPreDelete.writerConnection);
        expect(
          afterPreDelete.writerConnection.all<{ run_id: string }>(`SELECT run_id FROM runs ORDER BY run_id`).map((r) => r.run_id)
        ).toEqual(['run-live-pre-restore']);
        assertImmutableTriggerEnforced(afterPreDelete.writerConnection, liveHandoffId);
      } finally {
        afterPreDelete.close();
      }

      // Pre-commit SIGKILL 2: at beforeCommitFence (all 128 tables copied, triggers recreated, before COMMIT)
      const preFenceDb = createDivergedLiveDb('live-pre-fence.db');
      spawnAndExpectSigkill({
        dbPath: preFenceDb,
        scopeId,
        trustedRootDir: storageRoot,
        backupDatabasePath,
        manifestPath,
        boundary: 'restore-kill-at-before-commit-fence'
      });

      const afterPreFence = new SqliteApplicationStore({ databasePath: preFenceDb, journalMode: 'wal', nowMs: () => NOW });
      try {
        assertIntegrityOk(afterPreFence.writerConnection);
        expect(
          afterPreFence.writerConnection.all<{ run_id: string }>(`SELECT run_id FROM runs ORDER BY run_id`).map((r) => r.run_id)
        ).toEqual(['run-live-pre-restore']);
        assertImmutableTriggerEnforced(afterPreFence.writerConnection, liveHandoffId);
      } finally {
        afterPreFence.close();
      }

      // Post-commit SIGKILL: immediately after COMMIT on dedicated restore connection
      const postCommitDb = createDivergedLiveDb('live-post-commit.db');
      spawnAndExpectSigkill({
        dbPath: postCommitDb,
        scopeId,
        trustedRootDir: storageRoot,
        backupDatabasePath,
        manifestPath,
        boundary: 'restore-kill-after-commit'
      });

      const afterPostCommit = new SqliteApplicationStore({ databasePath: postCommitDb, journalMode: 'wal', nowMs: () => NOW });
      try {
        assertIntegrityOk(afterPostCommit.writerConnection);
        expect(
          afterPostCommit.writerConnection.all<{ run_id: string }>(`SELECT run_id FROM runs ORDER BY run_id`).map((r) => r.run_id)
        ).toEqual(['run-backup-only']);
        assertImmutableTriggerEnforced(afterPostCommit.writerConnection, backupHandoffId);
      } finally {
        afterPostCommit.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Failed writes / disk full (SQLITE_FULL & SQLITE_READONLY)
  // ---------------------------------------------------------------------------
  describe('2. Failed writes / disk full (SQLITE_FULL via PRAGMA max_page_count & SQLITE_READONLY)', () => {
    it('maps AtomicTransactionUnitsService SQLITE_FULL and SQLITE_READONLY to STORAGE_BUSY_OR_FULL, rolls back 100%, and recovers cleanly', async () => {
      const dir = await makeTempDir('schegent-fm-tx-full-');
      const dbPath = path.join(dir, 'tx-full.db');
      const store = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal', nowMs: () => NOW });
      try {
        seedFence(store);
        const conn = store.writerConnection;
        const originalMaxPages = Number(conn.scalar('PRAGMA max_page_count'));
        const currentPages = Number(conn.scalar('PRAGMA page_count'));

        // Cap DB at current page count so multi-page admission hits real SQLITE_FULL
        conn.exec(`PRAGMA max_page_count = ${currentPages}`);
        const fullOutcome = store.transactions.executeAdmission({
          idempotency: {
            scopeKind: 'run',
            scopeId: 'run-full-1',
            idempotencyKey: 'admit-full-1',
            requestSha256: 'sha-admit-full-1'
          },
          fence: FAULT_MATRIX_FENCE,
          expectedRevision: 0,
          run: {
            runId: 'run-full-1',
            workspaceId: 'ws-fm',
            workflowId: 'wf-fm',
            priority: 5,
            inputs: { largeBlob: LARGE_PAGE_OVERFLOW_TEXT },
            initialStep: {
              stepId: 'step-full-1',
              stepIndex: 0,
              phaseId: 'specify',
              attemptId: 'att-full-1'
            }
          }
        });
        expect(fullOutcome.status).toBe('rejected');
        if (fullOutcome.status === 'rejected') {
          expect(fullOutcome.code).toBe('STORAGE_BUSY_OR_FULL');
        }
        expect(conn.scalar(`SELECT COUNT(*) FROM runs`)).toBe(0);
        expect(conn.scalar(`SELECT COUNT(*) FROM queue_entries`)).toBe(0);
        expect(conn.scalar(`SELECT COUNT(*) FROM steps`)).toBe(0);
        expect(conn.scalar(`SELECT COUNT(*) FROM operation_receipts`)).toBe(0);
        expect(conn.scalar(`SELECT COUNT(*) FROM state_change_outbox`)).toBe(0);
        assertIntegrityOk(conn);

        // Restore page cap and verify SQLITE_READONLY via PRAGMA query_only = ON
        conn.exec(`PRAGMA max_page_count = ${originalMaxPages}`);
        conn.exec('PRAGMA query_only = ON');
        const roOutcome = store.transactions.executeAdmission({
          idempotency: {
            scopeKind: 'run',
            scopeId: 'run-full-1',
            idempotencyKey: 'admit-full-1',
            requestSha256: 'sha-admit-full-1'
          },
          fence: FAULT_MATRIX_FENCE,
          expectedRevision: 0,
          run: {
            runId: 'run-full-1',
            workspaceId: 'ws-fm',
            workflowId: 'wf-fm',
            priority: 5,
            inputs: { largeBlob: LARGE_PAGE_OVERFLOW_TEXT }
          }
        });
        expect(roOutcome.status).toBe('rejected');
        if (roOutcome.status === 'rejected') {
          expect(roOutcome.code).toBe('STORAGE_BUSY_OR_FULL');
        }
        expect(conn.scalar(`SELECT COUNT(*) FROM runs`)).toBe(0);

        // Restore writability -> exact admission now succeeds cleanly
        conn.exec('PRAGMA query_only = OFF');
        const recovered = store.transactions.executeAdmission({
          idempotency: {
            scopeKind: 'run',
            scopeId: 'run-full-1',
            idempotencyKey: 'admit-full-1',
            requestSha256: 'sha-admit-full-1'
          },
          fence: FAULT_MATRIX_FENCE,
          expectedRevision: 0,
          run: {
            runId: 'run-full-1',
            workspaceId: 'ws-fm',
            workflowId: 'wf-fm',
            priority: 5,
            inputs: { largeBlob: LARGE_PAGE_OVERFLOW_TEXT },
            initialStep: {
              stepId: 'step-full-1',
              stepIndex: 0,
              phaseId: 'specify',
              attemptId: 'att-full-1'
            }
          }
        });
        expect(recovered.status).toBe('committed');
        assertIntegrityOk(conn);
      } finally {
        store.close();
      }

      const reopened = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal', nowMs: () => NOW });
      try {
        assertIntegrityOk(reopened.writerConnection);
        expect(reopened.writerConnection.scalar(`SELECT run_id FROM runs WHERE run_id = 'run-full-1'`)).toBe(
          'run-full-1'
        );
      } finally {
        reopened.close();
      }
    });

    it('rolls back SqliteOperationalBacking.updateBatch and admitRunAtomically on SQLITE_FULL and SQLITE_READONLY with exact in-memory cache and reopen parity', async () => {
      const dir = await makeTempDir('schegent-fm-backing-full-');
      const dbPath = path.join(dir, 'backing-full.db');
      const scopeId = 'scope-backing-full';

      const sqliteStore = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal', nowMs: () => NOW });
      let preQueueDigest = '';
      let prePendingTaskId = '';
      try {
        const memento = createSwitchableOperationalMemento(createMemoryMemento());
        const backing = memento.attachSqlite(sqliteStore, scopeId, () => NOW);
        const wsStore = new WorkspaceStateStore(memento);
        await wsStore.initialize();
        const queue = new QueueManager(wsStore);
        const seededTask = await queue.enqueue('Pre-fault pending task');
        prePendingTaskId = seededTask.id;

        const preQueueSnapshot = structuredClone(backing.get<Record<string, QueueState>>(KEYS.queue));
        const preRunSnapshot = backing.get<Record<string, WorkflowRun>>(KEYS.run);
        preQueueDigest = computeCanonicalSha256(preQueueSnapshot);

        const conn = sqliteStore.writerConnection;
        const originalMaxPages = Number(conn.scalar('PRAGMA max_page_count'));
        const currentPages = Number(conn.scalar('PRAGMA page_count'));

        // (a) updateBatch hitting SQLITE_FULL -> SQL rollback + identical in-memory cache
        conn.exec(`PRAGMA max_page_count = ${currentPages}`);
        const oversizedTask = makeFeatureRequest('task-oversized-full', 1, LARGE_PAGE_OVERFLOW_TEXT);
        const attemptedQueues: Record<string, QueueState> = {
          [DEFAULT_QUEUE_ID]: {
            ...preQueueSnapshot![DEFAULT_QUEUE_ID]!,
            requests: [...preQueueSnapshot![DEFAULT_QUEUE_ID]!.requests, oversizedTask]
          }
        };
        const attemptedRuns: Record<string, WorkflowRun> = {
          [DEFAULT_QUEUE_ID]: makeWorkflowRun(seededTask.id, 'run-batch-full', {
            featureDir: `specs/${LARGE_PAGE_OVERFLOW_TEXT}`
          })
        };
        expect(() =>
          backing.updateBatch([
            { key: KEYS.run, value: attemptedRuns },
            { key: KEYS.queue, value: attemptedQueues }
          ])
        ).toThrow(/database or disk is full/i);

        expect(backing.get(KEYS.queue)).toEqual(preQueueSnapshot);
        expect(backing.get(KEYS.run)).toEqual(preRunSnapshot);
        expect(wsStore.getRun(DEFAULT_QUEUE_ID)).toBeNull();
        expect(wsStore.getQueue(DEFAULT_QUEUE_ID).requests.map((r) => r.id)).toEqual([prePendingTaskId]);
        expect(conn.scalar(`SELECT COUNT(*) FROM runs WHERE run_id = 'run-batch-full'`)).toBe(0);
        assertIntegrityOk(conn);

        // (b) admitRunAtomically (via queue.admitRun) hitting SQLITE_FULL -> cache + SQL stay at pre-state
        const fullRun = makeWorkflowRun(prePendingTaskId, 'run-admit-full', {
          featureDir: `specs/${LARGE_PAGE_OVERFLOW_TEXT}`
        });
        await expect(queue.admitRun(prePendingTaskId, fullRun)).rejects.toThrow(/database or disk is full/i);
        expect(backing.get(KEYS.queue)).toEqual(preQueueSnapshot);
        expect(backing.get(KEYS.run)).toEqual(preRunSnapshot);
        expect(wsStore.getRun(DEFAULT_QUEUE_ID)).toBeNull();
        expect(wsStore.getQueue(DEFAULT_QUEUE_ID).inFlightId).toBeNull();
        expect(wsStore.getQueue(DEFAULT_QUEUE_ID).requests[0]?.status).toBe('pending');
        expect(conn.scalar(`SELECT COUNT(*) FROM runs WHERE run_id = 'run-admit-full'`)).toBe(0);

        // (c) updateBatch & admitRunAtomically hitting SQLITE_READONLY -> cache + SQL stay at pre-state
        conn.exec(`PRAGMA max_page_count = ${originalMaxPages}`);
        conn.exec('PRAGMA query_only = ON');

        expect(() =>
          backing.updateBatch([{ key: KEYS.queueDefaultId, value: 'should-fail-ro' }])
        ).toThrow(/readonly/i);
        expect(backing.get(KEYS.queueDefaultId)).not.toBe('should-fail-ro');
        expect(backing.get(KEYS.queue)).toEqual(preQueueSnapshot);

        await expect(
          queue.admitRun(prePendingTaskId, makeWorkflowRun(prePendingTaskId, 'run-admit-ro'))
        ).rejects.toThrow(/readonly/i);
        expect(wsStore.getRun(DEFAULT_QUEUE_ID)).toBeNull();
        expect(wsStore.getQueue(DEFAULT_QUEUE_ID).inFlightId).toBeNull();
        expect(wsStore.getQueue(DEFAULT_QUEUE_ID).requests[0]?.status).toBe('pending');
        expect(conn.scalar(`SELECT COUNT(*) FROM runs WHERE run_id = 'run-admit-ro'`)).toBe(0);

        conn.exec('PRAGMA query_only = OFF');
      } finally {
        sqliteStore.close();
      }

      // Reopen from disk confirms exact pre-state parity and clean subsequent admission
      const reopened = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal', nowMs: () => NOW });
      try {
        assertIntegrityOk(reopened.writerConnection);
        const memento = createSwitchableOperationalMemento(createMemoryMemento());
        const backing = memento.attachSqlite(reopened, scopeId, () => NOW + 1_000);
        const wsStore = new WorkspaceStateStore(memento);
        await wsStore.initialize();

        expect(computeCanonicalSha256(backing.get(KEYS.queue))).toBe(preQueueDigest);
        expect(wsStore.getRun(DEFAULT_QUEUE_ID)).toBeNull();
        expect(wsStore.getQueue(DEFAULT_QUEUE_ID).inFlightId).toBeNull();

        const queue = new QueueManager(wsStore);
        await queue.admitRun(prePendingTaskId, makeWorkflowRun(prePendingTaskId, 'run-admit-recovered'));
        expect(wsStore.getRun(DEFAULT_QUEUE_ID)?.id).toBe('run-admit-recovered');
        expect(wsStore.getQueue(DEFAULT_QUEUE_ID).inFlightId).toBe(prePendingTaskId);
        assertIntegrityOk(reopened.writerConnection);
      } finally {
        reopened.close();
      }
    });

    it('rolls back Migration 9 cleanly on SQLITE_FULL leaving schema 8 intact and reopenable, then migrates cleanly when space returns', async () => {
      const dir = await makeTempDir('schegent-fm-mig9-full-');
      const dbPath = path.join(dir, 'mig9-full.db');
      const scopeId = 'scope-mig9-full';

      // Seed schema-8 database with substantial operational_kv_documents so Migration 9 requires new pages
      const tasks: FeatureRequest[] = [];
      for (let i = 0; i < 24; i += 1) {
        tasks.push(makeFeatureRequest(`s8-task-${String(i).padStart(3, '0')}`, i, `Task ${i}: ${'d'.repeat(1500)}`));
      }
      const queues: Record<string, QueueState> = {
        default: {
          requests: tasks,
          inFlightId: null,
          updatedAt: NOW,
          queueLifecycle: 'idle-pending',
          pauseSource: null,
          pausedReason: null,
          scheduledStartAt: null,
          scheduledStartSource: null,
          failurePolicy: 'halt-on-failure'
        }
      };
      const runs: Record<string, WorkflowRun> = {
        default: makeWorkflowRun(tasks[0]!.id, 'run-s8-1', { status: 'completed' })
      };
      const expectedQueueDigest = computeCanonicalSha256(queues);
      const expectedRunDigest = computeCanonicalSha256(runs);

      const seedConn = new NodeSqliteConnection({ databasePath: dbPath, journalMode: 'wal' });
      try {
        SchemaBootstrapService.bootstrapAndMigrate(seedConn, () => NOW, MIGRATIONS_UP_TO_8);
        const qJson = JSON.stringify(queues);
        const rJson = JSON.stringify(runs);
        seedConn.run(
          `INSERT INTO operational_kv_documents (
            doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms
          ) VALUES (?, ?, 1, 1, ?, ?, 0, ?)`,
          scopeId,
          KEYS.queue,
          qJson,
          Buffer.byteLength(qJson, 'utf8'),
          NOW
        );
        seedConn.run(
          `INSERT INTO operational_kv_documents (
            doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms
          ) VALUES (?, ?, 1, 1, ?, ?, 0, ?)`,
          scopeId,
          KEYS.run,
          rJson,
          Buffer.byteLength(rJson, 'utf8'),
          NOW
        );
      } finally {
        seedConn.close();
      }

      // Attempt Migration 9 with max_page_count capped at current page count -> real SQLITE_FULL
      const failConn = new NodeSqliteConnection({ databasePath: dbPath, journalMode: 'wal' });
      try {
        const currentPages = Number(failConn.scalar('PRAGMA page_count'));
        failConn.exec(`PRAGMA max_page_count = ${currentPages}`);
        expect(() => SchemaBootstrapService.bootstrapAndMigrate(failConn, () => NOW + 1_000)).toThrow(
          /database or disk is full/i
        );
      } finally {
        failConn.close();
      }

      // Reopen fresh: database MUST remain cleanly at schema 8 with intact KV rows and zero schema-9 tables
      const reopenConn = new NodeSqliteConnection({ databasePath: dbPath, journalMode: 'wal' });
      try {
        assertIntegrityOk(reopenConn);
        expect(
          reopenConn.get<{ meta_value: string }>(
            `SELECT meta_value FROM schema_meta WHERE meta_key = 'schema_version'`
          )?.meta_value
        ).toBe('8');
        expect(
          reopenConn.get<{ meta_value: string }>(
            `SELECT meta_value FROM schema_meta WHERE meta_key = 'min_reader_version'`
          )?.meta_value
        ).toBe('1');
        expect(Number(reopenConn.scalar(`SELECT MAX(version) FROM schema_migrations`))).toBe(8);
        expect(
          reopenConn.all<{ name: string }>(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('operational_queue_meta', 'operational_tasks', 'operational_runs')`
          )
        ).toEqual([]);

        const kvRows = reopenConn.all<{ doc_key: string; payload_json: string }>(
          `SELECT doc_key, payload_json FROM operational_kv_documents WHERE doc_namespace = ? ORDER BY doc_key`,
          scopeId
        );
        expect(kvRows.map((r) => r.doc_key)).toEqual([KEYS.queue, KEYS.run]);
        expect(computeCanonicalSha256(JSON.parse(kvRows[0]!.payload_json))).toBe(expectedQueueDigest);
        expect(computeCanonicalSha256(JSON.parse(kvRows[1]!.payload_json))).toBe(expectedRunDigest);

        // Retry without page cap upgrades losslessly to schema 9
        const upgraded = SchemaBootstrapService.bootstrapAndMigrate(reopenConn, () => NOW + 2_000);
        expect(upgraded.schemaVersion).toBe(9);
        expect(upgraded.appliedMigrations).toEqual([9]);
        assertIntegrityOk(reopenConn);
        expect(computeCanonicalSha256(readOperationalQueueMapFromDb(reopenConn, scopeId).map)).toBe(
          expectedQueueDigest
        );
        expect(computeCanonicalSha256(readOperationalRunMapFromDb(reopenConn, scopeId).map)).toBe(
          expectedRunDigest
        );
      } finally {
        reopenConn.close();
      }
    });

    it('keeps live DB, triggers, and FKs intact with zero partial backups when createOnlineBackup and validateAndRestoreBackupAsync hit SQLITE_FULL or read-only targets', async () => {
      const storageRoot = await makeTempDir('schegent-fm-bkp-full-');
      const scopeId = 'scope-bkp-full';
      const liveDir = path.join(storageRoot, 'sqlite', scopeId);
      const backupsDir = path.join(liveDir, 'backups');
      await fs.mkdir(backupsDir, { recursive: true, mode: 0o700 });
      const liveDbPath = path.join(liveDir, 'schegent-state.db');
      const liveHandoffId = 'e'.repeat(64);
      const backupHandoffId = 'f'.repeat(64);

      // Build a verified backup image with substantial payload so restoring onto a page-capped DB hits SQLITE_FULL
      const sourceStore = new SqliteApplicationStore({
        databasePath: path.join(storageRoot, 'source-large.db'),
        journalMode: 'wal',
        nowMs: () => NOW
      });
      let verifiedBackup: Awaited<ReturnType<SqliteApplicationStore['backupRestore']['createOnlineBackup']>>;
      try {
        sourceStore.writerConnection.run(
          `INSERT INTO runs (
            run_id, workspace_id, workflow_id, status, revision, created_at_ms, updated_at_ms
          ) VALUES ('run-bkp-heavy', ?, 'wf-heavy', 'succeeded', 1, ?, ?)`,
          scopeId,
          NOW,
          NOW
        );
        sourceStore.writerConnection.run(
          `INSERT INTO operational_kv_documents (
            doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms
          ) VALUES (?, 'heavy-doc', 1, 9, ?, ?, 0, ?)`,
          scopeId,
          JSON.stringify({ blob: LARGE_PAGE_OVERFLOW_TEXT }),
          LARGE_PAGE_OVERFLOW_TEXT.length + 12,
          NOW
        );
        seedImmutableTriggerRow(sourceStore.writerConnection, scopeId, backupHandoffId);
        verifiedBackup = await sourceStore.backupRestore.createOnlineBackup({
          backupId: 'bkp-heavy-verified',
          scopeId,
          trustedRootDir: storageRoot,
          relativeBackupDirSegments: ['sqlite', scopeId, 'backups-verified']
        });
      } finally {
        sourceStore.close();
      }

      const liveStore = new SqliteApplicationStore({ databasePath: liveDbPath, journalMode: 'wal', nowMs: () => NOW });
      try {
        liveStore.writerConnection.run(
          `INSERT INTO runs (
            run_id, workspace_id, workflow_id, status, revision, created_at_ms, updated_at_ms
          ) VALUES ('run-live-intact', ?, 'wf-live', 'succeeded', 2, ?, ?)`,
          scopeId,
          NOW + 10,
          NOW + 10
        );
        seedImmutableTriggerRow(liveStore.writerConnection, scopeId, liveHandoffId);

        // (a) createOnlineBackup into read-only target directory (POSIX) -> refused, zero leftover files
        if (process.platform !== 'win32') {
          await fs.chmod(backupsDir, 0o500);
          try {
            await expect(
              liveStore.backupRestore.createOnlineBackup({
                backupId: 'bkp-ro-dir',
                scopeId,
                trustedRootDir: storageRoot,
                relativeBackupDirSegments: ['sqlite', scopeId, 'backups']
              })
            ).rejects.toThrow(/BACKUP_PATH_REFUSED|BACKUP_MODE_NARROWING_FAILED|EACCES|readonly/i);
          } finally {
            await fs.chmod(backupsDir, 0o700);
          }
          expect(await listBackupsInRoot(storageRoot, ['sqlite', scopeId, 'backups'])).toEqual([]);
        }

        // (b) createOnlineBackup when VACUUM INTO hits real SQLITE_READONLY (0o400 reserved file)
        if (process.platform !== 'win32') {
          const origRun = liveStore.writerConnection.run.bind(liveStore.writerConnection);
          liveStore.writerConnection.run = ((...args: Parameters<typeof liveStore.writerConnection.run>) => {
            const [sql, targetPath] = args;
            if (sql === 'VACUUM INTO ?' && typeof targetPath === 'string') {
              fsSync.chmodSync(targetPath, 0o400);
            }
            return origRun(...args);
          }) as typeof liveStore.writerConnection.run;
          try {
            await expect(
              liveStore.backupRestore.createOnlineBackup({
                backupId: 'bkp-vacuum-ro',
                scopeId,
                trustedRootDir: storageRoot,
                relativeBackupDirSegments: ['sqlite', scopeId, 'backups']
              })
            ).rejects.toThrow(/readonly/i);
          } finally {
            liveStore.writerConnection.run = origRun;
          }
          // Partial .db and manifest were cleaned up completely -> zero selectable partial backups
          expect(await fs.readdir(backupsDir)).toEqual([]);
          expect(await listBackupsInRoot(storageRoot, ['sqlite', scopeId, 'backups'])).toEqual([]);
        }

        // (c) validateAndRestoreBackup (sync) hitting real SQLITE_FULL via PRAGMA max_page_count
        const originalMaxPages = Number(liveStore.writerConnection.scalar('PRAGMA max_page_count'));
        const currentPages = Number(liveStore.writerConnection.scalar('PRAGMA page_count'));
        liveStore.writerConnection.exec(`PRAGMA max_page_count = ${currentPages}`);
        try {
          expect(() =>
            liveStore.backupRestore.validateAndRestoreBackup({
              backupDatabasePath: verifiedBackup.backupDatabasePath,
              manifest: verifiedBackup.manifest,
              trustedRootDir: storageRoot
            })
          ).toThrow(/database or disk is full/i);
        } finally {
          liveStore.writerConnection.exec(`PRAGMA max_page_count = ${originalMaxPages}`);
        }
        assertIntegrityOk(liveStore.writerConnection);
        expect(
          liveStore.writerConnection.all<{ run_id: string }>(`SELECT run_id FROM runs`).map((r) => r.run_id)
        ).toEqual(['run-live-intact']);
        assertImmutableTriggerEnforced(liveStore.writerConnection, liveHandoffId);

        // (d) validateAndRestoreBackupAsync hitting real SQLITE_FULL via PRAGMA max_page_count on dedicated connection
        const origProtoExec = NodeSqliteConnection.prototype.exec;
        NodeSqliteConnection.prototype.exec = function (this: NodeSqliteConnection, sql: string) {
          const res = origProtoExec.call(this, sql);
          if (sql === 'PRAGMA defer_foreign_keys = ON') {
            origProtoExec.call(this, `PRAGMA max_page_count = ${currentPages}`);
          }
          return res;
        };
        try {
          await expect(
            liveStore.backupRestore.validateAndRestoreBackupAsync({
              backupDatabasePath: verifiedBackup.backupDatabasePath,
              manifest: verifiedBackup.manifest,
              trustedRootDir: storageRoot
            })
          ).rejects.toThrow(/database or disk is full/i);
        } finally {
          NodeSqliteConnection.prototype.exec = origProtoExec;
        }
        assertIntegrityOk(liveStore.writerConnection);
        expect(
          liveStore.writerConnection.all<{ run_id: string }>(`SELECT run_id FROM runs`).map((r) => r.run_id)
        ).toEqual(['run-live-intact']);
        assertImmutableTriggerEnforced(liveStore.writerConnection, liveHandoffId);

        // (e) validateAndRestoreBackupAsync hitting real SQLITE_READONLY on dedicated connection
        const origProtoExecRo = NodeSqliteConnection.prototype.exec;
        NodeSqliteConnection.prototype.exec = function (this: NodeSqliteConnection, sql: string) {
          const res = origProtoExecRo.call(this, sql);
          if (sql === 'PRAGMA defer_foreign_keys = ON') {
            origProtoExecRo.call(this, 'PRAGMA query_only = ON');
          }
          return res;
        };
        try {
          await expect(
            liveStore.backupRestore.validateAndRestoreBackupAsync({
              backupDatabasePath: verifiedBackup.backupDatabasePath,
              manifest: verifiedBackup.manifest,
              trustedRootDir: storageRoot
            })
          ).rejects.toThrow(/readonly/i);
        } finally {
          NodeSqliteConnection.prototype.exec = origProtoExecRo;
        }
        assertIntegrityOk(liveStore.writerConnection);
        expect(
          liveStore.writerConnection.all<{ run_id: string }>(`SELECT run_id FROM runs`).map((r) => r.run_id)
        ).toEqual(['run-live-intact']);
        assertImmutableTriggerEnforced(liveStore.writerConnection, liveHandoffId);

        // (f) After removing faults, validateAndRestoreBackupAsync succeeds cleanly with triggers intact
        const restored = await liveStore.backupRestore.validateAndRestoreBackupAsync({
          backupDatabasePath: verifiedBackup.backupDatabasePath,
          manifest: verifiedBackup.manifest,
          trustedRootDir: storageRoot
        });
        expect(restored.status).toBe('restored');
        assertIntegrityOk(liveStore.writerConnection);
        expect(
          liveStore.writerConnection.all<{ run_id: string }>(`SELECT run_id FROM runs`).map((r) => r.run_id)
        ).toEqual(['run-bkp-heavy']);
        assertImmutableTriggerEnforced(liveStore.writerConnection, backupHandoffId);
      } finally {
        liveStore.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Simultaneous windows (dual on-disk connections to one WAL database)
  // ---------------------------------------------------------------------------
  describe('3. Simultaneous windows (dual on-disk WAL connections)', () => {
    it('returns typed STORAGE_BUSY_OR_FULL after busy_timeout=250ms when Handle A holds BEGIN IMMEDIATE and succeeds once Handle A commits or rolls back', async () => {
      const dir = await makeTempDir('schegent-fm-dual-busy-');
      const dbPath = path.join(dir, 'dual-busy.db');

      const storeA = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal', nowMs: () => NOW });
      const storeB = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal', nowMs: () => NOW });
      try {
        expect(storeA.writerConnection.verifiedPragmas.journalMode).toBe('wal');
        expect(storeB.writerConnection.verifiedPragmas.journalMode).toBe('wal');
        expect(storeB.writerConnection.verifiedPragmas.busyTimeoutMs).toBe(250);
        seedFence(storeA);

        // Handle A holds BEGIN IMMEDIATE write lock
        storeA.writerConnection.exec('BEGIN IMMEDIATE');
        storeA.writerConnection.run(
          `INSERT INTO runs (
            run_id, workspace_id, workflow_id, status, revision, created_at_ms, updated_at_ms
          ) VALUES ('run-handle-a', 'ws-fm', 'wf-a', 'running', 1, ?, ?)`,
          NOW,
          NOW
        );

        // Handle B attempts an atomic admission -> hits SQLITE_BUSY after busy_timeout=250ms
        const startMs = performance.now();
        const busyOutcome = storeB.transactions.executeAdmission({
          idempotency: {
            scopeKind: 'run',
            scopeId: 'run-handle-b',
            idempotencyKey: 'admit-handle-b',
            requestSha256: 'sha-handle-b'
          },
          fence: FAULT_MATRIX_FENCE,
          expectedRevision: 0,
          run: {
            runId: 'run-handle-b',
            workspaceId: 'ws-fm',
            workflowId: 'wf-b',
            priority: 1
          }
        });
        const elapsedMs = performance.now() - startMs;

        expect(busyOutcome.status).toBe('rejected');
        if (busyOutcome.status === 'rejected') {
          expect(busyOutcome.code).toBe('STORAGE_BUSY_OR_FULL');
        }
        expect(elapsedMs).toBeGreaterThanOrEqual(200);

        // Handle A commits -> Handle B sees Handle A's row and now commits cleanly with zero torn rows
        storeA.writerConnection.exec('COMMIT');

        const retryOutcome = storeB.transactions.executeAdmission({
          idempotency: {
            scopeKind: 'run',
            scopeId: 'run-handle-b',
            idempotencyKey: 'admit-handle-b',
            requestSha256: 'sha-handle-b'
          },
          fence: FAULT_MATRIX_FENCE,
          expectedRevision: 0,
          run: {
            runId: 'run-handle-b',
            workspaceId: 'ws-fm',
            workflowId: 'wf-b',
            priority: 1
          }
        });
        expect(retryOutcome.status).toBe('committed');

        // Also verify rollback release path: Handle A holds BEGIN IMMEDIATE then ROLLBACK
        storeA.writerConnection.exec('BEGIN IMMEDIATE');
        const busyBeforeRollback = storeB.transactions.executeAdmission({
          idempotency: {
            scopeKind: 'run',
            scopeId: 'run-handle-b2',
            idempotencyKey: 'admit-handle-b2',
            requestSha256: 'sha-handle-b2'
          },
          fence: FAULT_MATRIX_FENCE,
          expectedRevision: 0,
          run: {
            runId: 'run-handle-b2',
            workspaceId: 'ws-fm',
            workflowId: 'wf-b',
            priority: 2
          }
        });
        expect(busyBeforeRollback).toMatchObject({
          status: 'rejected',
          code: 'STORAGE_BUSY_OR_FULL'
        });
        storeA.writerConnection.exec('ROLLBACK');

        const afterRollback = storeB.transactions.executeAdmission({
          idempotency: {
            scopeKind: 'run',
            scopeId: 'run-handle-b2',
            idempotencyKey: 'admit-handle-b2',
            requestSha256: 'sha-handle-b2'
          },
          fence: FAULT_MATRIX_FENCE,
          expectedRevision: 0,
          run: {
            runId: 'run-handle-b2',
            workspaceId: 'ws-fm',
            workflowId: 'wf-b',
            priority: 2
          }
        });
        expect(afterRollback.status).toBe('committed');
      } finally {
        storeB.close();
        storeA.close();
      }

      const reopen = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal', nowMs: () => NOW });
      try {
        assertIntegrityOk(reopen.writerConnection);
        expect(
          reopen.writerConnection.all<{ run_id: string }>(`SELECT run_id FROM runs ORDER BY run_id`).map((r) => r.run_id)
        ).toEqual(['run-handle-a', 'run-handle-b', 'run-handle-b2']);
      } finally {
        reopen.close();
      }
    });

    it('enforces WAL snapshot isolation for concurrent BoundedReadConnectionPool and read-only handles during a multi-row write transaction', async () => {
      const dir = await makeTempDir('schegent-fm-dual-snap-');
      const dbPath = path.join(dir, 'dual-snap.db');
      const scopeId = 'scope-snap';

      const storeA = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal', nowMs: () => NOW });
      const storeB = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal', nowMs: () => NOW });
      const pinnedReader = new NodeSqliteConnection({ databasePath: dbPath, readOnly: true });
      try {
        // Seed consistent pre-state across runs + operational_runs + operational_tasks
        storeA.writerConnection.exec('BEGIN IMMEDIATE');
        storeA.writerConnection.run(
          `INSERT INTO runs (
            run_id, workspace_id, workflow_id, status, revision, created_at_ms, updated_at_ms
          ) VALUES ('run-snap-1', ?, 'wf-snap', 'running', 1, ?, ?)`,
          scopeId,
          NOW,
          NOW
        );
        storeA.writerConnection.run(
          `INSERT INTO operational_runs (
            scope_id, queue_id, run_id, revision, feature_id, status, current_phase,
            started_at_ms, last_transition_at_ms, failure_cause, payload_json
          ) VALUES (?, 'default', 'run-snap-1', 1, 'feat-snap-1', 'running', 'implement', ?, ?, NULL, '{}')`,
          scopeId,
          NOW,
          NOW
        );
        storeA.writerConnection.exec('COMMIT');

        // Pin a read snapshot on Handle B's dedicated read-only connection before Handle A begins writing
        pinnedReader.exec('BEGIN');
        expect(pinnedReader.get(`SELECT status, revision FROM runs WHERE run_id = 'run-snap-1'`)).toEqual({
          status: 'running',
          revision: 1
        });

        // Handle A opens a multi-row transaction and mutates multiple tables WITHOUT committing yet
        storeA.writerConnection.exec('BEGIN IMMEDIATE');
        storeA.writerConnection.run(
          `UPDATE runs SET status = 'succeeded', revision = 2, updated_at_ms = ? WHERE run_id = 'run-snap-1'`,
          NOW + 100
        );
        storeA.writerConnection.run(
          `INSERT INTO runs (
            run_id, workspace_id, workflow_id, status, revision, created_at_ms, updated_at_ms
          ) VALUES ('run-snap-2', ?, 'wf-snap', 'queued', 1, ?, ?)`,
          scopeId,
          NOW + 100,
          NOW + 100
        );
        storeA.writerConnection.run(
          `UPDATE operational_runs SET status = 'completed', revision = 2 WHERE scope_id = ? AND queue_id = 'default'`,
          scopeId
        );

        // While Handle A is uncommitted, Handle B's BoundedReadConnectionPool sees strictly complete pre-state
        const prePoolRead = storeB.readPool.withReadConnection(storeB.writerConnection, (ro) => ({
          runs: ro.all<{ run_id: string; status: string; revision: number }>(
            `SELECT run_id, status, revision FROM runs ORDER BY run_id`
          ),
          opStatus: ro.scalar<string>(
            `SELECT status FROM operational_runs WHERE scope_id = ? AND queue_id = 'default'`,
            scopeId
          )
        }));
        expect(prePoolRead).toEqual({
          runs: [{ run_id: 'run-snap-1', status: 'running', revision: 1 }],
          opStatus: 'running'
        });

        // Handle A commits atomically
        storeA.writerConnection.exec('COMMIT');

        // Pinned reader STILL sees strictly consistent pre-commit snapshot until its read tx ends
        expect(
          pinnedReader.all<{ run_id: string; status: string; revision: number }>(
            `SELECT run_id, status, revision FROM runs ORDER BY run_id`
          )
        ).toEqual([{ run_id: 'run-snap-1', status: 'running', revision: 1 }]);
        pinnedReader.exec('COMMIT');

        // Fresh reads on both BoundedReadConnectionPool and pinnedReader see complete post-state
        const postPoolRead = storeB.readPool.withReadConnection(storeB.writerConnection, (ro) => ({
          runs: ro.all<{ run_id: string; status: string; revision: number }>(
            `SELECT run_id, status, revision FROM runs ORDER BY run_id`
          ),
          opStatus: ro.scalar<string>(
            `SELECT status FROM operational_runs WHERE scope_id = ? AND queue_id = 'default'`,
            scopeId
          )
        }));
        expect(postPoolRead).toEqual({
          runs: [
            { run_id: 'run-snap-1', status: 'succeeded', revision: 2 },
            { run_id: 'run-snap-2', status: 'queued', revision: 1 }
          ],
          opStatus: 'completed'
        });
        assertIntegrityOk(storeB.writerConnection);
      } finally {
        pinnedReader.close();
        storeB.close();
        storeA.close();
      }
    });

    it('hands off ownership cleanly across sequential connections on the canonical WAL DB', async () => {
      const dir = await makeTempDir('schegent-fm-handoff-');
      const dbPath = path.join(dir, 'handoff.db');
      const scopeId = 'scope-handoff';
      let task1Id = '';

      // Handle A writes operational + relational state and closes cleanly
      const storeA = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal', nowMs: () => NOW });
      try {
        const memA = createSwitchableOperationalMemento(createMemoryMemento());
        memA.attachSqlite(storeA, scopeId, () => NOW);
        const wsA = new WorkspaceStateStore(memA);
        await wsA.initialize();
        const queueA = new QueueManager(wsA);
        const t1 = await queueA.enqueue('Written by Window A');
        task1Id = t1.id;
        await queueA.admitRun(t1.id, makeWorkflowRun(t1.id, 'run-window-a'));
      } finally {
        storeA.close();
      }

      // Handle B opens the canonical WAL DB, reads Window A's state, appends new work, and closes
      const storeB = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal', nowMs: () => NOW + 500 });
      let task2Id = '';
      try {
        assertIntegrityOk(storeB.writerConnection);
        const memB = createSwitchableOperationalMemento(createMemoryMemento());
        memB.attachSqlite(storeB, scopeId, () => NOW + 500);
        const wsB = new WorkspaceStateStore(memB);
        await wsB.initialize();
        expect(wsB.getRun(DEFAULT_QUEUE_ID)?.id).toBe('run-window-a');
        expect(wsB.getQueue(DEFAULT_QUEUE_ID).inFlightId).toBe(task1Id);

        const queueB = new QueueManager(wsB);
        const t2 = await queueB.enqueue('Written by Window B');
        task2Id = t2.id;
      } finally {
        storeB.close();
      }

      // Handle C verifies full continuity and integrity
      const storeC = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal', nowMs: () => NOW + 1_000 });
      try {
        assertIntegrityOk(storeC.writerConnection);
        const memC = createSwitchableOperationalMemento(createMemoryMemento());
        memC.attachSqlite(storeC, scopeId, () => NOW + 1_000);
        const wsC = new WorkspaceStateStore(memC);
        await wsC.initialize();
        expect(wsC.getRun(DEFAULT_QUEUE_ID)?.id).toBe('run-window-a');
        expect(wsC.getQueue(DEFAULT_QUEUE_ID).requests.map((r) => r.id)).toEqual([task1Id, task2Id]);
      } finally {
        storeC.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Reopen & end-to-end fault-to-verified-backup recovery
  // ---------------------------------------------------------------------------
  describe('4. Reopen & end-to-end fault-to-verified-backup recovery', () => {
    it('replays committed WAL frames and discards uncommitted frames cleanly on reopen with an uncheckpointed -wal after SIGKILL', async () => {
      const dir = await makeTempDir('schegent-fm-wal-replay-');
      const dbPath = path.join(dir, 'wal-replay.db');
      const scopeId = 'scope-wal-replay';

      const seed = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal', nowMs: () => NOW });
      seed.close();

      spawnAndExpectSigkill({
        dbPath,
        scopeId,
        boundary: 'wal-uncheckpointed-commit-then-uncommitted-kill'
      });

      // Confirm `-wal` sidecar exists and carries uncheckpointed frames before reopen
      const walStat = await fs.stat(`${dbPath}-wal`);
      expect(walStat.size).toBeGreaterThan(0);

      const reopened = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal', nowMs: () => NOW + 200 });
      try {
        assertIntegrityOk(reopened.writerConnection);
        expect(
          reopened.writerConnection.all<{ run_id: string; status: string }>(`SELECT run_id, status FROM runs ORDER BY run_id`)
        ).toEqual([{ run_id: 'run-wal-committed', status: 'succeeded' }]);
        expect(
          reopened.writerConnection.get<{ run_id: string; status: string; revision: number }>(
            `SELECT run_id, status, revision FROM operational_runs WHERE scope_id = ? AND queue_id = 'queue-wal'`,
            scopeId
          )
        ).toEqual({
          run_id: 'run-wal-committed',
          status: 'completed',
          revision: 1
        });
      } finally {
        reopened.close();
      }
    });

    it('detects live-DB corruption and recovers full entity parity, triggers, and FR-R7-14 deletion tombstones via offline verified-backup swap AND online restore', async () => {
      const workspaceRoot = await makeTempDir('schegent-fm-e2e-ws-');
      const storageRoot = await makeTempDir('schegent-fm-e2e-st-');
      const scopeId = 'scope-e2e-recovery';
      const liveDir = path.join(storageRoot, 'sqlite', scopeId);
      await fs.mkdir(liveDir, { recursive: true, mode: 0o700 });
      const liveDbPath = path.join(liveDir, 'schegent-state.db');

      // Seed live external artifact file (present on disk) and deleted tombstone artifact (absent on disk, FR-R7-14)
      const liveArtRel = '.schegent/reports/live-report.md';
      const liveArtBytes = Buffer.from('# Verified live artifact\n');
      await fs.mkdir(path.join(workspaceRoot, '.schegent', 'reports'), { recursive: true });
      await fs.writeFile(path.join(workspaceRoot, liveArtRel), liveArtBytes);
      const deletedArtBytes = Buffer.from('# Deleted artifact bytes removed via lifecycle\n');
      const handoffId = '1'.repeat(64);
      const inspector = createWorkspaceExternalDependencyInspector(workspaceRoot);

      let expectedQueueDigest = '';
      let expectedRunDigest = '';
      let backupDatabasePath = '';
      let manifestPath = '';

      const initialStore = new SqliteApplicationStore({ databasePath: liveDbPath, journalMode: 'wal', nowMs: () => NOW });
      try {
        const memento = createSwitchableOperationalMemento(createMemoryMemento());
        const backing = memento.attachSqlite(initialStore, scopeId, () => NOW);
        const wsStore = new WorkspaceStateStore(memento);
        await wsStore.initialize();
        const queue = new QueueManager(wsStore);
        const task = await queue.enqueue('Task protected by verified backup');
        await queue.admitRun(task.id, makeWorkflowRun(task.id, 'run-e2e-1'));
        expectedQueueDigest = computeCanonicalSha256(backing.get(KEYS.queue));
        expectedRunDigest = computeCanonicalSha256(backing.get(KEYS.run));

        seedImmutableTriggerRow(initialStore.writerConnection, scopeId, handoffId);

        // Live workspace_file artifact (must exist on disk for verify/restore)
        initialStore.artifacts.registerArtifact({
          artifactId: 'art-e2e-live',
          contentSha256: sha256Hex(liveArtBytes),
          byteLength: liveArtBytes.byteLength,
          mediaType: 'text/markdown',
          kind: 'report',
          location: { locationId: 'loc-e2e-live', storageTier: 'workspace_file', uriOrRelpath: liveArtRel }
        });
        initialStore.writerConnection.run(
          `INSERT INTO artifact_lifecycle (
            artifact_id, lifecycle_revision, owner_run_id, owner_attempt_id, sensitivity,
            retention_class, store_kind, immutability, digest_algorithm, digest_value,
            generation, extent_bytes, byte_size, availability, producer_identity, display_name,
            created_at_ms, terminal_settled_at_ms, expires_at_ms, updated_at_ms
          ) VALUES (
            'art-e2e-live', 1, NULL, NULL, 'metadata',
            'generated-reports-handoff-exports', 'report', 'immutable', 'sha256', ?,
            NULL, NULL, ?, 'present', 'fault-matrix', 'live-report.md',
            ?, NULL, NULL, ?
          )`,
          sha256Hex(liveArtBytes),
          liveArtBytes.byteLength,
          NOW,
          NOW
        );

        // Lifecycle-deleted tombstone artifact (bytes absent on disk; must survive backup/verify/restore per FR-R7-14)
        initialStore.artifacts.registerArtifact({
          artifactId: 'art-e2e-deleted',
          contentSha256: sha256Hex(deletedArtBytes),
          byteLength: deletedArtBytes.byteLength,
          mediaType: 'text/markdown',
          kind: 'report',
          location: {
            locationId: 'loc-e2e-del',
            storageTier: 'workspace_file',
            uriOrRelpath: '.schegent/reports/already-deleted.md'
          }
        });
        initialStore.writerConnection.run(
          `INSERT INTO artifact_lifecycle (
            artifact_id, lifecycle_revision, owner_run_id, owner_attempt_id, sensitivity,
            retention_class, store_kind, immutability, digest_algorithm, digest_value,
            generation, extent_bytes, byte_size, availability, producer_identity, display_name,
            created_at_ms, terminal_settled_at_ms, expires_at_ms, updated_at_ms
          ) VALUES (
            'art-e2e-deleted', 1, NULL, NULL, 'metadata',
            'generated-reports-handoff-exports', 'report', 'immutable', 'sha256', ?,
            NULL, NULL, ?, 'deleted', 'fault-matrix', 'already-deleted.md',
            ?, ?, NULL, ?
          )`,
          sha256Hex(deletedArtBytes),
          deletedArtBytes.byteLength,
          NOW,
          NOW,
          NOW
        );

        const created = await initialStore.backupRestore.createOnlineBackup({
          backupId: 'bkp-e2e-verified',
          scopeId,
          trustedRootDir: storageRoot,
          relativeBackupDirSegments: ['sqlite', scopeId, 'backups']
        });
        backupDatabasePath = created.backupDatabasePath;
        manifestPath = created.manifestPath;
        expect(created.manifest.externalDependencies).toHaveLength(1);
        expect(created.manifest.externalDependencies[0]?.referenceId).toBe('art-e2e-live');
      } finally {
        initialStore.close();
      }

      // ---- Part A: Physical live-DB header & page corruption -> detection -> offline verified-backup swap ----
      const rawBytes = await fs.readFile(liveDbPath);
      const corrupted = Buffer.from(rawBytes);
      corrupted.fill(0xff, 0, Math.min(256, corrupted.byteLength));
      if (corrupted.byteLength > 8192) {
        corrupted.fill(0xaa, 4096, 8192);
      }
      await fs.writeFile(liveDbPath, corrupted, { mode: 0o600 });
      // Plant stale `-wal` and `-shm` sidecars alongside the corrupted live DB
      await fs.writeFile(`${liveDbPath}-wal`, Buffer.from('corrupt-stale-wal'), { mode: 0o600 });
      await fs.writeFile(`${liveDbPath}-shm`, Buffer.from('corrupt-stale-shm'), { mode: 0o600 });

      // Prove corruption is detected on open / PRAGMA quick_check
      let corruptionDetected = false;
      try {
        const probeConn = new NodeSqliteConnection({ databasePath: liveDbPath, journalMode: 'wal' });
        try {
          const qc = probeConn.runQuickCheck();
          if (qc.length !== 1 || qc[0] !== 'ok') {
            corruptionDetected = true;
          }
        } finally {
          probeConn.close();
        }
      } catch {
        corruptionDetected = true;
      }
      expect(corruptionDetected).toBe(true);

      // Verify backup standalone before swapping
      const parsedManifest = parseAndValidateBackupManifest(await fs.readFile(manifestPath, 'utf8'));
      expect(parsedManifest).not.toBeNull();
      const verified = await verifyBackupStandaloneAsync({
        backupDatabasePath,
        manifest: parsedManifest!,
        trustedRootDir: storageRoot,
        inspectExternalDependency: inspector
      });
      expect(verified).toMatchObject({ status: 'verified', verifiedExternalDependencies: 1 });

      // Offline verified-backup swap: archive corrupt DB, remove stale sidecars, copy backup, narrow to 0600
      await fs.rename(liveDbPath, `${liveDbPath}.corrupt-forensic`);
      for (const suffix of ['-wal', '-shm', '-journal']) {
        await fs.rm(`${liveDbPath}${suffix}`, { force: true });
      }
      await fs.copyFile(backupDatabasePath, liveDbPath);
      const narrowRes = await narrowMode(liveDbPath, 0o600);
      expect(narrowRes.outcome === 'narrowed' || narrowRes.outcome === 'already-private').toBe(true);
      if (process.platform !== 'win32') {
        expect((await fs.lstat(liveDbPath)).mode & 0o077).toBe(0);
      }

      // Reopen recovered store -> verify full entity parity, triggers, tombstones, quick_check & FK check
      const afterOffline = new SqliteApplicationStore({ databasePath: liveDbPath, journalMode: 'wal', nowMs: () => NOW + 1_000 });
      try {
        assertIntegrityOk(afterOffline.writerConnection);
        expect(computeCanonicalSha256(readOperationalQueueMapFromDb(afterOffline.writerConnection, scopeId).map)).toBe(
          expectedQueueDigest
        );
        expect(computeCanonicalSha256(readOperationalRunMapFromDb(afterOffline.writerConnection, scopeId).map)).toBe(
          expectedRunDigest
        );
        expect(afterOffline.writerConnection.scalar(`SELECT run_id FROM runs WHERE run_id = 'run-e2e-1'`)).toBe(
          'run-e2e-1'
        );
        expect(
          afterOffline.writerConnection.scalar(
            `SELECT availability FROM artifact_lifecycle WHERE artifact_id = 'art-e2e-deleted'`
          )
        ).toBe('deleted');
        assertImmutableTriggerEnforced(afterOffline.writerConnection, handoffId);

        // ---- Part B: Openable live-DB logical fault -> online restore recovery + missing live bytes refusal ----
        afterOffline.writerConnection.run(
          `INSERT INTO runs (
            run_id, workspace_id, workflow_id, status, revision, created_at_ms, updated_at_ms
          ) VALUES ('run-unwanted-divergence', ?, 'wf-bad', 'failed', 9, ?, ?)`,
          scopeId,
          NOW + 2_000,
          NOW + 2_000
        );
        afterOffline.writerConnection.run(`DELETE FROM operational_tasks WHERE scope_id = ?`, scopeId);

        // Removing required live external bytes refuses online restore pre-commit (FR-R7-14)
        await fs.unlink(path.join(workspaceRoot, liveArtRel));
        const refusedMissing = await afterOffline.backupRestore.validateAndRestoreBackupAsync({
          backupDatabasePath,
          manifest: parsedManifest!,
          trustedRootDir: storageRoot,
          inspectExternalDependency: inspector
        });
        expect(refusedMissing).toMatchObject({
          status: 'rejected',
          outcome: 'refused_pre_commit',
          reasonCode: 'EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT'
        });

        // Restoring live external bytes allows online restore to succeed (while deleted tombstone stays absent on disk)
        await fs.writeFile(path.join(workspaceRoot, liveArtRel), liveArtBytes);
        const onlineRestored = await afterOffline.backupRestore.validateAndRestoreBackupAsync({
          backupDatabasePath,
          manifest: parsedManifest!,
          trustedRootDir: storageRoot,
          inspectExternalDependency: inspector
        });
        expect(onlineRestored).toMatchObject({
          status: 'restored',
          outcome: 'restored',
          verifiedExternalDependencies: 1
        });
        assertIntegrityOk(afterOffline.writerConnection);
      } finally {
        afterOffline.close();
      }

      // Final fresh reopen after online restore confirms full entity parity & intact triggers
      const finalReopen = new SqliteApplicationStore({ databasePath: liveDbPath, journalMode: 'wal', nowMs: () => NOW + 3_000 });
      try {
        assertIntegrityOk(finalReopen.writerConnection);
        expect(
          finalReopen.writerConnection.all<{ run_id: string }>(`SELECT run_id FROM runs ORDER BY run_id`).map((r) => r.run_id)
        ).toEqual(['run-e2e-1']);
        expect(computeCanonicalSha256(readOperationalQueueMapFromDb(finalReopen.writerConnection, scopeId).map)).toBe(
          expectedQueueDigest
        );
        expect(computeCanonicalSha256(readOperationalRunMapFromDb(finalReopen.writerConnection, scopeId).map)).toBe(
          expectedRunDigest
        );
        expect(
          finalReopen.writerConnection.scalar(
            `SELECT availability FROM artifact_lifecycle WHERE artifact_id = 'art-e2e-deleted'`
          )
        ).toBe('deleted');
        assertImmutableTriggerEnforced(finalReopen.writerConnection, handoffId);
      } finally {
        finalReopen.close();
      }
    });
  });
});
