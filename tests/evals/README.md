# The backend outcome corpus

**This corpus measures parser coverage. It is not behavioral qualification, and it must not be
cited as such.**

FR-R3-061 added this file because the distinction was being lost. The corpus is a versioned,
deterministic set of **10 cases** (`fixtures/backend-outcomes.json`), and the suite around it reports
**18 passing tests** — the extra eight are structural meta-assertions about the corpus itself, not
additional cases. That tally is asserted by the suite against its own test declarations (FR-R3-067), so
adding a test moves both sides at once; it read 13 for a while because `FR-R3-061` added two
meta-assertions in the same change that wrote this sentence. Which counts in this corpus are checked, by
what, and which were deliberately left uncounted is recorded in
[Counts the round-3 documents assert](../../docs/operations/asserted-counts-sweep.md). A review cited the suite as evidence that backend behaviour was qualified. It is
not evidence of that, and cannot be.

## What it does cover

Given a recorded stdout/stderr and exit code, does the host classify it the same way it did
yesterday? The corpus exercises:

- `parseInvocation` and `parseAuditLogBlock` — the shape of what the backend emitted.
- `detectCreditError` — credit and rate-limit recognition.
- `mapOutcome` / `mapTerminationReason` — outcome classification.
- `failClosedOnTruncatedOutput` — the truncation arm.
- `resolveSessionDispatch` — session continuation policy.

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

## Where behavioral qualification lives

`.github/workflows/backend-canary.yml` — scheduled, off the PR path, and non-blocking by design.
It probes real CLI versions and protocol shape where credentials are available, and **degrades to a
version probe and says so in its output** where they are not. Its failures are findings to file, not
gate reds: making PRs depend on a third-party service is exactly what the review warned against.

Adding a case here is welcome and does not change any of the above. The corpus can be exhaustive
about parsing and still say nothing about behaviour.
