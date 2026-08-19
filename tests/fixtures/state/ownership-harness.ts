/**
 * Feature FR-R3-003 (T303–T306) — two extension hosts, one arbitrated resource.
 *
 * The thing under test is a race, so the harness has to be able to *hold* one
 * open. `SharedOwnershipFs` is an in-memory `OwnershipFs` whose
 * `createExclusive` is genuinely exclusive — one success, one `EEXIST`, never
 * both — with a hook that runs after a caller has read the directory and before
 * it creates its file. That hook is where an interleaving is produced
 * deterministically, rather than hoped for by launching two promises and
 * trusting the scheduler.
 *
 * Two hosts are modelled as two `WorkspaceStateStore` instances over **separate
 * mementos** and **one** `SharedOwnershipFs`. That is the faithful shape and it
 * is also the point of the feature: a `Memento` is a per-extension-host cache,
 * so the only thing two hosts can both see is the shared record. A harness that
 * gave them one memento would make mirror writes look coordinated and would
 * quietly let a test pass for the wrong reason.
 */

import type { OwnershipFs } from '../../../src/state/ownership-fs';
import { alreadyExistsError } from '../../../src/state/ownership-fs';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import type { Clock, Scheduler, SchedulerHandle } from '../../../src/state/lock';

/** The directory both hosts arbitrate in. A key prefix; nothing is on disk. */
export const OWNERSHIP_DIR = '/ws/.schegent/ownership';

export class FakeMemento implements Memento {
  private readonly map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

export class ManualClock implements Clock {
  constructor(public current = 1_000_000) {}
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

export class ManualScheduler implements Scheduler {
  public readonly intervals: Array<{ fn: () => void; ms: number }> = [];
  setInterval(fn: () => void, ms: number): SchedulerHandle {
    const entry = { fn, ms };
    this.intervals.push(entry);
    return {
      clear: () => {
        const index = this.intervals.indexOf(entry);
        if (index >= 0) this.intervals.splice(index, 1);
      }
    };
  }
}
// Deliberately no `tick()` helper. Both managers arm their interval with
// `() => { void this.heartbeat(); }`, so firing the callback returns `undefined`
// and there is nothing to await — a helper that looked like it awaited the beat
// would let a test assert on a record the beat had not written yet, and against
// real storage that is a flake rather than a failure. Tests that need a beat to
// have landed call `heartbeat()` directly; that the interval is armed at the
// production cadence is asserted in `tests/unit/state/lock.test.ts`.

export interface OwnershipFsFaults {
  /**
   * Runs after a caller has listed the directory and before it creates its
   * file. Awaited, so a second host can be driven to completion inside it and
   * the first host then finds the world changed underneath it.
   */
  beforeCreate?: (file: string) => Promise<void> | void;
  /** Throw on every `list`, standing in for storage that cannot answer. */
  failList?: boolean;
  /** Throw on every `createExclusive`, standing in for an unwritable directory. */
  failCreate?: boolean;
  /** Report `EEXIST` for every create, however many generations are tried. */
  alwaysContended?: boolean;
}

/** An in-memory `OwnershipFs` two hosts share, with injectable interleavings. */
export class SharedOwnershipFs implements OwnershipFs {
  private readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>();
  public faults: OwnershipFsFaults = {};
  /** Every operation, in order. Useful when a test is about what was attempted. */
  public readonly log: string[] = [];

  async ensureDir(dir: string): Promise<void> {
    this.dirs.add(dir);
  }

  async list(dir: string): Promise<readonly string[]> {
    this.log.push(`list:${dir}`);
    if (this.faults.failList) throw new Error('storage unavailable');
    const prefix = `${dir}/`;
    return [...this.files.keys()]
      .filter((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'))
      .map((file) => file.slice(prefix.length));
  }

  async read(file: string): Promise<string | null> {
    this.log.push(`read:${file}`);
    return this.files.get(file) ?? null;
  }

  async createExclusive(file: string, data: string): Promise<void> {
    await this.faults.beforeCreate?.(file);
    this.log.push(`create:${file}`);
    if (this.faults.failCreate) throw new Error('storage unavailable');
    if (this.faults.alwaysContended || this.files.has(file)) throw alreadyExistsError(file);
    this.files.set(file, data);
  }

  async replace(file: string, data: string): Promise<void> {
    this.log.push(`replace:${file}`);
    this.files.set(file, data);
  }

  async remove(file: string): Promise<void> {
    this.log.push(`remove:${file}`);
    this.files.delete(file);
  }

  /** File names currently present, for assertions about generations. */
  names(): readonly string[] {
    return [...this.files.keys()].map((file) => file.slice(file.lastIndexOf('/') + 1)).sort();
  }
}

export interface Host {
  readonly store: WorkspaceStateStore;
  readonly memento: FakeMemento;
}

/**
 * `count` hosts over one shared ownership storage.
 *
 * Each gets its own memento, and every store is pointed at `fs` through the same
 * `useOwnershipStorage()` seam activation uses, so the tests exercise the
 * production wiring rather than reaching into the registry directly.
 */
export async function createHosts(
  count: number,
  fs: SharedOwnershipFs
): Promise<readonly Host[]> {
  const hosts: Host[] = [];
  for (let index = 0; index < count; index += 1) {
    const memento = new FakeMemento();
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    store.useOwnershipStorage(fs, OWNERSHIP_DIR);
    hosts.push({ store, memento });
  }
  return hosts;
}

/**
 * Run `body` while the *next* `createExclusive` is suspended.
 *
 * The hook removes itself before awaiting, so a rival driven to completion
 * inside `body` is not itself suspended — otherwise the two would deadlock,
 * each waiting for the other's create.
 */
export function interleaveOnce(
  fs: SharedOwnershipFs,
  body: () => Promise<unknown>
): void {
  fs.faults.beforeCreate = async () => {
    fs.faults.beforeCreate = undefined;
    await body();
  };
}
