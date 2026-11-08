// FR-R4-F04 (contract D, T059) — where one Run's private recovery checkpoint lives, named once.
//
// Three modules read this location: the service that writes checkpoints, the retention service that ages
// them, and the deletion that removes a Run's. Each had its own copy of the directory name and, in the
// writer, of the rule that turns a Run id into a path segment. A deletion that guessed the segment
// differently from the writer would silently miss the checkpoint it exists to remove, so the constant and
// the rule are exported from here and imported by all three.
//
// The checkpoints sit under the extension's private storage (`<globalStorage>/checkpoints/<segment>/`),
// deliberately outside the workspace, because they hold unredacted Git diffs.

/** The directory under private storage that holds every Run's checkpoint directory. */
export const RUN_CHECKPOINT_DIRECTORY = 'checkpoints';

/** The characters a path segment may keep; anything else becomes `_`. */
const UNSAFE_SEGMENT_CHARACTERS = /[^a-zA-Z0-9_-]/g;

/**
 * The directory name for one Run (or one Phase) under `RUN_CHECKPOINT_DIRECTORY`. Run ids are UUIDs and
 * pass through unchanged; the replacement is what makes any other id safe to join onto a path.
 */
export function safeRunSegment(runId: string): string {
  return runId.replace(UNSAFE_SEGMENT_CHARACTERS, '_');
}

/** Suffix for persisted bounded candidate handover artifacts (`SPEC-05` / `D5`). */
export const RECOVERY_ENVELOPE_SUFFIX = '.recovery.json';

/** Canonical filename for one candidate handover artifact inside a Run's checkpoint directory. */
export function recoveryEnvelopeFileName(handoverId: string): string {
  return `${safeRunSegment(handoverId)}${RECOVERY_ENVELOPE_SUFFIX}`;
}

