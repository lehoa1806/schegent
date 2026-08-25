import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { openWithinRoot } from '../lib/safe-open';
import { resolveContainedLink } from '../lib/path-containment';
import { boundForCaller } from '../lib/io-barrier';
import { ensureSchegentGitignore } from '../audit/schegent-gitignore';
// A real `SanitizedLogger` with no sinks discards everything, and it TYPECHECKS.
// A hand-rolled stub had to be laundered through `as unknown as`, which disabled
// checking at the call site entirely — so a refusal path calling `logger.debug`
// would have thrown inside activation, from the one module whose contract says it
// never throws.
import { SanitizedLogger } from '../lib/logger';
import {
  CONTAINMENT_REFUSED_ERRNO,
  classifyMountCapability,
  type ExclusiveCreateObservation,
  type MountCapabilityVerdict
} from './mount-capability';

/**
 * FR-R3-083 — the I/O half of the mount capability probe.
 *
 * Exercises the fence's OWN primitive rather than inferring capability from a
 * mount type, a path prefix, or a platform name. That is the point: a table of
 * "filesystems known to be bad" is a guess that ages, and it would have to be kept
 * in agreement with a kernel it does not ship with. Two exclusive creates at one
 * name answer the actual question on the actual mount.
 *
 * BOUNDED, BECAUSE THE ENVIRONMENT THIS EXISTS FOR IS THE ONE THAT HANGS
 *
 * An unresponsive NFS or SMB mount is precisely what this probe is looking for, and
 * an unbounded exclusive create against one would hang activation — the very path
 * `FR-R3-028` and `FR-R3-082` bounded. So every attempt races a timer, and expiry
 * classifies `undetermined`: the probe must not manufacture a finding out of its
 * own impatience.
 *
 * The outstanding create is deliberately NOT awaited into the resolution. It is
 * left to settle on its own and its cleanup is best-effort, because awaiting it is
 * the same stall the bound exists to prevent.
 */

/**
 * How long one attempt may take.
 *
 * Two seconds, chosen against what it is bounding rather than as a round number: a
 * local exclusive create is sub-millisecond, and a responsive network mount is
 * single-digit milliseconds. Two seconds is three orders of magnitude of headroom,
 * so an expiry means the mount is not answering rather than that it is slow — while
 * still being short enough that a hung mount costs activation a bounded pause and
 * not a visible freeze.
 */
export const MOUNT_PROBE_TIMEOUT_MS = 2_000;

/**
 * How many probe bounds the deferred sweep waits for an abandoned create to settle.
 *
 * The sweep exists for a create that lost its race but lands shortly after. One
 * that never lands must not hold its closure — and everything the closure captures
 * — for the life of the extension host.
 */
const DEFERRED_SWEEP_BOUNDS = 5;

/** Where the probe writes. Inside `.schegent/`, which the product already owns. */
const PROBE_SEGMENTS_PREFIX: readonly string[] = ['.schegent'];

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Monotonic within the process, so two probes in one window cannot collide either.
 * Combined with `pid`, this follows `ownership-fs.replace`'s temp naming.
 */
let probeCounter = 0;

export interface MountProbeDeps {
  /**
   * The workspace root, ALREADY RESOLVED by activation.
   *
   * Do not reach for the first workspace folder to obtain it: the hard rule routes
   * every first-folder read through `getCanonicalWorkspaceRoot()`, and
   * `tests/lint/no-direct-first-workspace-folder.test.ts` enforces it. Rephrased
   * rather than allowlisted — that gate matches text, and an allowlist entry for a
   * phrase with a clean synonym spends the gate's credibility for nothing
   * (the rule that held in FR-R3-055 and FR-R3-056).
   */
  readonly workspaceRoot: string;
  /**
   * Injection seam for the exclusive create.
   *
   * This exists for one arm that no filesystem available to this project exhibits:
   * a mount where the SECOND exclusive create of the same name succeeds. Handing
   * that observation in is how the classification gets covered at all. It is a
   * weaker claim than a measurement and
   * `docs/operations/platform-observation-record.md` records it as one.
   */
  readonly exclusiveCreate?: (segments: readonly string[]) => Promise<ExclusiveCreateObservation>;
  /** Injection seam for the bound, so a test does not wait two seconds. */
  readonly timeoutMs?: number;
  /**
   * Asked between stages. When it answers true the probe stops doing filesystem
   * work and resolves `undetermined`.
   *
   * `dispose()` used to set a flag that suppressed only the REPORT, while the probe
   * kept creating `.schegent/`, writing the ignore file, creating and removing
   * `.mount-probe.*` — against a workspace root the window had left, or during host
   * shutdown. A disposal contract that stops the notification and not the writes is
   * not a disposal contract.
   */
  readonly isDisposed?: () => boolean;
  /**
   * Whether to drop `.schegent/.gitignore`. Defaults to true.
   *
   * Its own option rather than a side effect of `exclusiveCreate` being absent: what
   * decides it is whether this probe is doing real I/O against a workspace, not
   * which parameter a test happened to pass.
   */
  readonly dropIgnoreFile?: boolean;
}

/**
 * Extract an errno, bounded.
 *
 * There are four other `errnoOf`-shaped helpers in `src/`, and they are NOT
 * interchangeable -- an earlier draft of this comment called them byte-identical
 * and that was wrong in a way that would have misled the next maintainer:
 *
 *   - `lib/safe-open.ts`, `runner/process-tree.ts` -- any string `code`, unbounded,
 *     fallback `'unknown'`
 *   - `lib/catalog-fs-adapter.ts` -- any string `code`, unbounded, fallback
 *     `'EUNKNOWN'`, and callers compare against that literal
 *   - `runner/child-stdin.ts` -- shape-checked, not length-checked, fallback
 *     `FALLBACK_CODE`
 *   - this one -- shape-checked AND length-capped, fallback `'unknown'`
 *
 * Four behaviours and three fallbacks. A naive extraction would silently change
 * three call sites, two of which compare against their own fallback literal. So
 * this is not "duplication awaiting a refactor" -- it is four deliberate contracts
 * that happen to share a name, and consolidating them is a change with its own
 * design question, not a tidy-up.
 *
 * WHY BOUNDED AT ALL. Node errnos are short uppercase constants (`ENOTSUP`,
 * `EROFS`), but `error.code` is `unknown` at the type level and this value is
 * interpolated into an operator-visible log line — nothing in the types stops a
 * rejected promise carrying a `code` that is a sentence, a path, or a megabyte.
 * Cheap, and it keeps the "bounded reason code" discipline the rest of this
 * codebase's refusals hold to.
 */
const MAX_ERRNO_LENGTH = 32;
const ERRNO_SHAPE = /^[A-Z][A-Z0-9_]*$/;

function boundErrno(code: string): string {
  return code.length <= MAX_ERRNO_LENGTH && ERRNO_SHAPE.test(code) ? code : 'unknown';
}

function errnoOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return boundErrno(code);
  }
  return 'unknown';
}

/**
 * One exclusive create through the containment primitive.
 *
 * `flags: 'wx'` is `O_EXCL|O_CREAT|O_WRONLY` at the leaf — the same open the
 * ownership registry's `createExclusive` performs, which is what makes this a probe
 * of the fence rather than a probe of something adjacent to it.
 */
async function realExclusiveCreate(
  workspaceRoot: string,
  segments: readonly string[]
): Promise<ExclusiveCreateObservation> {
  const result = await openWithinRoot(workspaceRoot, segments, {
    flags: 'wx',
    createDirs: true,
    dirMode: DIR_MODE,
    fileMode: FILE_MODE
  });
  if (result.outcome === 'opened') {
    await result.handle.close().catch(() => undefined);
    return { outcome: 'created' };
  }
  // `safe-open` refuses by REASON, not by errno, and the two must not share a
  // channel: a `symlink-component` refusal is a fact about the workspace, and
  // letting it arrive as an errno would let it be read as a mount property.
  if (result.reason !== 'io-failed') {
    return { outcome: 'io-failed', errno: CONTAINMENT_REFUSED_ERRNO };
  }
  // EEXIST is the answer the second attempt wants, so it is a REFUSAL and not an
  // I/O failure. Everything else the walk could not complete is the latter.
  if (result.errno === 'EEXIST') return { outcome: 'refused', errno: 'EEXIST' };
  // BOUNDED here too. `safe-open`'s own `errnoOf` returns any string `code`,
  // unbounded and unshaped, and this value reaches an operator-visible log line
  // through the verdict. Bounding only the rejection channel left the production
  // path — which is the one that actually carries a filesystem's answer — unguarded,
  // while a test asserting the guarantee exercised the other one.
  return { outcome: 'io-failed', errno: boundErrno(result.errno) };
}

/**
 * Race any promise against the bound, once, without throwing.
 *
 * Built ON `io-barrier.ts`'s `boundForCaller` rather than beside it. That module's
 * header states it exists "so there is ONE implementation" of a bounded wait, and
 * that "two copies of a shape are two shapes as soon as one is edited" — a third
 * hand-rolled settled-flag/`setTimeout`/`clearTimeout` here would have made the next
 * fix to the race land in two of three places.
 *
 * What is local is the SETTLEMENT DISCIPLINE, not the race: `boundForCaller` rejects
 * on expiry because its callers want an error with their own code, and this one
 * needs a tri-state that never throws — the probe's whole contract is that a failure
 * to answer is a verdict, not an exception.
 *
 * The bound's timer is UNREF'D. The deferred sweep waits several bounds on a create
 * that may never settle, and a ref'd timer there holds the Node event loop open for
 * that whole window after the probe has answered — a probe outliving activation is
 * the opposite of bounded.
 */
type Settled<T> =
  | { readonly state: 'value'; readonly value: T }
  | { readonly state: 'error'; readonly error: unknown }
  | { readonly state: 'timeout' };

/** Distinguishes the bound's own rejection from the work's, since both arrive as one. */
const PROBE_TIMEOUT_MARKER = Symbol('mount-probe-timeout');

async function raceSettled<T>(work: Promise<T>, timeoutMs: number): Promise<Settled<T>> {
  try {
    return { state: 'value', value: await boundForCaller(work, timeoutMs, timeoutError, true) };
  } catch (error) {
    if (isTimeout(error)) return { state: 'timeout' };
    return { state: 'error', error };
  }
}

function timeoutError(): Error {
  return Object.assign(new Error('mount probe bound expired'), {
    [PROBE_TIMEOUT_MARKER]: true
  });
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as Record<symbol, unknown>)[PROBE_TIMEOUT_MARKER] === true
  );
}

/**
 * One exclusive-create attempt, bounded.
 *
 * The loser is abandoned, not awaited — awaiting it is the same stall the bound
 * exists to prevent. What it may leave behind is the caller's to sweep.
 */
async function withBound(
  attempt: Promise<ExclusiveCreateObservation>,
  timeoutMs: number
): Promise<ExclusiveCreateObservation> {
  const settled = await raceSettled(attempt, timeoutMs);
  if (settled.state === 'value') return settled.value;
  if (settled.state === 'timeout') return { outcome: 'timed-out' };
  return { outcome: 'io-failed', errno: errnoOf(settled.error) };
}

/**
 * Probe the workspace's mount and return a verdict.
 *
 * NEVER THROWS. Activation must not depend on this, and a probe that can throw is
 * a probe that can prevent the extension from starting — which would make an
 * environment-dependent check strictly worse than no check.
 */
export async function probeMountCapability(
  deps: MountProbeDeps
): Promise<MountCapabilityVerdict> {
  const timeoutMs = deps.timeoutMs ?? MOUNT_PROBE_TIMEOUT_MS;
  probeCounter += 1;
  // Unique per attempt AND per process, so two windows activating on one workspace
  // probe different names and neither observes the other's artifact as its own
  // second create.
  // pid + a per-attempt counter + the wall clock. The clock is what closes the
  // case the first two do not: after an extension-host restart the counter resets
  // to 1, and if the OS has reused the pid, a probe file left behind by an
  // abandoned create (the slow-mount path this whole module exists for) makes the
  // FIRST create answer EEXIST — which classifies `undetermined`, and
  // `undetermined` deliberately does not notify. A genuinely broken mount would
  // then be permanently unreportable, by the artifact its own brokenness produced.
  const leaf = `.mount-probe.${process.pid}.${probeCounter}.${Date.now().toString(36)}`;
  const segments = [...PROBE_SEGMENTS_PREFIX, leaf];
  const disposed = (): boolean => deps.isDisposed?.() === true;
  const create =
    deps.exclusiveCreate ??
    ((s: readonly string[]) => realExclusiveCreate(deps.workspaceRoot, s));

  // `schegent-gitignore.ts` states the invariant: every writer that creates
  // `.schegent/` also drops the local ignore file. This probe creates the directory
  // and therefore owes it.
  //
  // It is NOT the first writer, and an earlier version of this comment claimed it
  // was. `extension.ts` awaits `lock.tryAcquire()` twelve lines earlier, and that
  // goes through `ownership-fs`'s `ensureAnchorWithinRoot` and creates
  // `.schegent/ownership/` without calling the helper. So on a fresh workspace the
  // directory already exists, un-ignored, before this runs — a residual that
  // belongs to the ownership path, not here.
  //
  // What this call still buys is that the ignore file lands at ACTIVATION rather
  // than at the first audit append, which is what keeps an abandoned
  // `.mount-probe.*` (the slow-mount path this module exists for) out of the
  // operator's `git status`. It is kept for that reason, and the reason is stated
  // so a reader who notices the ordering does not delete it as redundant.
  //
  // Gated on its OWN option, never on `exclusiveCreate === undefined`. Hanging a
  // production side effect off whether a test seam was supplied means any future
  // non-test caller that injects a create — a diagnostics command, a second probe
  // variant — silently stops dropping the file, and the drop is never exercised
  // through the seam at all.
  //
  // Bounded and best-effort, like everything else here: it must not become a way
  // for the probe to stall or to fail.
  // GUARDED, like the body below. The prologue used to sit outside any handler, so a
  // synchronous throw from `deps.isDisposed()` or from constructing the logger
  // rejected a function whose header promises it never throws — leaving the contract
  // enforced only for callers that happen to attach one of their own.
  try {
    if (disposed()) return { capability: 'undetermined', cause: 'probe-disposed' };
    if (deps.dropIgnoreFile !== false) {
      await raceSettled(
        ensureSchegentGitignore(deps.workspaceRoot, new SanitizedLogger([])).catch(() => undefined),
        timeoutMs
      );
    }
  } catch (error) {
    return { capability: 'undetermined', cause: 'unclassified-error', errno: errnoOf(error) };
  }

  // Every attempt STARTED, whether or not its bound waited for it. A create that
  // loses the race still runs, and a create that runs can still make a file.
  const outstanding: Promise<unknown>[] = [];
  /**
   * Did any attempt outlive its bound? Only then is a deferred sweep worth anything.
   *
   * A record rather than a `let`, because the mutation happens inside `attempt`'s
   * closure and TypeScript's control-flow analysis does not follow it: a plain
   * boolean narrows to `false` at the `finally` and the linter reports the guard as
   * dead code. The runtime behaviour was correct either way; this makes the
   * mutation-through-a-closure visible instead of arguing with the checker.
   */
  const bound = { abandoned: false, created: false };
  const attempt = async (): Promise<ExclusiveCreateObservation> => {
    const started = create(segments);
    // Tracked through a handled derivative, so tracking can never itself add an
    // unhandled rejection; `withBound` observes the original.
    outstanding.push(started.then(
      () => undefined,
      () => undefined
    ));
    const observation = await withBound(started, timeoutMs);
    if (observation.outcome === 'timed-out') bound.abandoned = true;
    if (observation.outcome === 'created') bound.created = true;
    return observation;
  };

  try {
    if (disposed()) return { capability: 'undetermined', cause: 'probe-disposed' };
    const first = await attempt();
    if (disposed()) return { capability: 'undetermined', cause: 'probe-disposed' };
    // The second attempt is only meaningful when the first created something.
    //
    // `null`, not a fabricated `io-failed`. `classifyMountCapability` returns from
    // `first` before ever reading the second on that path, so a value here is dead
    // — and a dead value that LOOKS like an observation is a trap: a later rule that
    // consulted `second` earlier would silently classify a fabricated
    // `io-failed`-with-no-errno as something observed. `null` cannot be mistaken for
    // one.
    const second = first.outcome === 'created' ? await attempt() : null;
    return classifyMountCapability(first, second);
  } catch (error) {
    // Belt and braces: `withBound` already converts a rejection into an
    // observation, so reaching here means something outside the attempts failed.
    // It is still not a mount finding.
    return { capability: 'undetermined', cause: 'unclassified-error', errno: errnoOf(error) };
  } finally {
    // The deferred sweep is registered FIRST, before anything is awaited. An
    // abandoned create can land at any point after its bound expires, and if this
    // registration sat below an await that never settles it would never happen at
    // all — the leak it exists to prevent would be guaranteed on exactly the mount
    // that caused it.
    // ONLY when an attempt was actually abandoned. Registered unconditionally, this
    // repeated the whole realpath + lstat + rm round-trip on every ordinary probe —
    // both attempts having already settled, `Promise.all` resolves on the next
    // microtask — so the syscalls were paid for twice per activation, the second
    // time after the function had already resolved.
    if (bound.abandoned) {
      // BOUNDED, and `allSettled`. `Promise.all` on a create that never settles
      // never runs the sweep and retains its closure — with `deps`, `segments` and
      // `outstanding` — for the life of the extension host, once per activation.
      // A generous multiple of the probe's own bound: long enough that a create
      // which is merely slow still gets swept, short enough that one which is hung
      // is let go.
      void raceSettled(Promise.allSettled(outstanding), timeoutMs * DEFERRED_SWEEP_BOUNDS).then(
        (settled) => {
          if (settled.state !== 'value') return;
          // Disposal is re-checked HERE, not only between stages. This callback can
          // fire up to `DEFERRED_SWEEP_BOUNDS` bounds later, long after the window
          // has moved on, and nothing else can cancel it. Removal of an artifact
          // this probe made is the stated exception to the disposal contract — but
          // the exception is for the INLINE sweep, which runs while the root is
          // still the one we were given. This one is not covered by it.
          if (disposed()) return;
          return removeProbeArtifact(deps.workspaceRoot, segments, timeoutMs);
        }
      );
    }
    // Only when something COULD be there. When the first attempt was refused
    // (EEXIST) or failed (EROFS, ECONTAINMENT), nothing was created and nothing was
    // abandoned — and `resolveContainedLink` is a `realpath` plus an `lstat` on the
    // mount that may not answer.
    //
    // WORKSPACE HYGIENE, NOT CORRECTNESS, and the distinction matters both ways.
    // An earlier comment here claimed a leftover artifact "turns the next
    // activation's first create into a second one, which would report `unsupported`
    // on a perfectly good mount". That is false: the leaf carries the pid and a
    // per-attempt counter, so no later probe reuses the name, and even on pid reuse
    // the first create answers EEXIST, which classifies `undetermined` and never
    // `unsupported`. Two readers could act wrongly on that sentence — one deleting
    // the unique naming as redundant, one treating this cleanup as
    // correctness-critical and therefore worth an unbounded wait, which is exactly
    // the defect this block used to have.
    //
    // What a leftover actually costs is accumulation: one file per activation, on
    // the mount least able to afford it.
    //
    // Bounded by the same timer the attempts use — see `removeProbeArtifact` for
    // what went wrong when it was not.
    // WHENEVER SOMETHING WAS CREATED, abandoned or not. The two flags are not
    // exclusive: attempt one can create and attempt two can then stall, which is an
    // ordinary shape on a degrading mount. A version that skipped the inline sweep
    // on `abandoned` left THAT file forever — the deferred sweep below cannot help,
    // because it waits on a create that by hypothesis never settles.
    //
    // When nothing was created and nothing was abandoned there is nothing to look
    // REMOVAL RUNS EVEN WHEN DISPOSED, and that is the one deliberate exception to
    // `isDisposed`'s contract. The contract exists to stop the probe CREATING things
    // in a workspace the window has left; abandoning a file this probe made in that
    // same workspace is the litter the ignore-file drop exists to prevent, and it
    // would be the operator's to find. Bounded, and it only ever touches a leaf this
    // function named.
    if (bound.created) {
      await removeProbeArtifact(deps.workspaceRoot, segments, timeoutMs);
    }
  }
}

/**
 * Remove what the probe made.
 *
 * `safe-open.ts` exports no removal helper, so this follows the shape
 * `ownership-fs.remove` and `raw-transcript-writer` both use: prove containment
 * with the oracle, then act on the RESOLVED path. `tests/lint/destructive-fs-requires-containment.test.ts`
 * governs it, and it caught the first version of this function, which argued that
 * the walk which opened the leaf was proof enough. It is not the same claim — the
 * walk proved a path it composed, and this removes a path some later reader could
 * change — and the gate was right to refuse the argument.
 *
 * `resolveContainedLink` is the right form for a removal: the entry itself is not
 * followed (removing a link the product created is legitimate), while its parent is
 * resolved in full.
 *
 * Best-effort by construction. A cleanup failure must not become the probe's
 * verdict, and must not throw into activation.
 */
async function removeProbeArtifact(
  workspaceRoot: string,
  segments: readonly string[],
  timeoutMs: number
): Promise<void> {
  try {
    const composed = path.join(workspaceRoot, ...segments);
    // The WHOLE cleanup is raced, not just the containment resolve. An earlier
    // version bounded `resolveContainedLink` and then awaited `fsp.rm` with nothing
    // racing it — so a mount that answers `realpath`/`lstat` but stalls on `unlink`
    // (a hard-mounted NFS share is the ordinary example) hung the `finally` of a
    // function whose entire contract is that it is bounded. The verdict was
    // computed and never returned, no line was ever logged, and the `unsupported`
    // notification could never fire: a silent total failure of the feature on its
    // target environment. It was also verbatim the defect the comment above it
    // claimed to have fixed.
    const removal = (async () => {
      const verdict = await resolveContainedLink(composed, [workspaceRoot]);
      // `absent` is the ordinary case when the create never happened, and it is not
      // a failure: a destructive op on a path that is not there has no work.
      if (verdict.outcome !== 'contained') return;
      await fsp.rm(verdict.resolved, { force: true });
    })();
    await raceSettled(removal, timeoutMs);
  } catch {
    /* cleanup is best-effort; a stale artifact cannot mislead a later probe, which names its own leaf */
  }
}
