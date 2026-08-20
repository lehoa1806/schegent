// Feature 099 (FR-R3-015) T476a — everything impure the store needs, as ports.
//
// `src/catalog/` imports no `vscode`, no Node built-in, and no third-party
// package (FR-057, pinned by `tests/lint/catalog-purity.test.ts`). The
// filesystem, the clock, the digest, and run provenance therefore arrive as
// injected interfaces, and the adapters that implement them live outside this
// directory.
//
// The filesystem port is addressed by **segments**, never by a path. That is not
// a stylistic choice: it is what makes FR-061 (no workspace root in any emitted
// record or log line) structural rather than a discipline. The core has no root
// to leak, because it never holds one. It also keeps every destructive call —
// and therefore the containment oracle — out of this directory entirely.

import type {
  LifecycleAdvisory,
  ReferenceBlocker,
  ValidationDefect
} from '../contracts/catalog-lifecycle';
import type { CatalogKind, CatalogSnapshot } from '../contracts/catalog-store';

/**
 * A location in the store, relative to the store root, as ordered segments.
 *
 * Never absolute, never joined here. `['phases', 'implement', 'v3.json']` is the
 * whole of what the core knows about where a record lives.
 */
export type StoreSegments = readonly string[];

export type FsReadOutcome =
  | { readonly outcome: 'read'; readonly contents: string }
  /** Absent is a value, not a throw: an absent store reads as an empty catalog (FR-001a). */
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'failed'; readonly errno: string };

export type FsWriteOutcome =
  | { readonly outcome: 'written' }
  | { readonly outcome: 'failed'; readonly errno: string };

export type FsWriteIfAbsentOutcome =
  | { readonly outcome: 'written' }
  /** The target already exists and was **not** overwritten (FR-030). */
  | { readonly outcome: 'exists' }
  | { readonly outcome: 'failed'; readonly errno: string };

export type FsRemoveOutcome =
  | { readonly outcome: 'removed' | 'absent' }
  | { readonly outcome: 'failed'; readonly errno: string };

/**
 * The store's filesystem.
 *
 * Three properties this shape enforces rather than requests:
 *
 *   - **No absolute path reaches the core**, so no record and no log line can
 *     carry a workspace root (FR-061, SC-012).
 *   - **No `errno` is a path.** Implementations map errors to their `code` only.
 *   - **Every failure is a returned value.** The core has no `try`/`catch` around
 *     I/O, so there is no place for a compensating delete to be written (FR-029).
 *
 * There is deliberately no `fileExists`: write-once is enforced by
 * `writeFileIfAbsent` reporting `exists`, because a separate existence check
 * followed by a write is a race against the very rule it would be checking.
 */
export interface CatalogFsPort {
  readFile(at: StoreSegments): Promise<FsReadOutcome>;

  /**
   * Write, replacing any existing contents, atomically as observed by a reader:
   * a sibling temp file plus a rename. Parent directories are created lazily, so
   * a workspace that never saves has no store directory (FR-001a).
   *
   * Only ever called for `manifest.json` — the one mutable file (FR-002).
   */
  writeFileAtomic(at: StoreSegments, contents: string): Promise<FsWriteOutcome>;

  /** Write only if the target does not exist. The write-once primitive (FR-030). */
  writeFileIfAbsent(at: StoreSegments, contents: string): Promise<FsWriteIfAbsentOutcome>;

  /** Entry names directly under `at`. An absent directory lists as empty, not as a failure. */
  listDirectory(at: StoreSegments): Promise<readonly string[]>;

  /**
   * Remove one file.
   *
   * Retention's prune is the only caller (FR-034). Never called on a failure
   * path: a partial write stays written (FR-028, FR-029).
   */
  removeFile(at: StoreSegments): Promise<FsRemoveOutcome>;

  /**
   * Can the store be written at all, and if not, why?
   *
   * Three-valued rather than a boolean because the two negative answers are
   * different refusals with different operator meaning: no workspace folder is
   * open at all (FR-033a), or one is and its store path cannot be written
   * (FR-033b). Both are named *write* faults, never integrity faults, and neither
   * is retried silently.
   *
   * Only the write path asks. A read never needs to: with no workspace every read
   * reports `absent`, which is already the empty catalog (FR-001a).
   */
  checkWritability(): Promise<StoreWritability>;
}

export type StoreWritability = 'writable' | 'no-workspace' | 'not-writable';

export interface Clock {
  /**
   * Epoch milliseconds — the store's one time representation (FR-021a, FR-022).
   *
   * An integer rather than an ISO string, because the manifest is a durable
   * forward-only file two windows read at once and an integer has no offset,
   * precision, or locale for two writers to differ on.
   */
  nowMs(): number;
}

export interface Digest {
  /** `sha256:<lowercase hex>` over the UTF-8 bytes of `canonical` (FR-012). */
  sha256(canonical: string): string;
}

export interface RunProvenance {
  /**
   * Is this version referenced by a run the history has not yet removed?
   *
   * Retention never prunes a version this reports as referenced (FR-037). The
   * store never reads run state itself — this feature ships an implementation
   * that answers `false` for everything and FR-R3-018 supplies the real one, so
   * the exemption exists and is testable before the data behind it does.
   */
  isReferenced(kind: CatalogKind, id: string, versionId: string): Promise<boolean>;
}

/** Everything the store is constructed with. */
export interface CatalogStorePorts {
  readonly fs: CatalogFsPort;
  readonly clock: Clock;
  readonly digest: Digest;
  readonly provenance: RunProvenance;
}

/** One pending body, named, as the publish gate hands it to validation. */
export interface CandidateDefinition {
  readonly kind: CatalogKind;
  readonly id: string;
  readonly body: unknown;
}

/**
 * What a definition *means* — the one thing the store deliberately does not know.
 *
 * Feature 100 (T500). The publish gate has to validate a candidate and the
 * deactivation gate has to find what references a definition, and both answers
 * live in `src/config/`: `unknownPhaseErrors`, `validateWorkflowGraph`, and
 * `invalidPipelineCauses`. None of those can be imported here. Every one of them
 * reaches `src/runner/backend-runner-factory.ts` through its validator, and from
 * there `node:child_process` — a bare specifier anywhere in the value-import
 * closure of `src/catalog/` is exactly what `tests/lint/catalog-purity.test.ts`
 * forbids (FR-057, FR-058).
 *
 * So semantics arrive the way the filesystem and the clock already do. The adapter
 * that implements this lives outside this directory and **calls those same
 * exported validators**: this port is a wire, not a second oracle (FR-017). A
 * reimplementation behind it would be the defect the requirement names.
 *
 * Synchronous on purpose. The validators are synchronous and the snapshot is
 * already in memory, so an async signature here would promise a suspension point
 * that never happens and would let a future implementation read the store a second
 * time — a skew between the catalog validated and the catalog written.
 */
export interface DefinitionSemantics {
  /**
   * Every defect in every candidate, validated against the snapshot's **active**
   * catalog with `candidates` overlaid on it (FR-016, FR-017).
   *
   * Overlaid, not appended: a candidate for an id that is already active replaces
   * that id's active body for this one validation, which is what makes publishing
   * a Phase and the Pipeline that binds it in the same operation succeed. The
   * union is a projection alive for one call and persisted nowhere (FR-018).
   *
   * Returns **all** defects rather than stopping at the first candidate that has
   * one (FR-019, SC-003).
   */
  defectsOf(
    snapshot: CatalogSnapshot,
    candidates: readonly CandidateDefinition[]
  ): readonly ValidationDefect[];

  /**
   * Every **active** definition that directly references `(kind, id)` (FR-025).
   *
   * Direct references per kind and never transitive (FR-025b): a Phase is named by
   * the Pipelines that bind it, a Pipeline by the Workflow nodes that name it, and
   * a Workflow by nothing. A reference held only by a Draft is not here — it is an
   * advisory, because a Draft cannot be triggered (FR-025a).
   */
  referencesTo(
    snapshot: CatalogSnapshot,
    kind: CatalogKind,
    id: string
  ): readonly ReferenceBlocker[];

  /**
   * What an operator should be told about a deactivation that is going to succeed
   * (FR-025a, FR-059).
   *
   * Draft-held references and configured defaults naming the definition. Neither
   * can become a blocker, and reporting one writes no operator-owned configuration
   * (FR-061).
   */
  advisoriesFor(
    snapshot: CatalogSnapshot,
    kind: CatalogKind,
    id: string
  ): readonly LifecycleAdvisory[];
}
