// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: DEFERRED.
// Two acts left this module. T1525c moved the election (`lock.tryAcquire()`, an
// exclusive-create under `.schegent/`), and the classification pass found the
// mount probe still in flight at wiring time — see `startMountProbe` on the
// returned interface. What remains is construction and one store read.

import * as path from 'node:path';
import * as vscode from 'vscode';

import { CatalogSession } from './catalog-loading';
import { createHostCatalogStore, createHostCatalogLifecycle } from './catalog-store-wiring';
import type { CatalogConfigReader } from '../config/pipeline-config-loader';
import { createCatalogReader } from './catalog-settings-wiring';
import { nodeDigest } from './catalog-store-wiring';
import { liveRunPlans, retainedHistoryPlans } from './run-provenance-enumeration';
import { warnIfEnvironmentIsUnrestricted } from './backend-wiring';
import { startMountCapabilityProbe } from './mount-capability-wiring';
import { warnIfScaffoldingMissing } from './workspace-scaffolding';
import { createDiskOwnershipFs } from '../state/ownership-fs';
import type { HistoryStore } from '../state/history-store';
import type { SanitizedLogger } from '../lib/logger';
import { QueueManager } from '../queue/queue-manager';
import type { ProcessEnvironmentPolicy } from '../runner/spawn-env';
import { ExecutionLeaseManager } from '../state/execution-lease';
import { WorkspaceLockManager } from '../state/lock';
import type { WorkspaceStateStore } from '../state/workspace-state';
import { Notifier } from '../ui/notifications';
import { SchegentStatusBar } from '../ui/status-bar';

/**
 * FR-R3-119 — the workspace session: catalog, leases, and the UI shell that
 * reports them.
 *
 * The fourth extraction out of `wireStage2()`. 77 lines, **six** bindings in, ten
 * out, no late binding — chosen on input boundary rather than size, as the three
 * before it were.
 *
 * WHY THESE BELONG TOGETHER. Each one answers "what does this window own, and how
 * does it say so": the catalog it reads, the two leases it holds (`FR-R3-003`
 * pointed both at storage two extension hosts can see), the lock manager that
 * will make the primacy claim, and the status bar and notifier that report the
 * outcome.
 *
 * FR-R3-136 — the claim ITSELF is not made here any more. Building the manager
 * writes nothing; `tryAcquire()` writes a file, and an untrusted window may not.
 * The call moved to `stage2-producers.ts` along with every other act that touches
 * the workspace, so this module returns the manager and no result.
 *
 * It is `async` for one reason only now: opening the catalog session.
 */
export interface WorkspaceSessionDeps {
  readonly workspaceRoot: string;
  readonly ownerId: string;
  readonly logger: SanitizedLogger;
  readonly store: WorkspaceStateStore;
  readonly disposables: vscode.Disposable[];
  readonly processEnvironmentPolicy: ProcessEnvironmentPolicy;
  /**
   * FR-R3-119 — a GETTER, not the store.
   *
   * `catalogStore`'s retained-history enumerator reads it inside a thunk, and the
   * store itself is constructed ~180 lines later by
   * `backend-execution-wiring.ts`. The original code closed over a `const`
   * declared further down the same function and re-read it per question — the
   * comment beside the enumerator says so explicitly. Taking the value here would
   * force the caller to build the history store first, reordering activation to
   * suit an extraction, which `FR-059` forbids. The getter preserves the lazy read
   * exactly.
   */
  readonly getHistoryStore: () => HistoryStore;
}

export interface WorkspaceSession {
  readonly catalogReader: CatalogConfigReader;
  readonly catalogStore: ReturnType<typeof createHostCatalogStore>;
  readonly catalogSession: CatalogSession;
  readonly catalogLifecycle: ReturnType<typeof createHostCatalogLifecycle>;
  readonly lock: WorkspaceLockManager;
  readonly executionLeases: ExecutionLeaseManager;
  readonly statusBar: SchegentStatusBar;
  readonly notifier: Notifier;
  readonly queue: QueueManager;
  /**
   * FR-R3-136 (FR-011, T1525a) — the mount probe, handed over rather than run.
   *
   * `probeMountCapability` creates `.schegent/`, drops the local ignore file,
   * exclusive-creates `.schegent/.mount-probe.<pid>.<n>.<t>` and removes it
   * again: three writes inside the folder whose contents are the reason trust is
   * being withheld. It ran at wiring time and T1525d's suppression list did not
   * name it, which is what the classification pass is for.
   *
   * A thunk that pushes onto the same `disposables` array the call site used, so
   * teardown behaviour is byte-for-byte what it was — a verdict for a torn-down
   * stage is still dropped. It has to run on a GRANT as well as on a trusted
   * activation, which is why it is a producer act and not a gate in place: a
   * folder trusted after the fact would otherwise get no mount verdict at all,
   * and the operator would learn about an unsupported mount from a failing Run.
   */
  readonly startMountProbe: () => void;
}

export async function openWorkspaceSession(
  deps: WorkspaceSessionDeps
): Promise<WorkspaceSession> {
  const { workspaceRoot, ownerId, logger, store, disposables, processEnvironmentPolicy, getHistoryStore } =
    deps;

const catalogReader: CatalogConfigReader = createCatalogReader(workspaceRoot);
// Feature 099 (T493b, FR-051, FR-052) — `null` in an untrusted workspace, where
// no catalog activates at all. The snapshot still has to exist for the resolvers,
// so the two facts stay apart: no store, and the empty catalog it resolves to.
// Feature 102 (T051, FR-037) and 103 (T078, FR-040, FR-042) — the store is built
// here, `queue` below it and `historyStore` further down still, so both enumerators
// close over their sources and re-read per question; `createHostCatalogStore`
// documents why each `list()` has to stay inside its thunk.
const catalogStore = createHostCatalogStore(
  () => liveRunPlans(queue.listAll(), Object.values(store.getRunMap())),
  () => retainedHistoryPlans(getHistoryStore().list())
);
// Feature 099 (T493b, T496f, FR-027a, FR-042) — the store is read once, here,
// before anything is composed, and the session owns that snapshot together with
// everything resolved from it. See `CatalogSession` for why the five bindings
// this replaced are one fact.
const catalogSession = await CatalogSession.open({
  store: catalogStore,
  reader: catalogReader,
  digest: nodeDigest,
  logger
});
// Feature 100 (T509c, FR-047) — the six lifecycle commands' one dependency,
// built once beside the store it operates on. The default is read through the
// session rather than captured, so the FR-059 advisory sees the value in force
// at the moment of a deactivation; `refreshCatalog` already re-resolves the
// session when `schegent.defaultPipelineId` changes.
const catalogLifecycle = createHostCatalogLifecycle(
  catalogStore,
  () => catalogSession.catalog.defaultPipelineId
);
// Feature FR-R3-003 (T295) — point both leases at storage two extension hosts
// can both see, now that the workspace root is known. Until this call the store
// arbitrates through a `Memento`-backed adapter, which is correct for one host
// and is exactly the assumption finding REL-01 was about. `.schegent/` is
// covered by its own `.gitignore` (`*`), and an ownership record carries owner
// ids and timestamps only — never a workspace path.
// Feature FR-R3-005 (T330) — one expression, read twice: the adapter's store
// directory and the registry's directory are the same path by construction,
// so they cannot drift into a guard that proves membership of a tree the
// registry does not write to. FR-R3-069 (feature 152) splits the TRUST role
// out of that expression: judgments anchor at `workspaceRoot`, which a
// checkout cannot choose, while paths still compose from `ownershipDir` — so
// a `.schegent/ownership` symlinked out of the workspace refuses instead of
// authorizing its own target.
const ownershipDir = path.join(workspaceRoot, '.schegent', 'ownership');
store.useOwnershipStorage(createDiskOwnershipFs({ workspaceRoot, ownershipDir }), ownershipDir);
const lock = new WorkspaceLockManager(store, ownerId);
// Feature 092 (T049, FR-031) — the execution half of the lock split. Same
// owner id as the workspace lock so a crash strands both together, but a
// separate manager over a separate key: holding a queue's execution lease
// must never make this window primary.
const executionLeases = new ExecutionLeaseManager(store, ownerId);
// FR-R3-136 (FR-009) — THE ELECTION IS NO LONGER HERE. It moved to
// `stage2-producers.ts`, and the reason is C2: `store.ownership.acquire` is an
// exclusive-create on a generation-numbered file under `.schegent/`, which is a
// write inside the folder whose contents are exactly why trust is being
// withheld. An untrusted window must not perform it, and a grant that arrives
// later must — so the call belongs with the other producer acts, in the one
// module that runs on both paths, rather than in a session that opens once.
//
// FR-R3-070's property is unchanged and still gated by
// `tests/lint/elect-before-recovering.test.ts`: the election precedes every
// recovery installer, which is now a statement about a single file rather than
// two. This function is trust-agnostic as a result — it reads no trust value and
// takes no trust dependency, which is the correct amount for a module that only
// opens what the window owns.
const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
disposables.push(statusBarItem);
const statusBar = new SchegentStatusBar(statusBarItem);
const notifier = new Notifier({
  showInformationMessage: (m) => vscode.window.showInformationMessage(m),
  showWarningMessage: (m) => vscode.window.showWarningMessage(m),
  showErrorMessage: (m) => vscode.window.showErrorMessage(m)
});
warnIfEnvironmentIsUnrestricted(processEnvironmentPolicy, workspaceRoot, logger);
// FR-R3-083 (`PORT-01`) — bounded, never awaited, and dropped on teardown so a
// verdict cannot surface against a workspace this window has left.
// FR-R3-136 (FR-011) — NOT started here any more; see `startMountProbe` on the
// returned interface for what it writes and why the grant needs it too.
const startMountProbe = (): void => {
  disposables.push(startMountCapabilityProbe(workspaceRoot, logger, notifier));
};
// The extension also activates via the implicit `onView:schegent.sidebar` event,
// so `workspaceContains:.specify/` does not imply the directory is there.
warnIfScaffoldingMissing(workspaceRoot, logger, notifier);

const queue = new QueueManager(store, logger);
  return {
    catalogReader,
    catalogStore,
    catalogSession,
    catalogLifecycle,
    lock,
    executionLeases,
    statusBar,
    notifier,
    queue,
    startMountProbe
  };
}
