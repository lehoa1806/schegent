import { describe, expect, it } from 'vitest';
import {
  CONTROL_COLLABORATOR_KINDS,
  PRODUCTION_RESOURCE_CEILINGS,
  PUBLIC_ENTRY_POINT_IDS,
  RECOVERY_CHECKPOINT_IDS,
  WORKFLOW_REFUSAL_CATEGORIES,
  buildQualificationRecord,
  createWorkflowRefusalOutcome,
  evaluateResourceBudgetBoundary,
  getBaselineFindingsReconciliation,
  getEntryPointWiringCensus,
  simulateCheckpointInterruptionAndRecovery
} from '../../../../src/services/workflow-execution/entry-point-wiring-census';
import {
  createCutoverAuthorityGuard,
  createDefaultDurableArtifactHandoverSeam,
  createProductionWorkflowComposition,
  isLiveProviderQualified
} from '../../../../src/services/workflow-execution/production-workflow-composition';

describe('FR-R6-F01 — Entry-point wiring census, refusal taxonomy, and resource ceilings', () => {
  it('enumerates every public launch, continue, retry, control, headless, recovery, and settlement entry point once (FR-001)', () => {
    const census = getEntryPointWiringCensus();
    expect(census).toHaveLength(PUBLIC_ENTRY_POINT_IDS.length);

    const seen = new Set<string>();
    for (const row of census) {
      expect(seen.has(row.entryPointId)).toBe(false);
      seen.add(row.entryPointId);
      expect(row.compositionId).toBe('ProductionWorkflowComposition');
      expect(row.requiredCollaborators.length).toBeGreaterThan(0);
      expect(row.suppliedCollaborators).toEqual(row.requiredCollaborators);
      expect(row.missingCollaborators).toEqual([]);
    }
  });

  it('reports missingCollaborators when a collaborator is absent in a degraded composition (FR-002, FR-018)', () => {
    const census = getEntryPointWiringCensus({
      repeatExecutor: false,
      forEachExecutor: false
    });
    const launchRow = census.find((r) => r.entryPointId === 'ui.launchWorkflow');
    expect(launchRow?.missingCollaborators).toEqual(['repeatExecutor', 'forEachExecutor']);
  });

  it('reconciles all 7 baseline findings with current tree evidence without rewriting history (FR-001, FR-015)', () => {
    const findings = getBaselineFindingsReconciliation();
    expect(findings).toHaveLength(7);
    const ids = findings.map((f) => f.findingId);
    expect(ids).toEqual([
      'F01-BF-01',
      'F01-BF-02',
      'F01-BF-03',
      'F01-BF-04',
      'F01-BF-05',
      'F01-BF-06',
      'F01-BF-07'
    ]);
    for (const finding of findings) {
      expect(['confirmed-and-wired', 'superseded-with-evidence']).toContain(
        finding.baselineStatus
      );
      expect(finding.evidenceRef.length).toBeGreaterThan(0);
    }
  });

  it('defines all 7 visible refusal categories with bounded messages and 0 default attemptsConsumed (FR-018)', () => {
    expect(WORKFLOW_REFUSAL_CATEGORIES).toEqual([
      'missing-collaborator',
      'unsupported-capability',
      'quota-deferred',
      'stale-fence',
      'corrupt-state',
      'policy-refusal',
      'budget-exceeded'
    ]);

    for (const category of WORKFLOW_REFUSAL_CATEGORIES) {
      const outcome = createWorkflowRefusalOutcome({
        category,
        reasonCode: `test:${category}`,
        message: 'x'.repeat(300),
        rootExecutionId: 'run-1',
        invocationId: 'inv-1'
      });
      expect(outcome.category).toBe(category);
      expect(outcome.attemptsConsumed).toBe(0);
      expect(outcome.message.length).toBeLessThanOrEqual(240);
      expect(outcome.rootExecutionId).toBe('run-1');
      expect(outcome.invocationId).toBe('inv-1');
    }
  });

  it('exercises before and after interruption outcomes across all 8 recovery checkpoints (FR-011, FR-019)', () => {
    expect(RECOVERY_CHECKPOINT_IDS).toHaveLength(8);
    for (const checkpoint of RECOVERY_CHECKPOINT_IDS) {
      const before = simulateCheckpointInterruptionAndRecovery({
        checkpoint,
        boundary: 'before'
      });
      const after = simulateCheckpointInterruptionAndRecovery({
        checkpoint,
        boundary: 'after'
      });
      expect(before.interruptedWriteCommitted).toBe(false);
      expect(after.interruptedWriteCommitted).toBe(true);
      expect(before.duplicateSpawns).toBe(0);
      expect(after.duplicateSpawns).toBe(0);
      expect(before.attemptsConsumed).toBeLessThanOrEqual(1);
      expect(after.attemptsConsumed).toBeLessThanOrEqual(1);
      expect(before.permitsConsumed).toBeLessThanOrEqual(1);
      expect(after.permitsConsumed).toBeLessThanOrEqual(1);
    }
  });

  it('enforces limit and limit-plus-one resource budget ceilings across all 5 dimensions (SC-008)', () => {
    expect(
      evaluateResourceBudgetBoundary({
        queueCount: PRODUCTION_RESOURCE_CEILINGS.maxQueues,
        activeRootWorkflowCount: PRODUCTION_RESOURCE_CEILINGS.maxActiveRootWorkflows,
        activeFramesInRoot: PRODUCTION_RESOURCE_CEILINGS.maxActiveFramesPerRoot,
        forEachItemCount: PRODUCTION_RESOURCE_CEILINGS.maxForEachItems,
        availableSettlementReserveSlots:
          PRODUCTION_RESOURCE_CEILINGS.minSettlementReserveSlots
      }).allowed
    ).toBe(true);

    const overQueue = evaluateResourceBudgetBoundary({
      queueCount: PRODUCTION_RESOURCE_CEILINGS.maxQueues + 1
    });
    expect(overQueue.allowed).toBe(false);
    if (!overQueue.allowed) {
      expect(overQueue.refusal.category).toBe('budget-exceeded');
      expect(overQueue.refusal.reasonCode).toBe('budget-exceeded:max-queues');
      expect(overQueue.refusal.attemptsConsumed).toBe(0);
    }

    const overRoots = evaluateResourceBudgetBoundary({
      activeRootWorkflowCount: PRODUCTION_RESOURCE_CEILINGS.maxActiveRootWorkflows + 1
    });
    expect(overRoots.allowed).toBe(false);

    const overFrames = evaluateResourceBudgetBoundary({
      activeFramesInRoot: PRODUCTION_RESOURCE_CEILINGS.maxActiveFramesPerRoot + 1
    });
    expect(overFrames.allowed).toBe(false);

    const overItems = evaluateResourceBudgetBoundary({
      forEachItemCount: PRODUCTION_RESOURCE_CEILINGS.maxForEachItems + 1
    });
    expect(overItems.allowed).toBe(false);

    const underReserve = evaluateResourceBudgetBoundary({
      availableSettlementReserveSlots: 0
    });
    expect(underReserve.allowed).toBe(false);
  });

  it('builds a valid 7-field QualificationRecord and rejects empty fields (SC-009)', () => {
    const record = buildQualificationRecord({
      editorVersion: '1.96.0',
      bundledRuntime: process.version,
      platform: `${process.platform}-${process.arch}`,
      backendOrFixtureVersion: 'fixture-v1',
      command: 'npx vitest run tests/integration/production-workflow-integration.test.ts',
      commit: '5897b7fd',
      outcome: 'passed'
    });
    expect(Object.keys(record)).toEqual([
      'editorVersion',
      'bundledRuntime',
      'platform',
      'backendOrFixtureVersion',
      'command',
      'commit',
      'outcome'
    ]);
    expect(() =>
      buildQualificationRecord({
        backendOrFixtureVersion: '',
        command: 'vitest',
        commit: '5897b7fd',
        outcome: 'passed'
      })
    ).toThrow(/backendOrFixtureVersion/);
  });

  it('verifies F08 durable artifact handover unavailability seam and F01-B cutover authority guard (FR-017, FR-020)', () => {
    const seam = createDefaultDurableArtifactHandoverSeam();
    expect(seam.status).toBe('unavailable');
    const handoffRes = seam.requestHandover({
      rootExecutionId: 'root-1',
      invocationId: 'inv-1',
      artifactIds: ['art-1']
    });
    expect(handoffRes.accepted).toBe(false);
    expect(handoffRes.refusal?.category).toBe('unsupported-capability');
    expect(handoffRes.refusal?.reasonCode).toBe('durable-handoff-not-qualified');

    const postCutoverMemento = createCutoverAuthorityGuard({
      mode: 'post-cutover-strict',
      storeAuthority: 'memento-bridged',
      runtimeAuthority: 'acp-f13'
    });
    const storeRefusal = postCutoverMemento.verifyAuthority({
      entryPointId: 'ui.launchWorkflow',
      rootExecutionId: 'root-1'
    });
    expect(storeRefusal.allowed).toBe(false);
    expect(storeRefusal.refusal?.reasonCode).toBe(
      'cutover-fallback-to-memento-forbidden'
    );

    const postCutoverRetiredRunner = createCutoverAuthorityGuard({
      mode: 'post-cutover-strict',
      storeAuthority: 'sqlite-f04',
      runtimeAuthority: 'cli-runner'
    });
    const runnerRefusal = postCutoverRetiredRunner.verifyAuthority({
      entryPointId: 'ui.launchWorkflow',
      rootExecutionId: 'root-1'
    });
    expect(runnerRefusal.allowed).toBe(false);
    expect(runnerRefusal.refusal?.reasonCode).toBe(
      'cutover-fallback-to-retired-runner-forbidden'
    );

    const composition = createProductionWorkflowComposition();
    for (const kind of CONTROL_COLLABORATOR_KINDS) {
      expect(composition.isCollaboratorSupplied(kind)).toBe(true);
    }
    expect(
      isLiveProviderQualified({
        backendId: 'claude',
        capability: 'strict-cost',
        status: 'verified',
        source: 'fixture-adapter',
        reasonCode: 'fixture-verified'
      })
    ).toBe(false);
    composition.dispose();
  });
});

