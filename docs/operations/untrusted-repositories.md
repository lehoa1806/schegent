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

`codex` is the exception: it carries an OS-enforced `workspace-write` sandbox
([the qualification record](../architecture/backend-containment-qualification.md)), so
model-generated shell commands are bounded by the operating system rather than by the model's own
judgement.

Schegent already enforces the first half of this by default: `claude` and `agy` are **refused**
unless you name them in `schegent.backend.uncontainedBackends`. This page is about the decision you
are making when you do.

<!-- executable-example: uncontained-grant-scope -->

```
| backend | granted   | outcome  |
|---------|-----------|----------|
| claude  | (none)    | refused  |
| agy     | (none)    | refused  |
| codex   | (none)    | allowed  |
| claude  | agy       | refused  |
| agy     | agy       | allowed  |
| claude  | claude    | allowed  |
| agy     | claude    | refused  |
| codex   | claude    | allowed  |
| claude  | claude,agy| allowed  |
```

These rows are read by `tests/lint/documented-defaults-are-executable.test.ts` and fed through
`judgeBackendContainment` in `src/services/backend-containment-policy.ts`. The rows that matter are
rows 4 and 7: **a grant applies to the backend it names and no other** (`FR-R3-125`). Row 3 is the
one an operator most often misreads — `codex` was never refused, so it needs no grant.

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
  subsumes it. A backend with `Bash` can invoke `curl`, whatever a capability declaration says.
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

## The two grants, and how to withdraw them

Schegent asks for consent in exactly two places, and both are asked **once** rather than per task.
They are different grants with different scopes and different storage, and neither implies the
other.

| | Uncontained backend | Git mutation plan |
|---|---|---|
| **What it permits** | Constructing a runner for a backend with no OS-enforced bound (`claude`, `agy`). Everything that backend does then runs with your local user authority. | The phases of **one exact pipeline plan** staging, committing, or changing branches in this workspace. |
| **When you are asked** | At the first refusal, as a blocking modal answered before anything is spawned — or ahead of that, on the Settings tab, where each backend's section states its posture and offers the grant behind the same confirmation. Both routes write the same setting through the same writer. | Before the first Run on that plan. `Approve This Run` covers that Run only and records nothing; `Always Approve This Plan Here` records the grant. |
| **Scope** | **Machine.** `application`-scoped: every workspace in this installation. | **This workspace, this plan.** Editing the pipeline changes the fingerprint and asks again. Another repository asks. |
| **Where it is stored** | `schegent.backend.uncontainedBackends` in your User settings (`settings.json`). | This workspace's `workspaceState` memento, under `schegent.consent.gitPlanGrants.v1`, keyed by fingerprint — with the pipeline id, the phase ids, and when you gave it. VS Code keeps that memento in its own `workspaceStorage`, **not** in the repository. |
| **How to withdraw it** | Turn the grant off in that backend's section on the Settings tab, or remove the backend id from the setting by hand — the tab's control removes exactly that id and leaves the rest of the list alone. Applies to the next runner Schegent builds; a runner already built in this window is not torn down, so reload the window if you need it to bite now. | Run **`Schegent: Git Approvals`** from the Command Palette. It lists every plan this workspace approves without asking, and withdraws the one you pick or all of them, behind a confirmation. Resetting Schegent's workspace state also clears them. The next Run on that plan asks again. |

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
