// Catalog loading for activation. Extracted from `extension.ts` so the resolved
// Phase/Pipeline/Workflow catalog and the loader diagnostics have a focused owner
// alongside the other Stage-2 wiring modules.

import type { ResolvedPipelineCatalog } from '../config/pipeline-catalog';
import type { PipelineCatalog } from '../config/pipeline-config';
import { loadCatalog, type CatalogConfigReader } from '../config/pipeline-config-loader';
import type { ResolvedPhaseCatalog } from '../config/process-catalog';
import { resolveWorkflowCatalog } from '../config/workflow-catalog';
import { emptyCatalogSnapshot, snapshotOfRead, storedIds, storedRows } from '../catalog';
import type { CatalogStore } from '../catalog/catalog-store';
import type { Digest } from '../catalog/ports';
import type {
  CatalogCollectableRecord,
  CatalogIntegrityFault,
  CatalogKind,
  CatalogSnapshot,
  StoredDefinition
} from '../contracts/catalog-store';
import type { WorkflowCatalogResolution } from '../contracts/workflow-definitions';
import type { SanitizedLogger } from '../lib/logger';

export interface LoadedCatalog {
  readonly catalog: PipelineCatalog;
  readonly phaseCatalog: ResolvedPhaseCatalog;
  readonly pipelineCatalog: ResolvedPipelineCatalog;
  /**
   * Feature 083 — the Workflow catalog, resolved here so load and reload stay
   * in lockstep and so it is built against the same **effective** Pipeline
   * catalog this call just produced. Resolving it at a separate site would let
   * the two drift after a store write.
   */
  readonly workflowCatalog: WorkflowCatalogResolution;
  /**
   * Feature 099 (T493a, FR-027) — the store's integrity findings, carried
   * alongside the resolution rather than thrown or logged and dropped.
   *
   * A fault presents one definition as unreadable and leaves every other one
   * resolving, so it cannot be an error on the load: the caller needs the catalog
   * *and* the findings. `collectable` is not a fault and travels separately for
   * exactly that reason (FR-026).
   */
  readonly faults: readonly CatalogIntegrityFault[];
  readonly collectable: readonly CatalogCollectableRecord[];
}

/**
 * Resolve the whole catalog from one store snapshot and report loader
 * diagnostics to the debug log.
 *
 * Feature 099 (T493a, FR-027a, FR-042) — the snapshot arrives already read. The
 * store's I/O is async and every resolver here is synchronous; reading once at the
 * wiring boundary is what keeps those signatures, and it also means one read backs
 * the Phase, Pipeline, and Workflow resolutions, so the three cannot disagree
 * about what the store held.
 *
 * Called once during activation and again after a successful store write.
 */
export function loadAndReportCatalog(
  snapshot: CatalogSnapshot,
  reader: CatalogConfigReader | undefined,
  logger: Pick<SanitizedLogger, 'debug'>
): LoadedCatalog {
  const result = loadCatalog(snapshot, reader);
  if (result.errors.length > 0) {
    logger.debug(
      `pipeline-config: ${result.errors.length} error(s) found in the stored catalog; resolving to the empty catalog`
    );
    for (const err of result.errors.slice(0, 3)) {
      logger.debug(
        `pipeline-config: ${err.source}${err.id ? `[${err.id}]` : ''}${err.field ? `.${err.field}` : ''}: ${err.message}`
      );
    }
    if (result.errors.length > 3) {
      logger.debug(`pipeline-config: ${result.errors.length - 3} additional error(s) suppressed`);
    }
  }
  for (const w of result.warnings) {
    logger.debug(
      `pipeline-config: ${w.source}${w.id ? `[${w.id}]` : ''}: ${w.message}`
    );
  }
  // Feature 099 (T494b, FR-060) — every store-reported condition goes to the same
  // runtime log sink the loader diagnostics already use. No audit event type and no
  // webview message family is added for them, and no emitted line carries a
  // workspace root: a fault names a kind, an id, and a version id (FR-061).
  for (const fault of snapshot.faults) {
    logger.debug(`catalog-store: integrity fault — ${describeFault(fault)}`);
  }
  for (const record of snapshot.collectable) {
    logger.debug(
      `catalog-store: collectable record ${record.kind}/${record.id}@${record.versionId} is unreferenced by the manifest`
    );
  }

  const { catalog, phaseCatalog, pipelineCatalog } = result;
  const workflowCatalog = resolveWorkflowCatalog({
    rows: storedRows(snapshot, 'workflow'),
    revision: snapshot.revisions.workflow,
    pipelineCatalog
  });
  return {
    catalog,
    phaseCatalog,
    pipelineCatalog,
    workflowCatalog,
    faults: snapshot.faults,
    collectable: snapshot.collectable
  };
}

/** What a session needs to read and re-resolve a catalog. */
export interface CatalogSessionPorts {
  /** `null` in an untrusted workspace, where no catalog activates at all (FR-051). */
  readonly store: CatalogStore | null;
  /** The two settings that stayed: `schegent.models` and `schegent.defaultPipelineId`. */
  readonly reader: CatalogConfigReader | undefined;
  readonly digest: Digest;
  readonly logger: Pick<SanitizedLogger, 'debug'>;
}

/**
 * The catalog one window currently holds, and the one place it is replaced.
 *
 * Feature 099 (T496f, FR-027a, FR-042, FR-054) — activation used to keep the
 * snapshot and the four resolutions as five mutable locals and re-assign all five
 * in a reload closure. They are one fact with one lifetime: a store read, and
 * everything resolved from that read. Splitting them across five bindings made
 * "resolved from the same snapshot" a convention the next edit could break
 * silently, which is precisely what `loadAndReportCatalog` exists to prevent.
 *
 * `refresh()` is sequential by construction — each call awaits its own read — so
 * two writes in flight cannot interleave a stale snapshot over a fresh one. It is
 * the replacement for the configuration listener that used to reload definitions:
 * a definition change is no longer a settings event, so nothing announces it; the
 * one window that can know is the one that just wrote, and it says so by calling
 * this. A save that changed nothing on disk does not call it.
 */
export class CatalogSession {
  private snapshot: CatalogSnapshot;
  private loaded: LoadedCatalog;

  private constructor(
    private readonly ports: CatalogSessionPorts,
    snapshot: CatalogSnapshot
  ) {
    this.snapshot = snapshot;
    this.loaded = loadAndReportCatalog(snapshot, ports.reader, ports.logger);
  }

  /**
   * Read the store once and resolve everything from that read.
   *
   * Awaited at this one boundary because the store's I/O is async and every
   * resolver below it is synchronous; that is what keeps those signatures, and it
   * means the Phase, Pipeline, and Workflow resolutions all see the same disk state.
   */
  static async open(ports: CatalogSessionPorts): Promise<CatalogSession> {
    return new CatalogSession(ports, await readSnapshot(ports));
  }

  get catalog(): PipelineCatalog {
    return this.loaded.catalog;
  }

  get phaseCatalog(): ResolvedPhaseCatalog {
    return this.loaded.phaseCatalog;
  }

  get pipelineCatalog(): ResolvedPipelineCatalog {
    return this.loaded.pipelineCatalog;
  }

  get workflowCatalog(): WorkflowCatalogResolution {
    return this.loaded.workflowCatalog;
  }

  /**
   * Feature 101 (T017) — every entry at every lifecycle state, out of the same
   * read the four resolutions came from.
   *
   * The resolutions above are bodies: `storedRows` drops a draft-only definition
   * because it has none to resolve (100 FR-021). The Builder has to show that
   * definition anyway, and the manifest is the only place it exists. Exposed as
   * the raw entries rather than as a projection because the projection belongs to
   * the sidebar and this class belongs to activation.
   */
  get definitions(): readonly StoredDefinition[] {
    return this.snapshot.definitions;
  }

  /**
   * One kind's stored rows and revision, out of the snapshot in hand.
   *
   * `storedRows` skips removals; the revision is the one the store derived for
   * that kind, and it is what a save echoes back (FR-044).
   */
  storedLayer(kind: CatalogKind): StoredLayer {
    return {
      rows: storedRows(this.snapshot, kind),
      revision: this.snapshot.revisions[kind],
      // Feature 100 (T512, FR-043) — the ids travel with the rows because they
      // must describe the SAME read. `rows` is the active bodies and `ids` is
      // every entry at every state, so the two differ by exactly the draft-only
      // definitions; derived from one snapshot they cannot disagree, and the
      // import presence gate reads the difference (FR-044).
      ids: storedIds(this.snapshot, kind)
    };
  }

  /** Re-read the store and re-resolve every catalog derived from it. */
  async refresh(): Promise<void> {
    this.snapshot = await readSnapshot(this.ports);
    this.loaded = loadAndReportCatalog(this.snapshot, this.ports.reader, this.ports.logger);
  }
}

/** One kind's stored rows and the revision a save is optimistic against. */
export interface StoredLayer {
  readonly rows: readonly unknown[];
  readonly revision: string;
  /**
   * Feature 100 (T512, FR-043) — every id the manifest holds an entry for, at
   * every state, which is a strict superset of the ids in `rows`.
   *
   * Import presence is resolved against this and never against `rows`: a
   * definition holding only an unpublished Draft has no active body, so it is
   * absent from `rows` and from the effective catalog (FR-007), and an import
   * that read only `rows` would plan straight over the operator's draft (FR-044).
   */
  readonly ids: ReadonlySet<string>;
}

/**
 * The three stored-layer read seams the save router takes, all from one session.
 *
 * Feature 099 (T496f, FR-042a, FR-044) — wiring the three separately made "all
 * three see the same snapshot" a convention repeated at three call sites, and a
 * gate that disagreed with the Library it defends is exactly the failure the
 * single-read discipline exists to rule out. Handed over together, they cannot.
 */
export function storedLayerReaders(session: CatalogSession): {
  readonly readPhaseConfig: () => StoredLayer;
  readonly readPipelineConfig: () => StoredLayer;
  readonly readWorkflowConfig: () => StoredLayer;
} {
  return {
    readPhaseConfig: () => session.storedLayer('phase'),
    readPipelineConfig: () => session.storedLayer('pipeline'),
    readWorkflowConfig: () => session.storedLayer('workflow')
  };
}

async function readSnapshot(ports: CatalogSessionPorts): Promise<CatalogSnapshot> {
  return ports.store
    ? snapshotOfRead(await ports.store.read(), ports.digest)
    : emptyCatalogSnapshot(ports.digest);
}

/** One line per fault, naming the kind, the id, and the cause — never a path (FR-061). */
function describeFault(fault: CatalogIntegrityFault): string {
  switch (fault.fault) {
    case 'dangling-record':
      return `${fault.kind}/${fault.id}@${fault.versionId} is named by the manifest and absent on disk`;
    case 'hash-mismatch':
      return `${fault.kind}/${fault.id}@${fault.versionId} does not match its recorded content hash`;
    case 'unreadable-manifest':
      return `the manifest cannot be read (${fault.reason})`;
    case 'unsupported-format':
      return `the store declares format ${fault.found}; this build supports ${fault.supported}`;
    case 'unreadable-store':
      return `the store cannot be read (${fault.errno})`;
  }
}
