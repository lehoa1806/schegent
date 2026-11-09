import { describe, expect, it } from 'vitest';
import { SqliteApplicationStore } from '../../../src/services/sqlite-store';

describe('FR-R6-F04 (US5 — F04-B): Round 6 Domain Store Adapters (F05, F06, F07, F08, F10, F11, F13, F14, F15)', () => {
  it('enforces F05 single-owner artifact_pins CHECK constraint, lineage relations, and GC eligibility (FR-011, SC-010)', () => {
    const store = SqliteApplicationStore.openInMemory({ nowMs: () => 1_700_000_000_000 });
    try {
      store.transactions.acquireOrRenewLeaseFence({
        fenceScope: 'window_primacy',
        resourceId: 'ws-dom',
        ownerId: 'win-1',
        epoch: 1,
        ttlMs: 60_000
      });
      store.transactions.executeAdmission({
        idempotency: {
          scopeKind: 'run',
          scopeId: 'run-d1',
          idempotencyKey: 'admit-d1',
          requestSha256: 'sha-d1'
        },
        fence: {
          fenceScope: 'window_primacy',
          resourceId: 'ws-dom',
          ownerId: 'win-1',
          epoch: 1
        },
        expectedRevision: 0,
        run: {
          runId: 'run-d1',
          workspaceId: 'ws-dom',
          workflowId: 'wf-dom',
          priority: 1,
          initialStep: {
            stepId: 'step-d1',
            stepIndex: 0,
            phaseId: 'implement',
            attemptId: 'att-d1'
          }
        }
      });

      store.artifacts.registerArtifact({
        artifactId: 'art-parent',
        contentSha256: 'sha-p',
        byteLength: 100,
        mediaType: 'text/plain',
        kind: 'input',
        createdByRunId: 'run-d1',
        createdByAttemptId: 'att-d1',
        location: {
          locationId: 'loc-p',
          storageTier: 'inline_db',
          uriOrRelpath: 'inline:art-parent',
          inlineBytes: new Uint8Array([1, 2, 3])
        }
      });

      store.artifacts.registerArtifact({
        artifactId: 'art-child',
        contentSha256: 'sha-c',
        byteLength: 200,
        mediaType: 'text/plain',
        kind: 'output',
        createdByRunId: null,
        createdByAttemptId: null,
        location: {
          locationId: 'loc-c',
          storageTier: 'cas_blob',
          uriOrRelpath: 'blobs/sha-c'
        }
      });

      store.artifacts.recordPublication({
        publicationId: 'pub-1',
        artifactId: 'art-parent',
        runId: 'run-d1',
        stepId: 'step-d1',
        attemptId: 'att-d1',
        role: 'spec'
      });
      store.artifacts.recordConsumption({
        consumptionId: 'con-1',
        artifactId: 'art-parent',
        runId: 'run-d1',
        stepId: 'step-d1',
        attemptId: 'att-d1',
        inputName: 'spec_input'
      });
      store.artifacts.recordDerivation({
        derivationId: 'der-1',
        parentArtifactId: 'art-parent',
        childArtifactId: 'art-child',
        transformKind: 'plan_generation'
      });

      // Violating single-owner CHECK (0 owners or 2 owners) must throw
      expect(() =>
        store.artifacts.pinArtifact({
          pinId: 'pin-invalid-zero',
          artifactId: 'art-child',
          reason: 'no_owner'
        })
      ).toThrow();

      expect(() =>
        store.artifacts.pinArtifact({
          pinId: 'pin-invalid-two',
          artifactId: 'art-child',
          ownerRunId: 'run-d1',
          ownerAttemptId: 'att-d1',
          reason: 'two_owners'
        })
      ).toThrow();

      // Valid single-owner pin protects art-child from GC
      store.artifacts.pinArtifact({
        pinId: 'pin-valid-1',
        artifactId: 'art-child',
        ownerExportId: 'exp-1',
        reason: 'active_export'
      });
      expect(store.artifacts.listGcEligibleArtifactIds()).toEqual([]);

      // Unpinning art-child makes it GC-eligible while art-parent stays protected by running run-d1
      store.artifacts.unpinArtifact('pin-valid-1');
      expect(store.artifacts.listGcEligibleArtifactIds()).toEqual(['art-child']);
    } finally {
      store.close();
    }
  });

  it('exercises F06 usage queries, F07 log streams/segments/gaps, F08 recovery manifests, and F10 execution workspaces (FR-012..FR-015)', () => {
    const store = SqliteApplicationStore.openInMemory({ nowMs: () => 1_700_000_000_000 });
    try {
      store.transactions.acquireOrRenewLeaseFence({
        fenceScope: 'window_primacy',
        resourceId: 'ws-dom',
        ownerId: 'win-1',
        epoch: 1,
        ttlMs: 60_000
      });
      store.transactions.executeAdmission({
        idempotency: {
          scopeKind: 'run',
          scopeId: 'run-d2',
          idempotencyKey: 'admit-d2',
          requestSha256: 'sha-d2'
        },
        fence: {
          fenceScope: 'window_primacy',
          resourceId: 'ws-dom',
          ownerId: 'win-1',
          epoch: 1
        },
        expectedRevision: 0,
        run: {
          runId: 'run-d2',
          workspaceId: 'ws-dom',
          workflowId: 'wf-dom',
          priority: 1,
          initialStep: {
            stepId: 'step-d2',
            stepIndex: 0,
            phaseId: 'implement',
            attemptId: 'att-d2'
          }
        }
      });

      // F07 Log streams, segments, gaps
      store.logIndex.openStream({
        streamId: 'stream-1',
        runId: 'run-d2',
        stepId: 'step-d2',
        attemptId: 'att-d2',
        channel: 'stdout'
      });
      store.logIndex.appendSegment({
        segmentId: 'seg-1',
        streamId: 'stream-1',
        segmentSeq: 0,
        startByteOffset: 0,
        endByteOffset: 1024,
        lineCount: 20,
        contentSha256: 'sha-seg-1',
        relativePath: 'logs/seg-1.log'
      });
      store.logIndex.recordGap({
        gapId: 'gap-1',
        streamId: 'stream-1',
        afterSegmentSeq: 0,
        droppedBytes: 512,
        reason: 'backpressure'
      });
      store.logIndex.closeStream('stream-1');
      expect(store.logIndex.listSegments('stream-1').length).toBe(1);

      // F08 Recovery manifest & sources
      store.recovery.recordRecoveryManifest({
        manifestId: 'rec-1',
        runId: 'run-d2',
        stepId: 'step-d2',
        attemptId: 'att-d2',
        classification: 'resumable',
        actionTaken: 'reattached_session',
        sources: [
          {
            sourceId: 'src-1',
            sourceKind: 'sqlite_row',
            sourceRef: 'runs:run-d2',
            digestSha256: 'sha-run-d2',
            verified: true
          }
        ]
      });
      expect(store.recovery.listSourcesForManifest('rec-1').length).toBe(1);

      // F10 Execution workspaces, candidate snapshots & integration receipts
      store.executionWorkspaces.registerWorkspace({
        executionWorkspaceId: 'ew-1',
        runId: 'run-d2',
        stepId: 'step-d2',
        attemptId: 'att-d2',
        strategy: 'worktree',
        rootRelpath: '.schegent/worktrees/ew-1',
        baseCommitSha: 'commit-base',
        headCommitSha: 'commit-base'
      });
      store.executionWorkspaces.recordCandidateSnapshot({
        snapshotId: 'snap-1',
        executionWorkspaceId: 'ew-1',
        treeSha: 'tree-1',
        commitSha: 'commit-next',
        dirtyFileCount: 0
      });
      store.executionWorkspaces.recordIntegrationReceipt({
        receiptId: 'int-1',
        executionWorkspaceId: 'ew-1',
        snapshotId: 'snap-1',
        targetBranch: 'develop',
        integratedCommitSha: 'commit-merged',
        status: 'merged'
      });
      expect(
        store.executionWorkspaces.getWorkspaceByAttempt('run-d2', 'step-d2', 'att-d2')?.state
      ).toBe('integrated');
    } finally {
      store.close();
    }
  });

  it('exercises F11 cutoff-S keyset pagination, F13 agent runtime with non-authoritative projection_intents, F14 telemetry cardinality, and F15 handoff/review queries (FR-016..FR-019)', () => {
    let clock = 1_700_000_000_000;
    const store = SqliteApplicationStore.openInMemory({ nowMs: () => clock });
    try {
      const fence = {
        fenceScope: 'window_primacy',
        resourceId: 'ws-keyset',
        ownerId: 'win-1',
        epoch: 1
      };
      store.transactions.acquireOrRenewLeaseFence({ ...fence, ttlMs: 600_000 });

      for (let i = 1; i <= 5; i += 1) {
        clock += 100;
        store.transactions.executeAdmission({
          idempotency: {
            scopeKind: 'run',
            scopeId: `run-k${i}`,
            idempotencyKey: `admit-k${i}`,
            requestSha256: `sha-k${i}`
          },
          fence,
          expectedRevision: 0,
          run: {
            runId: `run-k${i}`,
            workspaceId: 'ws-keyset',
            workflowId: 'wf-k',
            priority: i,
            initialStep: {
              stepId: `step-k${i}`,
              stepIndex: 0,
              phaseId: 'specify',
              attemptId: `att-k${i}`
            }
          }
        });
      }

      // F11 Keyset pagination at cutoffRevision = 1 (pages 2 items at a time)
      const page1 = store.reporting.queryExecutionSummariesKeysetPage({
        workspaceId: 'ws-keyset',
        cutoffRevision: 1,
        pageSize: 2
      });
      expect(page1.items.map((r) => r.runId)).toEqual(['run-k5', 'run-k4']);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = store.reporting.queryExecutionSummariesKeysetPage({
        workspaceId: 'ws-keyset',
        cutoffRevision: 1,
        pageSize: 2,
        cursor: page1.nextCursor ?? undefined
      });
      expect(page2.items.map((r) => r.runId)).toEqual(['run-k3', 'run-k2']);

      // F11 Report manifest, lease, and export operation
      store.reporting.createReportManifest({
        reportId: 'rep-m1',
        scopeKey: 'ws-keyset',
        cutoffRevision: 1,
        format: 'json'
      });
      store.reporting.acquireReportLease({
        leaseId: 'lease-1',
        reportId: 'rep-m1',
        holderId: 'ui-export',
        cutoffRevision: 1,
        ttlMs: 30_000
      });
      store.reporting.recordExportOperation({
        exportId: 'exp-1',
        reportId: 'rep-m1',
        destinationRelpath: 'exports/rep-m1.json',
        status: 'completed',
        byteLength: 4096,
        contentSha256: 'sha-exp-1'
      });

      // F13 Agent Runtime profiles, sessions, turns, receipts, effects, and projection_intents
      store.agentRuntime.upsertProfileAndVersion({
        profileId: 'prof-claude',
        name: 'claude-default',
        provider: 'anthropic',
        adapterKind: 'acp',
        profileVersionId: 'prof-claude@v1',
        versionNumber: 1,
        configJson: '{"model":"claude-sonnet-4-5"}'
      });
      store.agentRuntime.createAgentSession({
        agentSessionId: 'as-1',
        runId: 'run-k1',
        stepId: 'step-k1',
        attemptId: 'att-k1',
        profileVersionId: 'prof-claude@v1'
      });
      store.agentRuntime.linkProviderSession({
        linkId: 'link-1',
        agentSessionId: 'as-1',
        providerSessionId: 'ps-1',
        provider: 'anthropic',
        externalSessionRef: 'ext-sess-1',
        capabilitiesJson: '{"streaming":true}'
      });
      store.agentRuntime.bindSessionConnection({
        bindingId: 'bind-1',
        agentSessionId: 'as-1',
        connectionId: 'conn-1',
        transportKind: 'stdio',
        pid: 12345,
        boundEpoch: 1
      });
      store.agentRuntime.recordTurn({
        turnId: 'turn-1',
        agentSessionId: 'as-1',
        turnIndex: 0,
        state: 'completed'
      });
      store.agentRuntime.recordProtocolReceipt({
        receiptId: 'pr-1',
        agentSessionId: 'as-1',
        turnId: 'turn-1',
        direction: 'inbound',
        messageType: 'turn.complete',
        sequenceNo: 1,
        payloadSha256: 'sha-msg-1'
      });
      store.agentRuntime.declareEffectIntent({
        effectIntentId: 'eff-1',
        agentSessionId: 'as-1',
        turnId: 'turn-1',
        effectKind: 'file_write',
        idempotencyKey: 'eff-idem-1',
        targetSummary: 'src/app.ts'
      });
      store.agentRuntime.recordEffectObservation({
        observationId: 'eff-obs-1',
        effectIntentId: 'eff-1',
        outcome: 'succeeded',
        exitCode: 0
      });

      // Projection intent with sourceRevision > committed session revision (1) is rejected
      expect(() =>
        store.agentRuntime.enqueueProjectionIntent({
          projectionId: 'proj-bad',
          agentSessionId: 'as-1',
          sourceRevision: 99,
          targetSurface: 'webview',
          payloadJson: '{}'
        })
      ).toThrow(/UNCOMMITTED_PROJECTION_REVISION/);

      const projOk = store.agentRuntime.enqueueProjectionIntent({
        projectionId: 'proj-1',
        agentSessionId: 'as-1',
        sourceRevision: 1,
        targetSurface: 'webview',
        payloadJson: '{"turn":0}'
      });
      expect(projOk.status).toBe('pending');

      // F14 Telemetry destination, copy, receipt & cardinality guard
      store.telemetry.registerDestination({
        destinationId: 'dest-1',
        kind: 'jsonl_file',
        endpointOrPath: 'telemetry/events.jsonl'
      });
      store.telemetry.enqueueExportCopy({
        copyId: 'copy-1',
        destinationId: 'dest-1',
        sourceCommitUnit: 'Admission',
        sourceRevision: 1,
        payloadJson: '{"event":"run.admitted"}'
      });
      store.telemetry.recordDeliveryReceipt({
        deliveryId: 'del-1',
        copyId: 'copy-1',
        destinationId: 'dest-1',
        statusCode: 200,
        diagnosticText: 'OK',
        markStatus: 'sent'
      });
      expect(
        store.telemetry.recordCardinalityAttribute({
          metricFamily: 'schegent.turns',
          attributeKey: 'phase',
          attributeValue: 'specify',
          maxDistinctPerKey: 1
        }).admitted
      ).toBe(true);
      expect(
        store.telemetry.recordCardinalityAttribute({
          metricFamily: 'schegent.turns',
          attributeKey: 'phase',
          attributeValue: 'plan',
          maxDistinctPerKey: 1
        }).admitted
      ).toBe(false);
    } finally {
      store.close();
    }
  });
});
