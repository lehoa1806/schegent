# System configuration

Schegent has no `.env`, `.env.example`, dotenv loader, Docker Compose environment block, or repository-local environment-file convention. Product configuration is contributed as VS Code settings under the `schegent.*` namespace; environment variables are used only at process boundaries and by build or test harnesses. Do not put secrets in a repository `.env` file. To forward a host credential such as `ANTHROPIC_API_KEY`, add its **name** to `schegent.cli.environmentAllowlist` or deliberately select the less-restrictive `inherit` mode in VS Code Settings.

<!-- Source: package.json -->
<!-- Source: .gitignore -->
<!-- Source: src/config/settings-schema.ts -->

## Backend process environment

The default policy is `allowlist` with an empty operator list. It copies the bootstrap variables below when they exist in the VS Code extension host, copies every `LC_*` variable, then overlays Schegent-controlled variables. It does not synthesize missing bootstrap values.

| Name | Type | Default | Purpose |
|---|---|---|---|
| `PATH` | string or absent | Extension-host value, if defined | POSIX executable lookup. |
| `Path` | string or absent | Extension-host value, if defined | Case-preserving Windows executable lookup. |
| `PATHEXT` | string or absent | Extension-host value, if defined | Windows executable suffix lookup. |
| `HOME` | string or absent | Extension-host value, if defined | POSIX home and tool configuration discovery. |
| `USERPROFILE` | string or absent | Extension-host value, if defined | Windows home discovery. |
| `APPDATA` | string or absent | Extension-host value, if defined | Windows roaming application data discovery. |
| `LOCALAPPDATA` | string or absent | Extension-host value, if defined | Windows local application data discovery. |
| `TMPDIR` | string or absent | Extension-host value, if defined | POSIX temporary-file root. |
| `TMP` | string or absent | Extension-host value, if defined | Temporary-file root, especially on Windows. |
| `TEMP` | string or absent | Extension-host value, if defined | Temporary-file root, especially on Windows. |
| `SHELL` | string or absent | Extension-host value, if defined | Host shell discovery by a backend or its children. Schegent itself still spawns with `shell: false`. |
| `TERM` | string or absent | Extension-host value, if defined | Terminal capability discovery. |
| `LANG` | string or absent | Extension-host value, if defined | Locale selection. |
| `LC_ALL` | string or absent | Extension-host value, if defined | Locale override. |
| `LC_*` | string or absent | Every matching extension-host value | All locale-category variables are copied dynamically, including names not known at build time. |
| `SystemRoot` | string or absent | Extension-host value, if defined | Windows runtime discovery. |
| `SYSTEMROOT` | string or absent | Extension-host value, if defined | Uppercase spelling of the Windows runtime root. |
| `WINDIR` | string or absent | Extension-host value, if defined | Windows directory discovery. |
| `COMSPEC` | string or absent | Extension-host value, if defined | Windows command interpreter discovery. |
| Any name in `schegent.cli.environmentAllowlist` | string or absent | Extension-host value, if defined | Operator-approved forwarding. Names must match `^[A-Za-z_][A-Za-z0-9_]*$`; invalid and duplicate names are discarded. |

<!-- Source: src/runner/spawn-env.ts -->
<!-- Source: package.json -->

The forwarding settings resolve to these effective policies:

| Setting state | Effective input environment |
|---|---|
| `schegent.cli.inheritEnvironment: false` | `minimal`, regardless of `schegent.cli.environmentMode`. |
| `schegent.cli.environmentMode: minimal` | Only Schegent-controlled overlays. |
| `schegent.cli.environmentMode: allowlist` | Bootstrap variables, every `LC_*` variable, configured names, then Schegent-controlled overlays. This is the manifest default. |
| `schegent.cli.environmentMode: inherit` | The entire extension-host environment, then Schegent-controlled overlays. Activation logs a warning because ambient secrets can be exposed. |

<!-- Source: src/runner/spawn-env.ts -->
<!-- Source: src/activation/backend-wiring.ts -->
<!-- Source: package.json -->

### Schegent-controlled overlays

| Name | Type | Default | Purpose |
|---|---|---|---|
| `SCHEGENT_PHASE` | string | Current Phase ID; `runner-probe` for capability probes | Identifies the Phase to the spawned backend. It overrides any ambient value. |
| `SCHEGENT_ITERATION` | decimal integer string | Current iteration; `0` for capability probes | Identifies the current loop iteration. It overrides any ambient value. |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | integer string, `1`–`100`, or absent | Absent | Passed only to Claude when `schegent.claude.autoCompactPctOverride` is a valid integer. Internal session compaction forces `1`. Invalid, null, or out-of-range setting values leave the variable absent. |

<!-- Source: src/controller/phase-runner.ts -->
<!-- Source: src/controller/session-compactor.ts -->
<!-- Source: src/activation/backend-wiring.ts -->
<!-- Source: src/lib/auto-compact-override.ts -->

`SCHEGENT_FEATURE_DIR` is a prompt marker, not an environment variable: `PromptBuilder` writes it into prompt text only when a feature directory exists.

<!-- Source: src/runner/prompt-builder.ts -->

## Build and test environment

These variables are implementation controls, not extension-user configuration.

| Name | Type | Default | Purpose |
|---|---|---|---|
| `NODE_ENV` | string or absent | Absent | Exact value `production` makes the host bundle minified and disables its source map. Exact value `test` skips the run-start backend availability probe. Repository scripts and workflows do not set `production`. |
| `CI` | string or absent | Absent | Exact value `true` enables Playwright's CI reporter and `forbidOnly`; any other value is treated as local mode. |
| `SCHEGENT_E2E_MODE` | `happy`, `loop-once`, `fatal`, or `rate-limit` | `happy` | Chooses deterministic behavior for the fake Claude E2E executable. |
| `SCHEGENT_E2E_STATE_DIR` | filesystem path or absent | Absent | Writable counter directory for the stateful E2E modes. `loop-once`, `fatal`, and `rate-limit` require it. |
| `SCHEGENT_INTEGRATION_FILTER` | string | Empty string | Runs only emitted `*.host.test.js` filenames containing the trimmed substring. A non-empty filter matching nothing is a failure. |
| `SCHEGENT_INTEGRATION_RESULT_DIR` | filesystem path | No public default; launcher supplies a temporary directory | Private extension-host handshake directory. The host must write exactly one valid result file. |
| `ELECTRON_RUN_AS_NODE` | string or absent | Removed by the integration launcher | The launcher deletes an ambient value before starting VS Code so Electron cannot be demoted to Node mode. |
| `SCHEGENT_MATRIX_C` | string or absent | Absent/disabled | Exact value `1` opts into the nondeterministic, token-consuming real-Claude integration matrix. |
| `SCHEGENT_MATRIX_C_CLI` | executable path | `claude` | Overrides the CLI executable used by the opt-in real-Claude matrix. |
| `SCHEGENT_SUSTAINED_RECORD_COUNT` | decimal integer string | `4600` | Controls rows per stream in the sustained evidence test. Invalid values or values below `4600` become `4600`; values above `100000` are capped at `100000`. The full gate uses `20000`. |
| `SCHEGENT_SOAK_REPORT` | filesystem path or absent | Absent | When set, writes the sustained evidence JSON report, creating parent directories. The full gate uses `tests/soak/.artifacts/sustained-evidence.json`. |
| `TMPDIR` | filesystem path | `.tmp/vitest-<pid>` during Vitest | Redirects POSIX test scratch files into an isolated per-run root. |
| `TMP` | filesystem path | `.tmp/vitest-<pid>` during Vitest | Redirects Windows-compatible test scratch files into the same isolated root. |
| `TEMP` | filesystem path | `.tmp/vitest-<pid>` during Vitest | Redirects Windows-compatible test scratch files into the same isolated root. |
| `GIT_CEILING_DIRECTORIES` | filesystem path | Absolute repository `.tmp` directory during Vitest | Stops scratch repositories from discovering the developer checkout while walking parent directories. |

<!-- Source: esbuild.config.mjs -->
<!-- Source: src/services/run-driver.ts -->
<!-- Source: playwright.config.ts -->
<!-- Source: tests/e2e/fixtures/fake-claude/index.js -->
<!-- Source: tests/integration/index.ts -->
<!-- Source: tests/integration/runTest.ts -->
<!-- Source: tests/integration/vscode-test-executable.ts -->
<!-- Source: tests/integration/matrix-c-real-cli.test.ts -->
<!-- Source: tests/perf/sustained-evidence-path.test.ts -->
<!-- Source: tests/global-temp-root.ts -->
<!-- Source: ../release/actions-terminal-record.md -->

The following names are unit-test canaries, not supported configuration. They default to absent: `SCHEGENT_ENV_ALLOWED_TEST` demonstrates an explicitly forwarded name; `SCHEGENT_ENV_BLOCKED_TEST` and `SCHEGENT_SECRET_TEST` demonstrate blocked ambient values; `LC_SCHEGENT_TEST` demonstrates dynamic locale forwarding.

<!-- Source: tests/unit/runner/spawn-env.test.ts -->
<!-- Source: tests/unit/runner/claude-cli.test.ts -->
<!-- Source: tests/unit/runner/codex-cli.test.ts -->
<!-- Source: tests/unit/services/run-driver-probe.test.ts -->

## GitHub Actions job variables

These names exist inside release or security workflow shells. They are supplied by GitHub Actions or scoped to one step; they are not local product configuration.

| Name | Type | Default | Purpose |
|---|---|---|---|
| `GITHUB_REF_TYPE` | string | GitHub-provided ref type | Prevents a non-tag dispatch from performing tag/version parity as if it were a tag. |
| `TAG_NAME` | string | Current Git ref name in applicable release steps | Carries the tag as data for version parity and GitHub Release creation. |
| `VSIX` | filesystem path | Resolved single `*.vsix` output | Carries the exact released archive between policy, checksum, and publishing steps. |
| `GH_TOKEN` | secret string | GitHub workflow token | Authenticates `gh release` operations. |
| `REPOSITORY` | `owner/name` string | Current GitHub repository | Scopes provenance-verification instructions in release notes. |
| `GITHUB_OUTPUT` | filesystem path | GitHub-provided | Receives the resolved VSIX step output. |
| `RUNNER_TEMP` | filesystem path | GitHub-hosted runner temporary directory | Holds the generated GitHub Release body. |
| `GITHUB_STEP_SUMMARY` | filesystem path | GitHub-provided | Receives the Markdown npm-audit summary in the security workflow. |

<!-- Source: ../release/actions-terminal-record.md -->

## Core directory tree

This tree shows authored source and the principal repository interfaces, not every generated dependency directory.

```text
repo/
|-- .github/
|   |-- ISSUE_TEMPLATE/
|   `-- workflows/
|-- .vscode/
|-- assets/
|-- docs/
|   |-- how-to/
|   |-- operations/
|   |-- reference/
|   `-- tutorials/
|-- examples/
|-- scripts/
|-- src/
|   |-- activation/ audit/ catalog/ commands/ config/
|   |-- contracts/ controller/ headless/ host-services/ lib/
|   |-- metrics/ monitor/ parser/ queue/ runner/ services/
|   `-- state/ telemetry/ ui/ watchdog/
|-- tests/
|   |-- contract/ e2e/ evals/ integration/ lint/
|   `-- parity/ perf/ unit/ visual/
`-- webview-ui/
    |-- src/
    |   |-- components/
    |   |-- dashboard/
    |   `-- lib/
    `-- tests/
```

<!-- Source: package.json -->
<!-- Source: src -->
<!-- Source: tests -->
<!-- Source: webview-ui -->

Local or generated directories have different ownership:

- `.schegent/` is workspace-local Schegent state and evidence.
- `.tmp/` is test scratch space.
- `.vscode-test/` holds the downloaded integration-test VS Code runtime.
- `coverage/`, `dist/`, and `out/` are generated outputs.
- `node_modules/` and `webview-ui/node_modules/` are installed dependencies.

<!-- Source: .gitignore -->
<!-- Source: .vscodeignore -->
<!-- Source: package.json -->
