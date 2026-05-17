# Installation

Getting Schegent ready to run takes three pieces: the extension, the Claude CLI, and a workspace that Schegent can write to. This guide walks you through each.

## What you need

- **VS Code 1.85 or later.** Schegent uses webview features added in that release.
- **The Claude Code CLI installed and authenticated.** Schegent does not bundle the CLI; it spawns the binary you have already authorized to your Anthropic account.
- **A workspace folder open in VS Code.** Schegent does not operate on individual files. It needs a workspace root to write `.schegent/` artefacts and (for the Speckit pipeline) the `specs/` and `docs/` directories.

If you have the CLI installed already and a workspace open, you can skip to [Install the extension](#step-1-install-the-extension).

## Step 0: Install the Claude Code CLI

Follow Anthropic's instructions to install the `claude` binary for your platform. Once installed, verify it works from a fresh terminal:

```bash
which claude
claude --version
claude --help | head -5
```

Then authenticate the CLI to your account:

```bash
claude login
```

Confirm the CLI can complete a simple prompt:

```bash
echo "Reply with the word ACK." | claude --prompt-stdin
```

If you do not get a one-word answer back, Schegent will not be able to drive the CLI. Fix the CLI authentication first.

## Step 1: Install the extension

You have two options:

### From the VS Code marketplace

Open the Extensions view in VS Code (`Ctrl+Shift+X` / `Cmd+Shift+X`), search for **Schegent**, and click **Install**. After the install completes, look for the Schegent icon in the activity bar on the left.

### From a `.vsix` file (offline / pre-release builds)

```bash
code --install-extension schegent-<version>.vsix
```

Reload the window when prompted.

## Step 2: Open a workspace

Schegent requires an open workspace folder. Either:

- `File > Open Folder…` and pick the project you want Schegent to drive, or
- `File > Open Workspace from File…` for multi-root workspaces.

The first time you open a workspace, Schegent prompts you to grant **workspace trust**. Trust is required because Schegent runs the Claude CLI with broad permissions inside the workspace. If you decline, the extension stays inert.

## Step 3: Confirm the CLI path

Schegent looks for the Claude CLI at the path you configure in `schegent.cli.path`. The default is `claude` — which works if the binary is on your shell's `PATH`. If your CLI lives somewhere else (e.g., `/opt/anthropic/bin/claude`), set the path explicitly in your user `settings.json`:

```jsonc
{
  "schegent.cli.path": "/opt/anthropic/bin/claude"
}
```

This setting has `application` scope — it applies across every workspace, but you can override it per workspace if you have different CLI installs for different projects.

### Verifying the wiring

Open the **Schegent** sidebar (the icon in the activity bar). The header will tell you whether the CLI is detected:

- **CLI ready** — green check. You are done.
- **CLI not found** — red warning. Either the path is wrong, the binary is missing, or VS Code's `PATH` does not include the binary's directory. Open a fresh terminal in VS Code (`` Ctrl+` ``) and run `which claude` to see what VS Code's environment sees.
- **CLI unauthenticated** — yellow warning. Re-run `claude login` in a fresh terminal.

## Step 4: (Optional) Pick a backend

Schegent supports two CLI backends: `claude` (the default) and `codex`. Almost every operator uses `claude`. If you have explicit reason to drive a different CLI, set:

```jsonc
{
  "schegent.backend.runner": "codex"
}
```

The backend setting is `application`-scoped. You can override it per workspace. The `codex` backend follows the same contract: argv composition, prompt delivery, stdout parsing, and audit pipeline are all driven by the same host code. The page on [the second backend runner](https://github.com/your-org/schegent/blob/main/docs/operations/backends.md) covers the contract in detail.

## Step 5: (Optional) Configure phase models

Out of the box, Schegent uses sensible defaults for the model and effort of each phase. If you want to tune them — for example, run `speckit-implement` with Opus and high effort, but keep `speckit-clarify` on Sonnet — set `schegent.phases` in your user `settings.json`:

```jsonc
{
  "schegent.phases": [
    {
      "id": "speckit-implement",
      "name": "Spec-kit Implement",
      "instruction": "",
      "model": "claude-opus-4-7",
      "effort": "high"
    }
  ]
}
```

A custom phase whose `id` matches a built-in **shadows** the built-in. Empty or omitted fields fall back to the built-in defaults. The `instruction` field is required by the JSON schema, but an empty string is accepted when shadowing a built-in (the built-in's instruction is preserved).

For the full set of phase fields and the override precedence, see [Phase Overrides](../features/phase-overrides.md).

## Step 6: (Optional) Workspace `.gitignore`

Schegent writes its evidence under `<workspaceRoot>/.schegent/`. The directory contains the audit log, raw transcripts, optional verbose diagnostics, and the runtime log. None of it belongs in version control. Add to your workspace `.gitignore`:

```text
# Schegent runtime sidecar — local-only, append-only evidence
.schegent/
```

Schegent ships a default `.gitignore` inside the `.schegent/` directory itself as a defense in depth, but a workspace-level entry makes the intent explicit and survives reset.

## You are ready

If the sidebar header shows **CLI ready** and you can see the queue panel beneath it, you are ready to enqueue your first feature. Continue to [Your First Pipeline](first-pipeline.md).

If anything went wrong, the sidebar header is your primary diagnostic. Common installation-time troubleshooting:

- **The sidebar is empty after installing.** Make sure you opened a workspace folder *and* granted workspace trust. Schegent is intentionally inert in untrusted contexts.
- **The CLI works in a terminal but the sidebar says it is not found.** VS Code's environment is not always identical to your interactive shell. Run `claude --version` from VS Code's integrated terminal; if that fails, your shell's PATH-setup file (`.zshrc`, `.bashrc`) does not run in login mode and you need to set `schegent.cli.path` explicitly.
- **The CLI exits non-zero on every invocation.** Confirm `claude login` worked. Try a one-shot prompt from the integrated terminal. The audit log will tell you the CLI's exit code; the raw transcript will show its stderr.

For a full troubleshooting reference, see [Troubleshooting](../operations/troubleshooting.md).
