// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT, AND ALREADY GATED
// BY AN OLDER CONTROL.
// The store's writes are methods the save router calls, and every `CMD_SAVE_*` /
// `CMD_PUBLISH_*` id it serves is in `MUTATING_COMMAND_TYPES`. Feature 099 got
// there first from the other direction: `isCatalogActivationTrusted()` below
// returns `vscode.workspace.isTrusted` and `createHostCatalogStore` returns
// `null` while untrusted, so an untrusted window has no store to write with. That
// is the one place this feature found a trust gate it did not have to add.

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
import type { SanitizedLogger } from '../lib/logger';
import {
  createSwitchableCatalogFsAdapter,
  type SwitchableCatalogFsAdapter
} from '../services/sqlite-store';
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
 * @param logger Feature 217 (FR-003) — where the store's filesystem says, once
 *                       and path-free, what narrowing its directories and files
 *                       found. Activation passes its logger; a caller that omits
 *                       it is told nothing.
 * @param disposables Feature 254 (FR-038, TA7) — where the claim on the store root
 *                       is released. The store root is claimed for this host while
 *                       the store lives: a second call for the same root returns
 *                       `null` with one path-free warning, because two stores on one
 *                       directory are not ordered by anything (the manifest is
 *                       last-writer-wins across them). Activation passes the
 *                       session's `disposables`, which `closeStage2Resources`
 *                       disposes, so a re-activated Stage 2 claims again. A caller
 *                       that omits it holds the claim for the life of the host, which
 *                       is why every caller that builds more than one store for a
 *                       root passes it. No claim is made in an untrusted workspace or
 *                       with no folder open: there is no directory to claim.
 */
export function createHostCatalogStore(
  enumeratePlans: () => Iterable<RunVersionCarrier> = () => [],
  enumerateRetained: () => Iterable<RunVersionCarrier> = () => [],
  logger?: Pick<SanitizedLogger, 'warn'>,
  disposables?: vscode.Disposable[],
  onSwitchableFs?: (fs: SwitchableCatalogFsAdapter) => void
): CatalogStore | null {
  if (!isCatalogActivationTrusted()) return null;
  const anchor = catalogStoreAnchor();
  if (anchor !== null && !claimStoreRoot(anchor.storeRoot, logger, disposables)) return null;
  const switchableFs = createSwitchableCatalogFsAdapter(
    createCatalogFsAdapter(anchor, logger),
    () => anchor !== null
  );
  onSwitchableFs?.(switchableFs);
  return createCatalogStore({
    fs: switchableFs,
    clock: systemClock,
    digest: nodeDigest,
    provenance: createQueueRunProvenance(enumeratePlans, enumerateRetained)
  });
}

/**
 * The store roots a live host store holds, for this host (feature 254, FR-038).
 *
 * In memory, and nothing else: no lock file and no lock directory (FR-038). It orders the stores THIS host
 * builds; it cannot order another process, which is why the single-writer precondition is also written in
 * `docs/architecture/durability-decision.md`. `createCatalogStore` itself is not claimed: the test
 * fixtures build it directly to model two windows.
 */
const claimedStoreRoots = new Set<string>();

/** Claim `storeRoot`, or say once, without a path, that it is held. Returns whether the claim was made. */
function claimStoreRoot(
  storeRoot: string,
  logger: Pick<SanitizedLogger, 'warn'> | undefined,
  disposables: vscode.Disposable[] | undefined
): boolean {
  if (claimedStoreRoots.has(storeRoot)) {
    logger?.warn('catalog store: a store is already open on this catalog directory, so this one was not created');
    return false;
  }
  claimedStoreRoots.add(storeRoot);
  // Released once: a second dispose of an old claim's Disposable must not free a claim made after it.
  let held = true;
  disposables?.push({
    dispose: () => {
      if (!held) return;
      held = false;
      claimedStoreRoots.delete(storeRoot);
    }
  });
  return true;
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
 * @param defaultWorkflowId Reads the resolved default Workflow ID fresh per call, so
 *                          the FR-059 advisory cannot go stale (see
 *                          `DefinitionSemanticsOptions`, Feature 285).
 */
export function createHostCatalogLifecycle(
  store: CatalogStore | null,
  defaultWorkflowId: () => string
): CatalogLifecycleOps | null {
  if (store === null) return null;
  const semantics = createDefinitionSemantics({ defaultWorkflowId });
  const service = createLifecycleService({ store, semantics });
  return {
    ...service,
    publishPackage: (request) => publishPackage({ store, semantics }, request)
  };
}
