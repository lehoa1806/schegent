// Feature 099 (FR-R3-015) T493 — the store's four ports, built once for the host.
//
// This is the only module that pairs the store with VS Code. It holds the
// workspace root, the Node clock, the Node digest, and the Workspace Trust
// decision, so `src/catalog/` holds none of them (FR-057). Everything below the
// port boundary is pure and testable with stubs; everything impure is here.

import * as crypto from 'node:crypto';

import * as vscode from 'vscode';

import {
  createCatalogStore,
  createLifecycleService,
  createQueueRunProvenance,
  publishPackage,
  type CatalogLifecycleOps,
  type CatalogStore,
  type Clock,
  type Digest,
  type RunVersionCarrier
} from '../catalog';
import { createDefinitionSemantics } from '../config/definition-semantics';
import { CATALOG_DIRECTORY_SEGMENTS, createCatalogFsAdapter } from '../host-services/catalog-fs-adapter';
import { getCanonicalWorkspaceRoot } from '../state/workspace-folder-picker';

/** Epoch milliseconds, the store's one time representation (FR-021a). */
export const systemClock: Clock = Object.freeze({
  nowMs: () => Date.now()
});

/** `sha256:<lowercase hex>` over the UTF-8 bytes of the canonical form (FR-012). */
export const nodeDigest: Digest = Object.freeze({
  sha256: (canonical: string) =>
    `sha256:${crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')}`
});

/**
 * Is the catalog allowed to activate at all?
 *
 * Feature 099 (T493, FR-051, FR-052) — Workspace Trust is the single gate the
 * collapse keeps, and it is kept for a reason the layer tier never addressed: a
 * cloned repository can contain a `.schegent/catalog/` directory, so activating
 * one in an untrusted workspace would execute definitions the operator has never
 * read. The two `allow*Overrides` settings that went with the layer tier gated
 * *which layer may redefine which*, a question that no longer exists (FR-045).
 *
 * Exported so the Builder can report the gate rather than an empty catalog: the
 * two states look identical from a snapshot alone, and "no catalog, and nobody
 * told you why" is the failure this distinction exists to prevent (FR-052).
 */
export function isCatalogActivationTrusted(): boolean {
  return vscode.workspace.isTrusted;
}

/**
 * The store, or `null` in an untrusted workspace.
 *
 * `null` rather than an empty store, because the two are different facts and the
 * surfaces report them differently (FR-052). A trusted workspace with no folder
 * open still gets a store: its reads report the empty catalog (FR-001a) and its
 * writes refuse `no-workspace` by name (FR-033a), which is more useful than a
 * second null to disambiguate downstream.
 *
 * @param enumeratePlans Feature 102 (T051, FR-037) — the versions live runs have
 *                       frozen, read fresh on every retention question. Late-bound
 *                       and defaulted to nothing, because the store is built
 *                       before the queue that answers this exists: a caller with
 *                       no queue yet (a fixture, a probe) gets a store whose
 *                       retention exempts nothing, which is the correct answer for
 *                       a host that runs nothing. `liveRunPlans` in
 *                       `run-provenance-enumeration.ts` is what activation passes.
 * @param enumerateRetained Feature 103 (T078, FR-040) — the versions recorded by
 *                       runs that have finished and are still in history, on the
 *                       same terms. Late-bound and defaulted for the same reason:
 *                       the store is built before the history store. Activation
 *                       passes `retainedHistoryPlans(historyStore.list())`, and
 *                       the `list()` belongs inside the thunk — hoisting it out
 *                       is the smallest cache there is, and FR-042 forbids it.
 */
export function createHostCatalogStore(
  enumeratePlans: () => Iterable<RunVersionCarrier> = () => [],
  enumerateRetained: () => Iterable<RunVersionCarrier> = () => []
): CatalogStore | null {
  if (!isCatalogActivationTrusted()) return null;
  return createCatalogStore({
    fs: createCatalogFsAdapter(catalogStoreAnchor()),
    clock: systemClock,
    digest: nodeDigest,
    provenance: createQueueRunProvenance(enumeratePlans, enumerateRetained)
  });
}

/**
 * The workspace root and the store root beneath it, or `null` with no
 * workspace folder open.
 *
 * The one place in the feature where a workspace root and the store's segments
 * meet, and it hands the result straight to the fs adapter — which is the one
 * place that keeps it (FR-061). FR-R3-069 — both roles travel separately: the
 * workspace root is the trusted anchor judgments resolve against, the store
 * root only composes paths, so a symlinked `.schegent`/`catalog` in a cloned
 * checkout refuses instead of becoming its own containment boundary.
 */
function catalogStoreAnchor(): { workspaceRoot: string; storeRoot: string } | null {
  const folder = getCanonicalWorkspaceRoot();
  if (folder === undefined) return null;
  return {
    workspaceRoot: folder.uri.fsPath,
    storeRoot: vscode.Uri.joinPath(folder.uri, ...CATALOG_DIRECTORY_SEGMENTS).fsPath
  };
}

/**
 * The six lifecycle operations, or `null` in an untrusted workspace.
 *
 * Feature 100 (FR-R3-016) T509c — one dependency for the six commands, built
 * here for the same reason the store is: the pieces it needs are impure. The
 * store carries the workspace root and the clock; the semantics carry a
 * configuration read. A handler that assembled this itself would read
 * configuration on every keystroke-driven save.
 *
 * `null` tracks the store's `null` exactly, and by construction rather than by
 * a second trust check: with no store there is nothing to run an operation
 * against, and a lifecycle service over a store that does not exist would refuse
 * every command for the wrong reason.
 *
 * `publishPackage` is bound on here rather than being a sixth method of the
 * service. It is a sequence over the store (FR-035), not a per-definition
 * operation, and `CatalogLifecycleOps` exists precisely so the two halves are
 * wired together and never apart.
 *
 * @param store             The host store, or `null` in an untrusted workspace.
 * @param defaultPipelineId Reads `schegent.defaultPipelineId` fresh per call, so
 *                          the FR-059 advisory cannot go stale (see
 *                          `DefinitionSemanticsOptions`).
 */
export function createHostCatalogLifecycle(
  store: CatalogStore | null,
  defaultPipelineId: () => string
): CatalogLifecycleOps | null {
  if (store === null) return null;
  const semantics = createDefinitionSemantics({ defaultPipelineId });
  const service = createLifecycleService({ store, semantics });
  return {
    ...service,
    publishPackage: (request) => publishPackage({ store, semantics }, request)
  };
}
