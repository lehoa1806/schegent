// Feature 099 (FR-R3-015) T476b — the store's only public surface.
//
// Everything outside `src/catalog/` imports from here, which buys two things:
// the wiring depends on one module rather than on eight, and the purity lint of
// FR-058 has one entry point whose value-import closure it can walk (FR-057).
//
// Deliberately narrow. `canonical-json.ts`, `catalog-manifest.ts`,
// `catalog-integrity.ts`, and `atomic-write.ts` are not re-exported: they are the
// store's internals, and a consumer reaching for one of them is a consumer about
// to write a second manifest writer.

export {
  createCatalogStore,
  emptyCatalogSnapshot,
  snapshotOfRead,
  type CatalogStore
} from './catalog-store';
export {
  createLifecycleService,
  type CatalogLifecycleOps,
  type LifecycleService,
  type LifecycleServicePorts
} from './lifecycle-service';
export { publishPackage, type PackagePublishPorts } from './package-publish';
export { storedIds, storedRows } from './snapshot-rows';
export { planRetention, withVersionsRemoved, type RetentionExemption, type RetentionPlan } from './catalog-retention';
export { runProvenanceNone } from './run-provenance-none';
export type {
  CandidateDefinition,
  CatalogFsPort,
  CatalogStorePorts,
  Clock,
  DefinitionSemantics,
  Digest,
  FsReadOutcome,
  FsRemoveOutcome,
  FsWriteIfAbsentOutcome,
  FsWriteOutcome,
  RunProvenance,
  StoreSegments,
  StoreWritability
} from './ports';
