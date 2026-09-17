# The backend outcome corpus

**This corpus measures parser coverage. It is not behavioral qualification, and it must not be
cited as such.**

FR-R3-061 added this file because the distinction was being lost. The corpus is a versioned,
deterministic set of **34 cases** (`fixtures/backend-outcomes.json`), and the suite around it reports
**47 passing tests** — the extra thirteen are structural meta-assertions about the corpus itself, not
additional cases. That tally is asserted by the suite against its own test declarations (FR-R3-067), so
adding a test moves both sides at once; it read 13 for a while because `FR-R3-061` added two
meta-assertions in the same change that wrote this sentence. Which counts in this corpus are checked, by
what, and which were deliberately left uncounted is recorded in
[Counts the round-3 documents assert](../../docs/operations/asserted-counts-sweep.md). A review cited the suite as evidence that backend behaviour was qualified. It is
not evidence of that, and cannot be.

## What it does cover

Given a recorded stdout/stderr and exit code, does the host classify it the same way it did
yesterday? The corpus exercises:

- `unwrapStreamJson` — the stream-json envelope, upstream of everything below it.
- `parseInvocation` and `parseAuditLogBlock` — the shape of what the backend emitted.
- `detectCreditError` — credit and rate-limit recognition.
- `classifyFatal` — fatal-signature recognition, including the two suppressions that keep a
  signature quoted inside a `tool_result` from failing a healthy phase.
- `mapOutcome` / `mapTerminationReason` — outcome classification.
- `failClosedOnTruncatedOutput` — the truncation arm.
- `resolveSessionDispatch` — session continuation policy.

How much of each is covered is not a claim made here. `verdict-enumeration.ts` enumerates the
verdict branches, the suite attributes coverage only from what the production code was **observed**
to return, and every entry no case reaches carries a written reason for why no input can reach it.
A branch that is simply unwritten cannot pass that assertion, so the gap shows up as a red test
rather than as an unstated absence in this file.

Every input is a **fixture**. Nothing here runs a CLI, opens a socket, or authenticates. That is
deliberate: the suite gates every PR, and a gate that depends on a third-party service is a gate
that goes red for reasons unrelated to the change under review.

## What it does not cover, at all

- **CLI protocol drift.** A backend that changes its stream-json envelope, its result record, or its
  exit-code conventions is invisible here until a fixture is updated by hand — which happens *after*
  someone notices in production.
- **Auth changes.** Token formats, refresh behaviour, and new failure modes on expiry.
- **Prompt and tool regressions.** The model's behaviour given the same prompt.
- **Cost drift.** Token accounting and per-invocation cost.
- **Anything about whether the agent's work was correct.** See
  `docs/security/threat-model.md` on self-certification, and `hostVerification` (FR-R3-058) for the
  mechanism that stops a Phase advancing on its own claim.

## What the enlarged corpus still does not establish

FR-R3-177 took the corpus from 11 cases to 34 and put an enumeration behind it. Seven things it
deliberately did **not** do, written here because an unnamed limit reads as an absent one:

- **Semantic drift is undetectable.** Every assertion is about classification. A backend that keeps
  its envelope, its exit codes and its termination token while changing what the text *means* passes
  this corpus unchanged, and would.
- **Leak freedom is reviewed, not gated.** No scrub gate scans the fixture for absolute operator
  paths or credential-shaped strings. Cases are synthesized and minimal so there is nothing to
  scrub; that is a property of how they are written, which a later contributor can break silently.
- **The enumeration is maintenance.** Both detectors' branches and the unwrapper's exit branches are
  hand-anchored. Add a branch to `classifyFatal` or `unwrapStreamJson` and nothing notices it is
  missing — the enumeration is derived from source only where a list exists to derive it from.
- **Minimal envelopes hide ignored fields.** A field a backend emits that the unwrapper does not read
  is absent from these cases by construction, so its disappearance upstream cannot show up here.
  That is FR-010 working as intended, and it is also a blind spot.
- **Five termination reasons are out of reach.** `deadline`, `iteration_cap`, `timeout`, `cancel`
  and `pre_spawn_refusal` are set by the run-level deadline check, the controller loop, the
  watchdog, an operator signal and a pre-spawn guard — none of which runs through
  `mapTerminationReason`. Prose here named three of the five until `verdict-enumeration.ts` counted
  them against the union; each now carries a written reason there, which is what keeps the list
  from drifting back.
- **The credit detector is fed different bytes here than in production.** `phase-runner.ts` passes
  `detectCreditError` the *raw* stdout buffer and the parser the *unwrapped* text; this harness
  passes both the unwrapped text. A rate-limit sigil that survives unwrapping is classified
  identically either way, which is why the cases hold — one that does not would diverge.
- **One fatal branch has no witness.** The whitespace-only guard in `isDiagnosticLine` is unreachable
  from `classifyFatal`, because a line carrying a signature cannot be blank. It is covered by a
  written reason, not by a case, and that reason expires if a blank pattern ever becomes registrable.

## Where behavioral qualification will live

`scripts/backend-canary-run.mjs`, invoked as `npm run canary` — off the PR path and non-blocking by
design. **No workflow declares it.** A `backend-canary.yml` did until 2026-08-26, when `FR-R3-099`
retired Actions by operator decision and deleted it, so the canary is a LOCAL QUALIFICATION STEP,
run deliberately against a backend release before that release is trusted rather than on a schedule.
The cadence that replaced the schedule is declared in
[live canary cadence](../../docs/operations/live-canary-cadence.md).

Since 2026-08-26 it **runs a live phase**: one bounded turn against each backend with a fixed trivial
prompt, reporting `ok` when the turn completes, `skipped-not-authenticated` when the CLI's own output
says it is not signed in, and `drifted` for any other failure. There is no credential and no auth
probe — these backends authenticate by subscription, and attempting the turn is the only non-proxy
answer to whether one can be completed.
Its failures are findings to file, not gate reds: making PRs depend on a third-party service is
exactly what the review warned against.

Adding a case here is welcome and does not change any of the above. The corpus can be exhaustive
about parsing and still say nothing about behaviour.
