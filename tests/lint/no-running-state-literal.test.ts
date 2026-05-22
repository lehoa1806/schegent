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
  'src/contracts/backend-runner.ts',
  'src/controller/workflow-controller.ts',
  'src/extension.ts',
  'src/monitor/claude-cli-monitor.ts',
  'src/monitor/monitor-state.ts',
  'src/queue/queue-manager.ts',
  // Comment-only occurrence ("A long-running" in a doc comment); no status
  // literal.
  'src/runner/claude-cli.ts',
  'src/services/guarded-run-service.ts',
  'src/services/run-driver.ts',
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
  'webview-ui/src/components/MonitorPill.svelte',
  'webview-ui/src/components/StatusBar.svelte',
  'webview-ui/src/components/StatusHeader.svelte',
  'webview-ui/src/lib/format.ts',
  // Feature 063 — UI copy strings ("currently running and will be
  // terminated.", "abort the running task") and template variable name
  // (`runningSuffix`). No pinned status discriminator literal.
  'webview-ui/src/lib/action-copy.ts',
  'webview-ui/src/lib/snapshot-types.ts'
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
