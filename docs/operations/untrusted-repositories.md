# Running Schegent on a repository you do not trust

**This page owns the rule.** The threat model and the quickstart link here and state nothing of their
own about it. A safety rule paraphrased in three documents is three rules, and the one a reader
happens to find is the one they follow.

Written 2026-08-27 for `FR-R3-125` (T1473), from do-not-ignore row 2 of the repository audit of
2026-08-27.

<!-- Source: docs/architecture/backend-containment-qualification.md -->
<!-- Source: docs/architecture/agent-capability-posture.md -->
<!-- Source: src/services/backend-containment-policy.ts -->

## The rule

**Do not run `claude` or `agy` against a repository you do not trust, unless you have deliberately
accepted full local-user authority in a disposable or restorable environment.**

Schegent observed Codex shell-child containment on macOS arm64 with version 0.163.x. For other Codex tuples, admission requires a named grant and a matching fingerprint binding. [Qualification record](../architecture/backend-containment-qualification.md)

Schegent already enforces the first half of this by default: `claude` and `agy` are **refused**
unless you name them in `schegent.backend.uncontainedBackends`. This page is about the decision you
are making when you do.

<!-- executable-example: uncontained-grant-scope -->

```
| backend | version minor | granted    | outcome |
|---------|---------------|------------|---------|
| claude  | 2.1           | (none)     | refused |
| agy     | 1.4           | (none)     | refused |
| codex   | 0.163         | (none)     | admitted |
| claude  | 2.1           | agy        | refused |
| agy     | 1.4           | agy        | admitted |
| claude  | 2.1           | claude     | admitted |
| agy     | 1.4           | claude     | refused |
| codex   | 0.164         | claude     | refused |
| codex   | 0.164         | codex      | admitted |
| claude  | 2.1           | claude,agy | admitted |
```

These examples assume a trusted primary macOS arm64 window, a resolved executable and first use with no prior binding. The gate checks the observed version of the selected executable. Updating a CLI at the same path invalidates its version observation. A change after admission requires a retry. A grant applies only to its named backend. [Admission decision](../../src/services/containment-qualification/admission.ts)

## Why the untrusted case is different

`claude` and `agy` are spawned with `--dangerously-skip-permissions`. Their approval prompts are off,
and model-generated actions execute with **your** local user authority — your files, your
credentials, your network.

A repository's *content* is an input to the model. Text in a README, a comment, a test fixture, an
issue template or a dependency's source can instruct the model, and the model can act on it through
its own legitimate tools. The host cannot classify that: whether a given instruction is legitimate is
a question about meaning, and the threat model's position is that model behaviour is not
host-classifiable. So there is no filter here to rely on — only the boundary, or its absence.

Two things follow that are easy to get wrong:

- **The declared `network` capability cannot be withheld in substance** on a backend whose shell
  subsumes it. A backend with `Bash` can invoke `curl`, whatever a capability declaration says. A
  capability declaration on Claude is a tool-access restriction, not OS network or filesystem isolation.
- **The grant is machine-level, not workspace-level.** `schegent.backend.uncontainedBackends` is
  `application`-scoped: it applies to every workspace you open in this installation. Granting it
  while working in a repository you wrote does not un-grant it when you open one you did not. This is
  deliberate — a workspace must not be able to grant itself the right to run an unbounded agent — and
  it is the edge case the audit named.

## What "disposable or restorable" concretely means

Not a mood. One of these, and it must be true of the environment *before* the Run starts:

| Shape | Concretely | Restores what |
|---|---|---|
| **Disposable VM or container** | A virtual machine or container you can destroy and recreate, holding no credential you would not hand to the repository's author, with no host filesystem mounted read-write beyond the workspace | Everything |
| **Throwaway user account** | A separate OS user whose home directory contains nothing you need, no SSH keys, no cloud credentials, no shell history | Everything outside that user |
| **Snapshotted machine state** | A filesystem or VM snapshot taken before the Run, which you are willing to roll back to | Everything, at the cost of the interval |
| **Git-restorable workspace, and nothing else** | A committed, pushed working tree | The **workspace only** — see below |

**The fourth is the weakest and is the one people mean when they say "it's fine, it's in Git".** A
committed tree restores the workspace. It does not restore anything outside the workspace, and an
uncontained backend is not confined to the workspace — that is the entire meaning of "uncontained".
Use it only when the credentials and files reachable by your user account are ones you would accept
losing or leaking.

Not sufficient, in any combination:

- A recovery checkpoint. Schegent's checkpoints cover the working tree, are `git diff` based, and are
  declined outright when they cannot be attributed. They are a recovery aid inside the workspace, not
  a boundary.
- Reviewing the repository first. The instruction may be in a dependency, a generated file, or a
  place review does not reach.
- `schegent.cli.environmentMode=minimal`. It removes ambient environment variables from the spawn,
  which is worth doing and is not a filesystem boundary. Files on disk are still reachable.
- VS Code's Workspace Trust prompt. It gates *Schegent's* mutating operations, not what a backend
  process does once spawned. What it does gate, exactly, is owned by
  [Workspace Trust](workspace-trust.md).

## The compounding case: `environmentMode=inherit`

If you grant an uncontained backend **and** leave `schegent.cli.environmentMode` at `inherit`, the
backend receives the full ambient environment of the shell that launched VS Code — including
credentials that happen to be exported there. Schegent logs a warning naming both facts when it
builds such a runner.

Set `schegent.cli.environmentMode` to `allowlist` or `minimal` whenever an uncontained backend is
granted. It is not containment; it removes one class of reachable secret.

## The consent grants, and how to withdraw them

Schegent asks for consent in three places, and each is remembered on its own scope rather than asked
on every unchanged task. They are separate grants with different scopes and storage, and none implies
another.

| | Uncontained backend | Git mutation plan | Repository agent configuration (`FR-R7-04`) |
|---|---|---|---|
| **What it permits** | Constructing a runner for a backend with no OS-enforced bound (`claude`, `agy`). Everything that backend does then runs with your local user authority. | The phases of **one exact pipeline plan** staging, committing, or changing branches in this workspace. | Starting an **uncontained** Run in a workspace whose repository contains listed agent configuration files (such as `.claude/settings.json` hooks, `.mcp.json`, or `CLAUDE.md`). |
| **When you are asked** | At the first refusal, as a blocking modal answered before anything is spawned — or ahead of that, on the Settings tab, where each backend's section states its posture and offers the grant behind the same confirmation. Both routes write the same setting through the same writer. | Before the first Run on that plan. `Approve This Run` covers that Run only and records nothing; `Always Approve This Plan Here` records the grant. | Before an uncontained Run starts when listed files exist (or cannot be read safely) and no matching workspace acknowledgement exists. `Approve This Run` covers that Run only; `Acknowledge for This Workspace` records the digest set (only when every discovered file was safely read). |
| **Scope** | **Machine.** `application`-scoped: every workspace in this installation. | **This workspace, this plan.** Editing the pipeline changes the fingerprint and asks again. Another repository asks. | **This workspace, this backend, this exact digest set.** A one-byte change, file addition/removal, or unreadable entry asks again. Contained (`codex`) runs are excluded. |
| **Where it is stored** | `schegent.backend.uncontainedBackends` in your User settings (`settings.json`). | This workspace's `workspaceState` memento, under `schegent.consent.gitPlanGrants.v1`, keyed by fingerprint — with the pipeline id, the phase ids, and when you gave it. VS Code keeps that memento in its own `workspaceStorage`, **not** in the repository. | This workspace's `workspaceState` memento, under `schegent.consent.agentConfigGrants.v1`, keyed by digest-set fingerprint — with backend, file names/digests, and timestamp. Kept in VS Code `workspaceStorage`, **not** in the repository. |
| **How to withdraw it** | Turn the grant off in that backend's section on the Settings tab, or remove the backend id from the setting by hand — the tab's control removes exactly that id and leaves the rest of the list alone. Applies to the next runner Schegent builds; a runner already built in this window is not torn down, so reload the window if you need it to bite now. | Run **`Schegent: Git Approvals`** from the Command Palette. It lists every plan this workspace approves without asking, and withdraws the one you pick or all of them, behind a confirmation. Resetting Schegent's workspace state also clears them. The next Run on that plan asks again. | Run **`Schegent: Agent Config Acknowledgements`** from the Command Palette. It lists every stored repository configuration acknowledgement for this workspace and withdraws one or all of them behind a confirmation. Resetting workspace state also clears them. |

The repository agent configuration preflight is **disclosure and consent, not enforcement**: it runs
before any uncontained backend subprocess starts (including pre-phase session compaction), does not block
or rewrite repository files, and because it scans a fixed per-backend path list, an attacker who controls
the repository may use unlisted mechanisms that the scan does not see. It is risk reduction for known
project-level configuration surfaces; it does not make an uncontained backend safe on an untrusted
repository.

**Scanner bounds and re-acknowledgement (`FR-R7-11`):**
- **Bounded reads (`<= 256 KiB` per file, `2,000 ms` total):** each candidate file opened through
  `openWithinRoot` is verified with pre- and post-read `fstat` checks so reads never request bytes past
  `256 KiB` and concurrent growth past `256 KiB` fails closed. The scan enforces a `2,000 ms` monotonic
  deadline via `AbortSignal` threaded through file opens and chunk reads, failing closed on timeout and
  closing descriptors once settled without mutating returned entries. Because Node/libuv cannot interrupt
  a single in-flight OS read syscall mid-flight, the deadline halts any subsequent I/O immediately, returns
  fail-closed, and releases the handle when that syscall finishes.
- **Re-acknowledgement policy:** within one extension-host activation, acknowledgement is evaluated once
  per `(runId, backend)` across subsequent phases, retries, and same-session resumes, coalescing
  overlapping concurrent checks for the same pair into a single scan, modal, and audit event. Completed
  and canceled Runs are cleared from the in-memory ledger via `forgetRun`, backed by a 512-pair LRU
  defensive bound whose eviction fails closed by re-running the check. Across an extension-host reload,
  matching persistent workspace grants clear silently as `stored`, whereas one-Run approvals, unreadable
  or timed-out scans, failed persistence writes (audited as `approved-once`), and modified configuration
  re-prompt before spawning.

The stored Git grant is written to be read: it names the pipeline and the phases, not just a hash,
so a grant you find months later can be judged without reading source. `Schegent: Git Approvals` is
where you read it. Until FR-R3-146 this page and four others told you to open and edit
`.schegent/state.json` — no such file exists, and nothing in this product has ever written one, so
that instruction could not be followed. The command is the route that works.

Both are explicit acts. Cancelling or dismissing either modal **denies** — closing a dialog is always
the safe move — and neither value is ever written except by its own affirmative action. Neither
widens on its own: granting `claude` does not grant `agy`, and approving one plan says nothing about
a plan that differs by a single phase.

Two things neither grant does:

- The uncontained grant does **not** restore the backend CLI's own approval prompts.
  `--dangerously-skip-permissions` is still passed. It is a bound on *whether the run starts*, not
  on what the model does once it has.
- The Git grant does **not** bound what a granted uncontained backend can do to the repository. A
  backend with a shell can invoke `git` whether or not any phase declared it would; the grant covers
  the phases Schegent itself runs, and the repository's safety against the other case is the
  disposable-or-restorable environment this page is about.

## Practical guidance

| Situation | Do |
|---|---|
| Repository you or your team wrote, on your own machine | Any backend. Grant per backend, not wholesale. |
| Third-party repository you are reading, not modifying | `codex`. Do not grant `claude` or `agy`. |
| Third-party repository you must let an agent modify | `codex` if the pipeline permits it; otherwise a disposable VM with `claude`/`agy` granted **inside** it. |
| CI-like unattended use on arbitrary input | Not supported. Nothing in this product bounds an uncontained backend on untrusted input. |

## What this page does not claim

- It does not claim `codex` is safe on arbitrary repositories. It claims the operating system, not the
  model, decides what its shell commands reach.
- It does not claim a disposable environment makes prompt injection harmless — it bounds the
  consequences, which is the whole reason to want one.
- It does not claim Schegent detects untrusted content. It does not.
- It does not claim per-Run working-tree isolation exists. It does not; the shape is decided and
  gated in [the run-isolation decision record](../architecture/run-isolation-decision.md).
