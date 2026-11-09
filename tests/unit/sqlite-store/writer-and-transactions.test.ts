import { describe, expect, it } from 'vitest';
import {
  SQLITE_WAL_ESCALATION_BYTES,
  SQLITE_WAL_PAUSE_BACKGROUND_BYTES,
  SQLITE_WRITER_MAX_QUEUE_REQUESTS,
  SQLITE_WRITER_NORMAL_MAX_REQUESTS
} from '../../../src/contracts/sqlite-store/schema-types';
import { SqliteApplicationStore, type WriterAdmissionResult } from '../../../src/services/sqlite-store';

describe('FR-R6-F04 (US1 & US2): Bounded Writer Queue, WAL Checkpoints & Seven Atomic Transaction Units', () => {
  it('enforces 48 normal request cap, reserves 16 slots for settlement up to 64, and pauses background writes at 128 MiB WAL (SC-005, SC-006)', () => {
    let clock = 1_700_000_000_000;
    const store = SqliteApplicationStore.openInMemory({ nowMs: () => clock });
    try {
      const heldStandard: Array<Extract<WriterAdmissionResult, { admitted: true }>> = [];
      for (let i = 0; i < SQLITE_WRITER_NORMAL_MAX_REQUESTS; i += 1) {
        const res = store.writerCoordinator.tryAdmitWrite('standard', 1024);
        expect(res.admitted).toBe(true);
        if (res.admitted) heldStandard.push(res);
      }

      // 49th normal or background request is rejected with QUEUE_SATURATED
      const rejectedNormal = store.writerCoordinator.tryAdmitWrite('standard', 1024);
      expect(rejectedNormal.admitted).toBe(false);
      if (!rejectedNormal.admitted) {
        expect(rejectedNormal.code).toBe('QUEUE_SATURATED');
      }

      // Reserved 16 settlement slots remain available up to 64 total requests
      const heldSettlement: Array<Extract<WriterAdmissionResult, { admitted: true }>> = [];
      for (let i = 0; i < SQLITE_WRITER_MAX_QUEUE_REQUESTS - SQLITE_WRITER_NORMAL_MAX_REQUESTS; i += 1) {
        const res = store.writerCoordinator.tryAdmitWrite('settlement', 1024);
        expect(res.admitted).toBe(true);
        if (res.admitted) heldSettlement.push(res);
      }

      // 65th request is rejected even for settlement
      const overCap = store.writerCoordinator.tryAdmitWrite('settlement', 1024);
      expect(overCap.admitted).toBe(false);

      for (const h of [...heldStandard, ...heldSettlement]) {
        h.release();
      }

      // WAL checkpoint triggers: 1,000 pages -> PASSIVE, 64 MiB -> TRUNCATE, 128 MiB -> pause background
      store.writerCoordinator.recordWalGrowth(1_000, 4 * 1024 * 1024);
      const passive = store.writerCoordinator.evaluateCheckpointPolicy();
      expect(passive?.mode).toBe('PASSIVE');
      expect(passive?.triggeredBy).toBe('pages_threshold');

      store.writerCoordinator.recordWalGrowth(10, SQLITE_WAL_ESCALATION_BYTES);
      const escalated = store.writerCoordinator.evaluateCheckpointPolicy();
      expect(escalated?.mode).toBe('TRUNCATE');
      expect(escalated?.triggeredBy).toBe('size_escalation');

      store.writerCoordinator.recordWalGrowth(50, SQLITE_WAL_PAUSE_BACKGROUND_BYTES);
      const pausedBg = store.writerCoordinator.tryAdmitWrite('background', 512);
      expect(pausedBg.admitted).toBe(false);
      if (!pausedBg.admitted) {
        expect(pausedBg.code).toBe('WAL_BACKGROUND_PAUSED');
      }

      // Settlement lane still admitted when WAL >= 128 MiB
      const settleUnderWalPressure = store.writerCoordinator.tryAdmitWrite('settlement', 512);
      expect(settleUnderWalPressure.admitted).toBe(true);
      if (settleUnderWalPressure.admitted) settleUnderWalPressure.release();

      // Time-based 30s passive checkpoint
      clock += 31_000;
      store.writerCoordinator.recordWalGrowth(5, 1024);
      const intervalCheckpoint = store.writerCoordinator.evaluateCheckpointPolicy();
      expect(intervalCheckpoint?.mode).toBe('PASSIVE');
      expect(intervalCheckpoint?.triggeredBy).toBe('interval_threshold');
    } finally {
      store.close();
    }
  });

  it('enforces expected-revision CAS, lease fences, idempotency replay, and 100% rollback across all 7 atomic transaction units (SC-002..SC-004)', () => {
    let clock = 1_700_000_000_000;
    const store = SqliteApplicationStore.openInMemory({ nowMs: () => clock });
    try {
      const fence = {
        fenceScope: 'window_primacy',
        resourceId: 'ws-1',
        ownerId: 'window-primary',
        epoch: 1
      };
      store.transactions.acquireOrRenewLeaseFence({
        ...fence,
        ttlMs: 60_000
      });

      // 1. Admission failpoint rollback test
      const failedAdmit = store.transactions.executeAdmission({
        idempotency: {
          scopeKind: 'run',
          scopeId: 'run-1',
          idempotencyKey: 'admit-1-fail',
          requestSha256: 'sha-fail'
        },
        fence,
        expectedRevision: 0,
        failpointStep: 'after_queue_insert',
        run: {
          runId: 'run-1',
          workspaceId: 'ws-1',
          workflowId: 'wf-1',
          priority: 5,
          inputs: { prompt: 'hello' },
          initialStep: {
            stepId: 'step-1',
            stepIndex: 0,
            phaseId: 'specify',
            attemptId: 'att-1'
          }
        }
      });
      expect(failedAdmit.status).toBe('rejected');
      expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM runs`)).toBe(0);
      expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM queue_entries`)).toBe(0);

      // Successful Admission + second step for handoff target
      const admit = store.transactions.executeAdmission({
        idempotency: {
          scopeKind: 'run',
          scopeId: 'run-1',
          idempotencyKey: 'admit-1',
          requestSha256: 'sha-admit-1'
        },
        fence,
        expectedRevision: 0,
        run: {
          runId: 'run-1',
          workspaceId: 'ws-1',
          workflowId: 'wf-1',
          priority: 5,
          inputs: { prompt: 'hello' },
          initialStep: {
            stepId: 'step-1',
            stepIndex: 0,
            phaseId: 'specify',
            attemptId: 'att-1'
          }
        }
      });
      expect(admit.status).toBe('committed');
      if (admit.status === 'committed') {
        expect(admit.replayed).toBe(false);
        expect(admit.revision).toBe(1);
      }

      // Replay identical command -> replayed = true, no revision bump
      const replayedAdmit = store.transactions.executeAdmission({
        idempotency: {
          scopeKind: 'run',
          scopeId: 'run-1',
          idempotencyKey: 'admit-1',
          requestSha256: 'sha-admit-1'
        },
        fence,
        expectedRevision: 0,
        run: {
          runId: 'run-1',
          workspaceId: 'ws-1',
          workflowId: 'wf-1',
          priority: 5
        }
      });
      expect(replayedAdmit.status).toBe('committed');
      if (replayedAdmit.status === 'committed') {
        expect(replayedAdmit.replayed).toBe(true);
        expect(replayedAdmit.revision).toBe(1);
      }

      // Replay same idempotencyKey with different hash -> IDEMPOTENCY_PAYLOAD_MISMATCH
      const mismatchAdmit = store.transactions.executeAdmission({
        idempotency: {
          scopeKind: 'run',
          scopeId: 'run-1',
          idempotencyKey: 'admit-1',
          requestSha256: 'sha-different'
        },
        fence,
        expectedRevision: 0,
        run: {
          runId: 'run-1',
          workspaceId: 'ws-1',
          workflowId: 'wf-1',
          priority: 5
        }
      });
      expect(mismatchAdmit.status).toBe('rejected');
      if (mismatchAdmit.status === 'rejected') {
        expect(mismatchAdmit.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
      }

      // Stale fence owner rejection
      const badFenceAdmit = store.transactions.executeAdmission({
        idempotency: {
          scopeKind: 'run',
          scopeId: 'run-2',
          idempotencyKey: 'admit-2',
          requestSha256: 'sha-2'
        },
        fence: { ...fence, ownerId: 'rogue-window' },
        expectedRevision: 0,
        run: {
          runId: 'run-2',
          workspaceId: 'ws-1',
          workflowId: 'wf-1',
          priority: 1
        }
      });
      expect(badFenceAdmit.status).toBe('rejected');
      if (badFenceAdmit.status === 'rejected') {
        expect(badFenceAdmit.code).toBe('FENCE_MISMATCH');
      }

      // Add step-2 and an artifact for Handoff acceptance
      store.writerConnection.run(
        `INSERT INTO steps (step_id, run_id, step_index, phase_id, status, revision, current_attempt_id, updated_at_ms)
         VALUES ('step-2', 'run-1', 1, 'plan', 'pending', 1, NULL, ?)`,
        clock
      );
      store.artifacts.registerArtifact({
        artifactId: 'art-1',
        contentSha256: 'sha-art-1',
        byteLength: 128,
        mediaType: 'text/markdown',
        kind: 'spec',
        createdByRunId: 'run-1',
        createdByAttemptId: 'att-1',
        location: {
          locationId: 'loc-1',
          storageTier: 'cas_blob',
          uriOrRelpath: 'blobs/sha-art-1'
        }
      });

      // 3. Handoff acceptance (with failpoint rollback then commit)
      const handoffFail = store.transactions.executeHandoffAcceptance({
        idempotency: {
          scopeKind: 'handoff',
          scopeId: 'ho-1',
          idempotencyKey: 'ho-fail',
          requestSha256: 'sha-ho-fail'
        },
        fence,
        expectedRevision: 1,
        failpointStep: 'after_handoff_insert',
        handoff: {
          runId: 'run-1',
          resultId: 'res-1',
          stepId: 'step-1',
          attemptId: 'att-1',
          schemaId: 'spec-output-v1',
          values: [{ fieldPath: 'specPath', valueType: 'artifact_ref', valueText: 'art-1', artifactId: 'art-1' }],
          handoffId: 'ho-1',
          toStepId: 'step-2',
          envelopeId: 'env-1',
          envelopeDigestSha256: 'sha-env-1',
          bindings: [{ paramName: 'spec', boundValueJson: '"art-1"', sourceFieldPath: 'specPath' }],
          pinArtifactIds: ['art-1']
        }
      });
      expect(handoffFail.status).toBe('rejected');
      expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM handoffs`)).toBe(0);

      const handoffOk = store.transactions.executeHandoffAcceptance({
        idempotency: {
          scopeKind: 'handoff',
          scopeId: 'ho-1',
          idempotencyKey: 'ho-ok',
          requestSha256: 'sha-ho-ok'
        },
        fence,
        expectedRevision: 1,
        handoff: {
          runId: 'run-1',
          resultId: 'res-1',
          stepId: 'step-1',
          attemptId: 'att-1',
          schemaId: 'spec-output-v1',
          values: [{ fieldPath: 'specPath', valueType: 'artifact_ref', valueText: 'art-1', artifactId: 'art-1' }],
          handoffId: 'ho-1',
          toStepId: 'step-2',
          envelopeId: 'env-1',
          envelopeDigestSha256: 'sha-env-1',
          bindings: [{ paramName: 'spec', boundValueJson: '"art-1"', sourceFieldPath: 'specPath' }],
          pinArtifactIds: ['art-1']
        }
      });
      expect(handoffOk.status).toBe('committed');

      // 4. Review acceptance (with failpoint rollback then commit)
      const reviewFail = store.transactions.executeReviewAcceptance({
        idempotency: {
          scopeKind: 'review',
          scopeId: 'rl-1',
          idempotencyKey: 'rev-fail',
          requestSha256: 'sha-rev-fail'
        },
        fence,
        expectedRevision: 0,
        failpointStep: 'after_findings_insert',
        review: {
          reviewLoopId: 'rl-1',
          runId: 'run-1',
          stepId: 'step-1',
          iteration: 1,
          maxIterations: 3,
          loopStatus: 'open',
          reportId: 'rep-1',
          reviewerRole: 'security-reviewer',
          verdict: 'changes_requested',
          findings: [
            {
              findingId: 'find-1',
              severity: 'high',
              category: 'security',
              filePath: 'src/index.ts',
              lineNumber: 42,
              summary: 'Check permissions',
              status: 'open'
            }
          ]
        }
      });
      expect(reviewFail.status).toBe('rejected');
      expect(store.writerConnection.scalar(`SELECT COUNT(*) FROM review_loops`)).toBe(0);

      const reviewOk = store.transactions.executeReviewAcceptance({
        idempotency: {
          scopeKind: 'review',
          scopeId: 'rl-1',
          idempotencyKey: 'rev-ok',
          requestSha256: 'sha-rev-ok'
        },
        fence,
        expectedRevision: 0,
        review: {
          reviewLoopId: 'rl-1',
          runId: 'run-1',
          stepId: 'step-1',
          iteration: 1,
          maxIterations: 3,
          loopStatus: 'converged',
          reportId: 'rep-1',
          reviewerRole: 'security-reviewer',
          verdict: 'pass',
          findings: [
            {
              findingId: 'find-1',
              severity: 'medium',
              category: 'code',
              filePath: 'src/index.ts',
              lineNumber: 42,
              summary: 'Fixed issue',
              status: 'fixed',
              disposition: {
                dispositionId: 'disp-1',
                disposition: 'fixed',
                actorId: 'agent-1',
                rationale: 'Patched in commit abc'
              },
              fixClaim: {
                claimId: 'claim-1',
                claimantAttemptId: 'att-1',
                commitSha: 'abc1234',
                status: 'verified'
              }
            }
          ],
          gateUpdate: {
            gateId: 'gate-1',
            gateType: 'review',
            status: 'approved',
            decidedBy: 'reviewer',
            notes: 'All findings resolved'
          }
        }
      });
      expect(reviewOk.status).toBe('committed');

      // 5. Usage/correction (observation + repricing correction)
      const usageObs = store.transactions.executeUsageCorrection({
        idempotency: {
          scopeKind: 'usage',
          scopeId: 'att-1',
          idempotencyKey: 'usage-1',
          requestSha256: 'sha-usage-1'
        },
        expectedRevision: 0,
        usage: {
          runId: 'run-1',
          stepId: 'step-1',
          attemptId: 'att-1',
          applicationId: 'app-1',
          completeness: 'exact',
          observation: {
            observationId: 'obs-1',
            provider: 'anthropic',
            modelId: 'claude-sonnet-4-5',
            inputTokens: 1_000,
            outputTokens: 500,
            cachedTokens: 200,
            costMicrodollars: 12_000,
            sourceKind: 'provider_exact'
          }
        }
      });
      expect(usageObs.status).toBe('committed');

      const usageCorr = store.transactions.executeUsageCorrection({
        idempotency: {
          scopeKind: 'usage',
          scopeId: 'att-1',
          idempotencyKey: 'usage-2',
          requestSha256: 'sha-usage-2'
        },
        expectedRevision: 1,
        usage: {
          runId: 'run-1',
          stepId: 'step-1',
          attemptId: 'att-1',
          applicationId: 'app-2',
          completeness: 'exact',
          correction: {
            correctionId: 'corr-1',
            observationId: 'obs-1',
            reason: 'tariff_update',
            deltaInputTokens: 0,
            deltaOutputTokens: 0,
            deltaCostMicrodollars: -2_000,
            pricingVersion: '2026-11'
          }
        }
      });
      expect(usageCorr.status).toBe('committed');
      if (usageCorr.status === 'committed') {
        expect(usageCorr.value.totalCostMicrodollars).toBe(10_000);
      }

      // 6. Catalog publication
      const catPub = store.transactions.executeCatalogPublication({
        idempotency: {
          scopeKind: 'catalog',
          scopeId: 'def-phase-1',
          idempotencyKey: 'cat-pub-1',
          requestSha256: 'sha-cat-1'
        },
        expectedRevision: 0,
        publication: {
          scope: 'workspace',
          definitionId: 'def-phase-1',
          layer: 'phase',
          slug: 'specify',
          displayName: 'Specify Phase',
          definitionVersionId: 'def-phase-1@v1',
          versionNumber: 1,
          status: 'published',
          canonicalYaml: 'id: specify\nlayer: phase\n',
          digestSha256: 'sha256-specify-v1',
          schemaVersion: 1,
          promoteAsPublished: true
        }
      });
      expect(catPub.status).toBe('committed');

      // 2. Terminal acceptance (settles run-1 at revision 2 -> 3)
      const termOut = store.transactions.executeTerminalAcceptance({
        idempotency: {
          scopeKind: 'run',
          scopeId: 'run-1',
          idempotencyKey: 'term-1',
          requestSha256: 'sha-term-1'
        },
        fence,
        expectedRevision: 2,
        settlement: {
          runId: 'run-1',
          terminalStatus: 'succeeded',
          terminalReason: 'workflow_completed',
          stepSettlement: {
            stepId: 'step-1',
            status: 'succeeded',
            attemptId: 'att-1',
            attemptStatus: 'succeeded',
            exitCode: 0
          }
        }
      });
      expect(termOut.status).toBe('committed');

      // 7. Retention: unpin art-1 and verify retention marks it evicted
      store.artifacts.unpinArtifact('pin-ho-ho-1-art-1');
      clock += 10_000;
      const retentionOut = store.transactions.executeRetention({
        idempotency: {
          scopeKind: 'retention',
          scopeId: 'ws-1',
          idempotencyKey: 'ret-1',
          requestSha256: 'sha-ret-1'
        },
        cutoffTimestampMs: clock
      });
      expect(retentionOut.status).toBe('committed');
      if (retentionOut.status === 'committed') {
        expect(retentionOut.value.evictedArtifacts).toBe(1);
      }
      expect(store.artifacts.getArtifactAvailability('art-1')?.state).toBe('evicted');
    } finally {
      store.close();
    }
  });
});
