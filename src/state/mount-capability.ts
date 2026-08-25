/**
 * FR-R3-083 (`PORT-01`) — can this workspace's filesystem arbitrate?
 *
 * The ownership fence rests on ONE platform property: `open(2)` with
 * `O_CREAT|O_EXCL` either creates or fails `EEXIST`, and cannot do both. That
 * property belongs to the filesystem, not to Node, and the documents say where it
 * is not guaranteed — NFSv2, some SMB, and the 9p, virtiofs and network-home
 * mounts ordinary remote development puts a workspace on.
 *
 * `docs/architecture/workspace-ownership-fencing.md` has stated that limit since
 * `FR-R3-040`. What has never existed is anything that LOOKS. A workspace on an
 * affected mount degrades silently: the operator's symptom is "no window is
 * primary" and the diagnosis is nothing.
 *
 * THIS MODULE IS THE DECISION ONLY, AND THAT SPLIT IS LOAD-BEARING
 *
 * The probe's own syscalls live in `mount-capability-probe.ts`. Keeping the
 * classification pure is what makes the case that matters testable: a filesystem
 * that lets the SECOND exclusive create of the same name SUCCEED. No such mount is
 * available to this project, so that arm is reached by handing this function the
 * observation directly. It is exercised, and it is not observed on real hardware —
 * `docs/operations/platform-observation-record.md` records it as the weaker claim
 * it is, rather than letting an injected pass read like a measured one.
 *
 * WHY A REFUSAL-ONLY PROBE WOULD MISS THE POINT
 *
 * The obvious probe creates a file exclusively and reports success. That detects a
 * mount which cannot create at all, which is not the failure mode. The failure mode
 * is a mount that creates and does not refuse — two windows both believing they
 * elected themselves. So the probe creates TWICE and the interesting answer is the
 * second one.
 */

/** What one exclusive-create attempt did. Bounded, and safe to log. */
export type ExclusiveCreateOutcome =
  /** The file was created. */
  | 'created'
  /** The filesystem refused. `errno` says why; `EEXIST` is the answer we want on the second attempt. */
  | 'refused'
  /** A syscall failed for a reason that proves nothing about the mount. */
  | 'io-failed'
  /** The attempt did not answer inside the probe's bound. */
  | 'timed-out';

export interface ExclusiveCreateObservation {
  readonly outcome: ExclusiveCreateOutcome;
  /** The originating error code when there was one. Never a path. */
  readonly errno?: string;
}

/**
 * The verdict.
 *
 * `read-only` is a FOURTH arm and not a flavour of `unsupported`, because the two
 * send an operator to different places. A read-only checkout is a legitimate
 * workspace condition — the fence will not elect there either, but the mount is
 * fine, and telling that operator their filesystem cannot arbitrate is a false
 * finding that costs the real one its credibility.
 */
export type MountCapability = 'supported' | 'unsupported' | 'read-only' | 'undetermined';

/** Why the verdict came out that way. Bounded, enumerated, and safe to log. */
export type MountCapabilityCause =
  /** Created once, refused `EEXIST` the second time. The primitive holds. */
  | 'exclusive-create-holds'
  /** The second exclusive create of the same name SUCCEEDED. The primitive does not hold. */
  | 'second-exclusive-create-succeeded'
  /** The filesystem does not implement the operation. */
  | 'exclusive-create-unsupported'
  /** The workspace is read-only. Not a mount-capability finding. */
  | 'read-only-workspace'
  /** The probe did not answer inside its bound. */
  | 'probe-timed-out'
  /** The containment primitive refused the probe's own location. */
  | 'containment-refused'
  /** A syscall failed with a code this table does not classify. */
  | 'unclassified-error';

export interface MountCapabilityVerdict {
  readonly capability: MountCapability;
  readonly cause: MountCapabilityCause;
  /**
   * The errno that decided it, when there was one. Preserved for the reason
   * `AcquireOutcome.cause` preserves it: flattening every failure to one shape
   * discards the datum that separates a full disk from a permissions problem from
   * a mount that does not implement the primitive.
   */
  readonly errno?: string;
}

/**
 * Codes that mean the filesystem does not implement exclusive creation.
 *
 * `ownership-registry.ts` names `ENOTSUP`, `EPERM`, `EROFS` and `ENOSYS` as codes
 * worth keeping APART, and that is a keep-them-apart list — not an equivalence
 * class. Only the two that actually say "this operation is not implemented here"
 * belong in this set:
 *
 *   - `EROFS` has its own arm above: the mount is fine, the checkout is read-only.
 *   - `EPERM` is a PERMISSIONS answer, for the same reason `EACCES` is. A
 *     root-owned `.schegent`, an immutable flag (`chattr +i`), or a FUSE or
 *     container mount that answers `EPERM` where another would answer `EACCES`,
 *     would all have produced the operator notification "this workspace is on a
 *     filesystem that does not implement atomic exclusive creation... move the
 *     workspace" — about a mount that is perfectly capable. That is the false
 *     finding this module excludes `EACCES` to avoid, arriving through the other
 *     door.
 *
 * So `EPERM` classifies `undetermined`, which is the honest answer: the probe did
 * not get to find out.
 */
const UNSUPPORTED_ERRNOS: ReadonlySet<string> = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

/**
 * The containment layer's own refusal, surfaced by the probe as a pseudo-errno.
 *
 * Not a real `errno`, and named so it cannot be mistaken for one: `safe-open`
 * refuses by reason code, not by syscall failure, and the two must not be merged
 * into one channel where a `symlink-component` refusal could be read as a mount
 * property.
 */
export const CONTAINMENT_REFUSED_ERRNO = 'ECONTAINMENT';

function fromFailure(errno: string | undefined): MountCapabilityVerdict {
  if (errno === 'EROFS') {
    return { capability: 'read-only', cause: 'read-only-workspace', errno };
  }
  if (errno === CONTAINMENT_REFUSED_ERRNO) {
    // The probe could not reach its own location safely. That says something about
    // the workspace and nothing about the mount, so it must not be reported as
    // either supported or unsupported.
    return { capability: 'undetermined', cause: 'containment-refused', errno };
  }
  if (errno !== undefined && UNSUPPORTED_ERRNOS.has(errno)) {
    return { capability: 'unsupported', cause: 'exclusive-create-unsupported', errno };
  }
  return {
    capability: 'undetermined',
    cause: 'unclassified-error',
    ...(errno === undefined ? {} : { errno })
  };
}

/**
 * Classify a mount from two exclusive-create attempts at the SAME name.
 *
 * The order matters and is the whole design: the first attempt establishes that
 * the filesystem can create at all, and the second establishes that it refuses.
 * A mount that fails the first tells us about the workspace; a mount that passes
 * the first and fails the second tells us the fence cannot arbitrate there.
 */
export function classifyMountCapability(
  first: ExclusiveCreateObservation,
  second: ExclusiveCreateObservation
): MountCapabilityVerdict {
  // A bound that expired is not evidence. It must never manufacture a finding out
  // of the probe's own impatience, which is exactly what an unresponsive network
  // mount — the environment this probe exists for — would otherwise produce.
  if (first.outcome === 'timed-out' || second.outcome === 'timed-out') {
    return { capability: 'undetermined', cause: 'probe-timed-out' };
  }

  if (first.outcome !== 'created') return fromFailure(first.errno);

  // THE CASE THIS PROBE EXISTS FOR. The name is already taken and the filesystem
  // created it again, so two windows can both believe they elected themselves.
  if (second.outcome === 'created') {
    return { capability: 'unsupported', cause: 'second-exclusive-create-succeeded' };
  }

  if (second.outcome === 'refused' && second.errno === 'EEXIST') {
    return { capability: 'supported', cause: 'exclusive-create-holds', errno: 'EEXIST' };
  }

  // Created once, then something else went wrong. The primitive was not shown to
  // hold and was not shown to fail.
  return fromFailure(second.errno);
}
