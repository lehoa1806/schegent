// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT HERE; THE PROBE IT
// STARTS IS ONE.
// This module formats and reports a verdict. `startMountCapabilityProbe` calls
// `probeMountCapability`, which creates `.schegent/`, drops the local ignore file
// and exclusive-creates then removes `.schegent/.mount-probe.<pid>.<n>.<t>` —
// three writes. `openWorkspaceSession` owns that call and defers it; see
// `startMountProbe` there.

import type { SanitizedLogger } from '../lib/logger';

/**
 * The two methods this module uses.
 *
 * `Pick<>` rather than the concrete class, matching `cli-transport-sink.ts`,
 * `claude-cli-monitor.ts`, `backend-runner-factory.ts` and three others. Taking the
 * class forced both new suites to write `as any` at the call site, which disables
 * checking of EVERY argument there — so a later signature change would not have
 * failed those tests. Declaring a narrow notifier interface for the same reason one
 * line below, and then not doing it for the logger, was an inconsistency with a
 * cost.
 */
type MountCapabilityLogger = Pick<SanitizedLogger, 'info' | 'warn'>;
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
  logger: MountCapabilityLogger,
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
      if (notifiedWorkspaces.has(workspaceRoot)) return;
      // Recorded only AFTER the call returns. A VS Code UI call throws when stage 2
      // is torn down underneath it — which is precisely when this probe's verdict
      // arrives — and marking first burned the one notification for that root: the
      // operator would never be told their filesystem cannot arbitrate, for the life
      // of the extension host. The bookkeeping has to record a DELIVERY, not an
      // attempt. The log line above is unconditional for the same reason.
      // `Promise.resolve(...).catch(...)`, not a bare call and not a bare `void`.
      // `Notifier.warn` returns the `Thenable` from `showWarningMessage`, and VS Code
      // rejects it when the host is disposing — which is exactly the window this
      // verdict arrives in. A bare call leaves that rejection unobserved, and the
      // `unknown` return type on the interface is what keeps the floating-promise
      // rule from saying so.
      void Promise.resolve(notifier.warn(UNSUPPORTED_MESSAGE)).then(
        () => notifiedWorkspaces.add(workspaceRoot),
        // Not marked. A synchronous throw was already handled; an ASYNC rejection —
        // which is the shape VS Code produces when the host is disposing, i.e. this
        // verdict's own window — used to run the `add` on the next line regardless.
        // The root was then permanently marked notified and a later `schegent.reset`
        // logged the finding without ever showing it, for the life of the host.
        () => undefined
      );
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
    default:
      // EXHAUSTIVE, checked by the compiler. `MountCapability` already grew from
      // three arms to four in this feature, and every case above `return`s — so a
      // fifth would fall out of the switch, produce no log line and no notification,
      // and `tsc` would stay green. This module's own header argues that a probe
      // which finds an unsupported mount and continues quietly is worse than no
      // probe; a silent fall-through is exactly that, arriving through the type
      // system instead of the filesystem.
      return assertNeverCapability(verdict.capability);
  }
}

/** Compile-time proof that the switch above covers every `MountCapability`. */
function assertNeverCapability(value: never): void {
  void value;
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
  logger: MountCapabilityLogger,
  notifier: MountCapabilityNotifier
): { dispose(): void } {
  // THE PROBE'S I/O OUTLIVES THIS CALL BY ROUGHLY TEN BOUNDS.
  //
  // Sequentially: the gitignore drop, attempt one, attempt two and the inline
  // cleanup are each raced against `MOUNT_PROBE_TIMEOUT_MS` (four), and on the
  // abandoned path a deferred sweep waits `DEFERRED_SWEEP_BOUNDS` (five) more and
  // then runs its own bounded removal. At the shipped 2 s that is about 20 s of
  // probe-owned filesystem work after this function returns.
  //
  // The number is written once, here, because it has been wrong twice — first "two
  // bounds", then "four" — and a maintainer sizing a disposal window against either
  // would size it at a fraction of the real figure. `disposed` is what makes the
  // over-run safe rather than the number being small.
  //
  // Stage 2 is re-wired on `schegent.reset` and on a workspace-folder change, so a probe
  // started against root A can resolve after the window has moved to root B — and
  // then pop an operator notification about a workspace they are no longer in.
  // A verdict for a torn-down stage is DROPPED rather than shown, AND the probe is
  // told, so it stops doing filesystem work against a root the window has left. The
  // `.catch` below only stops a disposed-UI throw becoming an unhandled rejection;
  // it does nothing about a successful, misattributed notification, and nothing at
  // all about writes.
  let disposed = false;
  void probeMountCapability({ workspaceRoot, isDisposed: () => disposed })
    .then(
      (verdict) => {
        if (disposed) return;
        reportMountCapability(verdict, workspaceRoot, logger, notifier);
      },
      () => undefined
    )
    // `.then(onFulfilled, onRejected)` does NOT route a throw from `onFulfilled`
    // to `onRejected`, so the arm above covers the probe and nothing else.
    // `reportMountCapability` calls the notifier, and the probe can still be in
    // flight when a workspace-folder change or `schegent.reset` tears stage 2
    // down underneath it — which is precisely when a VS Code UI call throws.
    // This is the arm that keeps that off the activation path.
    .catch(() => undefined);

  return {
    dispose: () => {
      disposed = true;
    }
  };
}
