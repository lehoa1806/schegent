# Workspace Trust: what Schegent does in a window you have not trusted

**This page owns the Workspace Trust boundary.** Two neighbours own what is most often confused with
it, and this page paraphrases neither:

- [Running Schegent on a repository you do not trust](untrusted-repositories.md) owns whether
  pointing a backend at a repository is acceptable at all. Workspace Trust does not answer that
  question, and the last section here says so in the form the misreading takes.
- [Trust scopes](trust-scopes.md) owns the two `schegent.trust.*` capability settings and the ladder
  that resolves them. Workspace Trust is the **ceiling** over that ladder; nothing below it widens it.

Written 2026-08-28 for `FR-R3-136` (T1528e). Every behavioural claim below is asserted by a host
test in a window where Workspace Trust is genuinely live —
`tests/integration/trust-untrusted-workspace.host.test.ts` for the untrusted half and
`tests/integration/trust-granted-workspace.host.test.ts` for the granted half. Until FR-R3-136 no
assertion in this repository had ever observed such a window: the harness appended
`--disable-workspace-trust` to every host launch, so every leg ran trusted no matter what it claimed
to be testing.

<!-- Source: src/activation/guarded-command-registration.ts -->
<!-- Source: src/activation/stage2-producers.ts -->
<!-- Source: src/contracts/entry-point-dispositions.ts -->
<!-- Source: src/contracts/configuration-trust-dispositions.ts -->

## Which state you are in

VS Code decides this per folder, not per extension. An untrusted window is one where you answered
**No, I don't trust the authors** — or dismissed the prompt — and it shows **Restricted Mode** in the
status bar. The decision is VS Code's to record and yours to change: *Workspaces: Manage Workspace
Trust* in the Command Palette.

Schegent reads `vscode.workspace.isTrusted` fresh at every decision point and never caches it, so
granting trust takes effect immediately and revoking it (which reloads the window) takes effect on
the reload.

Three cheap ways to confirm what Schegent thinks:

| Signal | Where | Means |
|---|---|---|
| A warning notification naming the command | On invoking a refused command | The window is untrusted |
| `command refused: workspace not trusted` | `.schegent/syslog` (default path, level `INFO`) | Same, with the `commandId` recorded |
| `stage 2 producers skipped: workspace is not trusted` | Same log, once, near activation | The producer half never ran |

## What stays available untrusted

Activation runs to completion. The extension activates, the sidebar renders, the tree view populates
from persisted state, and Stage 2 **constructs** its services. What it does not do is *act* — see the
next section for where the line falls.

**7 commands stay available** in an untrusted window, registered unwrapped because none of them
mutates workspace state:

| Command | What it does |
|---|---|
| `schegent.showAuditLog` | Opens the audit log |
| `schegent.showActiveRun` | Reveals the active Run in the sidebar |
| `schegent.openDashboard` | Opens the dashboard webview |
| `schegent.verifyAuditChain` | Recomputes the audit hash chain and reports |
| `schegent.redetectClaudeTransport` | Re-reads which transport the resolved CLI offers |
| `schegent.exportAuditLog` | Writes the audit log to a path you choose |
| `schegent.exportRunEvidence` | Writes a Run's evidence bundle to a path you choose |

The last two write a file, and are classified read-only anyway: each opens a modal save dialog, so
the write is a place *you* named in a dialog *you* answered. A modal cannot be answered by repository
content, which is the threat Workspace Trust exists to bound. (The untrusted host leg drives the
other five for exactly that reason — a headless leg cannot answer a modal.)

Reading settings, reading the audit log, reading persisted Run state and rendering all of it are
unaffected.

## What refuses untrusted

**23 commands refuse.** Every mutating command id in
`src/contracts/entry-point-dispositions.ts` is wrapped by `registerGuardedCommand`, which — when the
window is untrusted — shows a warning, records `command refused: workspace not trusted` with the
`commandId`, and returns without calling the handler.

Two properties of that shape matter more than the list:

- **Refused at the point of effect, not at registration.** The command stays registered and stays in
  the palette. So the refusal holds for an invocation from the palette, from the sidebar, from a
  task, and from another installed extension alike — `executeCommand` reaches a registered command
  from all four. Palette absence would not have been authorization; the guard is in the registration
  helper rather than in a manifest `enablement` clause for that reason.
- **Per invocation, not captured.** The trust value is read when the command runs. Nothing holds a
  stale `true` from activation.

The sidebar's own IPC surface is gated the same way: its mutating half is refused before it reaches
storage, its read half is not.

**And activation's producer half does not run at all.** This is the half that matters most, because
it needs no command and no click. In an untrusted window Stage 2 does not:

- acquire the workspace ownership lock (which writes a generation record under
  `.schegent/ownership/`);
- replay terminal phase transitions;
- re-arm a scheduled start;
- reattach the watchdog;
- resume a persisted Run;
- probe backend capabilities — **so no backend CLI is spawned.**

The ownership election is itself a write, which is why it moved into the producer half rather than
staying with construction: acquiring the resource *is* the mutation. The two gates are independent by
design, and demonstrably so — with the command guard reverted, the untrusted leg still observed no
ownership record and no spawn.

**One thing is still written, deliberately.** The runtime log sink is attached in Stage 1, before any
trust decision, so an untrusted window creates `<workspaceRoot>/.schegent/` and appends to `syslog`
there. That is not an oversight and it is not a loophole: the refusal record has to go somewhere, and
the table above sends you to that file to read it. It is also why the log's path and its two size
bounds are restricted settings — a workspace that could redirect or truncate the log could refuse
you the evidence of its own refusals. What the gate withholds is the acts, not every byte.

## What settings do untrusted

The manifest declares **14 restrictedConfigurations**. While a window is untrusted, VS Code
suppresses the **workspace** value of each of those keys and hands Schegent the default instead, so a
checked-in `.vscode/settings.json` cannot redirect a log path or grant a trust capability in a
repository you have not trusted. User-scope and application-scope values of the same keys are
unaffected — the suppression is of workspace values only.

Three cases, which the host legs assert side by side because operators conflate them:

| Setting shape | Untrusted | Trusted |
|---|---|---|
| Restricted, set by the workspace (e.g. `schegent.trust.allowCustomPhases`) | Default; the workspace value is ignored | The workspace value applies |
| Not restricted, set by the workspace (e.g. `schegent.loop.maxIterations`) | The workspace value applies | The workspace value applies |
| **9 application-scoped keys** (e.g. `schegent.cli.path`, `schegent.backend.uncontainedBackends`) | The workspace value is ignored | **Still ignored** |

The third row is the strongest of the three and does not depend on trust at all: an
`application`-scoped setting has no workspace scope to read, so a repository cannot point Schegent at
a different CLI or grant itself an uncontained backend whether you trusted it or not. Trusting a
workspace does not weaken that.

Which keys are restricted is decided in `src/contracts/configuration-trust-dispositions.ts` and
declared in the manifest from there; the settings themselves are documented in
[the configuration reference](../reference/settings.md).

## What granting trust does

Trust is granted through VS Code, not through Schegent. When you grant it, VS Code fires
`onDidGrantWorkspaceTrust`, Schegent's subscriber runs the producer half **once**, in the same
window, and no reload is needed. In the order it runs: the ownership election; the mount probe;
terminal-transition replay; the evidence backlog; a catalog re-resolve; the checkpoint-retention
sweep; the backend capability probe, which spawns the resolved CLI once per backend kind with
`--help` and nothing else; then the recovery half — scheduled-start re-arm, watchdog reattach,
delayed-retry re-arm, and resuming a persisted Run.

**The recovery half runs only in the window that won the election.** A second window on the same
workspace grants trust, elects, loses, and stands down: it records why in the log and leaves every
persisted deadline addressable by the primary window rather than racing it. The earlier acts are not
primacy-gated, because they are this window's own writes regardless of who is primary.

The capability probe is the observable consequence a granted window has and an untrusted window does
not, and it is what the granted host leg watches for.

Commands need nothing at all: the next invocation reads `isTrusted` afresh and proceeds.

## What this page does not claim

- **It does not claim Workspace Trust bounds a backend.** It gates *Schegent's* mutating operations.
  Once a backend process is spawned in a trusted window it acts with your local user authority, and
  what to do about that is owned by
  [Running Schegent on a repository you do not trust](untrusted-repositories.md). Granting Workspace
  Trust to a repository and pointing an uncontained backend at it are two decisions, and the first is
  much cheaper than the second.
- **It does not claim an untrusted window is a sandbox.** It is a set of refusals in this
  extension's own code paths, verified by test. It does nothing about other extensions, tasks, or
  anything you run in a terminal.
- **It does not claim the refusals are a substitute for review.** A refused command tells you
  Schegent declined to act; it says nothing about whether the repository is safe to trust.
- **It does not re-state the `schegent.trust.*` ladder.** Workspace Trust is its ceiling and that is
  the whole of the relationship; the ladder is [Trust scopes](trust-scopes.md).

## Related

- [Trust scopes](trust-scopes.md) — the two capability settings under this ceiling.
- [Running Schegent on a repository you do not trust](untrusted-repositories.md) — the backend rule.
- [Operator threat model](../security/threat-model.md) — T7 states the gated surfaces and why the
  split is by act rather than by construction.
- [Command reference](../reference/commands.md) and
  [API and CLI reference](../reference/api-and-cli.md) — per-command dispositions.
- [Configuration reference](../reference/settings.md) — every setting, with its scope.
