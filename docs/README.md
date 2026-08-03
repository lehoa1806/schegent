<p align="center">
  <img src="../assets/banner.png" alt="Schegent Banner" />
</p>

# Schegent — Operator Manual

**Schegent** is a VS Code extension that runs the Claude Code CLI as a headless backend to autonomously drive the Spec Driven Development workflow. You enqueue feature work in the sidebar, walk away, and come back to either a finished feature or a paused run waiting for your decision.

This manual is the operator's reference. It explains every setting, command, audit event, and feature in detail and shows you how to apply them to real workflows.

> If you only have ten minutes, start with [Getting Started → Installation](getting-started/installation.md) and then [Getting Started → Your First Pipeline](getting-started/first-pipeline.md). Come back here when you want depth.

## How to use this manual

The pages are organized by *what you are trying to do*, not by the order the extension was built.

- If you have never used Schegent before → **Getting Started**.
- If you want to understand what a "run", a "phase", or "the queue" actually is → **Concepts**.
- If you want to look up a setting, a command, or an audit event → **Reference**.
- If you want to use a specific feature (wake-up, breakpoints, custom phases, etc.) → **Features**.
- If a pipeline is misbehaving and you need to intervene → **Operations**.
- If you are deciding whether to run Schegent in a sensitive environment → **Security**.

## Getting Started

- [Quickstart & Dashboard Walkthrough](getting-started/quickstart.md) — a visual guide to the dashboard, phases, and pipelines.
- [Installation](getting-started/installation.md) — install the extension, install the Claude CLI, link your account.
- [Your First Pipeline](getting-started/first-pipeline.md) — enqueue a feature, watch a run from start to finish.
- [Sidebar Tour](getting-started/sidebar-tour.md) — every panel in the Schegent sidebar, what it shows, and what you can click.

## Concepts

The conceptual model you need to use Schegent effectively. None of these pages contain source code — they explain the rules of the system.

- [Architecture Overview](concepts/architecture-overview.md) — extension host, CLI subprocess, webviews, trust boundaries.
- [Local-first, Not Offline](concepts/local-first-not-offline.md) — what stays local, what provider connectivity is still required, and the queue-only degraded-mode boundary.
- [Pipelines & Phases](concepts/pipeline-and-phases.md) — the Spec Driven Development workflow pipeline, the built-in phases, and how phase overrides work.
- [The Queue, Tasks, and Runs](concepts/queue-and-runs.md) — how work is ordered, what an in-flight task is, and the difference between a task and a run.
- [The Workspace Lock](concepts/workspace-lock.md) — why only one run executes at a time, how pause/resume preserves the lock, and what to do when it gets stuck. Includes the [multi-root workspace semantics](concepts/workspace-lock.md#multi-root-workspaces): the first folder is canonical, `schegent.multiRoot.suppressWarning` silences the activation toast, and the `multi-root.warning-shown` audit event records the chosen folder.
- [Sessions, Logs, and Audit Evidence](concepts/sessions-and-logs.md) — what gets written to disk for each run, where it lives, and what is sanitized.

## Features

Each page follows the same structure: what it does, why you'd use it, how it works conceptually, every parameter, two or three real examples, edge cases, and troubleshooting.

### Core orchestration

- [Phase Log Feed](features/phase-log-feed.md) — the live activity feed beneath each phase, with tool-call and message rendering.
- [Phase Breakpoints](features/phase-breakpoints.md) — pause a run before a specific phase so you can review and intervene.
- [Custom Phases](features/custom-phases.md) — add your own pipeline phases via `schegent.phases` and run them through the same audit path as the built-ins.
- [Phase Overrides](features/phase-overrides.md) — change the model, effort, timeout, or loopability of any phase without forking the pipeline.
- [Phase YAML Exchange](features/phase-yaml-exchange.md) — export a phase to a portable YAML document, and inspect an imported one before it touches your catalog.

### Reliability and recovery

- [Context-Preserving Retries](features/context-preserving-retries.md) — retry a phase with `--continue` so Claude resumes the prior context instead of starting fresh.
- [Aggressive Pause](features/aggressive-pause.md) — what happens when you pause a run mid-phase: the subprocess is killed *after* state is updated.
- [Rate-Limit Handling](features/rate-limit-handling.md) — how Schegent parses Anthropic's reset hints and schedules dynamic retries instead of fixed backoffs.
- [Fatal Signatures](features/fatal-signatures.md) — the code-resident "stop the run" patterns plus your operator-additive extensions.

### Observability

- [Verbose Diagnostics](features/verbose-diagnostics.md) — opt-in unredacted per-phase debug/stream/log files for deep troubleshooting.
- [Telemetry Projection](features/telemetry-projection.md) — the ephemeral PID and status display while a phase is in-flight.
- [Runtime Logging](features/runtime-logging.md) — the file sink that mirrors the sanitized Output channel for tail and grep.

### Productivity

- [Wake-up Scheduler](features/wake-up-scheduler.md) — keep your Claude 5-hour rolling allocation warm so unattended pipelines never pay the cold-start cost.
- [Auto-Compact Override](features/auto-compact-override.md) — control when Claude compacts its context window, per workspace.

## Reference

Authoritative lookup tables, derived from the running extension's contributions and source-of-truth contracts.

- [Glossary](reference/glossary.md) — the composition, catalog, and run vocabularies, including which of the two senses of "Workflow" is meant where.
- [Settings](reference/settings.md) — every `schegent.*` configuration key, with type, default, scope, and validation rules.
- [Commands](reference/commands.md) — every command contributed to the VS Code command palette, plus the internal ones routed only from the sidebar.
- [Audit Events](reference/audit-events.md) — every structured event written to `.schegent/audit.log`, with payload schema and trigger.
- [File Layout](reference/file-layout.md) — what lives under `.schegent/` in your workspace and `<globalStorage>/` in your VS Code profile.

## Operations

Day-2 playbooks for monitoring active work and intervening when something is wrong.

- [Monitoring a Run](operations/monitoring.md) — sidebar, status bar, dashboard, and the verbose-diagnostics sink — when to look at which.
- [Execution Evidence Health](operations/evidence-health.md) — unified audit/raw/runtime health, fail-closed rules, and the recovery playbook.
- [Intervention Playbook](operations/intervention.md) — pause, resume, retry-now, skip-phase, cancel, and what each action actually does to the in-flight state.
- [Troubleshooting](operations/troubleshooting.md) — symptoms, causes, and concrete fixes for the most common operator-facing failure modes.
- [Trust Scopes](operations/trust-scopes.md) — per-capability trust scopes that narrow Workspace Trust for custom phases, retry-conditions, and pipeline overrides.

## Security

Schegent runs the Claude CLI with broad workspace capabilities. Before deploying it against sensitive code, read these two pages.

- [Operator Threat Model](security/threat-model.md) — what we defend against, what we explicitly do not, and which knobs you control.
- [Security White-Paper](security/whitepaper.md) — operator-facing trust ceiling, audit boundary, and failure-mode summary; designed for a 45-minute read by an enterprise reviewer or operator deciding whether to deploy Schegent.

## Architecture decisions

- [Remote, Multi-user, and Parallel Execution Expansion Gate](architecture/remote-multi-user-expansion-gate.md) — mandatory identity, isolation, scheduler, locking, secrets, evidence, injection, and rollback criteria before any non-local expansion.

## Versioning and updates

This manual is versioned alongside the extension. Each major user-visible change ships with an update to the matching page (settings, commands, and audit events drift checks are enforced in CI). If you find a discrepancy between this manual and the running extension, the running extension is authoritative — please open an issue.

## Conventions used in this manual

- Settings are written as their full key: `schegent.wakeUp.enabled`.
- Commands are written with their VS Code command palette title in **bold** and the raw command id in `code`.
- File paths are written relative to either the **workspace root** (your project) or **`<globalStorage>`** (per-VS-Code-profile).
- "Webview" means the Svelte UI that renders inside the VS Code sidebar or dashboard. "Host" means the extension's main process. "Runner" means the spawned Claude CLI subprocess.
- "Operator" means you — the person using the extension.

## Acknowledgements & Prerequisites

A special thanks to the [GitHub Spec-Kit](https://github.com/github/spec-kit) team and the [Superpowers](https://github.com/superpowers) team for their phenomenal work. Schegent's default pipeline is heavily inspired by and relies on these platforms. 

**Note on pipelines:** To use the *default pipeline* out-of-the-box, we strongly suggest installing the Spec-Kit and Superpowers plugins/platforms. If you choose to define your own custom pipeline, you must ensure that you have installed the specific skills, platforms, and tools required by your custom phases.
