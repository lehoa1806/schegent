# `untrusted-workspace` fixture (FR-R3-136, T1527a)

The workspace two host-test launches open: `trust-untrusted-workspace.host.test.ts`
and `trust-granted-workspace.host.test.ts`. **The same fixture, opened twice with
one variable changed** — whether VS Code's Workspace Trust feature is on. Every
assertion in either leg is a difference between the two runs, which is what makes
the untrusted leg's long list of absences mean "refused" rather than "the harness
never worked".

The harness never opens this directory in place. `runTest.ts` copies it into its
temporary directory per launch, because activation writes `.schegent/` into the
folder it is given and a tracked fixture would dirty the working tree on every
integration run. Same reason `materializeMultiRootWorkspace` copies the multi-root
shape rather than opening the checked-in one.

## What each file is here for

| Path | Why |
| --- | --- |
| `.specify/README.md` | The `workspaceContains:.specify/` activation trigger. A directory with no file in it is not something git tracks, so the marker needs a body. |
| `.vscode/settings.json` | Workspace-scoped values for three properties chosen to make Phase D decidable — see below. |
| `no-spawn-sentinel.sh` | Stands in for every backend CLI. Appends to `spawned.marker` beside itself and exits non-zero. The harness installs it at **user** scope for `schegent.cli.path`, `schegent.codex.path` and `schegent.agy.path`. |

## The settings are the Phase D acceptance

`restrictedConfigurations` is a manifest list, and
`tests/lint/restricted-configurations-parity.test.ts` proves the list agrees with
the sensitivity classes in `src/contracts/configuration-trust-dispositions.ts`.
Neither shows VS Code *honouring* it. Only a live untrusted window can, and only
against a workspace that actually tries to set something:

- **`schegent.trust.allowCustomPhases: true`** — class `capability`, restricted.
  Untrusted, the effective value must be the manifest default (`false`): VS Code
  suppresses the workspace value. Trusted, it must be `true`.
- **`schegent.loop.maxIterations: 3`** — class `run-shape`, deliberately NOT
  restricted. It must read `3` in **both** windows. This is the control: without
  it, "the restricted property did not apply" is indistinguishable from "the
  settings file was never read".
- **`schegent.cli.path`** — `application` scope, so a repository may not name the
  binary that runs at all (FR-015, C5). The effective value must not be the one
  this file sets, in either window. The sentinel the harness installs at user
  scope is what a spawn would actually reach.

Do not add settings here casually. Each one is an assertion in both legs.
