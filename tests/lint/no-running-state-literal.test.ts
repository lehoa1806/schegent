import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { filesMatching } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOTS = [
  resolve(REPO_ROOT, 'src'),
  resolve(REPO_ROOT, 'webview-ui', 'src')
] as const;

const ALLOWED_FILES: ReadonlySet<string> = new Set([
  // FR-R3-054 — comment-only. Explains that a signalled process tree may leave
  // descendants "still running"; it does not compare a status literal. Added
  // rather than reworded: this gate's allowlist exists for exactly this case and
  // carries sixteen such precedents, and writing a worse comment to satisfy a text
  // match is the wrong trade.
  //
  // `src/runner/process-lifecycle-runner.ts` was struck 2026-08-25 (FR-R3-083):
  // extracting the escalation ladder into `process-tree.ts` took the phrase with
  // it, and `allowlist-entries-still-apply.test.ts` caught the entry excusing
  // something that file no longer does. Recorded rather than deleted silently —
  // the allowlist is expected to shrink, and which line went is how that stays
  // checkable.
  'src/runner/process-tree.ts',
  'src/commands/cancel.ts',
  'src/commands/auto.ts',
  // Feature 063 — references `controller.running` (a WorkflowController
  // property accessor used by the Clean All probe loop), not the pinned
  // status discriminator literal "running".
  'src/commands/clear-all.ts',
  // Feature FR-R3-006 — operator-facing confirmation and refusal copy ("Any
  // running phase is cancelled first", "a phase is still running"), plus one
  // comment. Same reason `webview-ui/src/lib/action-copy.ts` is here, and this
  // is that entry's host-side twin: the word appears in a sentence an operator
  // reads, never as the pinned per-task status discriminator, which this file
  // neither reads nor writes.
  'src/commands/reset.ts',
  // Feature FR-R3-006 — reads `controller.running`, the boolean accessor that
  // reports whether any driver is mid-drive, to bound the reset's quiesce wait.
  // Same reason `src/commands/clear-all.ts` and
  // `src/services/auto-drain-coordinator.ts` are here: a property name that
  // shares the substring, never the status literal.
  'src/commands/reset-wiring.ts',
  // Feature 065 — comment-only references to `queueLifecycle === 'running'`
  // describing the lifecycle target after a coerce / convert-to-now path.
  'src/commands/retry-active-run.ts',
  'src/commands/schedule.ts',
  // Feature 065 — checks `result.lifecycleAfter === 'running'` after the
  // GuardedRunService applies a convert-to-now startIntent.
  'src/commands/start-queue.ts',
  'src/contracts/audit-events.ts',
  'src/contracts/backend-runner.ts',
  'src/contracts/generated/boundary-contracts.ts',
  'src/contracts/generated/schemas/state.schema.json',
  // Operator-command extraction — reads `driver.running`, the boolean accessor
  // that reports whether this queue's session is mid-drive, to refuse a manual
  // retry that is already under way. Same reason `src/controller/run-session.ts`
  // and `src/commands/clear-all.ts` are here: a property name that shares the
  // substring, never the pinned per-task status discriminator. Moved verbatim
  // out of `src/controller/workflow-controller.ts`, which is already listed.
  'src/controller/manual-retry-override.ts',
  // P4 extraction — owns phase mutation policy and therefore transitions a
  // resumed/restarted phase back to the canonical running workflow status.
  'src/controller/phase-control-service.ts',
  // Feature 093 — the per-queue driving context. Reads `driver.running`, the
  // boolean accessor that reports whether a session is mid-drive, in the one
  // place that decides whether a session may be disposed. Same reason
  // `src/services/auto-drain-coordinator.ts` and `src/commands/clear-all.ts`
  // are here: a property name that shares the substring, never the pinned
  // per-task status discriminator. The terminal statuses this module *does*
  // compare against come from `isTerminalRunStatus`, so it names none of them.
  'src/controller/run-session.ts',
  // Operator-command extraction — this one IS the pinned per-task status
  // discriminator: `run.status === 'running'` guards whether deleting a Task
  // must cancel the Run that owns it. It is a read, never a write, and it moved
  // verbatim out of `src/controller/workflow-controller.ts`, which is already
  // listed for the same comparison. Recorded as a distinct entry from
  // `manual-retry-override.ts` above because the two are here for different
  // reasons and a single shared comment would misdescribe one of them.
  'src/controller/task-deletion.ts',
  'src/controller/workflow-controller.ts',
  // `src/extension.ts` was struck 2026-08-28 (FR-R3-136): the composition root
  // held two occurrences and this feature moved both out. The resume sweep's
  // `run.status === 'running'` filter went to `stage2-producers.ts` (listed
  // below), and extracting `wireTrustGrant` into `trust-grant-wiring.ts` took the
  // last one — a log line, since reworded there. Recorded rather than deleted
  // silently, same as the `process-lifecycle-runner.ts` strike above: the file
  // has no occurrence left, so an entry for it would have been the exemption
  // outliving its reason that the staleness check below exists to catch.
  // FR-R3-119 — the audit writer and its quarantine drain moved to `src/activation/evidence-wiring.ts`.
  'src/activation/evidence-wiring.ts',
  // FR-R3-119 — the clock-driven work moved to `src/activation/scheduled-work-wiring.ts`.
  'src/activation/scheduled-work-wiring.ts',
  // FR-R3-136 — the persisted-run resume sweep moved out of `src/extension.ts`
  // (struck above) into `src/activation/stage2-producers.ts`, taking the
  // `run.status === 'running'` filter with it. Listed for exactly the reason
  // `extension.ts` used to be: the filter belongs on THIS side of the boundary
  // because `services/resume-decision.ts` must not know the status vocabulary,
  // and the comment beside the call says so.
  'src/activation/stage2-producers.ts',
  'src/monitor/claude-cli-monitor.ts',
  'src/monitor/monitor-state.ts',
  'src/queue/queue-manager.ts',
  // Feature 065 — `QueueLifecycle = 'running' | ...` union (FR-001..FR-005).
  // The literal is the lifecycle discriminator, not the pinned task-status
  // projection, and is required by the lifecycle entity.
  'src/queue/feature-request.ts',
  // Comment-only occurrence ("A long-running" in a doc comment); no status
  // literal.
  'src/runner/claude-cli.ts',
  'src/services/guarded-run-service.ts',
  'src/services/run-driver.ts',
  // Feature 075 owns an independent ephemeral BackendPingState discriminator.
  'src/services/backend-ping-service.ts',
  // Feature 065 — coordinator owns the in-process scheduled-start timer and
  // emits 'already-running' as a superseder literal in the audit payload.
  'src/services/scheduled-start-coordinator.ts',
  // Feature 092 — drain step 4b reads `controller.running`, the boolean
  // accessor on `WorkflowController` that reports whether the single shared
  // `RunDriver` is mid-flight. Same reason `src/commands/clear-all.ts` and
  // `src/services/guarded-run-service.ts` are here: a property name that
  // happens to share the substring, never the pinned per-task status
  // discriminator, which this file neither reads nor writes.
  'src/services/auto-drain-coordinator.ts',
  // Feature 065 — v6→v7 derivation table maps (inFlight, paused, pending)
  // tuples to a `queueLifecycle` value; `'running'` appears as a target.
  'src/state/queue-state-migrator.ts',
  // Feature 065 — host activation path reads `queueLifecycle` and re-arms.
  'src/state/workspace-state.ts',
  'src/state/workflow-run.ts',
  'src/state/workflow-run-migrator.ts',
  // Feature 093 — the v10 → v11 run-record reshape. `RUN_STATUSES` enumerates
  // the `WorkflowRunStatus` union so `isWorkflowRun` can tell a persisted Run
  // from an unreadable record, which is the same pinned status projection
  // `src/state/workflow-run-migrator.ts` above is here for; a migrator that
  // could not name the statuses could not recognise the shape it migrates.
  'src/state/run-state-migrator.ts',
  'src/telemetry/platform/platform-ps.ts',
  'src/telemetry/platform/platform-windows.ts',
  'src/ui/sidebar/phase-projector.ts',
  'src/ui/sidebar/run-projector.ts',
  // FR-R3-132 (T1502) — the status unions moved from `src/ui/sidebar/snapshot.ts`
  // to `src/contracts/snapshot-projections.ts` so the webview could import them
  // rather than restate them. The literals travelled with the declarations; the
  // entry moved with them rather than being added beside a stale one.
  'src/contracts/snapshot-projections.ts',
  // FR-R3-132 (T1502) — the second and third waves: `QueueLifecycle`,
  // `TelemetryStatus` and their neighbours moved here from seven host modules so
  // the webview could import them rather than restate them. Their literals came
  // with them.
  'src/contracts/snapshot-vocabulary.ts',
  'src/ui/sidebar/projector-bookkeeping.ts',
  'src/ui/status-bar.ts',
  // Feature 065 — comment-only references to the `running` queue lifecycle
  // describing the chooser dispatch rules. No pinned status literal.
  'webview-ui/src/components/QueueInputForm.svelte',
  'webview-ui/src/components/StatusBar.svelte',
  // Feature 103 — one CSS selector, `.status-running .status-badge`, one of the
  // six that colour a row's status badge from the `status-{row.status}` class
  // the row already carries. Character-identical in kind to the
  // `.status-running .dot` rule `StatusBar.svelte` above is listed for, and
  // reached for the same reason: FR-003 folds runs that are still going into
  // history, so a history row now renders the live statuses as well as the
  // terminal ones. That comparison used to name three entries; FR-R3-140
  // deleted two of them, `MonitorPill.svelte` and `StatusHeader.svelte`, along
  // with `ControlPanel.svelte` from the line above. No TypeScript in this file
  // names the literal — the status reaches it as data, and the outcome filter
  // that does name it lives in `webview-ui/src/lib/format.ts`, with the rest of
  // the status vocabulary.
  'webview-ui/src/components/HistoryRunRow.svelte',
  'webview-ui/src/lib/format.ts',
  // Feature 063 — UI copy strings ("currently running and will be
  // terminated.", "abort the running task") and template variable name
  // (`runningSuffix`). No pinned status discriminator literal.
  'webview-ui/src/lib/action-copy.ts',
  'webview-ui/src/lib/snapshot-types.ts',
  // Metrics wire entities own the in-flight `isRunning` projection field.
  'src/contracts/sidebar-ipc/metrics.ts',
  'webview-ui/src/components/MetricsDashboard/MetricsTaskTable.svelte',
  'webview-ui/src/components/settings/BackendHealthSection.svelte',
  'src/metrics/metrics-service.ts',
  'src/services/workflow-run-factory.ts',
  // Feature 092 — the webview's label map for `QueueLifecycle`, whose own
  // discriminator legitimately has a `running` member. That is the deliberately
  // narrow queue-lifecycle surface governed by
  // `queue-lifecycle-literal-allowlist.test.ts`, not the pinned per-task status
  // projection this guard protects; the two are distinct vocabularies and this
  // file touches only the former.
  'webview-ui/src/lib/queue-lifecycle-label.ts'
]);

function filesWithRunningLiteral(): readonly string[] {
  let out = '';
  for (const root of SCAN_ROOTS) {
    try {
      out += filesMatching(root, "running", { skipDirectories: ['__tests__'] }).join('\n') + '\n';
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string };
      if (e.status === 1 && (!e.stdout || e.stdout.trim() === '')) continue;
      throw err;
    }
  }
  return Array.from(
    new Set(
      out
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((abs) => (abs.startsWith(REPO_ROOT + '/') ? abs.slice(REPO_ROOT.length + 1) : abs))
    )
  ).sort();
}

describe('Feature 017 — no stray running state literal', () => {
  it('keeps running literals confined to workflow/monitor state files', () => {
    const offenders = filesWithRunningLiteral().filter((rel) => !ALLOWED_FILES.has(rel));
    expect(offenders, `Unexpected running literals:\n${offenders.join('\n')}`).toEqual([]);
  });

  // Vacuity control. The assertion above subtracts the allowlist from the scan
  // and expects nothing left — which is what an empty scan produces too. Two
  // scan roots feed it, and either going missing is silently tolerated by the
  // `status === 1` arm above.
  //
  // Every allowlisted file is an anchor: each is listed because it DOES contain
  // the literal, so each must be found. That makes this a staleness check in the
  // same motion — an entry that stops matching is an exemption outliving its
  // reason.
  it('finds every allowlisted file, so a broken scan cannot read as a clean tree', () => {
    const matched = filesWithRunningLiteral();
    expect(
      matched.length,
      'Neither scan root yielded a file containing the literal. The assertion above ' +
        'is passing over an empty set.'
    ).toBeGreaterThan(0);
    for (const allowed of ALLOWED_FILES) {
      expect(
        matched,
        `${allowed} is allowlisted for containing the "running" literal but the scan ` +
          `did not find it. Either the literal is gone — remove the stale entry — or ` +
          `the scan no longer reaches that root.`
      ).toContain(allowed);
    }
  });
});
