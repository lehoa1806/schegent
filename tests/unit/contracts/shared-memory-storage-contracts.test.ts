/**
 * FR-R6-F02 — Unit coverage for shared memory and storage contracts
 * (T007, T010, T013, T015, T017, T019, T021).
 */
import { describe, expect, it } from 'vitest';
import {
  DATA_CLASS_AUTHORITY_INVENTORY,
  DATA_CLASS_IDS,
  NON_AUTHORITATIVE_EXECUTION_SOURCES,
  RETENTION_CLASS_IDS,
  ROUND6_FEATURE_CONSUMER_MAPPING,
  ROUND6_FEATURE_IDS,
  SHARED_CONTRACT_ERROR_CATEGORIES,
  SHARED_FIELD_DICTIONARY,
  SHARED_STORAGE_CONTRACT_VERSION,
  acceptUsageObservation,
  applyUsageCorrection,
  assertExecutionEffectAuthority,
  checkPinQuotaAdmission,
  createObservationLedgerState,
  createStorageOperationReceiptStore,
  evaluateRetentionSweep,
  evaluateStreamCursorDelivery,
  evaluateTransitionOrderingAndDuration,
  executeIdempotentStorageAcceptance,
  lookupRetentionPolicy,
  mapCurrentRecordToSharedIdentity,
  pageReportAtCutoff,
  readCompatibleRecord,
  renderHandoffProseProjection,
  resolveArtifactReference,
  reviewAuthorityProposal,
  sanitizeOperatorExplanation,
  sumMonetaryObservations,
  validateAuthorityInventoryCompleteness,
  validateSharedIdentifier,
  type ArtifactDescriptor,
  type ObservationLedgerState,
  type ReportRowFact,
  type UsageObservationInput
} from '../../../src/contracts';
import { SHARED_CONTRACT_ACCEPTANCE_FIXTURES as FX } from '../../../src/services/shared-memory-storage/shared-contract-entry-boundary';

const FENCE = FX.defaultFence;

function baseObservation(overrides: Partial<UsageObservationInput> = {}): UsageObservationInput {
  return {
    schemaVersion: SHARED_STORAGE_CONTRACT_VERSION,
    workspaceId: 'ws-1',
    queueId: 'queue-main',
    rootExecutionId: 'run-1',
    attemptId: 'att-1',
    producerNamespace: 'claude-cli',
    producerObservationId: 'obs-1',
    source: 'cli-stream',
    observationTimeUtc: '2026-11-09T09:00:00Z',
    counterScope: 'attempt-incremental',
    inputTokens: 100n,
    outputTokens: 20n,
    modelId: 'model-a',
    quality: { provenance: 'observed', completeness: 'known' },
    ...overrides
  };
}

function accepted<T>(outcome: { status: string; value?: T }): T {
  expect(outcome.status).toBe('accepted');
  return outcome.value as T;
}

describe('C1 identifier validation (T007)', () => {
  it('accepts 256-byte identifiers and refuses 257 bytes with identity-mismatch', () => {
    const ok = validateSharedIdentifier('a'.repeat(256), 'attemptId');
    expect(accepted(ok).aliased).toBe(false);
    const tooLong = validateSharedIdentifier('a'.repeat(257), 'attemptId');
    expect(tooLong.status).toBe('refused');
    if (tooLong.status === 'refused') {
      expect(tooLong.error.category).toBe('identity-mismatch');
      expect(tooLong.error.reasonCode).toBe('identifier-exceeds-256-utf8-bytes');
    }
  });

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    // SAFE_ID_PATTERN refuses non-ASCII, so multi-byte ids are malformed rather than silently truncated.
    const res = validateSharedIdentifier('é'.repeat(10), 'attemptId');
    expect(res.status).toBe('refused');
  });

  it('preserves valid legacy ids > 256 bytes via deterministic, collision-free aliases', () => {
    const a = 'L'.repeat(300);
    const b = 'L'.repeat(299) + 'M';
    const ra1 = accepted(validateSharedIdentifier(a, 'rootExecutionId', { allowLegacyAlias: true }));
    const ra2 = accepted(validateSharedIdentifier(a, 'rootExecutionId', { allowLegacyAlias: true }));
    const rb = accepted(validateSharedIdentifier(b, 'rootExecutionId', { allowLegacyAlias: true }));
    expect(ra1.aliased).toBe(true);
    expect(ra1.id).toMatch(/^alias:[0-9a-f]{64}$/);
    expect(ra1.id).toBe(ra2.id);
    expect(ra1.id).not.toBe(rb.id);
    expect(ra1.originalId).toBe(a);
    expect(ra1.utf8Bytes).toBeLessThanOrEqual(256);
  });

  it.each(['', '..', '.', 'a/../b', '../x', 'a b', 'a\u0000b', 'a\\..\\b'])(
    'refuses malformed or traversal id %j',
    (bad) => {
      const res = validateSharedIdentifier(bad, 'artifactId');
      expect(res.status).toBe('refused');
      if (res.status === 'refused') expect(res.error.category).toBe('identity-mismatch');
    }
  );

  it('refuses non-string identifiers', () => {
    expect(validateSharedIdentifier(42, 'attemptId').status).toBe('refused');
  });

  it('publishes exactly the eight error categories', () => {
    expect([...SHARED_CONTRACT_ERROR_CATEGORIES]).toEqual([
      'identity-mismatch',
      'stale-revision',
      'invalid-observation',
      'missing-artifact',
      'expired-cursor',
      'unsupported-version',
      'capacity-refusal',
      'uncertain-persistence'
    ]);
  });

  it('redacts host paths and credentials via the canonical sanitizer and bounds explanation length', () => {
    const out = sanitizeOperatorExplanation(
      'failed at /Users/alice/secret/file.txt with token=abc123def456ghi789 and Bearer eyJhbGciOiJIUzI1NiJ9.abcdefgh ' +
        'x'.repeat(400)
    );
    expect(out).not.toContain('/Users/alice');
    expect(out).not.toContain('abc123def456ghi789');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(240);
  });
});

describe('C2 authority inventory & C4 retention inventory (T010)', () => {
  it('covers 13 data classes with one authority each, 15 features, zero orphan fields', () => {
    const result = validateAuthorityInventoryCompleteness();
    expect(result.ok).toBe(true);
    expect(result.dataClassesCovered).toBe(13);
    expect(DATA_CLASS_IDS).toHaveLength(13);
    expect(result.featuresCovered).toBe(15);
    expect(ROUND6_FEATURE_CONSUMER_MAPPING.map((f) => f.featureId)).toEqual([...ROUND6_FEATURE_IDS]);
    expect(result.orphanSharedFields).toEqual([]);
    expect(result.competingAuthorities).toEqual([]);
    const owners = new Map<string, number>();
    for (const row of DATA_CLASS_AUTHORITY_INVENTORY) {
      owners.set(row.dataClass, (owners.get(row.dataClass) ?? 0) + 1);
    }
    for (const count of owners.values()) expect(count).toBe(1);
  });

  it('every consumed shared field and authority is published', () => {
    const fields = new Set(SHARED_FIELD_DICTIONARY.map((f) => f.fieldName));
    const classes = new Set<string>(DATA_CLASS_IDS);
    for (const feature of ROUND6_FEATURE_CONSUMER_MAPPING) {
      for (const f of feature.sharedFieldsConsumed) expect(fields.has(f)).toBe(true);
      for (const a of [...feature.inputAuthorities, ...feature.outputAuthorities]) {
        expect(classes.has(a)).toBe(true);
      }
      expect(feature.targetArchitecture.forbidsDirectAgentOrUiSql).toBe(true);
    }
  });

  it('rejects parallel root/attempt identity allocation and competing write authority', () => {
    const parallel = reviewAuthorityProposal({
      featureId: 'F06',
      dataClass: 'accepted-usage-observations-adjustments',
      claimsWriteAuthority: true,
      introducesParallelIdentity: 'attemptId'
    });
    expect(parallel.status).toBe('refused');
    const rootParallel = reviewAuthorityProposal({
      featureId: 'F11',
      dataClass: 'historical-execution-facts',
      claimsWriteAuthority: false,
      introducesParallelIdentity: 'rootExecutionId'
    });
    expect(rootParallel.status).toBe('refused');
    const competing = reviewAuthorityProposal({
      featureId: 'F11',
      dataClass: 'accepted-usage-observations-adjustments',
      claimsWriteAuthority: true
    });
    expect(competing.status).toBe('refused');
    if (competing.status === 'refused') {
      expect(competing.error.reasonCode).toBe('competing-data-class-authority-rejected');
    }
    const owner = reviewAuthorityProposal({
      featureId: 'F06',
      dataClass: 'accepted-usage-observations-adjustments',
      claimsWriteAuthority: true
    });
    expect(accepted(owner).authoritativeOwner).toBe('F06');
  });

  it.each([...NON_AUTHORITATIVE_EXECUTION_SOURCES])(
    'derived source %s cannot authorize execution effects',
    (source) => {
      for (const effect of ['dispatch', 'completion', 'permit-release', 'git-integration'] as const) {
        const res = assertExecutionEffectAuthority(source, effect);
        expect(res.status).toBe('refused');
      }
    }
  );

  it('only execution-authority data classes may authorize effects', () => {
    expect(assertExecutionEffectAuthority('current-execution-admission-permits', 'dispatch').status).toBe(
      'accepted'
    );
    expect(assertExecutionEffectAuthority('historical-execution-facts', 'completion').status).toBe(
      'refused'
    );
  });

  it.each([...RETENTION_CLASS_IDS])('publishes retention policy for %s', (cls) => {
    const policy = lookupRetentionPolicy(cls);
    expect(policy.retentionClass).toBe(cls);
    expect(policy.upgradeDeletesLegacyHistory).toBe(false);
    expect(policy.reportingHorizonDisclosure.length).toBeGreaterThan(0);
  });

  it('new terminal detail uses 90 days or 256 MiB from terminal settlement after activation', () => {
    const p = lookupRetentionPolicy('new-terminal-execution-usage-detail');
    expect(p.maxAgeDays).toBe(90);
    expect(p.reclaimTargetBytes).toBe(256 * 1024 * 1024);
    expect(p.ageStartsAt).toBe('terminal-settlement');
    expect(p.appliesOnlyAfterActivation).toBe(true);
  });
});

describe('C1/C3 identity mapping and observation acceptance (T013)', () => {
  it('maps a control attempt to shared identity', () => {
    const id = accepted(
      mapCurrentRecordToSharedIdentity({
        recordKind: 'control-attempt',
        workspaceId: 'ws-1',
        queueId: 'queue-main',
        rootRunId: 'run-1',
        frameId: 'frame-1',
        nodePath: 'wf/implement',
        occurrenceIndex: 1,
        attemptId: 'att-1',
        attemptOrdinal: 1,
        fence: FENCE,
        providerSessionId: 'prov-1'
      })
    );
    expect(id.rootExecutionId).toBe('run-1');
    expect(id.invocationId).toBe('frame-1');
    expect(id.providerSessionId).toBe('prov-1');
    expect(id.executionFence).toEqual(FENCE);
    expect(id.missingIdentityReasons).toEqual({});
  });

  it('keeps distinct occurrence lineage for ForEach duplicate item values', () => {
    const common = {
      recordKind: 'foreach-slot-attempt' as const,
      workspaceId: 'ws-1',
      queueId: 'queue-main',
      rootRunId: 'run-1',
      frameId: 'frame-foreach',
      nodePath: 'wf/foreach/implement',
      itemValue: 'same-value',
      attemptOrdinal: 1,
      fence: FENCE
    };
    const a = accepted(mapCurrentRecordToSharedIdentity({ ...common, slotIndex: 0, attemptId: 'att-s0' }));
    const b = accepted(mapCurrentRecordToSharedIdentity({ ...common, slotIndex: 1, attemptId: 'att-s1' }));
    expect(a.occurrenceIndex).not.toBe(b.occurrenceIndex);
    expect(a.attemptId).not.toBe(b.attemptId);
  });

  it('maps a legacy metrics phase with honest missing attribution reasons', () => {
    const id = accepted(
      mapCurrentRecordToSharedIdentity({
        recordKind: 'legacy-metrics-phase',
        workspaceId: 'ws-1',
        queueId: 'queue-main',
        runId: 'run-legacy',
        phaseType: 'implement',
        iteration: 2
      })
    );
    expect(id.attemptId).toBeUndefined();
    expect(id.missingIdentityReasons).toMatchObject({
      attemptId: 'not-recorded-in-legacy-schema',
      invocationId: 'not-recorded-in-legacy-schema',
      modelId: 'not-recorded-in-legacy-schema',
      providerSessionId: 'not-recorded-in-legacy-schema'
    });
  });

  it('maps a legacy record with an over-long id via alias without collision', () => {
    const long = 'r'.repeat(400);
    const id = accepted(
      mapCurrentRecordToSharedIdentity({
        recordKind: 'legacy-metrics-phase',
        workspaceId: 'ws-1',
        queueId: 'queue-main',
        runId: long,
        phaseType: 'implement',
        iteration: 1,
        allowLegacyAlias: true
      })
    );
    expect(id.rootExecutionId).toMatch(/^alias:/);
    expect(id.identifierAliases[id.rootExecutionId]).toBe(long);
  });

  it('maps a recovery envelope before attempt admission', () => {
    const id = accepted(
      mapCurrentRecordToSharedIdentity({
        recordKind: 'recovery-envelope',
        workspaceId: 'ws-1',
        queueId: 'queue-main',
        rootRunId: 'run-1',
        invocationId: 'frame-1',
        artifactRef: 'art-1'
      })
    );
    expect(id.missingIdentityReasons.attemptId).toBe('pre-attempt-admission');
    expect(id.artifactId).toBe('art-1');
  });

  it('refuses traversal identifiers in mapped records', () => {
    const res = mapCurrentRecordToSharedIdentity({
      recordKind: 'recovery-envelope',
      workspaceId: 'ws-1',
      queueId: 'queue-main',
      rootRunId: '../escape',
      invocationId: 'frame-1'
    });
    expect(res.status).toBe('refused');
  });

  it('deduplicates redeliveries of the same producer observation', () => {
    const ledger = createObservationLedgerState();
    const first = accepted(acceptUsageObservation(ledger, baseObservation()));
    const again = accepted(acceptUsageObservation(ledger, baseObservation()));
    expect(first.deduplicationStatus).toBe('accepted-new');
    expect(again.deduplicationStatus).toBe('duplicate-ignored');
    expect(again.observationId).toBe(first.observationId);
    expect(ledger.observationsById.size).toBe(1);
  });

  it('counts byte-identical payloads from distinct attempts twice', () => {
    const ledger = createObservationLedgerState();
    acceptUsageObservation(ledger, baseObservation({ attemptId: 'att-1' }));
    acceptUsageObservation(ledger, baseObservation({ attemptId: 'att-2' }));
    expect(ledger.observationsById.size).toBe(2);
  });

  it('marks cross-restart redelivery without producer id as unresolved-duplicate', () => {
    const ledger = createObservationLedgerState();
    const obs = accepted(
      acceptUsageObservation(
        ledger,
        baseObservation({ producerObservationId: undefined, isCrossRestartRedelivery: true })
      )
    );
    expect(obs.replayQuality).toBe('unavailable');
    expect(obs.deduplicationStatus).toBe('unresolved-duplicate');
    expect(obs.billableInputTokens).toBeNull();
    expect(obs.quality.completeness).toBe('conflicting');
  });

  it('refuses negative token counts', () => {
    const ledger = createObservationLedgerState();
    for (const bad of [-1n, -5, '-3']) {
      const res = acceptUsageObservation(ledger, baseObservation({ inputTokens: bad }));
      expect(res.status).toBe('refused');
      if (res.status === 'refused') expect(res.error.category).toBe('invalid-observation');
    }
  });

  it('keeps token counts above Number.MAX_SAFE_INTEGER exact', () => {
    const ledger = createObservationLedgerState();
    const huge = BigInt(Number.MAX_SAFE_INTEGER) * 10n + 7n;
    const obs = accepted(acceptUsageObservation(ledger, baseObservation({ inputTokens: huge })));
    expect(obs.billableInputTokens).toBe(huge);
    expect(obs.exactInputTokensText).toBe(huge.toString());
    const unsafeNumber = acceptUsageObservation(
      ledger,
      baseObservation({ producerObservationId: 'obs-2', inputTokens: Number.MAX_SAFE_INTEGER + 2 })
    );
    expect(unsafeNumber.status).toBe('refused');
  });

  it('preserves legacy float monetary precision as recorded decimal text', () => {
    const ledger = createObservationLedgerState();
    const obs = accepted(
      acceptUsageObservation(
        ledger,
        baseObservation({
          monetary: {
            amountDecimal: '0.125',
            unit: 'USD',
            unitKind: 'currency',
            origin: 'legacy-float',
            legacyRecordedPrecisionDigits: 3
          }
        })
      )
    );
    expect(obs.monetary?.amountDecimal).toBe('0.125');
    expect(obs.monetary?.origin).toBe('legacy-float');
  });

  it('never counts ACP context occupancy as billable usage', () => {
    const ledger = createObservationLedgerState();
    const obs = accepted(
      acceptUsageObservation(ledger, baseObservation({ counterScope: 'acp-context-occupancy' }))
    );
    expect(obs.attributionScope).toBe('non-billable-occupancy');
    expect(obs.billableInputTokens).toBeNull();
    expect(obs.billableOutputTokens).toBeNull();
  });

  it('keeps cumulative session totals without baseline at session scope with unknown completeness', () => {
    const ledger = createObservationLedgerState();
    const obs = accepted(
      acceptUsageObservation(ledger, baseObservation({ counterScope: 'session-cumulative' }))
    );
    expect(obs.attributionScope).toBe('session-only');
    expect(obs.quality.completeness).toBe('unknown');
    expect(obs.quality.unavailableReason).toBe('unattributed-session-baseline');
    expect(obs.billableInputTokens).toBeNull();
  });

  it('refuses unknown observation fields and unsupported schema versions', () => {
    const ledger = createObservationLedgerState();
    const unknown = acceptUsageObservation(ledger, { ...baseObservation(), executePolicy: 'rm -rf' });
    expect(unknown.status).toBe('refused');
    const future = acceptUsageObservation(ledger, { ...baseObservation(), schemaVersion: 2 });
    expect(future.status).toBe('refused');
    if (future.status === 'refused') expect(future.error.category).toBe('unsupported-version');
    const badTime = acceptUsageObservation(
      ledger,
      baseObservation({ observationTimeUtc: '2026-11-09 09:00:00' })
    );
    expect(badTime.status).toBe('refused');
  });

  it('refuses cross-currency and credit summation, sums same currency exactly', () => {
    const usd = { unit: 'USD', unitKind: 'currency' as const, origin: 'provider-billed' as const };
    const total = accepted(
      sumMonetaryObservations([
        { ...usd, amountDecimal: '0.1' },
        { ...usd, amountDecimal: '0.2' }
      ])
    );
    expect(total.totalDecimal).toBe('0.3');
    expect(
      sumMonetaryObservations([
        { ...usd, amountDecimal: '1' },
        { ...usd, unit: 'EUR', amountDecimal: '1' }
      ]).status
    ).toBe('refused');
    expect(
      sumMonetaryObservations([
        { amountDecimal: '5', unit: 'credits', unitKind: 'nonmonetary-credits', origin: 'provider-billed' }
      ]).status
    ).toBe('refused');
    expect(sumMonetaryObservations([null, undefined]).status).toBe('refused');
  });
});

describe('C3 corrections and clocks (T015)', () => {
  function ledgerWithObservation(): { ledger: ObservationLedgerState; observationId: string } {
    const ledger = createObservationLedgerState(['audit-1', 'audit-2']);
    const obs = accepted(acceptUsageObservation(ledger, baseObservation()));
    return { ledger, observationId: obs.observationId };
  }

  const correction = (replacesObservationId: string) => ({
    schemaVersion: SHARED_STORAGE_CONTRACT_VERSION,
    correctionId: 'corr-1',
    replacesObservationId,
    attemptId: 'att-1',
    consumerId: 'f06-metrics',
    calculationVersion: 'v1',
    deltaInputTokens: -10n,
    reason: 'provider restatement'
  });

  it('applies once per consumer/calculationVersion and leaves audit history unchanged', () => {
    const { ledger, observationId } = ledgerWithObservation();
    const auditBefore = [...ledger.auditHistoryLog];
    const first = accepted(applyUsageCorrection(ledger, correction(observationId)));
    const second = accepted(applyUsageCorrection(ledger, correction(observationId)));
    expect(first.status).toBe('applied');
    expect(second.status).toBe('duplicate-noop');
    expect(ledger.appliedCorrectionsByKey.size).toBe(1);
    expect(ledger.auditHistoryLog).toEqual(auditBefore);
    const otherVersion = accepted(
      applyUsageCorrection(ledger, { ...correction(observationId), calculationVersion: 'v2' })
    );
    expect(otherVersion.status).toBe('applied');
  });

  it('resolves corrections against compacted targets with tombstone, not without', () => {
    const ledger = createObservationLedgerState();
    ledger.compactedObservationIdsWithTombstone.add('obs-compacted-tomb');
    ledger.compactedObservationIdsWithoutTombstone.add('obs-compacted-gone');
    expect(accepted(applyUsageCorrection(ledger, correction('obs-compacted-tomb'))).status).toBe(
      'applied'
    );
    const gone = accepted(
      applyUsageCorrection(ledger, { ...correction('obs-compacted-gone'), correctionId: 'corr-2' })
    );
    expect(gone.status).toBe('unresolved-compacted-target');
    expect(gone.deltaInputTokens).toBe(0n);
    expect(
      applyUsageCorrection(ledger, { ...correction('missing'), correctionId: 'corr-3' }).status
    ).toBe('refused');
  });

  it('orders by acceptedSeq and clamps wall-clock reversal to elapsedMs >= 0', () => {
    const result = evaluateTransitionOrderingAndDuration([
      {
        transitionId: 't2',
        acceptedSeq: 2,
        startedAtUtc: '2026-11-09T10:00:10Z',
        endedAtUtc: '2026-11-09T10:00:00Z'
      },
      {
        transitionId: 't1',
        acceptedSeq: 1,
        startedAtUtc: '2026-11-09T10:00:00Z',
        endedAtUtc: '2026-11-09T09:59:00Z',
        startMonotonicMs: 100,
        endMonotonicMs: 350
      },
      {
        transitionId: 't3',
        acceptedSeq: 3,
        startedAtUtc: '2026-11-09T10:00:00Z',
        endedAtUtc: '2026-11-09T10:00:05Z',
        acrossRestart: true
      }
    ]);
    expect(result.map((r) => r.transitionId)).toEqual(['t1', 't2', 't3']);
    expect(result[0]).toMatchObject({ elapsedMs: 250, timingQuality: 'monotonic-exact' });
    expect(result[1]).toMatchObject({ elapsedMs: 0, timingQuality: 'wall-clock-skew-clamped' });
    expect(result[2]).toMatchObject({ elapsedMs: 5000, timingQuality: 'cross-restart-wall-clock' });
    for (const r of result) expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

describe('C4 artifacts and retention (T017)', () => {
  const pinned = FX.pinnedArtifactDescriptor;
  const expired = FX.unpinnedExpiredArtifactDescriptor;

  it('resolves verified matches with an opaque projection that strips host paths', () => {
    const res = accepted(resolveArtifactReference(pinned, 1, pinned.digestHex));
    expect(res.projection.validationState).toBe('verified');
    expect(res.substitutedBytes).toBeNull();
    expect(JSON.stringify(res.projection)).not.toContain('/Users/');
    expect('hostPrivateFilePath' in res.projection).toBe(false);
  });

  it('refuses digest or version mismatch and never substitutes bytes', () => {
    const mismatch = resolveArtifactReference(pinned, 1, 'c'.repeat(64));
    expect(mismatch.status).toBe('refused');
    if (mismatch.status === 'refused') expect(mismatch.error.category).toBe('missing-artifact');
    expect(resolveArtifactReference(pinned, 2, pinned.digestHex).status).toBe('refused');
  });

  it('marks a growing live log as an unverified live prefix', () => {
    const res = accepted(resolveArtifactReference(FX.growingLiveLogDescriptor, 1, null));
    expect(res.projection.validationState).toBe('unverified-live-prefix');
    expect(res.projection.digestHex).toBeNull();
    expect(res.projection.byteSize).toBe(1024);
  });

  it('reserves pin capacity for settlement work', () => {
    const base = { currentPinnedCount: 8, maxPinQuota: 10, settlementReservePins: 2 };
    expect(checkPinQuotaAdmission({ ...base, isSettlementWork: false }).status).toBe('refused');
    expect(checkPinQuotaAdmission({ ...base, isSettlementWork: true }).status).toBe('accepted');
    const full = checkPinQuotaAdmission({ ...base, currentPinnedCount: 10, isSettlementWork: true });
    expect(full.status).toBe('refused');
    if (full.status === 'refused') expect(full.error.category).toBe('capacity-refusal');
  });

  it('keeps pinned artifacts, collects unpinned eligible ones after watermark + aggregate', () => {
    const [p, e, ineligible] = evaluateRetentionSweep([
      { artifact: pinned, eligibleByAgeOrSize: true },
      { artifact: expired, eligibleByAgeOrSize: true },
      { artifact: { ...expired, artifactId: 'art-young' } as ArtifactDescriptor, eligibleByAgeOrSize: false }
    ]);
    expect(p!.action).toBe('preserved-pinned');
    expect(p!.resultingAvailability).toBe('present');
    expect(e!.action).toBe('collected');
    expect(e!.aggregateContributionCommitted).toBe(true);
    expect(e!.deletionWatermarkCommitted).toBe(true);
    expect(e!.resultingAvailability).toBe('expired');
    expect(ineligible!.action).toBe('preserved-ineligible');
  });

  it('reports consequences and persists missing evidence on authorized recovery-dependency deletion', () => {
    const [item] = evaluateRetentionSweep([
      { artifact: pinned, eligibleByAgeOrSize: false, explicitlyAuthorizedDeletion: true }
    ]);
    expect(item).toMatchObject({
      action: 'authorized-deleted-recovery-dependency',
      consequenceReported: true,
      resultingAvailability: 'deleted',
      missingEvidenceStatePersisted: true
    });
  });
});

describe('C5 stream cursors and report/handoff provenance (T019)', () => {
  const cursor = { streamId: 'stream-1', generation: 2, sequence: 10 };
  const base = {
    cursor,
    activeGeneration: 2,
    earliestRetainedSequence: 5,
    latestSequence: 20,
    incomingGeneration: 2,
    snapshotRevision: 42
  };

  it('classifies new-item, duplicate, gap, and stale-generation deliveries', () => {
    expect(evaluateStreamCursorDelivery({ ...base, incomingSequence: 11 }).disposition).toBe('new-item');
    expect(evaluateStreamCursorDelivery({ ...base, incomingSequence: 10 }).disposition).toBe('duplicate');
    const gap = evaluateStreamCursorDelivery({ ...base, incomingSequence: 14 });
    expect(gap).toMatchObject({ disposition: 'gap', missingFromSequence: 11, missingToSequence: 13 });
    expect(
      evaluateStreamCursorDelivery({ ...base, incomingGeneration: 1, incomingSequence: 11 }).disposition
    ).toBe('stale-generation');
  });

  it('returns a fresh tail cursor and full snapshot meta for expired cursors', () => {
    const res = evaluateStreamCursorDelivery({ ...base, earliestRetainedSequence: 15, incomingSequence: 16 });
    expect(res.disposition).toBe('expired-cursor');
    if (res.disposition === 'expired-cursor') {
      expect(res.errorCategory).toBe('expired-cursor');
      expect(res.gapFromSequence).toBe(11);
      expect(res.gapToSequence).toBe(14);
      expect(res.freshTailCursor).toEqual({ streamId: 'stream-1', generation: 2, sequence: 20 });
      expect(res.freshSnapshotMeta).toEqual({ mode: 'full', revision: 42 });
    }
  });

  it('pages stably at a cutoff despite concurrent arrivals', () => {
    const facts: ReportRowFact[] = [1, 2].map((seq) => ({
      attemptId: `att-${seq}`,
      rootExecutionId: 'run-root-100',
      queueId: 'queue-main',
      acceptedSeq: seq,
      summary: `row ${seq}`
    }));
    const manifest = FX.initialReportManifest;
    const page1 = accepted(pageReportAtCutoff({ allFacts: facts, manifest, pageSize: 1 }));
    expect(page1.rows.map((r) => r.acceptedSeq)).toEqual([1]);
    const withArrival = [
      ...facts,
      { attemptId: 'att-3', rootExecutionId: 'run-root-100', queueId: 'queue-main', acceptedSeq: 3, summary: 'late' }
    ];
    const page2 = accepted(
      pageReportAtCutoff({
        allFacts: withArrival,
        manifest,
        pageSize: 1,
        afterAcceptedSeq: page1.nextAfterAcceptedSeq ?? undefined
      })
    );
    expect(page2.rows.map((r) => r.acceptedSeq)).toEqual([2]);
    expect(page2.nextAfterAcceptedSeq).toBeNull();
    expect(page2.sourceCutoff).toEqual(manifest.sourceCutoff);
  });

  it('refuses canceled report generation', () => {
    const res = pageReportAtCutoff({
      allFacts: [],
      manifest: FX.initialReportManifest,
      pageSize: 10,
      canceled: true
    });
    expect(res.status).toBe('refused');
  });

  it('editing handoff prose does not mutate the authoritative manifest', () => {
    const manifest = FX.regeneratedHandoffManifest;
    const snapshot = JSON.stringify(manifest);
    const rendered = renderHandoffProseProjection(manifest, 'Operator edited prose');
    expect(rendered.prose).toBe('Operator edited prose');
    expect(JSON.stringify(rendered.authoritativeManifest)).toBe(snapshot);
    expect(JSON.stringify(manifest)).toBe(snapshot);
    expect(rendered.authoritativeManifest.grantsExecutionAuthority).toBe(false);
  });
});

describe('C8 storage outcomes and compatibility (T021)', () => {
  it('returns uncertain on interrupted acknowledgement and replay preserves the original fact id', () => {
    const store = createStorageOperationReceiptStore();
    const first = executeIdempotentStorageAcceptance(store, {
      operationId: 'op-1',
      factId: 'fact-original',
      payloadDigest: 'd1',
      simulateInterruptedAcknowledgement: true
    });
    expect(first.status).toBe('uncertain');
    if (first.status === 'uncertain') {
      expect(first.error.category).toBe('uncertain-persistence');
      expect(first.recoveryObligation).toBe('reconcile-receipt-before-retry-or-effect');
    }
    const replay = executeIdempotentStorageAcceptance(store, {
      operationId: 'op-1',
      factId: 'fact-second-attempt',
      payloadDigest: 'd1'
    });
    expect(accepted(replay)).toEqual({ factId: 'fact-original', replayed: true });
    expect(store.committedByOperationId.size).toBe(1);
    expect(store.uncertainByOperationId.size).toBe(0);
  });

  it('refuses operation id reuse with different content', () => {
    const store = createStorageOperationReceiptStore();
    executeIdempotentStorageAcceptance(store, { operationId: 'op-2', factId: 'f', payloadDigest: 'a' });
    const conflict = executeIdempotentStorageAcceptance(store, {
      operationId: 'op-2',
      factId: 'f',
      payloadDigest: 'b'
    });
    expect(conflict.status).toBe('refused');
  });

  it('reads legacy records with honest missing attribution reasons and no startup rewrite', () => {
    const view = accepted(readCompatibleRecord(FX.legacyRecordMissingModelAndSession));
    expect(view.missingAttributionReasons).toMatchObject({
      modelId: 'not-recorded-in-legacy-schema',
      providerSessionId: 'not-recorded-in-legacy-schema',
      attemptId: 'not-recorded-in-legacy-schema'
    });
    expect(view.upgradedFromLegacyInMemory).toBe(true);
    expect(view.startupRewritePerformed).toBe(false);
  });

  it('refuses unknown future versions leaving input byte-identical', () => {
    const record = FX.unknownFutureVersionRecord;
    const before = JSON.stringify(record);
    const res = readCompatibleRecord(record);
    expect(res.status).toBe('refused');
    if (res.status === 'refused') expect(res.error.category).toBe('unsupported-version');
    expect(JSON.stringify(record)).toBe(before);
  });

  it('refuses retired formats without conversion', () => {
    const res = readCompatibleRecord(FX.retiredFormatRecord);
    expect(res.status).toBe('refused');
    if (res.status === 'refused') expect(res.error.reasonCode).toBe('retired-format-refused');
  });
});

describe('review hardening regressions', () => {
  it('refuses absolute-path identifiers', () => {
    expect(validateSharedIdentifier('/etc/passwd', 'artifactId').status).toBe('refused');
  });

  it('truncates multi-byte explanations within the byte ceiling', () => {
    const out = sanitizeOperatorExplanation('é'.repeat(500));
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(240);
    expect(out.endsWith('...')).toBe(true);
  });

  it('does not collide observation ids when components contain ":"', () => {
    const ledger = createObservationLedgerState();
    acceptUsageObservation(
      ledger,
      baseObservation({ attemptId: 'a:b', producerNamespace: 'c', producerObservationId: 'd' })
    );
    acceptUsageObservation(
      ledger,
      baseObservation({ attemptId: 'a', producerNamespace: 'b:c', producerObservationId: 'd' })
    );
    expect(ledger.observationsById.size).toBe(2);
  });

  it('refuses malformed quality, counter scope, monetary, and derivation keys without throwing', () => {
    const ledger = createObservationLedgerState();
    const cases: unknown[] = [
      { ...baseObservation(), quality: undefined },
      { ...baseObservation(), quality: { provenance: 'guessed', completeness: 'known' } },
      { ...baseObservation(), counterScope: 'lifetime' },
      baseObservation({
        monetary: { amountDecimal: '-0.5', unit: 'USD', unitKind: 'currency', origin: 'provider-billed' }
      }),
      baseObservation({
        monetary: { amountDecimal: '0.1234567', unit: 'USD', unitKind: 'currency', origin: 'provider-billed' }
      }),
      baseObservation({ producerObservationId: undefined, deterministicDerivationKey: '../x' }),
      baseObservation({ inputTokens: '9'.repeat(100) }),
      baseObservation({ eventTimeUtc: 'yesterday' })
    ];
    for (const input of cases) {
      const res = acceptUsageObservation(ledger, input);
      expect(res.status).toBe('refused');
    }
    expect(ledger.observationsById.size).toBe(0);
  });

  it('refuses malformed monetary amounts during summation', () => {
    const res = sumMonetaryObservations([
      { amountDecimal: 'abc', unit: 'USD', unitKind: 'currency', origin: 'provider-billed' }
    ]);
    expect(res.status).toBe('refused');
  });

  it('refuses corrections naming the wrong attempt or ambiguous consumer keys', () => {
    const ledger = createObservationLedgerState();
    const obs = accepted(acceptUsageObservation(ledger, baseObservation()));
    const wrongAttempt = applyUsageCorrection(ledger, {
      schemaVersion: SHARED_STORAGE_CONTRACT_VERSION,
      correctionId: 'corr-x',
      replacesObservationId: obs.observationId,
      attemptId: 'att-other',
      consumerId: 'f06',
      calculationVersion: 'v1',
      reason: 'r'
    });
    expect(wrongAttempt.status).toBe('refused');
    const base = {
      schemaVersion: SHARED_STORAGE_CONTRACT_VERSION,
      replacesObservationId: obs.observationId,
      attemptId: 'att-1',
      reason: 'r'
    };
    const a = accepted(
      applyUsageCorrection(ledger, { ...base, correctionId: 'c', consumerId: 'x:y', calculationVersion: 'z' })
    );
    const b = accepted(
      applyUsageCorrection(ledger, { ...base, correctionId: 'c', consumerId: 'x', calculationVersion: 'y:z' })
    );
    expect(a.status).toBe('applied');
    expect(b.status).toBe('applied');
  });

  it('clamps unparsable wall-clock durations to zero', () => {
    const [r] = evaluateTransitionOrderingAndDuration([
      { transitionId: 't', acceptedSeq: 1, startedAtUtc: 'bad', endedAtUtc: 'worse' }
    ]);
    expect(r!.elapsedMs).toBe(0);
    expect(r!.timingQuality).toBe('wall-clock-skew-clamped');
  });

  it('treats a cursor from a superseded generation as expired', () => {
    const res = evaluateStreamCursorDelivery({
      cursor: { streamId: 's', generation: 1, sequence: 50 },
      activeGeneration: 2,
      earliestRetainedSequence: 1,
      latestSequence: 3,
      incomingGeneration: 2,
      incomingSequence: 4,
      snapshotRevision: 9
    });
    expect(res.disposition).toBe('expired-cursor');
  });

  it('refuses out-of-range report page sizes', () => {
    for (const pageSize of [0, -1, 101, 1.5]) {
      const res = pageReportAtCutoff({ allFacts: [], manifest: FX.initialReportManifest, pageSize });
      expect(res.status).toBe('refused');
    }
  });

  it('refuses reconciliation of an uncertain operation with different content', () => {
    const store = createStorageOperationReceiptStore();
    executeIdempotentStorageAcceptance(store, {
      operationId: 'op-u',
      factId: 'f1',
      payloadDigest: 'a',
      simulateInterruptedAcknowledgement: true
    });
    const res = executeIdempotentStorageAcceptance(store, {
      operationId: 'op-u',
      factId: 'f1',
      payloadDigest: 'b'
    });
    expect(res.status).toBe('refused');
    expect(store.committedByOperationId.size).toBe(0);
  });

  it('refuses non-object compatible records', () => {
    expect(readCompatibleRecord(null as unknown as Record<string, unknown>).status).toBe('refused');
  });
});
