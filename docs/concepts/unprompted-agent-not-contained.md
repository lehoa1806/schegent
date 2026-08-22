# The agent runs unprompted, and `sideEffects` is not what stops it

Status: Accepted product-boundary decision (2026-08-22)

Permission-posture: prompts-disabled

Schegent spawns its backend CLI with that CLI's own approval prompts switched
off, deliberately, and there is no setting that turns them back on. This
document is the position, what it actually means for your working tree, what a
`sideEffects` declaration does and does not do, what the alternative would cost,
and the name of the test that holds it.

## The posture, per backend

| Runner | Default | What it is permitted to do | How |
|---|---|---|---|
| `claude` | **yes** | anything the CLI's tools can do, without asking | spawned with `--dangerously-skip-permissions` |
| `agy` | no | anything the CLI's tools can do, without asking | spawned with `--dangerously-skip-permissions` |
| `codex` | no | read the workspace, write it, but **not** `.git` | spawned with `--sandbox workspace-write`, an OS-enforced bound |

Two of the three run with no approval gate. **The one that has a bound is not
the default.**

**The bound is a filesystem bound, and only that.** `workspace-write` is what
Schegent asks the Codex CLI for, and what this project documents and relies on
is the `.git` read-only property. Whether that sandbox also restricts outbound
network access is the Codex CLI's own behaviour: Schegent does not configure it,
does not verify it, and makes no claim about it. Read "contained" narrowly — the
runner is bounded in what it may write, not established as bounded in what it may
send.

The flag is unconditional in both cases: it is a literal in a fixed argument
prefix in [`src/runner/claude-cli.ts`](../../src/runner/claude-cli.ts) and
[`src/runner/agy-cli.ts`](../../src/runner/agy-cli.ts), not a branch on a
setting, a phase field, or a request property. There is no
`--permission-mode`, no `--allowedTools`, and no operator control anywhere in
the extension's contributed settings.

## Product decision

**The permission prompts stay off, and that is not configurable.** Three
grounds:

- **A prompt in an unattended run is a hang, not a safeguard.** Schegent's
  entire proposition is that you enqueue work and walk away. A CLI that stops
  for approval at 03:00 does not protect the workspace; it burns the phase
  timeout and leaves the queue stalled behind it. The safety a prompt offers
  requires someone present to answer it, and by construction nobody is.
- **A setting would make the failure mode worse, not better.** An operator who
  enabled prompts would get a product that appears to work and then silently
  stops making progress — the hardest class of failure to diagnose, and one the
  logs would attribute to a timeout rather than to a choice made in settings
  weeks earlier.
- **The project already said so, to the other audience.** This repository's
  agent constitution states the same reasoning as a directive to the agent it
  invokes: *"The bypass flag exists to prevent stalls, not to authorize
  destruction; an unrecoverable change costs more than the entire queue it
  serves."* That governs the worker. It was never said to the operator, and it
  is not shipped anywhere an operator would look. That gap is what this document
  closes.

The decision is defensible. What was not defensible is that it was undisclosed
while three shipped surfaces described a *containment* the product does not
have.

## What `sideEffects` actually does

A phase declares `sideEffects` as `none`, `workspace`, `git`, or
`unrestricted`. Omitted, it is `workspace`.

**It selects a consent prompt and a rollback checkpoint. It does not restrict
the subprocess.**

| Declared | Consent prompt before the run | Rollback checkpoint | Refused on `codex` | Restricts what the subprocess may do |
|---|---|---|---|---|
| `none` | no | no | no | **no** |
| `workspace` (and omitted) | no | no | no | **no** |
| `git` | yes | yes | **yes** | **no** |
| `unrestricted` | yes | yes | no | **no** |

Traced end to end: [`src/services/mutation-plan.ts`](../../src/services/mutation-plan.ts)
reads the field only to collect the Git-capable phases;
[`src/services/workflow-run-factory.ts`](../../src/services/workflow-run-factory.ts)
approves the run outright when that collection is empty;
[`src/services/run-driver.ts`](../../src/services/run-driver.ts) checks the
approval receipt and takes a checkpoint only for `git` and `unrestricted`; and
[`src/config/phase-runner-policy.ts`](../../src/config/phase-runner-policy.ts)
refuses `sideEffects: git` paired with the `codex` runner.

That last one is a real check, and the only one. It exists because `codex` keeps
`.git` read-only, so a phase that must write `.git` cannot run there — which is
also why the only contained backend is unavailable to precisely the phases that
mutate most.

So a phase declaring `workspace`, or declaring nothing, gets no modal, no
checkpoint, and a subprocess that will `git commit`, `rm -rf`, install a
package, or make an outbound request without asking. **The declaration is
consent bookkeeping, not a sandbox.** Declare it accurately because the
checkpoint and the modal depend on it — not because it will stop anything.

## What this means for you

- **Point Schegent at a repository you can restore.** Committed, pushed, or
  otherwise recoverable. The audit log records what happened; it does not
  prevent it.
- **`codex` is the contained option**, with the caveat above: `.git` is
  read-only there, so Git-writing phases are refused on it.
- **Workspace trust is the real gate.** The extension is inert in an untrusted
  workspace. That is a decision you make once, per workspace, and it is the
  point at which this posture becomes live.

## What reversing this would cost

Adding an operator setting that restores the CLI's prompts is a small code
change and a large behavioural one:

- **Every unattended run becomes capable of hanging.** The phase timeout is
  idle-based and resets on output, so a run waiting on a prompt that nobody will
  answer does not fail fast — it waits.
- **The hang would need its own detection and its own reporting**, because
  "stalled waiting for approval" and "the model is thinking" are the same thing
  from outside the process.
- **The setting would need a per-phase override**, since a pipeline that is
  interactive for one phase and unattended for eight is the realistic case, and
  that is a catalog schema change plus a Builder surface.

None of that is impossible. It is simply much larger than the one-line flag
suggests, and it buys a safeguard that only helps an operator who is watching.

### The condition that would reopen this

**A supervised execution mode with someone present to answer.** Concretely: a
decision to support attended runs as a first-class mode — a run the operator
starts and watches, with the UI surfacing the prompt and the timeout suspended
while it is open. Not "make the flag configurable"; the flag is not the feature.
The feature is a run that expects a human, and this decision reopens when that
run exists.

## How this is held

[`tests/lint/backend-permission-posture.test.ts`](../../tests/lint/backend-permission-posture.test.ts)
reads the `Permission-posture:` line at the top of this document and checks the
runners against it. It fails when a runner's permission-shaped arguments change
without this document changing, when a supported runner has no stated posture,
and when any shipped document goes back to describing `sideEffects` as
containment.

It reads the posture rather than pinning it, so reversing this decision is an
edit to line 5 and not a deleted test.
