import type { SanitizedLogger } from '../lib/logger';
import type { MountCapabilityVerdict } from '../state/mount-capability';
import { probeMountCapability } from '../state/mount-capability-probe';

/**
 * FR-R3-083 — surface the mount probe's verdict, once per workspace.
 *
 * WHY A NOTIFICATION FOR ONE ARM AND A LOG LINE FOR THE REST
 *
 * `FR-R3-083` §5 is explicit that "a probe that finds an unsupported mount and
 * continues quietly is worse than no probe: it converts an environment-dependent
 * risk into a false assurance." A line in an output channel nobody has open is
 * quiet. So `unsupported` notifies.
 *
 * `undetermined` does not, and that asymmetry is the point. Notifying on a
 * non-finding is how an operator learns to dismiss this notification, and the one
 * that matters arrives looking identical to the four that did not. The undetermined
 * case is still recorded — it is just recorded where a diagnosis is looked for
 * rather than where an interruption is delivered.
 *
 * `read-only` is its own arm for the same reason: a read-only checkout is a
 * legitimate workspace condition, and telling that operator their filesystem cannot
 * arbitrate is a false finding.
 */

/**
 * The narrow slice of the notifier this needs, so a test does not construct VS Code.
 *
 * The return type is `unknown` rather than `void` because the real `Notifier.warn`
 * returns a `Thenable` for the modal it may show. Nothing here awaits it — an
 * activation-time advisory must not wait on an operator dismissing a dialog.
 */
export interface MountCapabilityNotifier {
  warn(message: string): unknown;
}

/**
 * Notified-once, keyed by workspace root.
 *
 * Module-level and keyed by root rather than a boolean, matching
 * `warnIfEnvironmentIsUnrestricted`: a window that adds a folder must be able to
 * warn about the new one, and must not re-warn about the old one.
 *
 * A root is recorded only on the arm that actually NOTIFIES, which is the same
 * discipline `warnIfEnvironmentIsUnrestricted` follows — it records the root
 * after its own early return, never before. Recording every verdict would let
 * the first one win permanently: `wireStage2` runs again in the same process
 * after `schegent.reset` and after a workspace-folder change, so a first probe
 * that answered `undetermined` — a transient timeout on exactly the slow mount
 * this exists for — would silently swallow the `unsupported` verdict that
 * followed it. The log lines are not gated, because a log line is a record and
 * not an interruption.
 */
const notifiedWorkspaces = new Set<string>();

/** Test seam. Activation never calls this. */
export function resetMountCapabilityWarnings(): void {
  notifiedWorkspaces.clear();
}

/**
 * The operator-facing sentence for a mount that cannot arbitrate.
 *
 * Names the condition, the consequence, and the remedy — and no path. The workspace
 * root never appears here: the standing rule against serializing workspace roots
 * into evidence applies to anything an operator might copy out of a log, and the
 * operator already knows which workspace they opened.
 */
const UNSUPPORTED_MESSAGE =
  'Schegent: this workspace is on a filesystem that does not implement atomic exclusive creation. ' +
  'Window primacy cannot be arbitrated safely here, so two windows may both consider themselves ' +
  'primary. Move the workspace to a local-style filesystem, or run a single window. ' +
  'See docs/architecture/workspace-ownership-fencing.md.';

export function reportMountCapability(
  verdict: MountCapabilityVerdict,
  workspaceRoot: string,
  logger: SanitizedLogger,
  notifier: MountCapabilityNotifier
): void {
  // The errno is the datum that separates a full disk from a permissions problem
  // from a mount that does not implement the primitive, which is why
  // `AcquireOutcome` preserves it too. Absent when nothing supplied one.
  const cause = verdict.errno === undefined ? verdict.cause : `${verdict.cause}/${verdict.errno}`;

  switch (verdict.capability) {
    case 'supported':
      // Deliberately silent at warn level. A probe that announces good news every
      // activation is noise, and the fence's own operation is stronger evidence
      // than the probe anyway.
      logger.info(`mount capability: exclusive create holds (${cause})`);
      return;
    case 'unsupported':
      logger.warn(`mount capability: UNSUPPORTED — exclusive create does not arbitrate (${cause})`);
      // The NOTIFICATION is the once-per-workspace thing, not the record. Marked
      // here, on the arm that delivers it, so no other verdict can spend it.
      if (notifiedWorkspaces.has(workspaceRoot)) return;
      notifiedWorkspaces.add(workspaceRoot);
      void notifier.warn(UNSUPPORTED_MESSAGE);
      return;
    case 'read-only':
      logger.warn(
        `mount capability: workspace is read-only (${cause}); window primacy will not be elected, ` +
          'which is a property of the checkout and not of the filesystem'
      );
      return;
    case 'undetermined':
      logger.warn(
        `mount capability: UNDETERMINED (${cause}); the probe reached no answer, which is neither ` +
          'a finding nor an assurance'
      );
      return;
  }
}

/**
 * Start the probe and report whatever it finds. Returns immediately.
 *
 * Activation calls this and does not wait. The probe is bounded and never throws,
 * but activation must not DEPEND on it either: an environment-dependent check that
 * can delay or prevent the extension from starting is strictly worse than no check.
 * The `.then` rejection arm is belt-and-braces — the probe converts its own
 * failures into `undetermined` — so that a future edit inside it cannot put an
 * unhandled rejection on the activation path.
 *
 * `workspaceRoot` is the value activation has ALREADY resolved. This function does
 * not go looking for a folder of its own; the hard rule routes every first-folder
 * read through `getCanonicalWorkspaceRoot()`.
 */
export function startMountCapabilityProbe(
  workspaceRoot: string,
  logger: SanitizedLogger,
  notifier: MountCapabilityNotifier
): void {
  void probeMountCapability({ workspaceRoot })
    .then(
      (verdict) => reportMountCapability(verdict, workspaceRoot, logger, notifier),
      () => undefined
    )
    // `.then(onFulfilled, onRejected)` does NOT route a throw from `onFulfilled`
    // to `onRejected`, so the arm above covers the probe and nothing else.
    // `reportMountCapability` calls the notifier, and the probe can still be in
    // flight when a workspace-folder change or `schegent.reset` tears stage 2
    // down underneath it — which is precisely when a VS Code UI call throws.
    // This is the arm that keeps that off the activation path.
    .catch(() => undefined);
}
