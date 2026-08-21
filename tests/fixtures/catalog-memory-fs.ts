// Feature 099 (FR-R3-015) T495 — the catalog store's ports, in memory.
//
// `src/catalog/` takes its filesystem, clock, digest, and run provenance as ports
// (FR-057), so its behaviour is testable without a disk. This is that test double,
// and it exists for three things the real filesystem is bad at:
//
//   1. **Failure injection.** A partial write (FR-028) needs the record write to
//      succeed and the manifest write that follows it to fail. Producing that on a
//      real filesystem means racing a `chmod`; here it is one line.
//   2. **A call log.** "Zero writes", "zero removes", and "nothing outside the
//      store was touched" are claims about calls that did NOT happen, and a claim
//      about absence needs a record of presence to check against.
//   3. **Segment addressing, kept honest.** Keys are `segments.join('/')` and
//      nothing here ever holds a path, so a test that passes against this double
//      cannot have depended on a root the core is not allowed to know (FR-061).
//
// The digest is the real `node:crypto` sha256, not a stub. Tests live outside the
// purity lint's scope, and a fake digest would make every content-hash assertion a
// claim about the fake — the short-circuit of FR-014 is only meaningful if the
// hash a test computes is the hash the store computes.
//
// This is not a second store implementation. `tests/fixtures/fake-catalog-store.ts`
// doubles the store for callers that only need one to exist; this doubles what the
// store sits on, so the store under test is always the real one.

import { createHash } from 'node:crypto';

import { createCatalogStore, type CatalogStore } from '../../src/catalog';
import type {
  CatalogFsPort,
  CatalogStorePorts,
  Clock,
  Digest,
  FsReadOutcome,
  FsRemoveOutcome,
  FsWriteIfAbsentOutcome,
  FsWriteOutcome,
  RunProvenance,
  StoreSegments,
  StoreWritability
} from '../../src/catalog/ports';
import type { CatalogKind } from '../../src/contracts/catalog-store';

/** Every port method, named so the call log can be filtered by intent. */
export type FsOp = 'read' | 'write' | 'write-if-absent' | 'list' | 'remove' | 'writability';

export interface FsCall {
  readonly op: FsOp;
  /** `segments.join('/')`; `''` for `checkWritability`, which addresses nothing. */
  readonly key: string;
  readonly at: readonly string[];
}

/** One injected failure and how many more calls it applies to. */
interface InjectedFailure {
  readonly errno: string;
  remaining: number;
}

/** The key a set of segments addresses. Kept in one place so seeds and asserts agree. */
export function keyOf(at: StoreSegments): string {
  return at.join('/');
}

/**
 * An in-memory {@link CatalogFsPort}.
 *
 * Flat: keys are full segment joins and there are no directory entries, because
 * the store never creates a directory explicitly — the adapter does that lazily on
 * write. A claim about directories therefore belongs in the integration suite
 * against the real adapter, not here.
 */
export class MemoryCatalogFs implements CatalogFsPort {
  /** Every file, by `keyOf(segments)`. Public so a test can seed or inspect it. */
  readonly files = new Map<string, string>();
  /** Every port call in order, including the ones that failed. */
  readonly calls: FsCall[] = [];

  writability: StoreWritability = 'writable';

  private readonly readFailures = new Map<string, InjectedFailure>();
  private readonly writeFailures = new Map<string, InjectedFailure>();

  /** Put a file in place without recording a call — arranging, not exercising. */
  seed(at: StoreSegments, contents: string): void {
    this.files.set(keyOf(at), contents);
  }

  /** Take a file out from under the store, to arrange the dangling-record case. */
  unlink(at: StoreSegments): void {
    this.files.delete(keyOf(at));
  }

  /** Fail the next `times` reads of this location with `errno`. */
  failRead(at: StoreSegments, errno: string, times = 1): void {
    this.readFailures.set(keyOf(at), { errno, remaining: times });
  }

  /** Fail the next `times` writes of this location with `errno`, either write kind. */
  failWrite(at: StoreSegments, errno: string, times = 1): void {
    this.writeFailures.set(keyOf(at), { errno, remaining: times });
  }

  /** Calls of one kind, for the assertions that count them. */
  callsOf(op: FsOp): readonly FsCall[] {
    return this.calls.filter((call) => call.op === op);
  }

  /** Every write of either kind, which is what "wrote nothing" is measured against. */
  get writeCalls(): readonly FsCall[] {
    return this.calls.filter((call) => call.op === 'write' || call.op === 'write-if-absent');
  }

  async readFile(at: StoreSegments): Promise<FsReadOutcome> {
    const key = this.record('read', at);
    const injected = this.consume(this.readFailures, key);
    if (injected) return { outcome: 'failed', errno: injected };
    const contents = this.files.get(key);
    return contents === undefined ? { outcome: 'absent' } : { outcome: 'read', contents };
  }

  async writeFileAtomic(at: StoreSegments, contents: string): Promise<FsWriteOutcome> {
    const key = this.record('write', at);
    const injected = this.consume(this.writeFailures, key);
    if (injected) return { outcome: 'failed', errno: injected };
    this.files.set(key, contents);
    return { outcome: 'written' };
  }

  async writeFileIfAbsent(at: StoreSegments, contents: string): Promise<FsWriteIfAbsentOutcome> {
    const key = this.record('write-if-absent', at);
    const injected = this.consume(this.writeFailures, key);
    if (injected) return { outcome: 'failed', errno: injected };
    // The write-once primitive (FR-030). Checked and applied in one step here for
    // the same reason the real adapter uses `wx`: a separate existence check is a
    // race against the rule it is checking.
    if (this.files.has(key)) return { outcome: 'exists' };
    this.files.set(key, contents);
    return { outcome: 'written' };
  }

  async listDirectory(at: StoreSegments): Promise<readonly string[]> {
    const key = this.record('list', at);
    const prefix = key === '' ? '' : `${key}/`;
    const names = new Set<string>();
    for (const candidate of this.files.keys()) {
      if (!candidate.startsWith(prefix)) continue;
      const rest = candidate.slice(prefix.length);
      if (rest === '') continue;
      // First segment only: `readdir` reports the child, not the descendant.
      names.add(rest.split('/')[0] as string);
    }
    return [...names];
  }

  async removeFile(at: StoreSegments): Promise<FsRemoveOutcome> {
    const key = this.record('remove', at);
    return this.files.delete(key) ? { outcome: 'removed' } : { outcome: 'absent' };
  }

  async checkWritability(): Promise<StoreWritability> {
    this.calls.push({ op: 'writability', key: '', at: [] });
    return this.writability;
  }

  private record(op: FsOp, at: StoreSegments): string {
    const key = keyOf(at);
    this.calls.push({ op, key, at: [...at] });
    return key;
  }

  private consume(from: Map<string, InjectedFailure>, key: string): string | null {
    const injected = from.get(key);
    if (!injected || injected.remaining <= 0) return null;
    injected.remaining -= 1;
    if (injected.remaining <= 0) from.delete(key);
    return injected.errno;
  }
}

export interface ManualClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
}

/**
 * A clock the test moves by hand.
 *
 * Every stored time is epoch milliseconds (FR-021a), and several claims here are
 * about a timestamp that must NOT move (FR-020) — which is unassertable against a
 * clock that moves on its own.
 */
export function manualClock(startMs = 1_700_000_000_000): ManualClock {
  let now = startMs;
  return {
    nowMs: () => now,
    advance: (ms) => {
      now += ms;
    },
    set: (ms) => {
      now = ms;
    }
  };
}

/** The production digest, restated: `sha256:<lowercase hex>` over UTF-8 (FR-012). */
export const testDigest: Digest = {
  sha256: (canonical) => `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
};

/** How a referenced version is named to {@link provenanceReferencing}. */
export function provenanceKey(kind: CatalogKind, id: string, versionId: string): string {
  return `${kind}/${id}@${versionId}`;
}

/**
 * A {@link RunProvenance} that reports exactly the named versions as referenced.
 *
 * Answers `'run-referenced'`, which is the reason a store-level test is about:
 * whether the walk skipped the version, not which of the two sources named it.
 * Feature 103 (T076) widened the port from a bare boolean to the reason, and the
 * two reasons are told apart where that distinction is the subject —
 * `run-provenance-enumeration.test.ts` and `retention-ordering.test.ts`.
 */
export function provenanceReferencing(referenced: Iterable<string>): RunProvenance {
  const keys = new Set(referenced);
  return {
    isReferenced: async (kind, id, versionId) =>
      keys.has(provenanceKey(kind, id, versionId)) ? 'run-referenced' : false
  };
}

export interface TestStore {
  readonly store: CatalogStore;
  readonly fs: MemoryCatalogFs;
  readonly clock: ManualClock;
  readonly digest: Digest;
  readonly ports: CatalogStorePorts;
}

/**
 * The real store on in-memory ports.
 *
 * The store is never doubled — only what it stands on is — so every assertion
 * below is about the code that ships.
 */
export function createTestStore(
  overrides: {
    readonly fs?: MemoryCatalogFs;
    readonly clock?: ManualClock;
    readonly provenance?: RunProvenance;
  } = {}
): TestStore {
  const fs = overrides.fs ?? new MemoryCatalogFs();
  const clock = overrides.clock ?? manualClock();
  const ports: CatalogStorePorts = {
    fs,
    clock,
    digest: testDigest,
    provenance: overrides.provenance ?? provenanceReferencing([])
  };
  return { store: createCatalogStore(ports), fs, clock, digest: testDigest, ports };
}
