// Feature 099 (T496f, FR-042/FR-043) — a `CatalogSnapshot` built from rows.
//
// The suites this serves used to hand their resolvers three arrays — `builtIn`,
// `user`, `workspace` — and get a revision back from `phaseLayerRevision([...])`.
// Both are gone: the resolvers take one row list and a revision string the store
// supplies. That is a change of INPUT SHAPE, not of what the suites assert, so
// this fixture exists to keep the change at the call site instead of pushing it
// into every expectation.
//
// It is deliberately dumb. It does not validate, deduplicate, or derive a
// revision from content — the store does that, and a fixture that reimplemented
// it would let a resolver test pass against a hash the store would never produce.
// A caller that wants two snapshots to differ says so by passing a different
// `revision`.

import type {
  CatalogKind,
  CatalogSnapshot,
  StoredDefinition
} from '../../src/contracts/catalog-store';
import { STORE_FORMAT_VERSION } from '../../src/contracts/catalog-store';
import { versionIdFor } from '../../src/catalog/catalog-paths';

/** The rows a snapshot should present, per kind. Absent means none of that kind. */
export interface SnapshotRowsInput {
  readonly phases?: readonly unknown[];
  readonly pipelines?: readonly unknown[];
  readonly workflows?: readonly unknown[];
  /**
   * The manifest revision, per kind. A test that only cares that the revision
   * round-trips can leave this alone and read `snapshot.revisions.<kind>`; a test
   * about staleness sets the one it is about.
   */
  readonly revisions?: Partial<Record<CatalogKind, string>>;
}

const DEFAULT_REVISION = 'rev-fixture';

/**
 * The id a row carries, under whichever key its kind spells it.
 *
 * Rows reach the resolvers exactly as authored, including malformed ones — a row
 * with no id at all is a case several suites are specifically about — so this
 * falls back to a positional name rather than refusing. The resolver is what
 * decides such a row is `invalid`; the fixture must not decide it earlier.
 */
function rowId(row: unknown, kind: CatalogKind, index: number): string {
  if (row !== null && typeof row === 'object') {
    const record = row as Record<string, unknown>;
    const candidate = record.id ?? record[`${kind}Id`];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return `${kind}-row-${index}`;
}

/** The first version's id, spelled the way the store spells it (`v<N>`). */
const FIRST_VERSION = versionIdFor(1);

function definitionsFor(kind: CatalogKind, rows: readonly unknown[]): StoredDefinition[] {
  return rows.map((row, index) => ({
    kind,
    id: rowId(row, kind, index),
    status: 'effective' as const,
    activeVersionId: FIRST_VERSION,
    body: row,
    createdAt: 0,
    updatedAt: 0,
    versions: [
      {
        versionId: FIRST_VERSION,
        contentHash: `sha256:${kind}-${index}`,
        createdAt: 0,
        publishedAt: 0,
        note: null
      }
    ]
  }));
}

/** A snapshot presenting exactly the rows given, in the order given. */
export function snapshotOf(input: SnapshotRowsInput = {}): CatalogSnapshot {
  return {
    storeFormatVersion: STORE_FORMAT_VERSION,
    definitions: [
      ...definitionsFor('phase', input.phases ?? []),
      ...definitionsFor('pipeline', input.pipelines ?? []),
      ...definitionsFor('workflow', input.workflows ?? [])
    ],
    faults: [],
    collectable: [],
    revisions: {
      phase: input.revisions?.phase ?? DEFAULT_REVISION,
      pipeline: input.revisions?.pipeline ?? DEFAULT_REVISION,
      workflow: input.revisions?.workflow ?? DEFAULT_REVISION
    }
  };
}

/** The snapshot a workspace nobody has saved into produces (FR-001a). */
export const EMPTY_SNAPSHOT: CatalogSnapshot = snapshotOf();

/**
 * The revision a fixture snapshot carries, for suites that echo it back on save.
 *
 * A named constant rather than a literal at each call site: the suites that use
 * it are asserting that the revision the resolver reported is the one the save
 * must present, and spelling it twice invites the two to drift apart silently.
 */
export const FIXTURE_REVISION = DEFAULT_REVISION;
