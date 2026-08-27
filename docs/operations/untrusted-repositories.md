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
  process does once spawned.

## The compounding case: `environmentMode=inherit`

If you grant an uncontained backend **and** leave `schegent.cli.environmentMode` at `inherit`, the
backend receives the full ambient environment of the shell that launched VS Code — including
credentials that happen to be exported there. Schegent logs a warning naming both facts when it
builds such a runner.

Set `schegent.cli.environmentMode` to `allowlist` or `minimal` whenever an uncontained backend is
granted. It is not containment; it removes one class of reachable secret.

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
