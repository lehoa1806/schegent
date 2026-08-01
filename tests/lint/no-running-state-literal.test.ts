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
  // P4 extraction — owns phase mutation policy and therefore transitions a
  // resumed/restarted phase back to the canonical running workflow status.
  'src/controller/phase-control-service.ts',
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
  // Feature 065 — coordinator owns the in-process scheduled-start timer and
  // emits 'already-running' as a superseder literal in the audit payload.
  'src/services/scheduled-start-coordinator.ts',
  // Feature 065 — v6→v7 derivation table maps (inFlight, paused, pending)
  // tuples to a `queueLifecycle` value; `'running'` appears as a target.
  'src/state/queue-state-migrator.ts',
  // Feature 065 — host activation path reads `queueLifecycle` and re-arms.
  'src/state/workspace-state.ts',
  'src/state/workflow-run.ts',
  'src/state/workflow-run-migrator.ts',
  'src/telemetry/platform/platform-ps.ts',
  'src/telemetry/platform/platform-windows.ts',
  'src/ui/sidebar/phase-projector.ts',
  'src/ui/sidebar/run-projector.ts',
  'src/ui/sidebar/snapshot.ts',
  'src/ui/sidebar/state-projector.ts',
  'src/ui/status-bar.ts',
  'webview-ui/src/components/ControlPanel.svelte',
  // Feature 065 — switches on the `QueueLifecycle` discriminator
  // (FR-001..FR-005) to render the lifecycle label and dot color. The
  // literal is the lifecycle union member, not the pinned task-status
  // projection.
  'webview-ui/src/components/QueueListView.svelte',
  // Feature 065 — comment-only references to the `running` queue lifecycle
  // describing the chooser dispatch rules. No pinned status literal.
  'webview-ui/src/components/QueueInputForm.svelte',
  'webview-ui/src/components/MonitorPill.svelte',
  'webview-ui/src/components/StatusBar.svelte',
  'webview-ui/src/components/StatusHeader.svelte',
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
  'src/metrics/metrics-service.ts'
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
