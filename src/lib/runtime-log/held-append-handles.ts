// Feature 218 (FR-R3-191) — the runtime log writer's held append descriptors,
// and the release that gives them back.
//
// The writer (`runtime-log-sink.ts`) holds one append descriptor per target
// path (FR-R3-080) and had no way to give them back: nothing closed them when
// the host deactivated, so each activation left its descriptors to the
// collector. The transport writer's release (`src/monitor/cli-transport-sink.ts`,
// FR-R3-137) is the model this follows. Its grace is copied, not imported,
// because `lib` is a leaf layer and may not value-import `monitor`
// (`tests/lint/architecture-layers.ts`).
//
// This module opens nothing. The writer passes `open`, so every open still goes
// through the writer's checked walk with both modes declared.

import type { FileHandle } from 'fs/promises';

/**
 * How long the release lets lines already accepted finish before it closes
 * every descriptor anyway. The transport writer's `TRANSPORT_DRAIN_GRACE_MS`,
 * for its reason: the two writers do the same kind of I/O at the same teardown.
 * A unit test pins the two equal, so they cannot drift apart unnoticed.
 */
export const RUNTIME_LOG_DRAIN_GRACE_MS = 2_000;

/** Said once when the grace expired with lines still in flight. No path, no count (FR-008). */
const GRACE_EXPIRED_WARNING =
  'release grace expired with lines still in flight; closing every descriptor anyway, so those lines may not be written.';

interface HeldHandle {
  readonly handle: FileHandle;
  /** The roots the open was proved against, joined, so a change is one comparison. */
  readonly roots: string;
}

/**
 * FR-R3-080 (T1064) — the append path's DESCRIPTORS, held per target path.
 *
 * `SEC-07`. What this replaced is the writer's cached containment verdict being
 * used as the proof of a write performed on a pathname: proven once, re-resolved
 * on every line. The only way to shrink that window was to pay `realpath` per
 * line. A held descriptor is strictly better than both: the walk happens ONCE per
 * target, and every later append goes to the file that walk proved, by
 * descriptor, so there is no window at all rather than a narrower one.
 * `O_APPEND` keeps concurrent writers from overwriting each other exactly as
 * `fs.appendFile` did.
 *
 * The writer closes a descriptor wherever the identity of its target can change:
 * a suppression clear (an operator repointed the path), a rotation (the file is
 * renamed out from under it, and a held descriptor would follow the inode into
 * the rotated generation, which is the one bug this cache can cause) and a
 * truncate-in-place.
 *
 * Feature 218 (FR-R3-191) — and the release closes all of them, once, when the
 * host deactivates.
 */
export class HeldAppendHandles {
  private readonly held: Map<string, HeldHandle> = new Map();

  /** Every close this module started that has not settled. The release waits on it (FR-005). */
  private readonly closesInFlight: Set<Promise<void>> = new Set();

  /** Set at the close step. Read through `isReleased()`, never as a field after an await. */
  private released = false;

  private releasing: Promise<void> | undefined;

  private readonly warn: (message: string) => void;
  private readonly graceMs: number;

  constructor(warn: (message: string) => void, graceMs = RUNTIME_LOG_DRAIN_GRACE_MS) {
    this.warn = warn;
    this.graceMs = graceMs;
  }

  /** The descriptors held now: the map's size, never a count kept beside it (FR-009). */
  get size(): number {
    return this.held.size;
  }

  /**
   * Whether the close step has begun. A method, not a field read: the checker
   * carries a field check across an `await` and would call a second read dead,
   * but the release sets the flag while an open is suspended. A call is not
   * narrowed. The transport's `closeSweepHasRun()` exists for the same reason.
   */
  isReleased(): boolean {
    return this.released;
  }

  /**
   * The descriptor for `targetPath`: the held one if it was proved against these
   * roots, otherwise a fresh one from `open`. `null` means nothing may be held
   * and the caller drops the line.
   */
  async acquire(
    targetPath: string,
    roots: readonly string[],
    open: () => Promise<FileHandle | null>
  ): Promise<FileHandle | null> {
    // Check 3: nothing opens once the close step has begun.
    if (this.isReleased()) return null;
    const rootsKey = roots.join('\u0000');
    const held = this.held.get(targetPath);
    if (held) {
      if (held.roots === rootsKey) return held.handle;
      await this.close(targetPath);
      // Check 4: the close step may have run while the stale handle closed.
      if (this.isReleased()) return null;
    }
    const handle = await open();
    if (handle === null) return null;
    // Check 5: an open that completed after the close step has no owner left to
    // close it, so it is closed here, tracked, and the line is dropped.
    if (this.isReleased()) {
      await this.track(closeQuietly(handle));
      return null;
    }
    this.held.set(targetPath, { handle, roots: rootsKey });
    return handle;
  }

  /**
   * Stop holding `targetPath`'s descriptor and close it. The entry goes first,
   * so a descriptor whose close fails is no longer counted (FR-007).
   */
  close(targetPath: string): Promise<void> {
    const held = this.held.get(targetPath);
    if (!held) return Promise.resolve();
    this.held.delete(targetPath);
    return this.track(closeQuietly(held.handle));
  }

  /** Close every held descriptor without waiting. The release waits through the tracked set. */
  closeAll(): void {
    for (const targetPath of [...this.held.keys()]) void this.close(targetPath);
  }

  /**
   * FR-003 to FR-008 — let the lines already accepted finish for at most the
   * grace, close every descriptor, and settle once every close in flight has.
   * Never rejects.
   *
   * Deliberately NOT `async`, so every caller, repeated or concurrent, receives
   * the same promise and the drain runs once (FR-006), as the transport's
   * `flushAndDispose()` does.
   */
  release(drain: () => Promise<void>): Promise<void> {
    this.releasing ??= this.drainThenClose(drain);
    return this.releasing;
  }

  /** The drain, bounded, then the close step. Runs once: `release()` memoizes it. */
  private async drainThenClose(drain: () => Promise<void>): Promise<void> {
    // The resolver is created OUTSIDE the promise executor, for the transport's
    // reason (`cli-transport-sink.ts`, `drainThenClose`): an assignment inside a
    // callback is one the checker cannot see. The executor runs synchronously, so
    // `onGraceElapsed` is the real `resolve` by the time the timer can fire.
    let onGraceElapsed: (expired: boolean) => void = () => undefined;
    const graceElapsed = new Promise<boolean>((resolve) => {
      onGraceElapsed = resolve;
    });
    const timer = setTimeout(() => {
      onGraceElapsed(true);
    }, this.graceMs);
    // Unref'd, so a release begun early in a short-lived process does not hold
    // the event loop open for the length of the grace.
    timer.unref();

    // Whether the grace won is the race's own result. The transport sets a flag
    // in the timer's callback instead, an assignment the checker cannot see, so
    // its `if` on that flag reads as always false: that is its one baselined
    // `no-unnecessary-condition` warning.
    let expired = false;
    try {
      expired = await Promise.race([drain().then(() => false), graceElapsed]);
    } catch {
      // The writer's drain uses `allSettled` and cannot reject. This is here so
      // a future change to it cannot make the release reject (FR-007).
    } finally {
      clearTimeout(timer);
    }

    if (expired) {
      try {
        this.warn(GRACE_EXPIRED_WARNING);
      } catch {
        // Nothing left to report it to. The close step below still runs: a
        // warning that throws must not leave every descriptor open (FR-007).
      }
    }

    // Closed regardless. The latch goes up BEFORE the sweep, so an open that
    // resumes during it is refused by checks 4 and 5 rather than kept behind the
    // snapshot of the keys.
    this.released = true;
    this.closeAll();
    while (this.closesInFlight.size > 0) {
      await Promise.allSettled([...this.closesInFlight]);
    }
  }

  /** Registers a close the release must wait for, and forgets it once it settles. */
  private track(closing: Promise<void>): Promise<void> {
    this.closesInFlight.add(closing);
    void closing.finally(() => {
      this.closesInFlight.delete(closing);
    });
    return closing;
  }
}

/**
 * A close that cannot reject, even when `close` throws rather than rejecting:
 * a throw out of the sweep's loop would end it with descriptors still held.
 * A failed close is not retried: its entry is already gone.
 */
async function closeQuietly(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // Swallowed, so the release cannot reject (FR-007).
  }
}
