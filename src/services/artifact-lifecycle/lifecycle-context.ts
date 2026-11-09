/**
 * FR-R6-F05 — the dependencies and stores every lifecycle module shares, and
 * the one rule that decides an artifact's standing: protected, eligible, or
 * neither (FR-005, FR-008, FR-009).
 *
 * The facade builds one context; the inventory, scan, pressure and deletion
 * modules read from it so the standing rule exists once.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import {
  NEVER_ELIGIBLE_STORE_KINDS,
  type ArtifactAvailabilityState,
  type ArtifactRecord,
  type LifecycleDiagnostic
} from '../../contracts/artifact-lifecycle/lifecycle-types';
import type { LegacyCatalogConsumerPort } from '../../contracts/artifact-lifecycle/legacy-preservation-types';
import type { RunFrameStatusLookup } from '../../contracts/artifact-lifecycle/retention-policy-types';
import type { NodeSqliteConnection } from '../sqlite-store';
import type { ArtifactByteProbe, ArtifactRecordStore } from './artifact-records';
import type { LegacyCatalogRoot } from './legacy-classification';
import type { LegacyPreservationFs } from './legacy-preservation-fs';
import type { ArtifactAccessPolicy, ArtifactByteReader, LifecycleFs, StorageScanRoot } from './lifecycle-ports';
import type { LifecycleAuditSink } from './mutation-authority';
import type { PreviewStore } from './previews';
import type { OwnerResolver, ReferenceStore } from './references';

/** The sweep lease and scan checkpoints key on this when the host names no workspace. */
export const DEFAULT_LIFECYCLE_WORKSPACE_ID = 'workspace';

/** Availability whose bytes no longer occupy storage; such records are left out of every total. */
const GONE_AVAILABILITY: readonly ArtifactAvailabilityState[] = ['deleted', 'missing', 'expired'];

/** The legacy catalog the preservation operations act on (FR-013..FR-015). */
export interface LegacyCatalogDependencies {
  readonly catalogRoot: LegacyCatalogRoot;
  readonly files: LegacyPreservationFs;
  readonly consumers: LegacyCatalogConsumerPort;
  /** Workspace-relative quarantine directory; defaults to `.schegent/quarantine/catalog`. */
  readonly quarantineSegments?: readonly string[];
}

export interface ArtifactLifecycleServiceDependencies {
  readonly conn: NodeSqliteConnection;
  readonly nowMs: () => number;
  readonly fs: LifecycleFs;
  readonly probe: ArtifactByteProbe;
  readonly audit: LifecycleAuditSink;
  readonly scanRoots: readonly StorageScanRoot[];
  readonly accessPolicy: ArtifactAccessPolicy;
  /** Places a reference owner after a restart; `unresolved` makes protection fail closed (FR-006). */
  readonly resolveOwner: OwnerResolver;
  /** Opaque id source for previews and operations; defaults to `randomUUID`. */
  readonly newId?: () => string;
  /** Absolute workspace root that `workspace_file` locators resolve against. Without it no deletion target resolves. */
  readonly workspaceRoot?: string;
  /** Runs F02 pins for recovery (`recoveryPinnedRunIds`); their artifacts are protected. */
  readonly pinnedRunIds?: () => ReadonlySet<string>;
  /** Operator storage target in bytes; absent means no target is configured. */
  readonly storageTargetBytes?: number;
  /** Key for the sweep lease and scan checkpoints; defaults to {@link DEFAULT_LIFECYCLE_WORKSPACE_ID}. */
  readonly workspaceId?: string;
  /** Byte source for materialized copies (FR-023); absent means every copy is `unavailable`. */
  readonly byteReader?: ArtifactByteReader;
  /** Control-ledger frame statuses of one run (FR-016); absent means every run counts as unresolved. */
  readonly runFrameStatuses?: RunFrameStatusLookup;
  /** The legacy catalog (FR-013); absent means every preservation operation answers `unavailable`. */
  readonly legacyCatalog?: LegacyCatalogDependencies;
}

export interface LifecycleContext {
  readonly deps: ArtifactLifecycleServiceDependencies;
  readonly records: ArtifactRecordStore;
  readonly previews: PreviewStore;
  readonly references: ReferenceStore;
  readonly newId: () => string;
}

export interface ArtifactStanding {
  readonly protected: boolean;
  readonly diagnostic: LifecycleDiagnostic | null;
  readonly unclassified: boolean;
  readonly neverEligible: boolean;
  readonly liveWriter: boolean;
  /** The bytes are gone; the record counts toward no total. */
  readonly gone: boolean;
  readonly eligible: boolean;
}

export function workspaceIdOf(ctx: LifecycleContext): string {
  return ctx.deps.workspaceId ?? DEFAULT_LIFECYCLE_WORKSPACE_ID;
}

export function pinnedRunsOf(ctx: LifecycleContext): ReadonlySet<string> {
  return ctx.deps.pinnedRunIds?.() ?? new Set<string>();
}

export function isLiveWriter(record: ArtifactRecord): boolean {
  return record.immutability === 'growing' && record.terminalSettledAtMs === null;
}

/** The standing of one record. `pinnedRuns` is read once per batch by the caller. */
export function standingOf(
  ctx: LifecycleContext,
  record: ArtifactRecord,
  pinnedRuns: ReadonlySet<string>
): ArtifactStanding {
  const verdict = ctx.references.isProtected(record.artifactId, ctx.deps.resolveOwner);
  const pinnedRun = record.ownerRunId !== null && pinnedRuns.has(record.ownerRunId);
  const isProtected = verdict.protected || pinnedRun;
  const unclassified = record.storeKind === 'unclassified';
  const neverEligible = NEVER_ELIGIBLE_STORE_KINDS.includes(record.storeKind);
  const liveWriter = isLiveWriter(record);
  const gone = GONE_AVAILABILITY.includes(record.availability);
  return {
    protected: isProtected,
    diagnostic: verdict.diagnostic,
    unclassified,
    neverEligible,
    liveWriter,
    gone,
    eligible: !isProtected && !unclassified && !neverEligible && !liveWriter && !gone
  };
}

/** The adopted policy revision, or 0 before any policy is adopted. */
export function adoptedPolicyRevision(conn: NodeSqliteConnection): number {
  return conn.scalar<number>(`SELECT policy_revision FROM retention_policy_revisions WHERE state = 'adopted'`) ?? 0;
}

/** Every managed record in keyset order, read in bounded chunks. */
export function forEachManagedRecord(
  ctx: LifecycleContext,
  visit: (record: ArtifactRecord) => void,
  retentionClass?: ArtifactRecord['retentionClass']
): void {
  const chunk = 500;
  let after: { retentionClass: string; artifactId: string } | undefined;
  for (;;) {
    const rows = ctx.records.pageManaged({ after, retentionClass, limit: chunk });
    rows.forEach(visit);
    const last = rows.at(-1);
    if (rows.length < chunk || last === undefined) return;
    after = { retentionClass: last.retentionClass, artifactId: last.artifactId };
  }
}
