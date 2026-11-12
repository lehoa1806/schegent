/**
 * FR-R6-F10 (F10-FR-16, F10-AC-06): Nested-repository local transactional sync
 * with compensating rollback for Master Workspace (envelope) + Execution Repository (`repo/`).
 *
 * Governance invariants:
 * - Models the two independent Git repositories as a local transactional sync with
 *   compensating rollback — never claims distributed atomicity or two-phase commit.
 * - Records both repositories' pre-sync, target, and actual observed post-sync revisions.
 * - Compensation performs only already-authorized guarded ref operations (CAS `update-ref`
 *   when the branch is not checked out, or an explicitly supplied authorized compensation
 *   callback). Whenever compensation would require unauthorized history rewriting or working-tree
 *   discard operations, both repositories' actual states are preserved and a concrete recovery
 *   action is returned.
 * - Zero `vscode` imports (docs/hard-rules.md rule 13) and zero raw filesystem paths in records.
 */

import type { LaneGitRunner } from '../execution-lanes/git-runner';
import type { NodeSqliteConnection } from '../sqlite-store';

const SYNC_DOC_NAMESPACE = 'nested-repo-sync-v1';
const GIT_TIMEOUT_MS = 15_000;
const COMMIT_HEX_PATTERN = /^[0-9a-f]{40}$/;

export type NestedSyncModel = 'local-transactional-sync';

export type NestedSyncStatus =
  | 'matched'
  | 'compensated-rolled-back'
  | 'partial-sync-preserved'
  | 'precheck-refused';

export type NestedSyncRecoveryAction =
  | 'none'
  | 'record-envelope-sync-commit'
  | 'fast-forward-execution-repo'
  | 'manual-operator-reconciliation';

export interface NestedRepoObservedState {
  readonly envelopeHead: string | null;
  readonly envelopeBranch: string | null;
  readonly recordedRepoTrailer: string | null;
  readonly executionHead: string | null;
  readonly executionBranch: string | null;
  readonly inSync: boolean;
}

export interface NestedRepoSyncRequest {
  readonly syncId?: string;
  readonly targetBranch: string;
  readonly expectedExecutionBefore: string;
  readonly executionTargetCommit: string;
  readonly expectedEnvelopeBefore: string;
  /**
   * Step that advances the envelope repository after the execution repository has advanced
   * (for example,guarded fast-forward or commit carrying `Repo-head: <executionTargetCommit>`).
   */
  readonly applyEnvelopeUpdate: (ctx: {
    readonly executionObservedCommit: string;
    readonly expectedEnvelopeBefore: string;
  }) => Promise<{ readonly ok: true; readonly envelopeCommit: string } | { readonly ok: false; readonly reason: string }>;
  /**
   * Optional explicitly authorized non-destructive compensation step. Absent by default:
   * automatic compensation uses CAS `git update-ref` ONLY when `targetBranch` is not checked
   * out in the execution repository.
   */
  readonly authorizedExecutionCompensation?: (ctx: {
    readonly fromCommit: string;
    readonly toCommit: string;
  }) => Promise<boolean>;
}

export interface NestedRepoSyncJournalRecord {
  readonly schemaVersion: 1;
  readonly model: NestedSyncModel;
  readonly syncId: string;
  readonly targetBranch: string;
  readonly expectedExecutionBefore: string;
  readonly executionTargetCommit: string;
  readonly expectedEnvelopeBefore: string;
  readonly actualExecutionRevision: string | null;
  readonly actualEnvelopeRevision: string | null;
  readonly recordedEnvelopeTrailer: string | null;
  readonly status: NestedSyncStatus;
  readonly failureReason: string | null;
  readonly compensationAttempted: boolean;
  readonly compensationOutcome: 'not-needed' | 'applied' | 'skipped-unauthorized-operation' | 'failed';
  readonly recoveryAction: NestedSyncRecoveryAction;
  readonly updatedAtIso: string;
}

export interface NestedRepoSyncCoordinatorDeps {
  readonly envelopeRoot: string;
  readonly executionRepoRoot: string;
  readonly git: LaneGitRunner;
  readonly clock?: () => number;
  readonly random?: (size: number) => Buffer;
  readonly conn?: NodeSqliteConnection | null;
}

function parseRepoHeadTrailer(commitBody: string): string | null {
  const lines = commitBody.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim() ?? '';
    const match = /^Repo-head:\s*([0-9a-f]{40})$/i.exec(line);
    if (match !== null) {
      return (match.at(1) ?? '').toLowerCase();
    }
  }
  return null;
}

async function readHeadCommit(git: LaneGitRunner, cwd: string): Promise<string | null> {
  const res = await git.run(['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS
  });
  if (!res.ok) return null;
  const trimmed = res.stdout.trim().toLowerCase();
  return COMMIT_HEX_PATTERN.test(trimmed) ? trimmed : null;
}

async function readSymbolicBranch(git: LaneGitRunner, cwd: string): Promise<string | null> {
  const res = await git.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS
  });
  if (!res.ok) return null;
  const trimmed = res.stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function readBranchCommit(
  git: LaneGitRunner,
  cwd: string,
  branchName: string
): Promise<string | null> {
  const res = await git.run(['rev-parse', '--verify', `refs/heads/${branchName}^{commit}`], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS
  });
  if (!res.ok) return null;
  const trimmed = res.stdout.trim().toLowerCase();
  return COMMIT_HEX_PATTERN.test(trimmed) ? trimmed : null;
}

async function isWorktreeClean(git: LaneGitRunner, cwd: string): Promise<boolean> {
  const res = await git.run(['status', '--porcelain=v1', '--untracked-files=normal'], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS
  });
  return res.ok && res.stdout.trim().length === 0;
}

async function isAncestor(
  git: LaneGitRunner,
  cwd: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  const res = await git.run(['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS
  });
  return res.ok;
}

async function readEnvelopeTrailer(git: LaneGitRunner, envelopeRoot: string): Promise<string | null> {
  const res = await git.run(['log', '-1', '--format=%B', 'HEAD'], {
    cwd: envelopeRoot,
    timeoutMs: GIT_TIMEOUT_MS
  });
  if (!res.ok) return null;
  return parseRepoHeadTrailer(res.stdout);
}

export class NestedRepoSyncCoordinator {
  private readonly clock: () => number;
  private readonly random: (size: number) => Buffer;
  private readonly memoryJournal = new Map<string, NestedRepoSyncJournalRecord>();

  public constructor(private readonly deps: NestedRepoSyncCoordinatorDeps) {
    this.clock = deps.clock ?? (() => Date.now());
    this.random =
      deps.random ??
      ((size: number) => {
        const buf = Buffer.alloc(size);
        for (let i = 0; i < size; i += 1) {
          buf[i] = Math.floor(Math.random() * 256);
        }
        return buf;
      });
  }

  public async observeState(): Promise<NestedRepoObservedState> {
    const [envelopeHead, envelopeBranch, recordedRepoTrailer, executionHead, executionBranch] =
      await Promise.all([
        readHeadCommit(this.deps.git, this.deps.envelopeRoot),
        readSymbolicBranch(this.deps.git, this.deps.envelopeRoot),
        readEnvelopeTrailer(this.deps.git, this.deps.envelopeRoot),
        readHeadCommit(this.deps.git, this.deps.executionRepoRoot),
        readSymbolicBranch(this.deps.git, this.deps.executionRepoRoot)
      ]);
    const inSync =
      envelopeHead !== null &&
      executionHead !== null &&
      recordedRepoTrailer !== null &&
      recordedRepoTrailer === executionHead &&
      (envelopeBranch === null || executionBranch === null || envelopeBranch === executionBranch);
    return {
      envelopeHead,
      envelopeBranch,
      recordedRepoTrailer,
      executionHead,
      executionBranch,
      inSync
    };
  }

  public async executeLocalTransactionalSync(
    request: NestedRepoSyncRequest
  ): Promise<NestedRepoSyncJournalRecord> {
    const syncId = request.syncId ?? this.random(12).toString('hex');
    const branchRef = `refs/heads/${request.targetBranch}`;

    if (
      !COMMIT_HEX_PATTERN.test(request.expectedExecutionBefore) ||
      !COMMIT_HEX_PATTERN.test(request.executionTargetCommit) ||
      !COMMIT_HEX_PATTERN.test(request.expectedEnvelopeBefore)
    ) {
      return this.persistRecord({
        schemaVersion: 1,
        model: 'local-transactional-sync',
        syncId,
        targetBranch: request.targetBranch,
        expectedExecutionBefore: request.expectedExecutionBefore,
        executionTargetCommit: request.executionTargetCommit,
        expectedEnvelopeBefore: request.expectedEnvelopeBefore,
        actualExecutionRevision: await readBranchCommit(
          this.deps.git,
          this.deps.executionRepoRoot,
          request.targetBranch
        ),
        actualEnvelopeRevision: await readHeadCommit(this.deps.git, this.deps.envelopeRoot),
        recordedEnvelopeTrailer: await readEnvelopeTrailer(this.deps.git, this.deps.envelopeRoot),
        status: 'precheck-refused',
        failureReason: 'invalid-commit-hash',
        compensationAttempted: false,
        compensationOutcome: 'not-needed',
        recoveryAction: 'none',
        updatedAtIso: new Date(this.clock()).toISOString()
      });
    }

    const [execCurrent, envCurrent, execBranch] = await Promise.all([
      readBranchCommit(this.deps.git, this.deps.executionRepoRoot, request.targetBranch),
      readHeadCommit(this.deps.git, this.deps.envelopeRoot),
      readSymbolicBranch(this.deps.git, this.deps.executionRepoRoot)
    ]);

    if (execCurrent !== request.expectedExecutionBefore || envCurrent !== request.expectedEnvelopeBefore) {
      return this.persistRecord({
        schemaVersion: 1,
        model: 'local-transactional-sync',
        syncId,
        targetBranch: request.targetBranch,
        expectedExecutionBefore: request.expectedExecutionBefore,
        executionTargetCommit: request.executionTargetCommit,
        expectedEnvelopeBefore: request.expectedEnvelopeBefore,
        actualExecutionRevision: execCurrent,
        actualEnvelopeRevision: envCurrent,
        recordedEnvelopeTrailer: await readEnvelopeTrailer(this.deps.git, this.deps.envelopeRoot),
        status: 'precheck-refused',
        failureReason:
          execCurrent !== request.expectedExecutionBefore
            ? 'execution-repo-expected-revision-mismatch'
            : 'envelope-repo-expected-revision-mismatch',
        compensationAttempted: false,
        compensationOutcome: 'not-needed',
        recoveryAction: 'manual-operator-reconciliation',
        updatedAtIso: new Date(this.clock()).toISOString()
      });
    }

    const canFf = await isAncestor(
      this.deps.git,
      this.deps.executionRepoRoot,
      request.expectedExecutionBefore,
      request.executionTargetCommit
    );
    if (!canFf) {
      return this.persistRecord({
        schemaVersion: 1,
        model: 'local-transactional-sync',
        syncId,
        targetBranch: request.targetBranch,
        expectedExecutionBefore: request.expectedExecutionBefore,
        executionTargetCommit: request.executionTargetCommit,
        expectedEnvelopeBefore: request.expectedEnvelopeBefore,
        actualExecutionRevision: execCurrent,
        actualEnvelopeRevision: envCurrent,
        recordedEnvelopeTrailer: await readEnvelopeTrailer(this.deps.git, this.deps.envelopeRoot),
        status: 'precheck-refused',
        failureReason: 'execution-target-not-fast-forward',
        compensationAttempted: false,
        compensationOutcome: 'not-needed',
        recoveryAction: 'manual-operator-reconciliation',
        updatedAtIso: new Date(this.clock()).toISOString()
      });
    }

    const checkedOutInExec = execBranch === request.targetBranch;
    if (checkedOutInExec) {
      const clean = await isWorktreeClean(this.deps.git, this.deps.executionRepoRoot);
      if (!clean) {
        return this.persistRecord({
          schemaVersion: 1,
          model: 'local-transactional-sync',
          syncId,
          targetBranch: request.targetBranch,
          expectedExecutionBefore: request.expectedExecutionBefore,
          executionTargetCommit: request.executionTargetCommit,
          expectedEnvelopeBefore: request.expectedEnvelopeBefore,
          actualExecutionRevision: execCurrent,
          actualEnvelopeRevision: envCurrent,
          recordedEnvelopeTrailer: await readEnvelopeTrailer(this.deps.git, this.deps.envelopeRoot),
          status: 'precheck-refused',
          failureReason: 'execution-worktree-dirty',
          compensationAttempted: false,
          compensationOutcome: 'not-needed',
          recoveryAction: 'none',
          updatedAtIso: new Date(this.clock()).toISOString()
        });
      }
      const ffRes = await this.deps.git.run(
        ['-c', 'merge.autoStash=false', 'merge', '--ff-only', request.executionTargetCommit],
        { cwd: this.deps.executionRepoRoot, timeoutMs: GIT_TIMEOUT_MS }
      );
      if (!ffRes.ok) {
        return this.persistRecord({
          schemaVersion: 1,
          model: 'local-transactional-sync',
          syncId,
          targetBranch: request.targetBranch,
          expectedExecutionBefore: request.expectedExecutionBefore,
          executionTargetCommit: request.executionTargetCommit,
          expectedEnvelopeBefore: request.expectedEnvelopeBefore,
          actualExecutionRevision: await readBranchCommit(
            this.deps.git,
            this.deps.executionRepoRoot,
            request.targetBranch
          ),
          actualEnvelopeRevision: await readHeadCommit(this.deps.git, this.deps.envelopeRoot),
          recordedEnvelopeTrailer: await readEnvelopeTrailer(this.deps.git, this.deps.envelopeRoot),
          status: 'precheck-refused',
          failureReason: 'execution-fast-forward-failed',
          compensationAttempted: false,
          compensationOutcome: 'not-needed',
          recoveryAction: 'manual-operator-reconciliation',
          updatedAtIso: new Date(this.clock()).toISOString()
        });
      }
    } else {
      const refRes = await this.deps.git.run(
        [
          'update-ref',
          branchRef,
          request.executionTargetCommit,
          request.expectedExecutionBefore
        ],
        { cwd: this.deps.executionRepoRoot, timeoutMs: GIT_TIMEOUT_MS }
      );
      if (!refRes.ok) {
        return this.persistRecord({
          schemaVersion: 1,
          model: 'local-transactional-sync',
          syncId,
          targetBranch: request.targetBranch,
          expectedExecutionBefore: request.expectedExecutionBefore,
          executionTargetCommit: request.executionTargetCommit,
          expectedEnvelopeBefore: request.expectedEnvelopeBefore,
          actualExecutionRevision: await readBranchCommit(
            this.deps.git,
            this.deps.executionRepoRoot,
            request.targetBranch
          ),
          actualEnvelopeRevision: await readHeadCommit(this.deps.git, this.deps.envelopeRoot),
          recordedEnvelopeTrailer: await readEnvelopeTrailer(this.deps.git, this.deps.envelopeRoot),
          status: 'precheck-refused',
          failureReason: 'execution-update-ref-failed',
          compensationAttempted: false,
          compensationOutcome: 'not-needed',
          recoveryAction: 'manual-operator-reconciliation',
          updatedAtIso: new Date(this.clock()).toISOString()
        });
      }
    }

    // Step 1 succeeded: execution repository is at executionTargetCommit. Now run Step 2 (envelope).
    const envelopeOutcome = await request.applyEnvelopeUpdate({
      executionObservedCommit: request.executionTargetCommit,
      expectedEnvelopeBefore: request.expectedEnvelopeBefore
    });

    if (envelopeOutcome.ok) {
      const [observedExec, observedEnv, observedTrailer] = await Promise.all([
        readBranchCommit(this.deps.git, this.deps.executionRepoRoot, request.targetBranch),
        readHeadCommit(this.deps.git, this.deps.envelopeRoot),
        readEnvelopeTrailer(this.deps.git, this.deps.envelopeRoot)
      ]);
      const matched =
        observedExec === request.executionTargetCommit &&
        observedTrailer === request.executionTargetCommit;
      return this.persistRecord({
        schemaVersion: 1,
        model: 'local-transactional-sync',
        syncId,
        targetBranch: request.targetBranch,
        expectedExecutionBefore: request.expectedExecutionBefore,
        executionTargetCommit: request.executionTargetCommit,
        expectedEnvelopeBefore: request.expectedEnvelopeBefore,
        actualExecutionRevision: observedExec,
        actualEnvelopeRevision: observedEnv,
        recordedEnvelopeTrailer: observedTrailer,
        status: matched ? 'matched' : 'partial-sync-preserved',
        failureReason: matched ? null : 'envelope-trailer-mismatch',
        compensationAttempted: false,
        compensationOutcome: 'not-needed',
        recoveryAction: matched ? 'none' : 'record-envelope-sync-commit',
        updatedAtIso: new Date(this.clock()).toISOString()
      });
    }

    // Step 2 failed! Evaluate compensating rollback under governance rules (F10-FR-16):
    // - Never run unauthorized history/worktree rewrite on a checked-out working tree.
    // - If `targetBranch` is NOT checked out, a guarded CAS `update-ref` back to
    //   `expectedExecutionBefore` does not touch any working tree or discard any commit object.
    // - If `authorizedExecutionCompensation` was explicitly supplied, delegate to it.
    let compensationAttempted = false;
    let compensationOutcome: NestedRepoSyncJournalRecord['compensationOutcome'] =
      'skipped-unauthorized-operation';

    if (request.authorizedExecutionCompensation !== undefined) {
      compensationAttempted = true;
      const compensated = await request.authorizedExecutionCompensation({
        fromCommit: request.executionTargetCommit,
        toCommit: request.expectedExecutionBefore
      });
      compensationOutcome = compensated ? 'applied' : 'failed';
    } else if (!checkedOutInExec) {
      compensationAttempted = true;
      const rollbackRef = await this.deps.git.run(
        [
          'update-ref',
          branchRef,
          request.expectedExecutionBefore,
          request.executionTargetCommit
        ],
        { cwd: this.deps.executionRepoRoot, timeoutMs: GIT_TIMEOUT_MS }
      );
      compensationOutcome = rollbackRef.ok ? 'applied' : 'failed';
    }

    const [postExec, postEnv, postTrailer] = await Promise.all([
      readBranchCommit(this.deps.git, this.deps.executionRepoRoot, request.targetBranch),
      readHeadCommit(this.deps.git, this.deps.envelopeRoot),
      readEnvelopeTrailer(this.deps.git, this.deps.envelopeRoot)
    ]);

    const rolledBackCleanly =
      compensationOutcome === 'applied' &&
      postExec === request.expectedExecutionBefore &&
      postEnv === request.expectedEnvelopeBefore;

    return this.persistRecord({
      schemaVersion: 1,
      model: 'local-transactional-sync',
      syncId,
      targetBranch: request.targetBranch,
      expectedExecutionBefore: request.expectedExecutionBefore,
      executionTargetCommit: request.executionTargetCommit,
      expectedEnvelopeBefore: request.expectedEnvelopeBefore,
      actualExecutionRevision: postExec,
      actualEnvelopeRevision: postEnv,
      recordedEnvelopeTrailer: postTrailer,
      status: rolledBackCleanly ? 'compensated-rolled-back' : 'partial-sync-preserved',
      failureReason: envelopeOutcome.reason,
      compensationAttempted,
      compensationOutcome,
      recoveryAction: rolledBackCleanly ? 'none' : 'record-envelope-sync-commit',
      updatedAtIso: new Date(this.clock()).toISOString()
    });
  }

  public getJournalRecord(syncId: string): NestedRepoSyncJournalRecord | null {
    if (this.deps.conn) {
      const row = this.deps.conn.get<{ readonly payload_json: string }>(
        `SELECT payload_json FROM operational_kv_documents WHERE doc_namespace = ? AND doc_key = ?`,
        SYNC_DOC_NAMESPACE,
        syncId
      );
      if (row !== undefined) {
        try {
          return JSON.parse(row.payload_json) as NestedRepoSyncJournalRecord;
        } catch {
          return null;
        }
      }
    }
    return this.memoryJournal.get(syncId) ?? null;
  }

  private persistRecord(record: NestedRepoSyncJournalRecord): NestedRepoSyncJournalRecord {
    const frozen = Object.freeze(record);
    this.memoryJournal.set(record.syncId, frozen);
    if (this.deps.conn) {
      const json = JSON.stringify(frozen);
      this.deps.conn.run(
        `INSERT INTO operational_kv_documents (
          doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms
        ) VALUES (?, ?, 1, 1, ?, ?, 1, ?)
        ON CONFLICT(doc_namespace, doc_key) DO UPDATE SET
          revision = operational_kv_documents.revision + 1,
          payload_json = excluded.payload_json,
          payload_bytes = excluded.payload_bytes,
          updated_at_ms = excluded.updated_at_ms`,
        SYNC_DOC_NAMESPACE,
        record.syncId,
        json,
        Buffer.byteLength(json, 'utf8'),
        this.clock()
      );
    }
    return frozen;
  }
}

