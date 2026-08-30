# Configure Schegent

Schegent exposes its operator configuration under the `schegent.*` namespace. Use VS Code's Settings editor for discoverability, or edit the user, workspace, or workspace-folder settings JSON directly when you need a reviewable configuration change. The contribution manifest is the public authority for each setting's type, default, range, enum, and VS Code scope. <!-- Source: package.json -->

For an exhaustive key-by-key table, use `docs/reference/settings.md`. This runbook concentrates on how changes are accepted and when they take effect. <!-- Source: src/config/settings-schema.ts -->

## Choose the right scope

The manifest declares each setting as `application`, `window`, or `resource`. Application settings apply across workspaces, window settings belong to a VS Code window, and resource settings may vary by workspace or workspace folder. VS Code resolves the effective value; Schegent reads that resolved configuration through `vscode.workspace.getConfiguration('schegent')`. <!-- Source: package.json --> <!-- Source: src/extension.ts -->

Prefer workspace scope for behavior that collaborators need to share, such as queue limits, retry policy, logging retention, and the default Pipeline. Keep executable paths and the backend environment policy at user/application scope unless every machine has the same installation. The scopes in the manifest—not this recommendation—are enforced. <!-- Source: package.json -->

## Use the General Settings surface

The sidebar's General Settings command accepts only the keys in the host's `KEY_SPECS` allowlist. A save batch is validated in full before any write occurs, and each accepted value goes to the layer its manifest scope requires: `configurationTargetFor` sends an `application`-scoped key to `vscode.ConfigurationTarget.Global`, because such a key has no workspace layer for VS Code to write, and every `window`- or `resource`-scoped key to `vscode.ConfigurationTarget.Workspace`. This supersedes the original Workspace-only rule, which stopped being true at `FR-R3-051`/M-05. If a later write in the batch fails, earlier writes from that batch are restored to the value captured at each key's own target, not to a workspace value in every case. <!-- Source: src/config/general-settings.ts -->

That surface intentionally covers a subset of the full configuration schema. Backend selection, model groups, and document trust settings use their own host paths or the native VS Code Settings surface; the tab shows the resolved trust decision but cannot write it, and offers a control that opens the native Settings editor instead. The process-environment policy is no longer in that list: `FR-R3-143` moved `cli.inheritEnvironment`, `cli.environmentMode`, and `cli.environmentAllowlist` onto the General Settings IPC surface, alongside `backend.probeTimeoutSeconds`, `ui.confirmations.enable`, and `multiRoot.suppressWarning`. A key existing in `package.json` does not by itself make it writable through the General Settings IPC command. <!-- Source: src/config/settings-schema.ts --> <!-- Source: src/config/general-settings.ts -->

## Know when a reload is required

Backend selection and the CLI environment policy are captured during extension activation. After changing `schegent.backend.runner`, `schegent.cli.inheritEnvironment`, `schegent.cli.environmentMode`, or `schegent.cli.environmentAllowlist`, run **Developer: Reload Window** before starting work that must use the new value. <!-- Source: src/extension.ts -->

The three executable-path settings are read through configuration-backed path resolvers, so subsequent capability probes and invocations see their current values. Runtime log settings are also resolved by the logging sink when it emits, and the watchdog updates its timer when its poll interval changes. <!-- Source: src/activation/backend-wiring.ts --> <!-- Source: src/lib/runtime-log/runtime-log-sink.ts --> <!-- Source: src/watchdog/credit-watchdog.ts -->

Changing session-retention limits requests a new retention sweep. Changing `schegent.defaultPipelineId` or `schegent.models` refreshes the in-memory catalog projection used by the extension. <!-- Source: src/extension.ts -->

## Validate a configuration change

Run the settings-schema parity test after adding or changing a setting. It requires the contribution manifest and the typed host schema to agree on keys and value constraints; settings exposed through General Settings also require a matching allowlist entry and validator. <!-- Source: tests/unit/config/settings-schema-parity.test.ts --> <!-- Source: src/config/settings-schema.ts --> <!-- Source: src/config/general-settings.ts -->

```bash
npx vitest run tests/unit/config/settings-schema-parity.test.ts
```

Schegent does not load a project `.env` file as an extension configuration source. Backend child-process environment forwarding is instead controlled by the `schegent.cli.*` environment-policy settings. <!-- Source: src/extension.ts --> <!-- Source: src/runner/spawn-env.ts -->
