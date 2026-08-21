import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOTS = [
  resolve(REPO_ROOT, 'src'),
  resolve(REPO_ROOT, 'webview-ui', 'src')
] as const;

const ALLOWED_FILES: ReadonlySet<string> = new Set([
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
  'src/extension.ts',
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
  'src/ui/sidebar/snapshot.ts',
  'src/ui/sidebar/state-projector.ts',
  'src/ui/sidebar/state-projector-runtime.ts',
  'src/ui/sidebar/projector-bookkeeping.ts',
  'src/ui/status-bar.ts',
  'webview-ui/src/components/ControlPanel.svelte',
  // Feature 065 — comment-only references to the `running` queue lifecycle
  // describing the chooser dispatch rules. No pinned status literal.
  'webview-ui/src/components/QueueInputForm.svelte',
  'webview-ui/src/components/MonitorPill.svelte',
  'webview-ui/src/components/StatusBar.svelte',
  'webview-ui/src/components/StatusHeader.svelte',
  // Feature 103 — one CSS selector, `.status-running .status-badge`, one of the
  // six that colour a row's status badge from the `status-{row.status}` class
  // the row already carries. Character-identical in kind to the
  // `.status-running .dot` rules the three entries above are listed for, and
  // reached for the same reason: FR-003 folds runs that are still going into
  // history, so a history row now renders the live statuses as well as the
  // terminal ones. No TypeScript in this file names the literal — the status
  // reaches it as data, and the outcome filter that does name it lives in
  // `webview-ui/src/lib/format.ts`, with the rest of the status vocabulary.
  'webview-ui/src/components/HistoryRunRow.svelte',
  'webview-ui/src/lib/format.ts',
  // Feature 063 — UI copy strings ("currently running and will be
  // terminated.", "abort the running task") and template variable name
  // (`runningSuffix`). No pinned status discriminator literal.
  'webview-ui/src/lib/action-copy.ts',
  'webview-ui/src/lib/snapshot-types.ts',
  'src/contracts/sidebar-ipc.ts',
  // Metrics wire entities own the in-flight `isRunning` projection field.
  'src/contracts/sidebar-ipc/metrics.ts',
  'webview-ui/src/components/MetricsDashboard/MetricsDashboard.svelte',
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
      out += execSync(`grep -rEl --exclude-dir=__tests__ "running" "${root}"`, {
        encoding: 'utf8'
      });
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
});
