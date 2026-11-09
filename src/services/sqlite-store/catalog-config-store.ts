/**
 * FR-R6-F04 (F04-C, FR-021, FR-022, SC-011) — `CatalogConfigStoreAdapter` for
 * catalog definitions (`Phase`, `Pipeline`, `Workflow`), model catalogs,
 * policy versions, frozen execution closures, canonical YAML round-trip
 * equivalence, and dependency-ordered (`Phase → Pipeline → Workflow`)
 * per-layer package partial-success semantics.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { createHash } from 'node:crypto';
import type {
  CatalogHeadRow,
  CatalogLayer,
  CatalogPackageImportItem,
  CatalogPackageImportResult,
  CatalogScope,
  DefinitionRow,
  DefinitionVersionRow,
  FrozenClosureMemberRow,
  FrozenClosureRow,
  ModelCatalogVersionRow,
  PolicyVersionRow
} from '../../contracts/sqlite-store/state-census';
import type { NodeSqliteConnection } from './sqlite-driver';
import type { AtomicTransactionUnitsService } from './transaction-units';

const LAYER_ORDER: Readonly<Record<CatalogLayer, number>> = {
  phase: 0,
  pipeline: 1,
  workflow: 2
};

export function canonicalizeYamlText(yamlText: string): string {
  const normalizedLines = yamlText
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''));
  while (normalizedLines.length > 0 && normalizedLines[0] === '') {
    normalizedLines.shift();
  }
  while (normalizedLines.length > 0 && normalizedLines[normalizedLines.length - 1] === '') {
    normalizedLines.pop();
  }
  return `${normalizedLines.join('\n')}\n`;
}

export function computeCanonicalYamlSha256(yamlText: string): string {
  return createHash('sha256').update(canonicalizeYamlText(yamlText), 'utf8').digest('hex');
}

export class CatalogConfigStoreAdapter {
  private readonly conn: NodeSqliteConnection;
  private readonly transactions: AtomicTransactionUnitsService;
  private readonly nowMs: () => number;

  public constructor(
    conn: NodeSqliteConnection,
    transactions: AtomicTransactionUnitsService,
    nowMs: () => number = () => Date.now()
  ) {
    this.conn = conn;
    this.transactions = transactions;
    this.nowMs = nowMs;
  }

  public getCatalogRevision(scope: 'workspace' | 'global' | 'combined'): number {
    return Number(
      this.conn.scalar(`SELECT revision FROM catalog_revisions WHERE scope = ?`, scope) ?? 0
    );
  }

  public publishPolicyVersion(params: {
    readonly policyVersionId: string;
    readonly scope: 'workspace' | 'global';
    readonly policyName: string;
    readonly versionNumber: number;
    readonly yamlText: string;
  }): { readonly version: PolicyVersionRow; readonly revision: number } {
    const now = this.nowMs();
    const canonicalYaml = canonicalizeYamlText(params.yamlText);
    const digestSha256 = computeCanonicalYamlSha256(canonicalYaml);

    this.conn.exec('BEGIN IMMEDIATE');
    try {
      this.conn.run(
        `INSERT INTO policy_versions (
          policy_version_id, scope, policy_name, version_number, canonical_yaml, digest_sha256, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params.policyVersionId,
        params.scope,
        params.policyName,
        params.versionNumber,
        canonicalYaml,
        digestSha256,
        now
      );

      this.conn.run(
        `INSERT INTO policy_heads (scope, policy_name, active_policy_version_id, revision, updated_at_ms)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(scope, policy_name) DO UPDATE SET
           active_policy_version_id = excluded.active_policy_version_id,
           revision = policy_heads.revision + 1,
           updated_at_ms = excluded.updated_at_ms`,
        params.scope,
        params.policyName,
        params.policyVersionId,
        now
      );

      const rev = Number(
        this.conn.scalar(
          `SELECT revision FROM policy_heads WHERE scope = ? AND policy_name = ?`,
          params.scope,
          params.policyName
        ) ?? 1
      );
      this.conn.exec('COMMIT');

      return {
        version: {
          policyVersionId: params.policyVersionId,
          scope: params.scope,
          policyName: params.policyName,
          versionNumber: params.versionNumber,
          canonicalYaml,
          digestSha256,
          createdAtMs: now
        },
        revision: rev
      };
    } catch (err) {
      try {
        this.conn.exec('ROLLBACK');
      } catch {
        // Ignore
      }
      throw err;
    }
  }

  public publishModelCatalogVersion(params: {
    readonly modelCatalogVersionId: string;
    readonly scope: CatalogScope;
    readonly versionNumber: number;
    readonly modelsJson: string;
  }): { readonly version: ModelCatalogVersionRow; readonly revision: number } {
    const now = this.nowMs();
    const digestSha256 = createHash('sha256').update(params.modelsJson, 'utf8').digest('hex');

    this.conn.exec('BEGIN IMMEDIATE');
    try {
      this.conn.run(
        `INSERT INTO model_catalog_versions (
          model_catalog_version_id, scope, version_number, models_json, digest_sha256, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        params.modelCatalogVersionId,
        params.scope,
        params.versionNumber,
        params.modelsJson,
        digestSha256,
        now
      );

      this.conn.run(
        `INSERT INTO model_catalog_heads (scope, active_model_catalog_version_id, revision, updated_at_ms)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(scope) DO UPDATE SET
           active_model_catalog_version_id = excluded.active_model_catalog_version_id,
           revision = model_catalog_heads.revision + 1,
           updated_at_ms = excluded.updated_at_ms`,
        params.scope,
        params.modelCatalogVersionId,
        now
      );

      const rev = Number(
        this.conn.scalar(
          `SELECT revision FROM model_catalog_heads WHERE scope = ?`,
          params.scope
        ) ?? 1
      );
      this.conn.exec('COMMIT');

      return {
        version: {
          modelCatalogVersionId: params.modelCatalogVersionId,
          scope: params.scope,
          versionNumber: params.versionNumber,
          modelsJson: params.modelsJson,
          digestSha256,
          createdAtMs: now
        },
        revision: rev
      };
    } catch (err) {
      try {
        this.conn.exec('ROLLBACK');
      } catch {
        // Ignore
      }
      throw err;
    }
  }

  public getDefinition(definitionId: string): DefinitionRow | undefined {
    const row = this.conn.get<{
      definition_id: string;
      scope: CatalogScope;
      layer: CatalogLayer;
      slug: string;
      display_name: string;
      created_at_ms: number;
    }>(`SELECT * FROM definitions WHERE definition_id = ?`, definitionId);
    if (!row) return undefined;
    return {
      definitionId: row.definition_id,
      scope: row.scope,
      layer: row.layer,
      slug: row.slug,
      displayName: row.display_name,
      createdAtMs: row.created_at_ms
    };
  }

  public getDefinitionVersion(definitionVersionId: string): DefinitionVersionRow | undefined {
    const row = this.conn.get<{
      definition_version_id: string;
      definition_id: string;
      version_number: number;
      status: DefinitionVersionRow['status'];
      canonical_yaml: string;
      digest_sha256: string;
      schema_version: number;
      created_at_ms: number;
    }>(`SELECT * FROM definition_versions WHERE definition_version_id = ?`, definitionVersionId);
    if (!row) return undefined;
    return {
      definitionVersionId: row.definition_version_id,
      definitionId: row.definition_id,
      versionNumber: row.version_number,
      status: row.status,
      canonicalYaml: row.canonical_yaml,
      digestSha256: row.digest_sha256,
      schemaVersion: row.schema_version,
      createdAtMs: row.created_at_ms
    };
  }

  public getCatalogHead(definitionId: string): CatalogHeadRow | undefined {
    const row = this.conn.get<{
      definition_id: string;
      published_version_id: string | null;
      draft_version_id: string | null;
      revision: number;
      updated_at_ms: number;
    }>(`SELECT * FROM catalog_heads WHERE definition_id = ?`, definitionId);
    if (!row) return undefined;
    return {
      definitionId: row.definition_id,
      publishedVersionId: row.published_version_id,
      draftVersionId: row.draft_version_id,
      revision: row.revision,
      updatedAtMs: row.updated_at_ms
    };
  }

  /**
   * Exports a definition version to canonical YAML along with its verified SHA-256 digest.
   */
  public exportDefinitionVersionToYaml(definitionVersionId: string): {
    readonly canonicalYaml: string;
    readonly digestSha256: string;
    readonly verifiedEquivalence: boolean;
  } {
    const ver = this.getDefinitionVersion(definitionVersionId);
    if (!ver) {
      throw new Error(`DEFINITION_VERSION_NOT_FOUND: ${definitionVersionId}`);
    }
    const recomputedDigest = computeCanonicalYamlSha256(ver.canonicalYaml);
    return {
      canonicalYaml: ver.canonicalYaml,
      digestSha256: ver.digestSha256,
      verifiedEquivalence: recomputedDigest === ver.digestSha256
    };
  }

  /**
   * Imports a multi-item catalog package in strict dependency order (`Phase → Pipeline → Workflow`).
   * Each item commits atomically via `executeCatalogPublication` (`Catalog publication` unit).
   * If a higher-layer item fails validation or references a missing dependency,
   * already-committed lower-layer items remain persisted and a deterministic
   * partial-success report is returned (`FR-022`, `SC-011`).
   */
  public importCatalogPackage(
    items: readonly CatalogPackageImportItem[]
  ): CatalogPackageImportResult {
    const ordered = [...items].sort((a, b) => LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer]);
    const committedDefinitionIds: string[] = [];
    const failedItems: Array<{
      readonly definitionId: string;
      readonly layer: CatalogLayer;
      readonly reason: string;
    }> = [];

    for (const item of ordered) {
      const canonicalYaml = canonicalizeYamlText(item.yamlText);
      if (canonicalYaml.trim().length === 0 || !canonicalYaml.includes(':')) {
        failedItems.push({
          definitionId: item.definitionId,
          layer: item.layer,
          reason: 'INVALID_YAML_SYNTAX'
        });
        continue;
      }

      // Verify all declared dependencies exist before committing this item
      let missingDep: string | null = null;
      if (item.dependencies) {
        for (const dep of item.dependencies) {
          const targetDef = this.getDefinition(dep.toDefinitionId);
          if (!targetDef) {
            missingDep = dep.toDefinitionId;
            break;
          }
        }
      }
      if (missingDep !== null) {
        failedItems.push({
          definitionId: item.definitionId,
          layer: item.layer,
          reason: `MISSING_DEPENDENCY:${missingDep}`
        });
        continue;
      }

      const revScope = item.scope === 'global' ? 'global' : 'workspace';
      const expectedRevision = this.getCatalogRevision(revScope);
      const digestSha256 = computeCanonicalYamlSha256(canonicalYaml);
      const definitionVersionId = `${item.definitionId}@v${item.versionNumber}`;

      const outcome = this.transactions.executeCatalogPublication({
        idempotency: {
          scopeKind: 'catalog_import',
          scopeId: item.definitionId,
          idempotencyKey: `pkg-import-${definitionVersionId}-${digestSha256.slice(0, 12)}`,
          requestSha256: digestSha256
        },
        expectedRevision,
        publication: {
          scope: item.scope,
          definitionId: item.definitionId,
          layer: item.layer,
          slug: item.slug,
          displayName: item.displayName,
          definitionVersionId,
          versionNumber: item.versionNumber,
          status: item.promoteAsPublished ? 'published' : 'draft',
          canonicalYaml,
          digestSha256,
          schemaVersion: item.schemaVersion,
          promoteAsPublished: item.promoteAsPublished,
          dependencies: item.dependencies
        }
      });

      if (outcome.status === 'committed') {
        committedDefinitionIds.push(item.definitionId);
      } else {
        failedItems.push({
          definitionId: item.definitionId,
          layer: item.layer,
          reason: `${outcome.code}:${outcome.message}`
        });
      }
    }

    return {
      committedDefinitionIds,
      failedItems,
      finalCatalogRevision: this.getCatalogRevision('combined')
    };
  }

  /**
   * Captures an immutable `frozen_closures` + `frozen_closure_members` pin set
   * for a run so subsequent catalog edits never mutate in-flight execution definitions.
   */
  public createFrozenExecutionClosure(params: {
    readonly frozenClosureId: string;
    readonly runId: string;
    readonly rootDefinitionVersionId: string;
    readonly policyVersionId?: string | null | undefined;
    readonly modelCatalogVersionId?: string | null | undefined;
    readonly members: ReadonlyArray<{
      readonly memberRole: string;
      readonly definitionVersionId: string;
    }>;
  }): { readonly closure: FrozenClosureRow; readonly members: readonly FrozenClosureMemberRow[] } {
    const now = this.nowMs();
    const digestInput = [
      params.rootDefinitionVersionId,
      params.policyVersionId ?? '',
      params.modelCatalogVersionId ?? '',
      ...params.members.map((m) => `${m.memberRole}=${m.definitionVersionId}`)
    ].join('|');
    const closureDigestSha256 = createHash('sha256').update(digestInput, 'utf8').digest('hex');

    this.conn.exec('BEGIN IMMEDIATE');
    try {
      this.conn.run(
        `INSERT INTO frozen_closures (
          frozen_closure_id, run_id, root_definition_version_id, policy_version_id, model_catalog_version_id, closure_digest_sha256, frozen_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params.frozenClosureId,
        params.runId,
        params.rootDefinitionVersionId,
        params.policyVersionId ?? null,
        params.modelCatalogVersionId ?? null,
        closureDigestSha256,
        now
      );

      for (const member of params.members) {
        this.conn.run(
          `INSERT INTO frozen_closure_members (frozen_closure_id, member_role, definition_version_id)
           VALUES (?, ?, ?)`,
          params.frozenClosureId,
          member.memberRole,
          member.definitionVersionId
        );
      }

      this.conn.run(
        `UPDATE runs SET frozen_closure_id = ? WHERE run_id = ?`,
        params.frozenClosureId,
        params.runId
      );
      this.conn.exec('COMMIT');
    } catch (err) {
      try {
        this.conn.exec('ROLLBACK');
      } catch {
        // Ignore
      }
      throw err;
    }

    return {
      closure: {
        frozenClosureId: params.frozenClosureId,
        runId: params.runId,
        rootDefinitionVersionId: params.rootDefinitionVersionId,
        policyVersionId: params.policyVersionId ?? null,
        modelCatalogVersionId: params.modelCatalogVersionId ?? null,
        closureDigestSha256,
        frozenAtMs: now
      },
      members: params.members.map((m) => ({
        frozenClosureId: params.frozenClosureId,
        memberRole: m.memberRole,
        definitionVersionId: m.definitionVersionId
      }))
    };
  }

  public getFrozenExecutionClosure(frozenClosureId: string): {
    readonly closure: FrozenClosureRow;
    readonly members: readonly FrozenClosureMemberRow[];
  } | undefined {
    const row = this.conn.get<{
      frozen_closure_id: string;
      run_id: string;
      root_definition_version_id: string;
      policy_version_id: string | null;
      model_catalog_version_id: string | null;
      closure_digest_sha256: string;
      frozen_at_ms: number;
    }>(`SELECT * FROM frozen_closures WHERE frozen_closure_id = ?`, frozenClosureId);
    if (!row) return undefined;

    const memberRows = this.conn.all<{
      frozen_closure_id: string;
      member_role: string;
      definition_version_id: string;
    }>(
      `SELECT * FROM frozen_closure_members WHERE frozen_closure_id = ? ORDER BY member_role ASC`,
      frozenClosureId
    );

    return {
      closure: {
        frozenClosureId: row.frozen_closure_id,
        runId: row.run_id,
        rootDefinitionVersionId: row.root_definition_version_id,
        policyVersionId: row.policy_version_id,
        modelCatalogVersionId: row.model_catalog_version_id,
        closureDigestSha256: row.closure_digest_sha256,
        frozenAtMs: row.frozen_at_ms
      },
      members: memberRows.map((m) => ({
        frozenClosureId: m.frozen_closure_id,
        memberRole: m.member_role,
        definitionVersionId: m.definition_version_id
      }))
    };
  }
}
