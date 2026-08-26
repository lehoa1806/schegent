# Canary credentials: a request WITHDRAWN, and the live phase that replaced it

**Raised**: 2026-08-25 · **Withdrawn**: 2026-08-26 · **Feature**: 155 (`FR-R3-084`)
· **Decision owner**: the repository operator

> **This request is withdrawn. Nothing is being asked for.**
>
> It rested on a premise that was wrong: that a live canary needs API keys. It does not. These
> backends authenticate by **subscription**, and the live phase now runs on that — no secret, no
> repository variable, no new plumbing. The itemization below is kept for the record, struck through
> in effect, because a withdrawn request is more useful than a deleted one: the next person to
> reach for an API key should be able to see that this was considered and why it was not needed.

## What was wrong, in two steps

**First, the canary asked whether an API key was set.** `credentialPresent` was
`process.env.ANTHROPIC_API_KEY?.length > 0` and its siblings. On the machine this product is
developed on that is false while the truth is true: `claude auth status` reports
`authMethod: "claude.ai"`, `codex login status` reports "Logged in using ChatGPT", and no `*_API_KEY`
variable exists anywhere. The canary therefore reported `skipped-no-credentials` **forever**, on a
machine where a live turn succeeds on the first try — and this document asked an operator to create
three live credentials to fix a problem that did not exist.

**Second, the fix for that substituted a different proxy** — ask each CLI whether it is signed in, via
`claude auth status`, `codex login status`, `agy models`. Wrong the same way. `agy models` answers
*"Please sign in to view available models"* — a statement about model-listing permission — while
`agy --print` completes a turn perfectly. The probe reported a working, authenticated backend as
unauthenticated. A false negative one step after fixing a false negative.

**So there is no auth probe.** The only non-proxy answer to *"can this backend complete a live
turn?"* is to attempt a live turn. That is what the canary does now.

## The qualification run

Recorded because `FR-R3-084` §3 requires the version pin to be **derived, not guessed**, and because
a live phase that has never run is exactly what that item forbids shipping.

**2026-08-26**, `darwin`, one machine, run by hand before the code was committed:

```
[backend-canary] results
  claude: ok — version 2.1.246, live probe passed
  codex: ok — version 0.149.0, live probe passed
  agy: ok — version 1.1.20, live probe passed
```

`ok` was previously unreachable by construction. This is the first time any backend has reached it.

**No expected-version prefix is enforced from this run**, and that is deliberate. One observation on
one machine is not a qualified baseline — it is the versions that happened to be installed, which is
precisely what §3 warns against — and pinning a prefix from it would make every routine CLI update
report drift. Drift detection stays structural until there is a qualification run worth pinning to.

## What is still true about CI

A scheduled GitHub Actions runner has no subscription session: no `~/.claude` credentials, no browser
to sign in with. So the live phase is expected to report `skipped-not-authenticated` there, which is
**the honest answer** rather than the wrong one it used to give. Running the canary live in CI would
need credentials — that is the only surviving reason to revisit the itemization below, and it is a
convenience, not a blocker. The local run above is what establishes the protocol still parses.

---

## The credentials

Each row is one repository secret. The environment variable names are the ones
`repo/scripts/backend-canary-run.mjs` already reads — no new plumbing is proposed.

| Secret | Backend | Env var read | Minimum scope needed | Read by | What a leak costs |
|---|---|---|---|---|---|
| `CANARY_ANTHROPIC_API_KEY` | `claude` | `ANTHROPIC_API_KEY` | A key that can complete **one short single-turn message**. No Files, no Batches, no admin. Lowest available spend cap; a dedicated key, never the one a human uses. | `.github/workflows/backend-canary.yml` only | Model spend against the owning account until revoked, and read access to whatever that key's org exposes. **Revocable in one action**, which is the reason for a dedicated key rather than a shared one. |
| `CANARY_OPENAI_API_KEY` | `codex` | `OPENAI_API_KEY` | The same: one short completion, lowest available spend cap, dedicated key. | Same workflow only | Same shape — spend, plus whatever the key's project scope exposes. |
| `CANARY_AGY_API_KEY` | `agy` | `AGY_API_KEY` | The same. | Same workflow only | Same shape. |

### Conditions this request makes on itself

1. **Scheduled workflow only.** No pull-request path, no `workflow_dispatch` from a fork, no other job.
   `backend-canary.yml` has zero branch filters and is registered in
   `tests/lint/workflow-trigger-branches.test.ts` with its reason; being off the PR path *is* the
   requirement, and `FR-R3-084` §5 says so.
2. **Three separate secrets, not one.** A single shared token would make revocation an all-or-nothing
   act and would let one backend's compromise reach the other two.
3. **Dedicated keys.** Not a key any person uses interactively. The canary's whole value is that its
   failure is boring; a key whose revocation interrupts a human makes it expensive.
4. **Lowest spend cap the provider offers.** The live phase is one turn with a fixed trivial prompt.
5. **No workspace mutation and no network target other than the provider.** The invocation is a
   protocol check, not a task.

## What is NOT being written until this is approved

**No live invocation.** `FR-R3-084` §5 is unambiguous:

> *"Do not write a live invocation that has never run. Shipping untested code into a scheduled job is
> what `61` §5 declined to do, and the reasoning has not changed: the invocation is written and run
> once by hand before it is scheduled."*

No credential exists in this checkout, so the invocation could not be run once by hand, so it is not
written. That is a **precondition on an operator action**, not an omission, and this file is where it
is recorded.

The same reasoning covers the two scenario families the source item asks for. The **fixture-based**
injection scenario belongs in the deterministic corpus, where it gates every pull request; the **live**
injection and cost scenarios belong here, after a live path exists. `FR-R3-061` §5 drew that line and
it holds.

## Why the expected-version prefix is still absent

`decideBackendState` accepts an expected-version prefix and nothing supplies one, so drift detection is
**structural** rather than version-pinned. That is deliberate and it stays that way.

Pinning a prefix from whatever happens to be installed on one machine records a **convenience as a
qualified baseline** — the number would then be evidence, and it would not be. A prefix is recorded only
from a deliberate qualification run against a stated backend release. No such run has happened.

Until one does, the honest state is *no prefix, structural drift detection*, which is what the tree
already does. `FR-R3-061` §5 established this and re-deriving it changed nothing.

## The observable result surface — designed, not activated

`00_backlog_verification_gaps_plan.md` recorded that whether the canary has ever produced a result
*"is not checkable from a checkout"* and declined to file it. With a live phase, a result becomes
something to publish.

**The design**, for whenever the credentials land:

- The scheduled run writes its per-backend states and the run date to a job summary, which is visible
  without repository write access.
- The last successful run's state and date are what a reader needs; nothing else is published, because
  nothing else would be true.
- The publication states, on every run, that a skip is a reported state and not a pass — the
  distinction `FR-R3-072` split apart, and the one a reader glancing at a green badge would otherwise
  lose.

**It is not activated.** Publishing "the canary last ran green" from a run that only ever probed
versions would be a new false assurance, which is the exact failure this whole item is a correction
for.

## What happens if this request is declined

Nothing breaks. The canary keeps reporting `skipped-no-credentials` at exit 0, the deterministic corpus
keeps gating every pull request, and this file remains the record of what was asked for and why — so
the next person to ask does not have to re-derive it.

A declined request that is written down is a decision. An un-asked question is a gap.
