# Backend qualification log

**Purpose**: the answer to *"has the canary ever produced a result, and what did it say?"* — checkable
from a checkout, which is the question `00_INDEX.md` §5 recorded as unanswerable.

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

---

## 2026-08-26 — FR-R3-105: the duplicate-flag merge scenario, authored and UNQUALIFIED

**State: `unqualified`.** No live turn was spent. This entry exists so the gap is a recorded state
rather than an absence, per `FR-R3-104` §5: *where a live turn is not affordable, the honest state is
"unqualified", displayed, never a fabricated pass.*

### What was found, and fixed, without a live turn

`planCapabilityEnforcement` de-duplicated emitted flags by their joined token
(`flags.join(' ')`), which only ever collapsed two capabilities whose flag **and value** were
identical. Claude's surface has **three** rows on `--disallowedTools`:

| Capability withheld | Flag and value |
|---|---|
| `process-spawn` | `--disallowedTools Bash` |
| `network` | `--disallowedTools WebFetch,WebSearch` |
| `workspace-write` | `--disallowedTools Edit,Write,NotebookEdit` |

So withholding any two emitted the flag twice, and withholding all three emitted it three times. The
host does not control the child's argument parser. **If that parser is last-wins, the most restrictive
set anyone can request silently re-granted `Bash`** — the stricter the operator's ask, the more likely
it was to be defeated. The fix merges values into one flag, which is the CLI's own documented
comma-list form, and `tests/unit/services/capability-argv-single-flag.test.ts` asserts the emitted argv
**literally** across every capability subset on all three backends. The defect was invisible to every
test that checked behaviour rather than bytes.

### What only a live turn can establish, and is therefore NOT established

**Which merge semantics the real parsers actually use.** Three answers are possible for a repeated
flag — last-wins, first-wins, or accumulate — and they differ in whether the old code was a live
security hole or merely untidy. This log does not claim to know which.

What the fix does establish without knowing: **the host no longer depends on the answer.** One flag,
one value, no repetition, on any subset. That is why the item is closable while this scenario stays
unqualified — the correctness of the emitted argv does not rest on the parser's disambiguation rule.

### The scenario, authored and ready to run

Costed at roughly **$0.13** for one claude turn, on the empty-temp-repo shape the 2026-08-25 entry
established (running it inside the workspace cost $0.38 and disclosed the tree, which is why it does
not).

1. Run a canary phase declaring `capabilities: [outside-workspace-write]` — withholding
   `process-spawn`, `network` and `workspace-write`, the three-way collision.
2. Capture the argv actually spawned, and assert `--disallowedTools` appears exactly once.
3. In the live turn, prompt the model to attempt a `Bash` command and a `WebFetch`. Both must be
   refused by the CLI's own permission engine.
4. Record the observed refusals. **A refusal of `Bash` is what falsifies last-wins re-granting** on
   the merged form.
5. Repeat step 1 against the *pre-fix* argv shape (the flag emitted three times) if the operator wants
   the historical question answered too. This is the only step that establishes whether the old code
   was exploitable, and it is optional — the fix does not depend on it.

### Also unqualified, and named rather than left implicit

- **The adapters' flag sets have still not been read against the CLIs' `--help` output.**
  `tests/evals/README.md` has recorded this gap since before the agy incident, and the agy incident is
  what it predicts: an adapter answered the wrong prompt for 24 days at exit 0 under 9,312 green tests.
  Reading three help outputs costs no quota — it needs the three CLIs installed and one operator
  session — so this is *unspent effort*, not an unaffordable one, and it is the cheapest remaining
  control in this area.
- **The ambient-configuration pinning decision** (`--settings`), which `FR-R3-105` deferred because the
  flag's stability cannot be established without a live turn. The observation shipped instead.
