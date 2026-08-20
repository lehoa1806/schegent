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

import type { CatalogKind } from '../contracts/catalog-store';

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
