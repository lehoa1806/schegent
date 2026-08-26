# Backend qualification log

**Purpose**: the answer to *"has the canary ever produced a result, and what did it say?"* — checkable
from a checkout, which is the question `00_backlog_verification_gaps_plan.md` recorded as unanswerable.

**Produced by**: `npm run canary` · **Decided**: `FR-R3-084` §3.5, amended 2026-08-26

**Moved 2026-08-26** from the planning envelope's `docs/release/` to here. It is evidence produced by a
script in this repository and read by whoever holds the checkout, which is what `AGENTS.md` places under
`repo/docs/`; it also sits beside `canary-credential-request.md`, which records the same episode. The
feature item's link had always pointed here, so the move fixed a broken link rather than creating one.

---

## Why this file rather than a public page

§3.5 asked for the result *"somewhere a reader without repository access can see."* That phrasing was
**CI-shaped**: it assumed a scheduled run publishing to a dashboard. This project does not run GitHub
Actions, so there is no dashboard and no such reader — the people who consume this result hold the
checkout. Publishing to a public surface would mean pushing, which is a separate decision the operator
has taken the other way.

So the clause is amended to what actually answers its concern: a dated record, in the repository, that
a reader with the checkout can check. Recorded as an amendment rather than a completion, because the
original wording is not satisfied and pretending otherwise is the failure this round exists to remove.

## How to add an entry

Run `npm run canary` and paste its output with the date and the platform. It is a **local
qualification step** — run it deliberately before trusting a backend release, not on a schedule. An
entry is evidence that the protocol still parsed on that date, on that machine, for those CLI
versions. It is not evidence about any other date, machine, or version.

`npm run canary:record` additionally rewrites the redacted envelopes under
`tests/fixtures/canary-live/`, which the deterministic replay in
`tests/unit/build/canary-live-records.test.ts` classifies. That costs six live turns instead of three,
so it is for regenerating fixtures, not for qualifying a release.

## Entries

### 2026-08-26 · darwin (arm64, macOS 26.6.2, Node 24.19.0)

First live result ever produced. `ok` was unreachable by construction until this date.

```
[backend-canary] results
  claude: ok — version 2.1.246, live probe passed
  codex: ok — version 0.149.0, live probe passed
  agy: ok — version 1.1.20, live probe passed
```

Drift path verified non-vacuous the same day: an injected `expectedVersionPrefix` of `9.9.` produced
`drifted` on all three; correcting it produced `ok` on all three; the exit code stayed **0** through
the drifted run.

**What this entry does NOT establish**: anything about Linux, Windows, or the Node floor; anything
about cost, since no cost signal is instrumented yet; and anything about whether the agent's work is
correct, which is the corpus's standing disclaimer and is unchanged.

### 2026-08-26 (second run) · darwin (arm64, macOS 26.6.2, Node 24.19.0)

**The first run in the shape the product actually uses.** The entry above probed each CLI with the
prompt on the command line and plain-text output; the host uses stream-json and delivers the prompt on
stdin. `LIVE_INVOCATIONS` in `scripts/backend-canary.mjs` now mirrors the host, and
`tests/unit/build/canary-live-records.test.ts` checks that mirror against the real runners rather than
against this sentence.

```
[backend-canary] results
  claude: ok — version 2.1.246, live probe passed
  codex: ok — version 0.149.0, live probe passed
  agy: ok — version 1.1.21, live probe passed
```

`agy` moved 1.1.20 → 1.1.21 between runs, and the answer is now the answer to the prompt. In the first
run it was not: the host sent `-p -`, agy took `-` as the prompt, and the greeting it returned satisfied
a probe that only checked for non-empty output. See
[`DONE_agy-prompt-never-reaches-the-cli.md`](../../../docs/features/bugs/DONE_agy-prompt-never-reaches-the-cli.md).
The probe now reads the answer for the token it asked for, so that failure cannot report `ok` again.

**What this run establishes that the first did not**

- The prompt reaches the model, for all three, in the host's shape.
- A real backend envelope carrying an injected instruction and a fake status token classifies as
  `issues_remain` / `remaining_issues` — the same verdict the deterministic corpus pins for the same
  lines. Recorded for codex and agy verbatim; claude declined to emit the block, so for the default
  backend the live half classifies a refusal rather than an injection.
- **Cost is instrumented for `claude` only.** `extractInvocationUsageMetrics` returns all seven fields
  for the claude envelope and `null` for the other two: codex names its terminal row `turn.completed`
  and reports no cost at all, agy keys rows on `event` with no top-level `type`. Both DO report token
  counts, under names the parser never looks for. Filed as its own item; pinned by the replay test so
  it cannot change silently.

**A bound, printed rather than implied.** One claude turn costs **$0.13** at list price, almost all of
it cache creation. It was **$0.38** until the live turn was moved out of the workspace: run from the
repository, the CLIs loaded `CLAUDE.md`, `AGENTS.md` and git state into a two-token prompt — 38,101
cache-creation tokens, and the model quoted this feature's own plan file back with no tool call in the
envelope. The turn now runs in an empty temp git repository, which cut the cost by two thirds and is
what makes the canary's "discloses nothing about the workspace" claim true rather than aspirational.

**What this entry does NOT establish**: anything about Linux, Windows, or the Node floor; anything about
cost for codex or agy, which is the gap above; whether the agent's work is correct, which is the
corpus's standing disclaimer and is unchanged; and nothing about any date, machine or CLI version other
than these.
