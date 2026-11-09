/**
 * FR-R6-F02 — Cross-feature acceptance matrix F02-AC-01..F02-AC-10 (T023, T025).
 *
 * Exercises the canonical fixtures through the public contract barrel, the
 * 4-view consumer projector, and the UI/host/headless entry-point boundary.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SHARED_STORAGE_CONTRACT_VERSION,
  acceptUsageObservation,
  createStorageOperationReceiptStore,
  evaluateRetentionSweep,
  evaluateStreamCursorDelivery,
  executeIdempotentStorageAcceptance,
  mapCurrentRecordToSharedIdentity,
  normalizeAcpEventToDomainFixtures,
  readCompatibleRecord,
  renderHandoffProseProjection,
  resolveArtifactReference,
  validateAuthorityInventoryCompleteness,
  type AcpNormalizationContext,
  type ObservationLedgerState,
  type UsageObservationInput
} from '../../src/contracts';
import * as contractsBarrel from '../../src/contracts';
import {
  SHARED_CONTRACT_ACCEPTANCE_FIXTURES as FX,
  applyUsageCorrection,
  createObservationLedgerState,
  executeSharedContractOperation,
  projectAttemptAcrossConsumerViews,
  type RenderedQualityDisplayState,
  type SharedContractEntrySurface
} from '../../src/services/shared-memory-storage/shared-contract-entry-boundary';
import { executeHeadlessSharedContractOperation } from '../../src/headless/workflow-run-api';

const REPO_ROOT = resolve(__dirname, '..', '..');
const IDS = FX.repeatTwiceAndRetryIdentities;

function observationFor(
  identity: (typeof IDS)[keyof typeof IDS],
  producerObservationId: string,
  overrides: Partial<UsageObservationInput> = {}
): UsageObservationInput {
  return {
    schemaVersion: SHARED_STORAGE_CONTRACT_VERSION,
    workspaceId: identity.workspaceId,
    queueId: identity.queueId,
    rootExecutionId: identity.rootExecutionId,
    invocationId: identity.invocationId,
    occurrenceNodePath: identity.occurrenceNodePath,
    occurrenceIndex: identity.occurrenceIndex,
    attemptId: identity.attemptId!,
    attemptOrdinal: identity.attemptOrdinal,
    producerNamespace: 'claude-cli',
    producerObservationId,
    source: 'cli-stream',
    observationTimeUtc: '2026-11-09T09:00:00Z',
    counterScope: 'attempt-incremental',
    inputTokens: 100n,
    outputTokens: 40n,
    modelId: 'model-a',
    quality: { provenance: 'observed', completeness: 'known' },
    ...overrides
  };
}

function seededLedger(): ObservationLedgerState {
  const ledger = createObservationLedgerState();
  for (const [key, identity] of Object.entries(IDS)) {
    const res = acceptUsageObservation(ledger, observationFor(identity, `obs-${key}`));
    expect(res.status).toBe('accepted');
  }
  return ledger;
}

describe('F02 acceptance matrix', () => {
  it('publishes all ten acceptance ids', () => {
    expect(FX.acceptanceIds).toHaveLength(10);
    expect(new Set(FX.acceptanceIds).size).toBe(10);
  });

  it('F02-AC-01: repeat-twice-and-retry keeps stable lineage across all four consumer views', () => {
    const ledger = seededLedger();
    // A redelivery of the retry's observation must not double count.
    acceptUsageObservation(ledger, observationFor(IDS.occurrence2Attempt2Retry, 'obs-occurrence2Attempt2Retry'));
    const attempts = new Set<string>();
    for (const identity of Object.values(IDS)) {
      const views = projectAttemptAcrossConsumerViews({ identity, ledger });
      const kinds = ['metrics', 'live-log', 'report', 'handoff'] as const;
      const reference = views.metrics;
      for (const kind of kinds) {
        const view = views[kind];
        expect(view.viewKind).toBe(kind);
        expect(view.rootExecutionId).toBe('run-root-100');
        expect(view.attemptId).toBe(identity.attemptId);
        expect(view.invocationId).toBe(identity.invocationId);
        expect(view.occurrenceIndex).toBe(identity.occurrenceIndex);
        expect(view.attemptOrdinal).toBe(identity.attemptOrdinal);
        expect(view.accountedInputTokens).toBe(100n);
        expect(view.displayState).toBe(reference.displayState);
        expect(view.providerSpecificBranchUsed).toBe(false);
      }
      attempts.add(reference.attemptId);
    }
    expect(attempts.size).toBe(3);
    expect(IDS.occurrence2Attempt1.invocationId).toBe(IDS.occurrence2Attempt2Retry.invocationId);
    expect(IDS.occurrence2Attempt1.attemptId).not.toBe(IDS.occurrence2Attempt2Retry.attemptId);
  });

  it.each<RenderedQualityDisplayState>([
    'zero-output-success',
    'absent',
    'capture-disabled',
    'expired',
    'partial',
    'estimated',
    'conflicting',
    'corrected'
  ])('F02-AC-02: renders %s identically across views', (kind) => {
    const ledger = seededLedger();
    const views = projectAttemptAcrossConsumerViews({
      identity: IDS.occurrence1Attempt1,
      ledger,
      forceDisplayScenario: { kind }
    });
    const states = new Set(
      Object.values(views).map((v) =>
        JSON.stringify({ ...v, viewKind: null }, (_k, val: unknown) =>
          typeof val === 'bigint' ? `${val.toString()}n` : val
        )
      )
    );
    expect(states.size).toBe(1);
    expect(views.report.displayState).toBe(kind);
    if (kind === 'zero-output-success') {
      expect(views.metrics.accountedInputTokens).toBe(0n);
    }
    if (kind === 'absent' || kind === 'capture-disabled') {
      // Absent data is never coerced to zero.
      expect(views.metrics.accountedInputTokens).toBeNull();
      expect(views.metrics.unavailableReason).toBeDefined();
    }
    if (kind === 'expired') {
      expect(views.handoff.expiryCutoffUtc).toBeDefined();
      expect(views.handoff.aggregateSummaryRetained).toBe(true);
    }
  });

  it('F02-AC-02: derives the corrected state from an applied correction', () => {
    const ledger = seededLedger();
    const target = [...ledger.observationsById.values()].find((o) => o.attemptId === 'att-occ1-try1')!;
    applyUsageCorrection(ledger, {
      schemaVersion: SHARED_STORAGE_CONTRACT_VERSION,
      correctionId: 'corr-ac02',
      replacesObservationId: target.observationId,
      attemptId: 'att-occ1-try1',
      consumerId: 'f06-metrics',
      calculationVersion: 'v1',
      deltaInputTokens: -25n,
      reason: 'restatement'
    });
    const views = projectAttemptAcrossConsumerViews({ identity: IDS.occurrence1Attempt1, ledger });
    expect(views.metrics.displayState).toBe('corrected');
    expect(views.report.accountedInputTokens).toBe(75n);
    expect(views.handoff.appliedCorrectionIds).toEqual(['corr-ac02']);
  });

  it('F02-AC-03: C2 authority inventory is complete and single-owner', () => {
    expect(validateAuthorityInventoryCompleteness().ok).toBe(true);
  });

  it('F02-AC-04: redeliveries are idempotent and distinct attempts stay distinct', () => {
    const ledger = createObservationLedgerState();
    acceptUsageObservation(ledger, observationFor(IDS.occurrence1Attempt1, 'same'));
    acceptUsageObservation(ledger, observationFor(IDS.occurrence1Attempt1, 'same'));
    acceptUsageObservation(ledger, observationFor(IDS.occurrence2Attempt1, 'same'));
    expect(ledger.observationsById.size).toBe(2);
  });

  it('F02-AC-05: retention keeps pinned recovery evidence and collects unpinned expired detail', () => {
    const outcomes = evaluateRetentionSweep([
      { artifact: FX.pinnedArtifactDescriptor, eligibleByAgeOrSize: true },
      { artifact: FX.unpinnedExpiredArtifactDescriptor, eligibleByAgeOrSize: true }
    ]);
    expect(outcomes.map((o) => o.action)).toEqual(['preserved-pinned', 'collected']);
    const resolved = resolveArtifactReference(
      FX.pinnedArtifactDescriptor,
      1,
      FX.pinnedArtifactDescriptor.digestHex
    );
    expect(resolved.status).toBe('accepted');
    expect(JSON.stringify(resolved)).not.toContain('/Users/');
  });

  it('F02-AC-06: expired stream cursor yields fresh tail and full snapshot; handoff prose is non-authoritative', () => {
    const res = evaluateStreamCursorDelivery({
      cursor: { streamId: 's', generation: 1, sequence: 2 },
      activeGeneration: 1,
      earliestRetainedSequence: 10,
      latestSequence: 30,
      incomingGeneration: 1,
      incomingSequence: 31,
      snapshotRevision: 7
    });
    expect(res.disposition).toBe('expired-cursor');
    const before = JSON.stringify(FX.regeneratedHandoffManifest);
    renderHandoffProseProjection(FX.regeneratedHandoffManifest, 'edited');
    expect(JSON.stringify(FX.regeneratedHandoffManifest)).toBe(before);
  });

  it('F02-AC-07: uncertain persistence replays under the original identity', () => {
    const store = createStorageOperationReceiptStore();
    const first = executeIdempotentStorageAcceptance(store, {
      operationId: 'op-ac07',
      factId: 'fact-1',
      payloadDigest: 'd',
      simulateInterruptedAcknowledgement: true
    });
    expect(first.status).toBe('uncertain');
    const replay = executeIdempotentStorageAcceptance(store, {
      operationId: 'op-ac07',
      factId: 'fact-2',
      payloadDigest: 'd'
    });
    expect(replay.status === 'accepted' && replay.value.factId).toBe('fact-1');
  });

  it('F02-AC-08: forward-only compatibility for legacy, future, and retired records', () => {
    expect(readCompatibleRecord(FX.legacyRecordMissingModelAndSession).status).toBe('accepted');
    const futureBefore = JSON.stringify(FX.unknownFutureVersionRecord);
    expect(readCompatibleRecord(FX.unknownFutureVersionRecord).status).toBe('refused');
    expect(JSON.stringify(FX.unknownFutureVersionRecord)).toBe(futureBefore);
    expect(readCompatibleRecord(FX.retiredFormatRecord).status).toBe('refused');
    const legacyIdentity = mapCurrentRecordToSharedIdentity({
      recordKind: 'legacy-metrics-phase',
      workspaceId: 'ws-canonical-01',
      queueId: 'queue-main',
      runId: 'run-legacy-01',
      phaseType: 'implement',
      iteration: 1
    });
    expect(legacyIdentity.status).toBe('accepted');
  });
});

describe('F02-AC-09: UI / host / headless entry-point boundary', () => {
  const surfaces: readonly SharedContractEntrySurface[] = ['ui', 'host', 'headless'];
  const run = (surface: SharedContractEntrySurface, request: unknown) =>
    surface === 'headless'
      ? executeHeadlessSharedContractOperation(request)
      : executeSharedContractOperation(surface, request);

  it.each(surfaces)('%s: valid inspection returns a read-only view', (surface) => {
    const res = run(surface, {
      operation: 'inspect-record',
      workspaceTrusted: true,
      record: FX.legacyRecordMissingModelAndSession
    });
    expect(res.status).toBe('accepted');
    if (res.status === 'accepted' && res.value.kind === 'inspected-record') {
      expect(res.value.surface).toBe(surface);
    }
  });

  it.each(surfaces)('%s: untrusted inspection has zero write side effects', (surface) => {
    const res = run(surface, {
      operation: 'inspect-record',
      workspaceTrusted: false,
      record: FX.legacyRecordMissingModelAndSession
    });
    expect(res.status).toBe('accepted');
    if (res.status === 'accepted' && res.value.kind === 'inspected-record') {
      expect(res.value.writeSideEffects).toEqual({
        repairTriggered: false,
        retentionTriggered: false,
        migrationTriggered: false,
        backendProbingTriggered: false
      });
    }
  });

  it.each(surfaces)('%s: untrusted mutation is refused without touching the ledger', (surface) => {
    const ledger = createObservationLedgerState();
    const res = run(surface, {
      operation: 'accept-observation',
      workspaceTrusted: false,
      activeFence: FX.defaultFence,
      suppliedFence: FX.defaultFence,
      ledger,
      payload: observationFor(IDS.occurrence1Attempt1, 'obs-untrusted')
    });
    expect(res.status).toBe('refused');
    expect(ledger.observationsById.size).toBe(0);
  });

  it.each(surfaces)('%s: stale fence is refused', (surface) => {
    const ledger = createObservationLedgerState();
    const res = run(surface, {
      operation: 'accept-observation',
      workspaceTrusted: true,
      activeFence: FX.defaultFence,
      suppliedFence: { ...FX.defaultFence, rootGeneration: 0 },
      ledger,
      payload: observationFor(IDS.occurrence1Attempt1, 'obs-stale')
    });
    expect(res.status).toBe('refused');
    if (res.status === 'refused') expect(res.error.category).toBe('stale-revision');
    expect(ledger.observationsById.size).toBe(0);
  });

  it.each(surfaces)('%s: trusted, fenced observation is accepted', (surface) => {
    const ledger = createObservationLedgerState();
    const res = run(surface, {
      operation: 'accept-observation',
      workspaceTrusted: true,
      activeFence: FX.defaultFence,
      suppliedFence: { ...FX.defaultFence },
      ledger,
      payload: observationFor(IDS.occurrence1Attempt1, 'obs-ok')
    });
    expect(res.status).toBe('accepted');
    expect(ledger.observationsById.size).toBe(1);
  });

  it.each(surfaces)('%s: unknown input fields are refused', (surface) => {
    const res = run(surface, {
      operation: 'inspect-record',
      workspaceTrusted: true,
      record: FX.legacyRecordMissingModelAndSession,
      runShell: 'echo pwned'
    });
    expect(res.status).toBe('refused');
    if (res.status === 'refused') expect(res.error.reasonCode).toBe('unknown-input-field');
  });

  it.each(surfaces)('%s: workspace move/copy rebinding requires host-controlled decision', (surface) => {
    const denied = run(surface, {
      operation: 'rebind-workspace',
      workspaceTrusted: true,
      previousWorkspaceId: 'ws-old',
      newWorkspaceId: 'ws-new',
      hostControlledDecisionConfirmed: false
    });
    expect(denied.status).toBe('refused');
    const ok = run(surface, {
      operation: 'rebind-workspace',
      workspaceTrusted: true,
      previousWorkspaceId: 'ws-old',
      newWorkspaceId: 'ws-new',
      hostControlledDecisionConfirmed: true
    });
    expect(ok.status).toBe('accepted');
    if (ok.status === 'accepted' && ok.value.kind === 'workspace-rebound') {
      expect(ok.value.foreignPermitsAttached).toBe(false);
      expect(ok.value.foreignEvidenceAttached).toBe(false);
    }
  });

  it('refuses non-object requests and unknown operations', () => {
    expect(executeSharedContractOperation('host', null).status).toBe('refused');
    expect(executeSharedContractOperation('host', []).status).toBe('refused');
    expect(
      executeSharedContractOperation('host', { operation: 'drop-tables', workspaceTrusted: true }).status
    ).toBe('refused');
  });

  it('contract and boundary modules carry zero vscode imports', () => {
    const files = [
      'src/services/shared-memory-storage/shared-contract-entry-boundary.ts',
      ...readdirSync(join(REPO_ROOT, 'src/contracts/shared-memory-storage')).map(
        (f) => `src/contracts/shared-memory-storage/${f}`
      )
    ];
    for (const file of files) {
      const text = readFileSync(join(REPO_ROOT, file), 'utf8');
      expect(text, file).not.toMatch(/from\s+['"]vscode['"]/);
      expect(text, file).not.toMatch(/require\(\s*['"]vscode['"]\s*\)/);
    }
  });

  it('the contracts barrel re-exports the shared contract surface', () => {
    expect(typeof contractsBarrel.validateSharedIdentifier).toBe('function');
    expect(typeof contractsBarrel.normalizeAcpEventToDomainFixtures).toBe('function');
  });
});

describe('F02-AC-10: ACP event normalization into logical SQLite fixtures', () => {
  function context(overrides: Partial<AcpNormalizationContext> = {}): AcpNormalizationContext {
    return {
      workspaceId: 'ws-canonical-01',
      queueId: 'queue-main',
      rootExecutionId: 'run-root-100',
      invocationId: 'frame-repeat-pass-2',
      attemptId: 'att-occ2-try2',
      activeConnectionGeneration: 3,
      hostResultValidated: false,
      ledger: createObservationLedgerState(),
      ...overrides
    };
  }

  it('stopReason alone never settles a Phase; host validation does', () => {
    const unvalidated = normalizeAcpEventToDomainFixtures(
      FX.acpEvents.liveTurnCompletedWithStopReason,
      context()
    );
    expect(unvalidated.status).toBe('accepted');
    if (unvalidated.status === 'accepted') {
      const receipt = unvalidated.value.protocolReceiptRow;
      expect(receipt.phaseSettledByWireFrame).toBe(false);
      expect(receipt.permissionGrantedByWireFrame).toBe(false);
      expect(receipt.effectivePhaseSettled).toBe(false);
      expect(receipt.replayQuality).toBe('durable-producer-id');
      expect(unvalidated.value.usageObservationRow?.billableInputTokens).toBe(1200n);
      expect(unvalidated.value.agentTurnRow?.connectionLocalRequestId).toBe('req-local-7');
    }
    const validated = normalizeAcpEventToDomainFixtures(
      FX.acpEvents.liveTurnCompletedWithStopReason,
      context({ hostResultValidated: true })
    );
    expect(validated.status === 'accepted' && validated.value.protocolReceiptRow.effectivePhaseSettled).toBe(
      true
    );
  });

  it('keeps acpSessionId and providerSessionId as distinct linked rows', () => {
    const res = normalizeAcpEventToDomainFixtures(FX.acpEvents.liveTurnCompletedWithStopReason, context());
    expect(res.status).toBe('accepted');
    if (res.status === 'accepted') {
      expect(res.value.agentSessionRow.acpSessionId).toBe('acp-sess-100');
      expect(res.value.providerSessionRow?.providerSessionId).toBe('prov-sess-claude-xyz');
      expect(res.value.agentSessionProviderLinkRow).toMatchObject({
        internalSessionKey: res.value.agentSessionRow.internalSessionKey,
        linkProvenance: 'observed-bridge'
      });
    }
    const conflated = normalizeAcpEventToDomainFixtures(
      {
        ...FX.acpEvents.liveTurnCompletedWithStopReason,
        observedBridgeProviderSession: {
          providerSessionId: 'acp-sess-100',
          backend: 'claude',
          accountAlias: 'acct'
        }
      },
      context()
    );
    expect(conflated.status).toBe('refused');
  });

  it('marks events without producer id as replayQuality unavailable', () => {
    const res = normalizeAcpEventToDomainFixtures(FX.acpEvents.eventWithoutProducerId, context());
    expect(res.status === 'accepted' && res.value.protocolReceiptRow.replayQuality).toBe('unavailable');
  });

  it('stores stale-generation events as historical-unattributed without attempt attribution', () => {
    const ctx = context({ hostResultValidated: true });
    const res = normalizeAcpEventToDomainFixtures(FX.acpEvents.staleGenerationEvent, ctx);
    expect(res.status).toBe('accepted');
    if (res.status === 'accepted') {
      expect(res.value.protocolReceiptRow.disposition).toBe('historical-unattributed');
      expect(res.value.protocolReceiptRow.effectivePhaseSettled).toBe(false);
      expect(res.value.agentConnectionRow.lifecycle).toBe('stale-historical');
      expect(res.value.agentTurnRow).toBeNull();
      expect(res.value.usageObservationRow).toBeNull();
    }
    expect(ctx.ledger.observationsById.size).toBe(0);
  });

  it('refuses connection-local requestId used as a global identity', () => {
    const res = normalizeAcpEventToDomainFixtures(
      { ...FX.acpEvents.liveTurnCompletedWithStopReason, jsonRpcRequestId: 'att-occ2-try2' },
      context()
    );
    expect(res.status).toBe('refused');
    if (res.status === 'refused') {
      expect(res.error.reasonCode).toBe('connection-local-request-id-used-as-global-id');
    }
  });
});

describe('boundary and ACP review hardening regressions', () => {
  it('refuses missing trust flags, malformed fences, and missing ledgers without throwing', () => {
    const payload = observationFor(IDS.occurrence1Attempt1, 'obs-h');
    expect(
      executeSharedContractOperation('host', { operation: 'inspect-record', record: {} }).status
    ).toBe('refused');
    expect(
      executeSharedContractOperation('host', {
        operation: 'accept-observation',
        workspaceTrusted: true,
        activeFence: FX.defaultFence,
        suppliedFence: 'stale',
        ledger: createObservationLedgerState(),
        payload
      }).status
    ).toBe('refused');
    expect(
      executeSharedContractOperation('host', {
        operation: 'accept-observation',
        workspaceTrusted: true,
        activeFence: FX.defaultFence,
        suppliedFence: FX.defaultFence,
        ledger: {},
        payload
      }).status
    ).toBe('refused');
    expect(
      executeSharedContractOperation('host', { operation: 'inspect-record', workspaceTrusted: true }).status
    ).toBe('refused');
  });

  it('refuses fields that belong to a different operation', () => {
    const res = executeSharedContractOperation('ui', {
      operation: 'inspect-record',
      workspaceTrusted: true,
      record: FX.legacyRecordMissingModelAndSession,
      hostControlledDecisionConfirmed: true
    });
    expect(res.status).toBe('refused');
  });

  it('refuses ACP events from a generation ahead of the host and malformed producer ids', () => {
    const ctx = {
      workspaceId: 'ws-canonical-01',
      queueId: 'queue-main',
      rootExecutionId: 'run-root-100',
      invocationId: 'frame-repeat-pass-2',
      attemptId: 'att-occ2-try2',
      activeConnectionGeneration: 3,
      hostResultValidated: true,
      ledger: createObservationLedgerState()
    };
    expect(
      normalizeAcpEventToDomainFixtures(
        { ...FX.acpEvents.liveTurnCompletedWithStopReason, connectionGeneration: 4 },
        ctx
      ).status
    ).toBe('refused');
    expect(
      normalizeAcpEventToDomainFixtures(
        { ...FX.acpEvents.liveTurnCompletedWithStopReason, producerEventId: '../evil' },
        ctx
      ).status
    ).toBe('refused');
    expect(ctx.ledger.observationsById.size).toBe(0);
  });

  it('acceptance fixtures are deeply frozen', () => {
    expect(Object.isFrozen(FX)).toBe(true);
    expect(Object.isFrozen(FX.pinnedArtifactDescriptor.pins)).toBe(true);
    expect(Object.isFrozen(FX.acpEvents.liveTurnCompletedWithStopReason)).toBe(true);
  });
});
