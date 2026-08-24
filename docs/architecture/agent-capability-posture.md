# Decision record: agent capability posture

**Status: DECIDED — shape 3, shipped.** Decided 2026-08-24 on the operator's explicit delegation,
after this record had been filed with the analysis and a recommendation and the decision was returned
for a call to be made.

**What ships:** `schegent.backend.allowUncontainedBackends`, `application`-scoped, **default
`false`**. A backend with no OS-enforced bound is refused at the point it would be constructed. The
mechanism is in `src/services/backend-containment-policy.ts` and enforced in
`createBackendRunner`; it is asserted by test, not by manifest prose.

**This changes the default install.** `backend.runner` defaults to `claude`, which is uncontained, so
a fresh install refuses its first run until the operator either sets this setting or selects a
backend that carries a sandbox. That is the intended effect of shape 3, and it is reversible with one
setting.

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

## Decision

**Shape 3, then shape 2.** Shape 3 is shipped. Shape 2 — the capability broker — remains the
destination and is not started.

Shape 1 was rejected: defaulting to `codex` trades the containment problem for a
behaviour-compatibility problem across every authored pipeline, and would not even help the shipped
examples, which pin `runner: claude` and `model: claude-sonnet-5` per phase and would be refused
regardless of the global default.

### Where the refusal lives, and why there

`createBackendRunner` — the last point before an uncontained backend exists as an object. Every route
reaches it: admission, resume, an auto-drain, a continuation. A check at admission alone would be
bypassed by every path that does not go through admission, which is most of them.

`allowUncontained` is a **required** option, not an optional one defaulting to permissive, so `tsc`
enumerates every construction site and no new one can be added without stating a posture. A lint gate
additionally refuses a literal `allowUncontained: true` anywhere under `src/`, because a required
option stops a site being *added* without a posture but not one hardcoding acceptance.

### What the refusal must not do, and did

It must not kill activation. The first implementation constructed the credit watchdog's runner during
`activate()`, so the refusal crashed the extension before it could explain itself — an operator would
have seen a dead Schegent with no message, which is far worse than a refused run. The watchdog now
takes a thunk and constructs at poll time. That is better regardless: a long-lived object holding a
runner built under a posture the operator can change is the caching shape the hard rules forbid.

## What is required to close FR-R3-056

The item's acceptance is mechanism, not prose:

1. A fresh install's default run path **cannot** reach unprompted OS-user capability without the
   consent/enforcement mechanism engaging.
2. The mechanism is **asserted by test**, not by manifest prose.
3. The threat model and backend docs describe the shipped posture exactly.

## The three questions, answered

- **Which shape?** 3, then 2.
- **What does the shipped default become?** Refuse, and require an explicit opt-in. Not a per-run
  modal prompt: this product's premise is autonomous multi-phase runs drained from a queue, and a
  modal per run would either block auto-drain or be dismissed reflexively — which is consent in form
  and not in substance.
- **What does the consent surface say, and how often?** The setting is the consent, and it is
  `application`-scoped so a workspace cannot grant it to itself. Each constructed uncontained runner
  logs that it is running unbounded and names the setting that permitted it.

### Outstanding: a genuine per-run record

The item's phrase is "unmistakable per-run consent". What ships is per-runner-construction, and the
registry caches runners by kind, so **this is not a per-run record and does not claim to be**. A
per-run audit entry belongs at admission and needs its own event in the audit contract. Recorded here
as outstanding rather than glossed.

The MCP and new-backend freeze the review attached to this item holds until shape 2 ships; the
review makes that ordering explicit, and shape 3 does not lift it.

## Related

- [Threat model](../security/threat-model.md) — the shipped posture as it stands, including the
  self-certification limit and where FR-R3-058 now enforces against it.
- [Backends](../operations/backends.md) — per-backend argv and the cancellation contract.
