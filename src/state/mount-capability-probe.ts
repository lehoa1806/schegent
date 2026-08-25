import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { openWithinRoot } from '../lib/safe-open';
import { resolveContainedLink } from '../lib/path-containment';
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
}

function errnoOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
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
  return { outcome: 'io-failed', errno: result.errno };
}

/**
 * Race one attempt against the bound.
 *
 * The loser is abandoned, not awaited. A settled-flag guards the cleanup so a
 * create that lands after expiry still removes what it made — otherwise a slow
 * mount would leave the artifact behind precisely when the probe stopped watching.
 */
function withBound(
  attempt: Promise<ExclusiveCreateObservation>,
  timeoutMs: number
): Promise<ExclusiveCreateObservation> {
  return new Promise<ExclusiveCreateObservation>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ outcome: 'timed-out' });
    }, timeoutMs);
    timer.unref?.();
    attempt.then(
      (observation) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(observation);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ outcome: 'io-failed', errno: errnoOf(error) });
      }
    );
  });
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
  const leaf = `.mount-probe.${process.pid}.${probeCounter}`;
  const segments = [...PROBE_SEGMENTS_PREFIX, leaf];
  const create =
    deps.exclusiveCreate ??
    ((s: readonly string[]) => realExclusiveCreate(deps.workspaceRoot, s));

  try {
    const first = await withBound(create(segments), timeoutMs);
    // The second attempt is only meaningful when the first created something. If it
    // did not, the name is not taken and a second create proves nothing.
    const second: ExclusiveCreateObservation =
      first.outcome === 'created'
        ? await withBound(create(segments), timeoutMs)
        : { outcome: 'io-failed' };
    return classifyMountCapability(first, second);
  } catch (error) {
    // Belt and braces: `withBound` already converts a rejection into an
    // observation, so reaching here means something outside the attempts failed.
    // It is still not a mount finding.
    return { capability: 'undetermined', cause: 'unclassified-error', errno: errnoOf(error) };
  } finally {
    // EVERY path — success, refusal, throw, and timeout. A probe that leaves its
    // artifact behind turns the next activation's first create into a second one,
    // which would report `unsupported` on a perfectly good mount.
    await removeProbeArtifact(deps.workspaceRoot, segments);
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
  segments: readonly string[]
): Promise<void> {
  try {
    const composed = path.join(workspaceRoot, ...segments);
    const verdict = await resolveContainedLink(composed, [workspaceRoot]);
    // `absent` is the ordinary case when the create never happened, and it is not a
    // failure: a destructive op on a path that is not there has no work.
    if (verdict.outcome !== 'contained') return;
    await fsp.rm(verdict.resolved, { force: true });
  } catch {
    /* cleanup is best-effort; a stale artifact cannot mislead a later probe, which names its own leaf */
  }
}
