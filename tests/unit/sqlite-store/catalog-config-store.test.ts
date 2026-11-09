import { describe, expect, it } from 'vitest';
import {
  STRUCTURED_STATE_CENSUS,
  validateStructuredStateCensus
} from '../../../src/contracts/sqlite-store/state-census';
import {
  SqliteApplicationStore,
  canonicalizeYamlText,
  computeCanonicalYamlSha256
} from '../../../src/services/sqlite-store';

describe('FR-R6-F04 (US6 — F04-C): Structured-State Census, Catalog/Policy/Model Store & Frozen Closures', () => {
  it('validates the complete structured-state census with zero unclassified execution-affecting JSON sidecars (FR-020)', () => {
    const validation = validateStructuredStateCensus(STRUCTURED_STATE_CENSUS);
    expect(validation.valid).toBe(true);
    expect(validation.totalSurfaces).toBeGreaterThanOrEqual(17);
    expect(validation.unclassifiedExecutionAffectingSurfaces).toEqual([]);
    expect(validation.duplicateSurfaceIds).toEqual([]);
  });

  it('publishes policy versions, model catalog versions, and catalog definitions with lossless canonical YAML round-trip equivalence (FR-021, FR-022, SC-011)', () => {
    const store = SqliteApplicationStore.openInMemory({ nowMs: () => 1_700_000_000_000 });
    try {
      const policy = store.catalogConfig.publishPolicyVersion({
        policyVersionId: 'pol-default@v1',
        scope: 'workspace',
        policyName: 'default-security',
        versionNumber: 1,
        yamlText: 'allowNetwork: false  \nmaxRetries: 3\r\n'
      });
      expect(policy.revision).toBe(1);
      expect(policy.version.canonicalYaml).toBe('allowNetwork: false\nmaxRetries: 3\n');

      const models = store.catalogConfig.publishModelCatalogVersion({
        modelCatalogVersionId: 'models-ws@v1',
        scope: 'workspace',
        versionNumber: 1,
        modelsJson: JSON.stringify([{ id: 'claude-sonnet-4-5', provider: 'anthropic' }])
      });
      expect(models.revision).toBe(1);

      // Multi-item package import in dependency order (Phase -> Pipeline -> Workflow)
      // Include a workflow with a missing dependency to verify per-layer partial-success semantics!
      const importResult = store.catalogConfig.importCatalogPackage([
        {
          definitionId: 'wf-broken',
          scope: 'workspace',
          layer: 'workflow',
          slug: 'broken-workflow',
          displayName: 'Broken Workflow',
          versionNumber: 1,
          schemaVersion: 1,
          yamlText: 'id: broken-workflow\nlayer: workflow\n',
          promoteAsPublished: true,
          dependencies: [
            { toDefinitionId: 'pipe-nonexistent', depLayer: 'pipeline', depOrder: 0 }
          ]
        },
        {
          definitionId: 'pipe-sdd',
          scope: 'workspace',
          layer: 'pipeline',
          slug: 'sdd-pipeline',
          displayName: 'SDD Pipeline',
          versionNumber: 1,
          schemaVersion: 1,
          yamlText: 'id: sdd-pipeline\nlayer: pipeline\nphases: [phase-specify]\n',
          promoteAsPublished: true,
          dependencies: [{ toDefinitionId: 'phase-specify', depLayer: 'phase', depOrder: 0 }]
        },
        {
          definitionId: 'phase-specify',
          scope: 'workspace',
          layer: 'phase',
          slug: 'specify',
          displayName: 'Specify Phase',
          versionNumber: 1,
          schemaVersion: 1,
          yamlText: 'id: specify  \r\nlayer: phase\r\n',
          promoteAsPublished: true
        }
      ]);

      // Even though wf-broken was passed first in the array, dependency sorting (`Phase -> Pipeline -> Workflow`)
      // committed phase-specify and pipe-sdd atomically and recorded wf-broken in failedItems!
      expect(importResult.committedDefinitionIds).toEqual(['phase-specify', 'pipe-sdd']);
      expect(importResult.failedItems).toEqual([
        {
          definitionId: 'wf-broken',
          layer: 'workflow',
          reason: 'MISSING_DEPENDENCY:pipe-nonexistent'
        }
      ]);

      // Verify canonical YAML round-trip equivalence
      const exported = store.catalogConfig.exportDefinitionVersionToYaml('phase-specify@v1');
      expect(exported.verifiedEquivalence).toBe(true);
      expect(exported.canonicalYaml).toBe(canonicalizeYamlText('id: specify\nlayer: phase\n'));
      expect(exported.digestSha256).toBe(computeCanonicalYamlSha256('id: specify\nlayer: phase\n'));
    } finally {
      store.close();
    }
  });

  it('captures immutable frozen execution closures for runs so subsequent catalog edits never mutate in-flight runs (US6, SC-011)', () => {
    const store = SqliteApplicationStore.openInMemory({ nowMs: () => 1_700_000_000_000 });
    try {
      store.catalogConfig.publishPolicyVersion({
        policyVersionId: 'pol-1@v1',
        scope: 'workspace',
        policyName: 'pol-1',
        versionNumber: 1,
        yamlText: 'mode: strict\n'
      });
      store.catalogConfig.publishModelCatalogVersion({
        modelCatalogVersionId: 'mc-1@v1',
        scope: 'workspace',
        versionNumber: 1,
        modelsJson: '[]'
      });
      store.catalogConfig.importCatalogPackage([
        {
          definitionId: 'phase-impl',
          scope: 'workspace',
          layer: 'phase',
          slug: 'implement',
          displayName: 'Implement v1',
          versionNumber: 1,
          schemaVersion: 1,
          yamlText: 'id: implement\nversion: 1\n',
          promoteAsPublished: true
        }
      ]);

      store.transactions.acquireOrRenewLeaseFence({
        fenceScope: 'window_primacy',
        resourceId: 'ws-closure',
        ownerId: 'win-1',
        epoch: 1,
        ttlMs: 60_000
      });
      store.transactions.executeAdmission({
        idempotency: {
          scopeKind: 'run',
          scopeId: 'run-c1',
          idempotencyKey: 'admit-c1',
          requestSha256: 'sha-c1'
        },
        fence: {
          fenceScope: 'window_primacy',
          resourceId: 'ws-closure',
          ownerId: 'win-1',
          epoch: 1
        },
        expectedRevision: 0,
        run: {
          runId: 'run-c1',
          workspaceId: 'ws-closure',
          workflowId: 'phase-impl',
          priority: 1
        }
      });

      const frozen = store.catalogConfig.createFrozenExecutionClosure({
        frozenClosureId: 'fc-run-c1',
        runId: 'run-c1',
        rootDefinitionVersionId: 'phase-impl@v1',
        policyVersionId: 'pol-1@v1',
        modelCatalogVersionId: 'mc-1@v1',
        members: [{ memberRole: 'root', definitionVersionId: 'phase-impl@v1' }]
      });

      // Publish v2 of phase-impl
      store.catalogConfig.importCatalogPackage([
        {
          definitionId: 'phase-impl',
          scope: 'workspace',
          layer: 'phase',
          slug: 'implement',
          displayName: 'Implement v2',
          versionNumber: 2,
          schemaVersion: 1,
          yamlText: 'id: implement\nversion: 2\n',
          promoteAsPublished: true
        }
      ]);

      expect(store.catalogConfig.getCatalogHead('phase-impl')?.publishedVersionId).toBe(
        'phase-impl@v2'
      );

      // Frozen closure for run-c1 still points to immutable phase-impl@v1
      const loadedClosure = store.catalogConfig.getFrozenExecutionClosure('fc-run-c1');
      expect(loadedClosure?.closure.rootDefinitionVersionId).toBe('phase-impl@v1');
      expect(loadedClosure?.closure.closureDigestSha256).toBe(frozen.closure.closureDigestSha256);
    } finally {
      store.close();
    }
  });
});
