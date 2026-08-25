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

## FR-R3-086 — stage 1: the route, costed, decided 2026-08-25

`FR-R3-056` shipped shape 3 and said plainly that shape 2 *"is the only shape that bounds `claude`
itself rather than gating whether it may run at all"*. `FR-R3-086` is where that is decided on
mechanism. The three routes it names, each costed rather than argued from preference:

### Route A — OS/CLI-enforced containment, driven by a host-declared capability set — **CHOSEN**

The host declares a capability set per phase and translates it into each backend's **own** enforcement
surface. The backend's permission engine refuses at the attempt.

**Why it was chosen, and it is not a compromise.** The route reads as the weakest of the three until
the CLIs are actually checked. Re-derived from the installed binaries on 2026-08-25:

| Backend | Enforcement surface it already has |
|---|---|
| `claude` | `--permission-mode`, `--allowedTools`, `--disallowedTools`, `--settings` |
| `agy` | `--sandbox` (*"run in a sandbox with terminal restrictions enabled"*), `--mode` |
| `codex` | `-s/--sandbox`, `-a/--ask-for-approval` — already at `workspace-write` |

All three carry one. So route A reaches **enforcement at the point of effect** without building a
mediator process inside the expansion freeze — and without MCP, which the reviewer brief names as the
most plausible route to what `SEC-1` lacks and which is explicitly blocked.

**Cost paid:** a per-phase declared set, one translation site, a run-level refusal, an audit event, and
the gaps below.

**What it does NOT bound, stated because a containment claim without its limits is the `R-14` class:**

- **The host does not observe tool calls.** It hands the backend a narrowed authority and trusts the
  backend to apply it. That trust is the anchor of this whole mechanism.
- **`agy` can express only one of the four capabilities.** Its CLI has `--sandbox` and no per-tool
  flag, so a phase withholding `network`, `workspace-write` or `outside-workspace-write` on `agy` is
  **refused before it starts** rather than run unbounded. That is an honest outcome, not a working
  one, and it is the strongest argument for route B later.
- **Nothing here closes `SEC-08` at the default.** A phase that declares no capability set spawns with
  today's argv, byte for byte. Narrowing is opt-in, per phase.

### Route B — a host-side mediated broker — **the destination, not yet built**

Every tool call passes through a host-side mediator that approves, denies or logs it against a
declared set. Strongest of the three: it would remove the trust anchor above, because the host would
see each call rather than delegating.

**Cost:** the review's own estimate is **1–3 months**. Its most plausible implementation route runs
through a plug-in protocol the expansion freeze blocks. `FR-R3-086` §5 is explicit that *"shipping a
token mediator to close a High is how a High gets relabelled a second time"*, and a half-built broker
that replaced a working refusal would be strictly worse than the refusal.

**Recorded as the destination.** If a backend's own surface proves insufficient — and `agy`'s already
is, for three of four capabilities — route B is what closes the gap.

### Route C — a separately enabled expert mode — **rejected**

Keep today's behaviour explicitly out of the ordinary path.

**Cost:** none, which is the problem. This is what shipped as shape 3, and choosing it again would be
choosing not to bound anything. Its honest description is *"we chose not to bound it"*, and the
2026-08-22 reviewer brief's question — whether an undisclosed unbounded tool boundary becoming a
disclosed one is a High closed or a High relabelled — would stay open on the same terms.

### What this does and does not close

**`SEC-08` is not marked closed by this.** The mechanism bounds a phase that opts into a narrower set;
the default is unchanged and `agy` is bounded in only one dimension. Whether that is enough is a
judgement for the independent review, and `FR-R3-093` §6 says this item does not pre-empt it.

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

### Decided: a genuine per-run record, built (FR-R3-064)

The item's phrase is "unmistakable per-run consent". Shape 3 shipped
per-runner-*construction*, and the registry caches runners by kind, so that was **not** a per-run
record and did not claim to be. Two shapes were available to close the gap, and they differ in what
the product can prove rather than in cost:

- **Shape A — narrow the sentence.** State that the runner used is recorded on every phase start and
  that containment is derivable from it. Minutes of work, honest, and it leaves this clause open.
- **Shape B — build the record.** Add the admission-time event this section already specified, emit
  it on every route that reaches a backend, and keep the promise the setting makes.

**Chosen: shape B.** Rejected: shape A. The reason is not effort. The registry caches runners by
kind, so a *construction*-time refusal can never be a per-run record however it is described — shape
A would therefore have left a real gap in the evidence an operator needs after the fact, while
describing that gap accurately. An operator who accepted this posture months ago and now needs to
answer "which runs actually drove an unbounded agent?" is not served by a sentence explaining that
they can infer it.

**What ships:** the `backend-posture-admitted` audit event, declared in `src/contracts/audit-events.ts`
and emitted in `PhaseRunner.run` immediately after the effective runner kind is resolved and before
`phase-start`. Its payload is three bounded primitives — the backend kind, its containment
classification, and the setting's value as read at that emission.

**Why there, and not at admission or at construction.** The same argument that put the refusal at
`createBackendRunner`: place the mechanism at the single funnel every route reaches. Every route that
can drive a run — a start, a resume, an auto-drain, a continuation — dispatches its phases through
`PhaseRunner.run`, so route coverage is structural rather than sampled. Admission alone would miss the
routes that do not pass through it; construction fires once per window per kind, which is the gap this
closes.

**What it does not do.** It does not move, weaken, or duplicate the enforcement — `createBackendRunner`
still refuses at the last point before an uncontained backend exists as an object. It adds no consent
prompt: the setting is the consent surface, and that is shape 3's recorded decision. It does not widen
or restate the containment classification, which is proven against each adapter's actual argv in
`backend-containment-policy.test.ts`.

**The posture is read fresh at each emission.** `extension.ts` reads
`allowUncontainedBackends` once at activation for the runner registry's construction-time refusal; the
emitter deliberately does **not** reuse that value, because a posture cached across the window is the
defect finding 1 of this item removed when it deleted a runner held across a posture the operator can
change. The emitter reads through an accessor, on the same never-cached pattern as the
verbose-diagnostics, fatal-signatures and auto-compact settings.

**Cardinality.** At most one entry per (run, backend kind) per extension-host activation, and never
one per phase. A run driven to completion in one activation on one backend records exactly one. A run
whose phases override the backend records one per distinct kind — recording only the first would make
the manifest sentence false for the second, which is the whole defect being removed. A run resumed
after a host restart records again, from a fresh read; the alternative is a persisted
"already recorded" flag, which is the cached posture under another name.

**Failure mode.** The entry is required evidence. An append failure raises through the same path
`phase-start` already uses, so a run cannot drive an unbounded agent unrecorded. This adds no new
failure mode: an audit writer that cannot append would fail the same phase microseconds later at
`phase-start`.

Shape 2 — the capability broker, which bounds what the agent may *do* rather than whether it may
start — remains outstanding and is unaffected by this.

The MCP and new-backend freeze the review attached to this item holds until shape 2 ships; the
review makes that ordering explicit, and shape 3 does not lift it.

## Related

- [Threat model](../security/threat-model.md) — the shipped posture as it stands, including the
  self-certification limit and where FR-R3-058 now enforces against it.
- [Backends](../operations/backends.md) — per-backend argv and the cancellation contract.
