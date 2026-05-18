# Schegent Execution Repository

This directory contains the VS Code extension implementation for Schegent.
The workspace root is the planning envelope; run build and verification
commands from this `repo/` directory.

## Quick Start

```bash
npm ci
npm run build
```

The extension activates in VS Code workspaces that contain `.specify/`.
Source code lives under `src/`; the Svelte webview app lives under
`webview-ui/`.

## Verification

```bash
npm run typecheck          # tsc --noEmit on the host
npm run typecheck:webview  # tsc --noEmit on the Svelte app
npm run lint               # eslint --ext .ts src tests
npm run test               # vitest run + webview-ui test
npm run build              # esbuild host + Vite webview
npm run test:e2e           # deterministic host E2E tests
npm run test:integration   # @vscode/test-electron host smoke tests
npm run ci                 # full local pre-merge gate
```

Run `npm run ci` before opening a PR. For release readiness and scheduled
gates, see [RELEASE.md](RELEASE.md).

## Command Reference

| Command | Palette Title | Purpose |
|---|---|---|
| `schegent.auto` | Schegent: Run Autonomous Workflow | Start an autonomous Speckit workflow. |
| `schegent.schedule` | Schegent: Enqueue Feature Request | Add a feature request to the queue. |
| `schegent.resume` | Schegent: Resume Paused or Failed Workflow | Resume the current paused or failed run. |
| `schegent.cancel` | Schegent: Cancel In-Flight Workflow | Cancel the active workflow run. |
| `schegent.reset` | Schegent: Reset Workspace State | Clear persisted Schegent workspace state. |
| `schegent.showAuditLog` | Schegent: Show Audit Log | Open the structured audit log. |
| `schegent.pauseQueue` | Schegent: Pause Queue | Pause queue draining. |
| `schegent.resumeQueue` | Schegent: Resume Queue | Resume queue draining. |
| `schegent.retryQueuedItem` | Schegent: Retry Queued Item | Retry a failed or paused queue item. |
| `schegent.moveQueuedItemUp` | Schegent: Move Queued Item Up | Move a queued item earlier. |
| `schegent.moveQueuedItemDown` | Schegent: Move Queued Item Down | Move a queued item later. |
| `schegent.clearCompleted` | Schegent: Clear Completed Queue Items | Remove completed items from the queue view. |
| `schegent.clearFailed` | Schegent: Clear Failed Queue Items | Remove failed items from the queue view. |
| `schegent.rerunFromHistory` | Schegent: Rerun From History | Re-enqueue a historical run. |
| `schegent.showActiveRun` | Schegent: Show Active Run | Focus the active run in the UI. |
| `schegent.openDashboard` | Schegent: Open Dashboard | Open the full dashboard webview. |
| `schegent.retryActiveRun` | Schegent: Retry Active Run | Retry the active run immediately. |
