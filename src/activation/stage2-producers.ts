// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: THE GATE. Every act the other
// twenty modules handed over runs here, behind one live trust read.

import * as vscode from 'vscode';

import type { SchegentWorkflowController } from '../controller/workflow-controller';
import type { SanitizedLogger } from '../lib/logger';
import { checkLiveness, createLivenessProbe } from '../services/process-liveness';
import { resumePersistedRuns } from '../services/resume-decision';
import type { CreditWatchdog } from '../watchdog/credit-watchdog';
import type { ScheduledStartCoordinator } from '../services/scheduled-start-coordinator';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { WorkspaceLockManager } from '../state/lock';
import type { WorkspaceStateStore } from '../state/workspace-state';

/**
 * FR-R3-136 (FR-009, FR-010, FR-011, FR-012) — everything Stage 2 *does* to the
 * workspace, in one place, behind one trust gate.
 *
 * THE SPLIT IS BY ACTION, NOT BY CONSTRUCTION, and that is a decision worth
 * naming because the plan's first sketch (D4) read the other way. Deferring the
 * *object graph* until trust is granted is not possible and would not help:
 * the sidebar's projection needs the audit writer, the history store and the
 * runner registry to render "here is what this workspace contains", and refusing
 * to build them would break the `limited` claim the manifest already ships —
 * state, history, audit and log views keep working in an untrusted window. What
 * must not happen is not construction. `new AuditLogWriter(...)` writes nothing;
 * `new RunnerRegistry(...)` spawns nothing. The hazard is the *acts*: electing,
 * appending, sweeping, arming, resuming. So those are what moved here, and the
 * graph is still built eagerly above.
 *
 * THE ELECTION IS THE FIRST STATEMENT (FR-R3-136 C2). `store.ownership.acquire`
 * is an exclusive-create on a generation-numbered file under `.schegent/` — a
 * write, inside the folder whose contents are the reason trust is being withheld.
 * An untrusted window therefore does not elect, and because FR-R3-070 already
 * gates every recovery installer on the election result, not electing suppresses
 * all four of them by construction rather than by four more conditions. That
 * transitive safety is why they are HERE, together, in the order the gate reads:
 * a landmark left behind in the composition root would be gated only by
 * primacy, and the coupling between primacy and trust would be an accident
 * nobody could see.
 *
 * THE ELECTION IS ALSO LATER IN ACTIVATION than it was, because this call sits at
 * the end of `wireStage2` where `openWorkspaceSession` sits near its start. That
 * was checked rather than assumed: no collaborator captures the claim. Every other
 * primacy reader in `src/` asks `lock.hasPrimacy()` or reads the ownership record
 * at call time, and the first sidebar projection happens when the webview mounts,
 * which is after activation returns.
 *
 * IDEMPOTENT, BECAUSE THE GRANT CALLS IT AGAIN. `onDidGrantWorkspaceTrust` fires
 * in a window that has already activated, so `run()` is the same entry point for
 * both the trusted-at-activation case and the granted-later case — one path, run
 * twice at most, rather than an activation path and a parallel grant path that
 * drift. VS Code has no revoke event (spec C1), so once this has run the window
 * stays a producer for its lifetime and a second grant is a no-op.
 */
export interface Stage2ProducerDeps {
  /**
   * Read fresh inside `run()`, never captured. The grant can land between this
   * object being built and `run()` being called, and a captured `false` would
   * make the grant subscriber a no-op — the failure this module exists to avoid.
   */
  readonly isWorkspaceTrusted: () => boolean;
  readonly logger: SanitizedLogger;
  readonly store: WorkspaceStateStore;
  readonly auditWriter: AuditLogWriter;
  readonly lock: WorkspaceLockManager;
  readonly controller: Pick<
    SchegentWorkflowController,
    'resumeExistingFromActivation' | 'resumeExisting' | 'scheduleAutoDrain'
  >;
  readonly watchdog: Pick<CreditWatchdog, 'reattachOnActivation'>;
  readonly scheduledStartCoordinator: Pick<ScheduledStartCoordinator, 'reArm'>;
  /**
   * The audit appends and the retention sweep `wireEvidence` used to perform at
   * construction. Handed over as a thunk rather than moved into this module
   * because they belong to the evidence surface — what changed is WHEN they run,
   * not what they are.
   */
  readonly replayEvidenceBacklog: () => Promise<void>;
  /**
   * The two acts `run-safety-wiring.ts` used to perform at wiring time.
   *
   * A `Pick` and not the bundle, following `controller` and `watchdog` above:
   * `run-safety-wiring.ts` returns eight members and this module has business
   * with two of them.
   *
   * `replayTerminalTransitions` finishes a queue item, records history and writes
   * the metrics rollup per journalled intent, so it runs BEFORE the recovery
   * installers that read the run map it reconciles — the relative order it held
   * in the composition root. `sweepCheckpointRetention` was fire-and-forget at
   * its old call site and stays that way; activation has never blocked on it.
   */
  readonly runSafety: {
    readonly replayTerminalTransitions: () => Promise<void>;
    readonly sweepCheckpointRetention: () => Promise<unknown>;
  };
  /**
   * The backend probe `live-picture-wiring.ts` used to fire at wiring time.
   *
   * `scan()` spawns one bounded `--help` per supported backend, so it is a
   * producer act by the plainest reading of T1523a's criterion. Fire-and-forget
   * here, exactly as it was at its old call site: activation has never waited on
   * installed CLI processes, and the sidebar re-renders through the capability
   * projector when the answer lands.
   */
  readonly backendCapabilities: { readonly scan: () => Promise<unknown> };
  /**
   * The mount probe `openWorkspaceSession` used to start at wiring time.
   *
   * Three writes under `.schegent/` — the directory itself, the local ignore
   * file, and an exclusive-created probe artifact it then removes. `workspace-
   * session.ts` carries why it is a thunk and why a grant needs it.
   */
  readonly startMountProbe: () => void;
  /**
   * Re-resolve the catalog. While untrusted `isCatalogActivationTrusted()`
   * refuses activation (feature 099), so the session holds the empty catalog; a
   * grant has to re-resolve it or the operator trusts the folder and still sees
   * nothing.
   */
  readonly refreshCatalog: () => Promise<void>;
}

export interface Stage2Producers {
  /**
   * Elect, replay, recover — or record why not. Safe to call more than once.
   */
  run(): Promise<void>;
  /** Whether the producers have already run in this window. */
  hasRun(): boolean;
}

export function createStage2Producers(deps: Stage2ProducerDeps): Stage2Producers {
  const {
    isWorkspaceTrusted,
    logger,
    store,
    auditWriter,
    lock,
    controller,
    watchdog,
    scheduledStartCoordinator,
    replayEvidenceBacklog,
    runSafety,
    backendCapabilities,
    startMountProbe,
    refreshCatalog
  } = deps;

  let ran = false;
  let running: Promise<void> | null = null;

  const runOnce = async (): Promise<void> => {
    if (!isWorkspaceTrusted()) {
      // Not a warning. An untrusted window behaving correctly is not a problem
      // to report; the operator chose this, and the sidebar already says so.
      logger.info('stage 2 producers skipped: workspace is not trusted');
      return;
    }

    // FR-R3-070 — elect BEFORE recovering. The recovery installers below used to
    // run ahead of this call, so a window about to lose the election could still
    // resume and drive a Run the primary already owned. Primacy is decided here,
    // once; every installer is gated on the result, and a non-primary window
    // leaves persisted deadlines addressable for the primary — the decline-and-
    // retain shape fire() models. FR-R3-136 moved the call out of
    // `openWorkspaceSession` so that an untrusted window never reaches it.
    const lockResult = await lock.tryAcquire();
    ran = true;

    // The mount probe goes here and not earlier: its own header argues that it is
    // not the first writer because the ownership path creates `.schegent/` before
    // it runs, and `tryAcquire()` above is that path. Started, never awaited —
    // activation has never waited for a verdict about the filesystem.
    startMountProbe();

    // Terminal-transition replay goes first among the writes, for the reason its
    // dep note gives: everything downstream reads the run map it reconciles, and
    // a Run whose completion was journalled but not projected must finish before
    // anything decides whether to resume it.
    await runSafety.replayTerminalTransitions();

    // The evidence backlog goes second: it appends the migration events
    // `store.initialize()` reported and sweeps `.schegent/sessions`, and both are
    // this window's writes regardless of who won the election — a non-primary
    // window still has to record the migration it performed.
    await replayEvidenceBacklog();

    // Third, because the catalog the recovery installers resolve against must be
    // the real one by the time they run.
    try {
      await refreshCatalog();
    } catch (err) {
      logger.warn(`catalog refresh after trust failed: ${(err as Error).message}`);
    }

    // Fire-and-forget, as it was at its old call site. Not gated on primacy
    // either, also as it was: global-storage checkpoints are this machine's, and
    // a sweep bounded by in-flight runs is safe for a non-primary window to run.
    void runSafety.sweepCheckpointRetention();

    // Also fire-and-forget, also not primacy-gated: knowing which backends are
    // installed is this machine's fact, and every window's UI shows it.
    void backendCapabilities.scan();

    if (lockResult.acquired) {
      try {
        await scheduledStartCoordinator.reArm();
      } catch (err) {
        logger.warn(`scheduled-start re-arm failed: ${(err as Error).message}`);
      }
    } else {
      // FR-R3-070 — non-primary: no re-arm. Persisted schedules stay exactly as
      // they are, addressable by the primary window's coordinator and watchdog.
      logger.info('scheduled-start re-arm skipped: window is not primary');
    }

    if (lockResult.acquired) {
      await watchdog.reattachOnActivation();
    } else {
      // FR-R3-070 — non-primary: the persisted poll deadline remains for the
      // primary window to reattach.
      logger.info('watchdog reattach skipped: window is not primary');
    }

    // Feature 011 FR-013 — restart handshake. If the persisted run has a
    // pending delayed-retry deadline, re-arm the watchdog (or resume
    // immediately if it has already elapsed).
    if (lockResult.acquired) {
      await controller.resumeExistingFromActivation();
    } else {
      // FR-R3-070 — the path that used to fire setImmediate(resumeExisting)
      // before the election was decided; the elapsed deadline stays persisted.
      logger.info('delayed-retry re-arm skipped: window is not primary');
    }

    // FR-R3-103 — ask whether the previous host's tree is still alive before
    // resuming. Feature 093 (T037/T039) — C-4 aggregate: a window that crashed
    // mid-concurrency persisted several Runs, each re-armed on its own queue.
    // Not awaited, unchanged from the composition root this moved out of: the
    // sweep probes a possibly-dead process tree, and activation has never blocked
    // on that answer.
    if (lockResult.acquired) {
      const probe = createLivenessProbe();
      void resumePersistedRuns({
        // Filtered HERE: `resume-decision.ts` is not on the status-literal
        // allowlist and this file is, which is the right way round — the policy
        // module should not know the status vocabulary.
        runs: () =>
          Object.entries(store.getRunMap()).filter(([, run]) => run.status === 'running'),
        liveness: (identity) => checkLiveness(identity, probe),
        appendAudit: async (entry) => {
          await auditWriter.append({ ...entry, payload: { ...entry.payload } });
        },
        resume: (queueId) => void controller.resumeExisting(queueId),
        notify: (message) => void vscode.window.showWarningMessage(message),
        log: (message) => logger.info(message)
      });
    } else {
      logger.info('persisted-run resume skipped: window is not primary');
    }

    // Bug "there is no way to start a pending task" (2026-09-02), second finding
    // — the drain nothing performed.
    //
    // `AutoDrainCoordinator` is edge-triggered: every transition to `pending`
    // has to be followed by a call site asking for a drain, and two producers of
    // pending rows have no call site to put one in. `queue-state-migrator.ts`
    // demotes rows a crashed host left `in-flight`, during state load, before a
    // controller exists to drain with. And a queue whose drain was declined
    // mid-session — at the concurrency ceiling, or on a lost execution lease —
    // keeps its rows with nothing scheduled to ask again, because the trigger
    // that would have re-asked is the terminal transition of a Run that no
    // longer exists. Both survived restarts, since restarting was the one thing
    // that asked for nothing. `pending-transition-drain-trigger.test.ts` already
    // excused the migrator on the recorded grounds that "the drain that picks
    // these up is the one activation performs once the controller is up"; this
    // is that drain, written now that the claim is checked.
    //
    // THE SWEEP IS THE ONE A TERMINAL RUN ALREADY PERFORMS, not a second one.
    // `scheduleAutoDrain()` is what the controller runs after every Run that
    // ends: it sweeps the whole registry, because the slot a finished Run frees
    // belongs to whichever queue the round-robin cursor reaches next. Activation
    // needs exactly that question asked once, about work no Run's ending will ask
    // it about. Reusing it rather than adding a registry-wide entry point beside
    // it keeps one spelling of "sweep for drainable work", and it is why this
    // fix adds no method to a controller whose size ratchet may only come down.
    //
    // HARD RULE 31 IS SATISFIED BY CONSTRUCTION, not by a condition here. That
    // sweep delegates to `drainAll()`, which reads no lifecycle value and
    // pre-filters on none; the `idle-pending` refusal remains step 1 of
    // `drainQueue`, the single enforcement site hard rule 32 requires. So this
    // starts work only on queues in the unheld lifecycles — the ones whose
    // meaning is "this drains automatically" — and an `idle-pending` or
    // `operator-paused` queue is visited and declines, exactly as on the
    // post-terminal sweep.
    //
    // LAST, AND PRIMACY-GATED. Last because the picture has to be settled first:
    // `replayTerminalTransitions` finishes Runs whose completion was journalled
    // but not projected, and the three installers above resume or re-arm the
    // Runs a queue already owns. A sweep ahead of them would read a queue as
    // busy on a Run that had already ended, or start a second Run on a queue
    // about to resume its own. Gated because starting a Run is the primary's
    // act — an ungated sweep here is precisely the two-processes-one-checkout
    // defect FR-R3-070 removed. Not awaited, and not wrapped: the method returns
    // void and logs its own failure through the controller's sanitized logger,
    // which is the same handling every other caller of it gets.
    if (lockResult.acquired) {
      controller.scheduleAutoDrain();
    } else {
      logger.info('activation drain sweep skipped: window is not primary');
    }
  };

  return {
    hasRun: () => ran,
    async run(): Promise<void> {
      // A second grant, a concurrent grant, and a grant that lands while the
      // first run is still awaiting all reach this. `ran` closes the first two;
      // `running` closes the third, which is the one a boolean alone would miss
      // because every landmark below is awaited.
      if (ran) return;
      if (running) return running;
      running = runOnce().finally(() => {
        running = null;
      });
      return running;
    }
  };
}
