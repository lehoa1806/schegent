// Feature FR-R3-003 (T295–T299, T302) — compare-and-swap acquisition with a
// monotonic fencing token, for the two resources the host arbitrates: window
// primacy (one holder per workspace) and the execution lease (one holder per
// queue).
//
// ## Why this is not a Memento
//
// Both leases were acquired by reading the current value, deciding, and then
// writing. `WorkspaceStateStore.serialize()` orders writes on a `Map` held by
// the store *object*, which is real ordering inside one extension host and no
// ordering at all between two — the case both leases exist to arbitrate. The
// `Memento` surface offers `get` and `update` and nothing conditional, so there
// is no compare-and-swap to reach for, and VS Code documents no cross-process
// visibility for `update` at all. See
// `docs/architecture/workspace-ownership-fencing.md` for what was measured and
// `tests/integration/state/memento-ordering-probe.test.ts` for the measurement.
//
// ## The mechanism
//
// One file per generation, named after the resource and the generation number:
//
//     primacy.9f21c4e0.g000000004.json
//
// Acquiring means exclusively creating the *next* generation's file. Exclusive
// creation is atomic, so exactly one contender wins a given generation; the
// losers see `EEXIST`, re-read, and find the winner in place. The generation
// number **is** the fencing token, which is what makes monotonicity structural
// rather than something a counter has to be trusted to maintain: a token can
// only be issued by creating a file whose name did not exist, and files below
// the current generation are pruned, never re-issued.
//
// A holder that stalls past the staleness threshold is reclaimed by a rival at
// generation N+1. When it revives it still believes it holds generation N, and
// `verify()` rejects it on the fence rather than merely finding it late — which
// is the half a compare-and-swap alone does not close.
//
// Two properties fall out of the naming that are worth stating, because both
// are load-bearing:
//
//   - A crash between creating generation N+1 and writing its body leaves an
//     unparseable file. Readers skip it and contend for N+2, so a dead winner
//     cannot wedge the resource. A mutex-guarded single record would have needed
//     its own staleness rule for exactly this case.
//   - Two resources are two file prefixes, so their counters are independent by
//     construction. Nothing has to remember to keep them apart.
//
// Every failure to read or write resolves to `unavailable`, and every caller
// treats `unavailable` as "do not proceed". The rule is refuse to acquire,
// never assume acquired.

import { createHash } from 'crypto';
import {
  alreadyExistsError,
  createMementoOwnershipFs,
  isAlreadyExists,
  type OwnershipFs
} from './ownership-fs';

/** The two arbitrated resources. Separate prefixes, separate counters. */
export const PRIMACY_RESOURCE = 'primacy';

export function queueResource(queueId: string): string {
  return `queue:${queueId}`;
}

export interface OwnershipHolder {
  readonly ownerId: string;
  readonly acquiredAt: number;
  readonly heartbeatAt: number;
}

export interface OwnershipRecord {
  readonly version: 1;
  readonly resource: string;
  readonly fence: number;
  readonly holder: OwnershipHolder | null;
}

export type AcquireOutcome =
  | { readonly outcome: 'acquired'; readonly fence: number; readonly acquiredAt: number }
  | { readonly outcome: 'held'; readonly ownerId: string }
  | {
      readonly outcome: 'unavailable';
      readonly reason: 'io-error' | 'contended';
      /**
       * FR-R3-040 — the errno the filesystem gave, when there was one.
       *
       * The whole mechanism rests on one platform property: `open(2)` with
       * `O_CREAT|O_EXCL` either creates or fails `EEXIST`, and cannot do both.
       * That property is the filesystem's, not Node's, and the documents say
       * where it is not guaranteed — NFSv2, some SMB, and the 9p, virtiofs and
       * network-home mounts that ordinary remote development puts a workspace on.
       *
       * When arbitration fails on such a mount, the operator's symptom is "no
       * window is primary" and the diagnosis is nothing. Flattening every failure
       * to `io-error` discarded the one datum that distinguishes a full disk from
       * a permissions problem from a mount that does not implement the primitive.
       * `ENOTSUP`, `EPERM`, `EROFS` and `ENOSYS` each point somewhere different.
       *
       * Follows `terminal-run-rollup-recorder.ts`, which preserves the errno the
       * same way for the same reason. Undefined when the failure carried no code.
       */
      readonly cause?: string;
    };

/**
 * The verdict on a guarded operation (T302). `rejected` is the interesting arm:
 * `stale-fence` means the resource moved on without us, `not-holder` means the
 * generation is still ours but the holder slot is not.
 */
export type FenceCheck =
  | { readonly outcome: 'valid'; readonly fence: number }
  | {
      readonly outcome: 'rejected';
      readonly reason: 'stale-fence' | 'not-holder';
      readonly currentFence: number;
      readonly ownerOfRecord: string | null;
    }
  | { readonly outcome: 'unavailable' };

interface ReadState {
  /** The highest generation with a parseable body, or `null` when there is none. */
  readonly record: OwnershipRecord | null;
  /** That record's generation, or `0` when there is no record. */
  readonly generation: number;
  /** The highest generation present at all, parseable or not. */
  readonly highestGeneration: number;
}

/**
 * How many times an acquisition re-reads after losing a generation race.
 *
 * Bounded rather than unbounded: each lost round means a rival won a generation,
 * and a caller that has lost eight in a row is contending with something that
 * is winning every time. Exhausting the budget resolves to `unavailable`, which
 * every caller reads as "do not proceed" — a wait, on the same terms as any
 * other refusal, and never a start.
 */
const MAX_ACQUIRE_ATTEMPTS = 8;

const GENERATION_DIGITS = 9;

export class OwnershipRegistry {
  private readonly fs: OwnershipFs;
  private readonly dir: string;
  private ensured = false;

  constructor(fs: OwnershipFs, dir: string) {
    this.fs = fs;
    this.dir = dir;
  }

  /**
   * Claim `resource` for `ownerId`, or report who holds it.
   *
   * Succeeds when the resource is unheld, already ours, or held by an owner
   * whose heartbeat has gone stale — the same three cases the pre-feature
   * managers admitted, decided against a record two processes can both see.
   */
  public async acquire(
    resource: string,
    ownerId: string,
    now: number,
    stalenessMs: number
  ): Promise<AcquireOutcome> {
    try {
      return await this.acquireOrReport(resource, ownerId, now, stalenessMs);
    } catch (err) {
      // Keep the errno. A bare `io-error` is the same answer for a full disk, a
      // permissions problem, and a mount that does not implement exclusive
      // create — and the third is the one the fence's stated limit is about.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      return code === undefined
        ? { outcome: 'unavailable', reason: 'io-error' }
        : { outcome: 'unavailable', reason: 'io-error', cause: code };
    }
  }

  private async acquireOrReport(
    resource: string,
    ownerId: string,
    now: number,
    stalenessMs: number
  ): Promise<AcquireOutcome> {
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      const state = await this.readState(resource);
      const holder = state.record?.holder ?? null;
      if (holder && holder.ownerId === ownerId) {
        // Re-acquisition by the same owner keeps its generation, and therefore
        // its fence: nothing changed hands, so nothing should invalidate the
        // token guarded writes are already carrying. `acquiredAt` is preserved
        // for the same reason.
        await this.fs.replace(
          this.fileFor(resource, state.generation),
          serialize({ ...state.record!, holder: { ...holder, heartbeatAt: now } })
        );
        return { outcome: 'acquired', fence: state.generation, acquiredAt: holder.acquiredAt };
      }
      if (holder && now - holder.heartbeatAt <= stalenessMs) {
        return { outcome: 'held', ownerId: holder.ownerId };
      }
      const next = Math.max(state.generation, state.highestGeneration) + 1;
      try {
        await this.fs.createExclusive(
          this.fileFor(resource, next),
          serialize({
            version: 1,
            resource,
            fence: next,
            holder: { ownerId, acquiredAt: now, heartbeatAt: now }
          })
        );
      } catch (err) {
        if (!isAlreadyExists(err)) throw err;
        continue;
      }
      // Winning the create is necessary and not sufficient. Pruning below the
      // current generation frees earlier names, so a caller working from a stale
      // listing can create a generation that is no longer the highest — it holds
      // a real file and a real payload, and it is nonetheless not the holder.
      // Confirming against a fresh read is what keeps `acquired` exact.
      const confirmed = await this.readState(resource);
      if (
        confirmed.generation === next &&
        confirmed.record?.holder?.ownerId === ownerId
      ) {
        await this.pruneBelow(resource, next);
        return { outcome: 'acquired', fence: next, acquiredAt: now };
      }
      const winner = confirmed.record?.holder?.ownerId ?? null;
      if (winner !== null && winner !== ownerId) {
        return { outcome: 'held', ownerId: winner };
      }
    }
    return { outcome: 'unavailable', reason: 'contended' };
  }

  /** Refresh our own record's heartbeat, rejecting on a moved fence. */
  public async heartbeat(
    resource: string,
    ownerId: string,
    fence: number,
    now: number
  ): Promise<FenceCheck> {
    return this.mutateAsHolder(resource, ownerId, fence, (record, holder) => ({
      ...record,
      holder: { ...holder, heartbeatAt: now }
    }));
  }

  /**
   * Give the resource back, keeping the record so the fence it issued is never
   * re-issued. Release writes an unheld record rather than removing the file,
   * because a removed file would let the next acquisition start over at
   * generation one and hand out a token a revived predecessor still carries.
   */
  public async release(resource: string, ownerId: string, fence: number): Promise<FenceCheck> {
    return this.mutateAsHolder(resource, ownerId, fence, (record) => ({
      ...record,
      holder: null
    }));
  }

  /**
   * The point-of-effect check (T300–T302). Deliberately about the fence and the
   * identity only: whether a holder's own heartbeat has aged is the staleness
   * question its manager already answers, and folding the two together would
   * make a guarded write's verdict depend on a clock the caller did not pass.
   */
  public async verify(resource: string, ownerId: string, fence: number): Promise<FenceCheck> {
    try {
      const state = await this.readState(resource);
      return judge(state, ownerId, fence);
    } catch {
      return { outcome: 'unavailable' };
    }
  }

  /** The authoritative record, or `null` when the resource has never been held. */
  public async read(resource: string): Promise<OwnershipRecord | null> {
    try {
      return (await this.readState(resource)).record;
    } catch {
      return null;
    }
  }

  private async mutateAsHolder(
    resource: string,
    ownerId: string,
    fence: number,
    next: (record: OwnershipRecord, holder: OwnershipHolder) => OwnershipRecord
  ): Promise<FenceCheck> {
    try {
      const state = await this.readState(resource);
      const verdict = judge(state, ownerId, fence);
      if (verdict.outcome !== 'valid') return verdict;
      const record = state.record!;
      await this.fs.replace(
        this.fileFor(resource, fence),
        serialize(next(record, record.holder!))
      );
      return { outcome: 'valid', fence };
    } catch {
      return { outcome: 'unavailable' };
    }
  }

  private async readState(resource: string): Promise<ReadState> {
    await this.ensureDir();
    const prefix = `${prefixFor(resource)}.g`;
    const generations = (await this.fs.list(this.dir))
      .map((name) => generationOf(name, prefix))
      .filter((generation): generation is number => generation !== null)
      .sort((a, b) => b - a);
    const highestGeneration = generations[0] ?? 0;
    for (const generation of generations) {
      const raw = await this.fs.read(this.fileFor(resource, generation));
      if (raw === null) continue;
      const record = parseRecord(raw, resource, generation);
      if (record === null) continue;
      return { record, generation, highestGeneration };
    }
    return { record: null, generation: 0, highestGeneration };
  }

  /**
   * Drop every generation below `keep`. Best effort: a failed prune leaves a
   * superseded file that readers already skip, so it costs a directory entry
   * and nothing else — and failing the acquisition over it would refuse a claim
   * that has already been won.
   */
  private async pruneBelow(resource: string, keep: number): Promise<void> {
    const prefix = `${prefixFor(resource)}.g`;
    let names: readonly string[];
    try {
      names = await this.fs.list(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const generation = generationOf(name, prefix);
      if (generation === null || generation >= keep) continue;
      await this.fs.remove(this.fileFor(resource, generation)).catch(() => undefined);
    }
  }

  private async ensureDir(): Promise<void> {
    if (this.ensured) return;
    await this.fs.ensureDir(this.dir);
    this.ensured = true;
  }

  private fileFor(resource: string, generation: number): string {
    return `${this.dir}/${prefixFor(resource)}.g${String(generation).padStart(
      GENERATION_DIGITS,
      '0'
    )}.json`;
  }
}

function judge(state: ReadState, ownerId: string, fence: number): FenceCheck {
  const ownerOfRecord = state.record?.holder?.ownerId ?? null;
  if (state.generation !== fence) {
    return {
      outcome: 'rejected',
      reason: 'stale-fence',
      currentFence: state.generation,
      ownerOfRecord
    };
  }
  if (ownerOfRecord !== ownerId) {
    return {
      outcome: 'rejected',
      reason: 'not-holder',
      currentFence: state.generation,
      ownerOfRecord
    };
  }
  return { outcome: 'valid', fence };
}

/**
 * A resource's filename prefix.
 *
 * A queue id reaches this function from persisted state, so it is not permitted
 * to reach a path. The readable half is reduced to an allowlist and truncated;
 * the hash of the *raw* resource carries the uniqueness the reduction throws
 * away, so two ids that slug identically still address different files.
 */
function prefixFor(resource: string): string {
  const slug = resource.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 32) || 'resource';
  const digest = createHash('sha256').update(resource, 'utf8').digest('hex').slice(0, 16);
  return `${slug}.${digest}`;
}

function generationOf(name: string, prefix: string): number | null {
  if (!name.startsWith(prefix) || !name.endsWith('.json')) return null;
  const digits = name.slice(prefix.length, name.length - '.json'.length);
  if (digits.length !== GENERATION_DIGITS || !/^\d+$/.test(digits)) return null;
  return Number.parseInt(digits, 10);
}

function serialize(record: OwnershipRecord): string {
  return JSON.stringify(record);
}

/**
 * Read a record body, treating anything unexpected as an aborted generation.
 *
 * `null` is a real answer here and not an error: a file created by a winner that
 * died before writing its body is empty, and the correct reading of an empty
 * generation is that nobody holds it.
 */
function parseRecord(raw: string, resource: string, generation: number): OwnershipRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const candidate = parsed as Partial<OwnershipRecord>;
  if (candidate.version !== 1) return null;
  if (candidate.resource !== resource) return null;
  if (candidate.fence !== generation) return null;
  const holder = candidate.holder;
  if (holder === null || holder === undefined) {
    return { version: 1, resource, fence: generation, holder: null };
  }
  if (
    typeof holder !== 'object' ||
    typeof (holder as OwnershipHolder).ownerId !== 'string' ||
    typeof (holder as OwnershipHolder).acquiredAt !== 'number' ||
    typeof (holder as OwnershipHolder).heartbeatAt !== 'number'
  ) {
    return null;
  }
  return {
    version: 1,
    resource,
    fence: generation,
    holder: {
      ownerId: (holder as OwnershipHolder).ownerId,
      acquiredAt: (holder as OwnershipHolder).acquiredAt,
      heartbeatAt: (holder as OwnershipHolder).heartbeatAt
    }
  };
}

/**
 * The nominal directory the memento-backed adapter names its records under. It
 * is a key prefix and not a path: nothing is created on disk.
 */
export const MEMENTO_OWNERSHIP_DIR = '.schegent/ownership';

const fallbacks = new WeakMap<object, OwnershipRegistry>();

/**
 * The registry a lease manager uses when its store supplies none.
 *
 * Keyed on the store *object*, so two managers built over one store share one
 * ownership universe and genuinely contend — the shape every multi-window test
 * uses — while two stores stay independent. Memoized, so repeated reads cost a
 * `WeakMap` lookup.
 *
 * This exists for hand-rolled doubles of the narrow `ExecutionLeaseStore` port,
 * which predate this feature and carry no registry. Production stores expose
 * their own, rooted in the workspace; `tests/lint/ownership-registry-wiring.test.ts`
 * pins that the production wiring is the disk one.
 */
export function fallbackOwnershipRegistry(store: object): OwnershipRegistry {
  const existing = fallbacks.get(store);
  if (existing) return existing;
  const entries = new Map<string, unknown>();
  const created = new OwnershipRegistry(
    createMementoOwnershipFs({
      get: <T>(key: string) => entries.get(key) as T | undefined,
      update: (key, value) => {
        if (value === undefined) entries.delete(key);
        else entries.set(key, value);
      }
    }),
    MEMENTO_OWNERSHIP_DIR
  );
  fallbacks.set(store, created);
  return created;
}

/** Re-exported so callers need one import for the seam and the registry. */
export { alreadyExistsError, isAlreadyExists };
export type { OwnershipFs };
