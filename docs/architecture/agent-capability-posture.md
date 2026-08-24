# Decision record: agent capability posture

**Status: DECISION PENDING — operator input required.** The engineering analysis is complete and a
recommendation is stated. The choice itself is not an engineering call and is not made here.

Filed under FR-R3-056, which says to file this record first and that the item "is not closed by a
documentation change". It is not closed by this document. This document exists so the decision can be
made against facts rather than impressions, and so what is already true is written down.

## The finding

H-01 of the 2026-08-23 principal architecture review — its largest strategic finding, and the
**default** execution path.

| backend | argv | OS-enforced bound |
|---|---|---|
| `claude` (**the default**) | `--dangerously-skip-permissions` | none |
| `agy` | `--dangerously-skip-permissions` | none |
| `codex` | `exec --json --sandbox workspace-write` | filesystem, `.git` read-only |

`schegent.backend.runner` defaults to `claude`. So a fresh install's default run path reaches
unprompted OS-user capability, and two of the three backends have no adapter-level bound at all.
<!-- Source: src/runner/claude-cli.ts -->
<!-- Source: src/runner/agy-cli.ts -->
<!-- Source: src/runner/codex-cli.ts -->
<!-- Source: package.json -->

FR-R3-031/032 added disclosure. The review is explicit that disclosure changed **informed consent**,
not **reachability or impact**, and does not reduce the severity. That assessment is correct: a
document does not bound a process.

## What has changed since the review, and what has not

Three items in this round reduced the blast radius without touching the posture, and the review said
they should not wait for it:

- **FR-R3-054** — cancellation now signals the backend's whole process group, so a forked helper no
  longer outlives cancel and keeps writing after a terminal state.
- **FR-R3-053** — the audit path opens through a symlink-refusing walk, so evidence can no longer be
  redirected out of the workspace by a pre-existing link.
- **FR-R3-058** — a phase can now require the host's exit status rather than the model's claim, so a
  sensitive gate is no longer advanced by the agent whose work it judges.

None of these bounds what the agent may do. They bound how far the consequences travel and how
honestly they are recorded. **The posture is unchanged.**

## The three shapes, assessed

### 1. Default to a genuinely sandboxed or mediated provider

Make `codex` (or an equivalent) the default, since it is the only backend carrying an OS-enforced
bound.

*Cost:* changes which agent every existing install runs. Pipelines authored against Claude's
behaviour, model selection (`claude-sonnet-5` in the shipped examples), and skill semantics do not
transfer. This is a product repositioning, not a setting change.

*Verdict:* strongest containment, highest disruption. Not recommended as a first move.

### 2. A capability broker with explicit policy and audit

Mediate the agent's filesystem and process access through a host-side broker that applies policy and
records decisions.

*Cost:* the review budgets this as weeks-to-months, and that is right. It means intercepting a CLI's
syscalls or running it under a supervisor the host controls — on three platforms, for three backends,
without breaking the tool's own behaviour. It is the only shape that bounds `claude` itself.

*Verdict:* the correct destination. Not reachable in one step, and not something to start without the
decision below being made first, because shapes 1 and 3 change what it must support.

### 3. Uncontained backends as a separately enabled expert mode

The shipped default refuses an uncontained backend. Enabling one is explicit, per-run consent is
unmistakable, and the consent is recorded.

*Cost:* every existing install's default path stops working until the operator opts in. That is the
point, and it is also the reason this is not mine to decide.

*Verdict:* **recommended as the first move.** It is the only shape that satisfies the acceptance
criterion — "a fresh install's default run path cannot reach unprompted OS-user capability without
the recorded consent/enforcement mechanism engaging" — without a provider migration or a broker. It is
enforceable with a mechanism, testable, and it does not foreclose shape 2; it makes the broker's job
smaller by making the uncontained path explicit rather than implicit.

## Recommendation

**Shape 3, then shape 2.** Ship the refusal-by-default with recorded per-run consent; build the
broker behind it. Do not start with shape 1: it trades the containment problem for a
behaviour-compatibility problem across every authored pipeline.

## What is required to close FR-R3-056

The item's acceptance is mechanism, not prose:

1. A fresh install's default run path **cannot** reach unprompted OS-user capability without the
   consent/enforcement mechanism engaging.
2. The mechanism is **asserted by test**, not by manifest prose.
3. The threat model and backend docs describe the shipped posture exactly.

## Why this document does not ship the mechanism

The operator decision determines the mechanism's shape, and building the wrong one is worse than
building none: a refusal path designed for shape 3 is not the policy layer shape 2 needs, and a
consent surface designed before the shape is chosen would be rewritten.

Three specific questions need answers before the enforcement half can be built:

- **Which shape?** (Recommendation above.)
- **What does the shipped default become?** Refuse and require opt-in, or prompt per run?
- **What does the consent surface say, and how often?** Once per workspace, once per session, or once
  per run — the item says "unmistakable per-run consent", which is the strictest reading and the most
  intrusive.

Until those are answered, the honest state is the one recorded at the top of this file: **decision
pending**. The MCP and new-backend freeze the review attached to this item holds meanwhile; the review
makes that ordering explicit.

## Related

- [Threat model](../security/threat-model.md) — the shipped posture as it stands, including the
  self-certification limit and where FR-R3-058 now enforces against it.
- [Backends](../operations/backends.md) — per-backend argv and the cancellation contract.
