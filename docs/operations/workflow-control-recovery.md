# Workflow Control Flow and Backend Recovery Runbook (`FR-R5-F35` / `SPEC-13`)

This runbook documents operating limits, backend availability checks versus counted execution trials, monitoring window renewal versus manual resume, strict monetary enforcement pauses, uncertain-effect recovery, and retained evidence for Schegent's workflow control-flow mechanisms:

1. **Standalone Phase Repetition & Exclusive Routing** (`SPEC-01`, `SPEC-02`)
2. **Candidate Recovery Blocks (`candidate-block`)** (`SPEC-03`–`SPEC-10`)
3. **Scoped Child-Workflow `Repeat` Loops** (`SPEC-11`)
4. **Sequential Child-Workflow `ForEach` Loops** (`SPEC-12`)

For importable Process YAML examples of each mechanism, see [`examples/workflow-control/README.md`](../../examples/workflow-control/README.md). For the IPC and headless command schemas, see [`docs/reference/api-and-cli.md`](../reference/api-and-cli.md).

---

## 1. Authoritative Bounds and Defaults (`D1`)

All workflow control-flow constructs enforce closed `version: 1` bounds validated at catalog save, import preflight, and launch freeze:

| Parameter / Resource | Bound / Default | Refusal / Runtime Behavior |
|---|---|---|
| Candidates per `candidate-block` | `1..8` | Rejected at validation (`invalid-candidate-count`) |
| `maxAttempts` per candidate | `1..20` (default `3`) | Candidate retires permanently for the block occurrence after `maxAttempts` |
| `maxDispatches` per `candidate-block` | `1..40` (default `min(40, sum(candidate.maxAttempts))`) | Block stops or pauses when dispatch cap is reached |
| Root Workflow Phase dispatches | `1..100` (default `100`, tighten-only via live host setting) | Counts all leaf Phase attempts across root, candidates, `Repeat`, and `ForEach` |
| Dynamic control nesting depth | `<= 2` | Refused at freeze (`control-nesting-depth-exceeded`); static closure limits (`depth <= 8`, `definitions <= 64`, `expandedNodes <= 256`) remain independent |
| `Repeat.maxIterations` | `1..25` (default `3`), `carry` `0..32` | Exhaustion follows `onExhausted: 'pause' \| 'fail'` (`repeat-exhausted`) |
| `ForEach.maxItems` | `1..100` (default `50`) | Collection `<= 262,144` bytes; item `<= 8,192` bytes and `<= 32` primitive fields |
| `ForEach` ordered `resultIndex` | `<= 262,144` bytes | Overflow pauses with `aggregate-result-too-large` without truncating slots |
| `structured-result` payload | `<= 262,144` bytes, `1..32` fields | Strings `<= 1,024` bytes, selector depth `1..5` segments, max `32` array elements |
| `diagnostic-result` record | `<= 65,536` bytes | Strings `<= 1,024` bytes, closed `DiagnosticEventKind` / `DiagnosticSeverity` enums |
| `RecoveryEnvelope` handover | `<= 16,384` bytes, `<= 100` paths | Excess paths set `truncated: true` and `coverage: 'partial'` while preserving workspace files |
| `monitoringWindowMs` | `60,000..172,800,000` ms (`1m..48h`, default `24h`) | Expiry transitions to `monitoring-expired` (pauses and notifies once) |
| Availability check execution | `10,000` ms timeout, max `3` concurrent checks | Readiness freshness `30,000` ms; minimum check interval `60,000` ms; `0..5,000` ms deterministic jitter |
| Live control roots / frames | Max `20` roots, `1,024` frames/root, `2,097,152` bytes/root (`16,384`-byte settlement reserve), `256` observations, `160` waiters | Terminal roots evict oldest-first; active overflow pauses for operator action |

---

## 2. Unsupported-Adapter Behavior and Check-Versus-Trial Accounting (`D7`, `D8`)

Backend adapters normalize their availability signals into a common observation contract (`ready`, `cooldown-known`, `cooldown-unknown`, `unreachable`, `top-up-required`, `check-unsupported`):

- **Qualified Non-Executing Status Checks (`check-now`)**:
  - Execute read-only status probes when supported by the backend adapter.
  - Consume **zero** Phase attempts (`dispatchedAttempts` is unchanged).
  - Sponsored check costs (`costMicrousd`) are recorded against the sponsoring root's usage rollup without consuming Phase attempt budgets.
  - Never shorten an active retry backoff or the 60-minute hard-credit fallback floor.
- **Counted Execution Trials (`try-now`)**:
  - When an adapter declares `check-unsupported` (or availability remains `unknown`), automatic recovery never guesses readiness from wall-clock elapsed time alone.
  - A candidate with `allowUnverifiedTrial: true` may run a bounded execution trial.
  - Every execution trial goes through full atomic admission (`ControlAttemptAdmissionService`), consumes **one** Phase attempt (`dispatchedAttempts + 1`), acquires all required quota permits, and respects unexpired `notBefore` deadlines.
- **Top-Up Required (`top-up-required`)**:
  - Treated as requiring manual operator recovery (`intervention-required`) unless another eligible candidate in the block can proceed; never coerced into an automatic timer reset.

---

## 3. Monitoring Window Renewal Versus Manual Resume (`D8`)

Schegent separates **monitoring window renewal** from **execution resumption** so operators retain explicit control over stalled or rate-limited runs:

| Control Action | Legal Frame States | Operational Effect |
|---|---|---|
| `renew-monitoring` | `selecting`, `retry-delayed`, `waiting-availability`, `intervention-required`, `monitoring-expired`, `paused` | Extends the automatic status-check window (`monitoringExpiresAt`) from the current wall clock and increments `monitoringRenewals`. Does **not** replenish retired candidate attempt counters or bypass `notBefore` deadlines. |
| `resume` | `paused`, `intervention-required`, `monitoring-expired` (when monitoring is active or a candidate is ready) | Clears manual pause or acknowledged intervention state and re-evaluates the current control frame. If the monitoring window is expired and no candidate is ready, `resume` is refused with `monitoring-expired` until the operator renews the window or selects a ready candidate. |
| `select-candidate` | `selecting`, `retry-delayed`, `waiting-availability`, `intervention-required`, `monitoring-expired`, `paused` | Appends a revision-fenced `ControlPolicyOverrideRecord` selecting an eligible non-retired candidate (`remainingAttempts > 0`). Never resets prior attempt counts or cumulative spend. |
| `set-policy` | `selecting`, `retry-delayed`, `waiting-availability`, `intervention-required`, `monitoring-expired`, `paused` | Switches between `first-ready`, `wait-for-selected`, and `stop-on-unavailability` via an append-only policy override. |
| `set-allowed-candidates` | `selecting`, `retry-delayed`, `waiting-availability`, `intervention-required`, `monitoring-expired`, `paused` | Restricts automatic selection to a non-empty subset of authored `candidateId`s (`1..8`). |

---

## 4. Strict Monetary Bounds and Unknown-Price Pauses (`D6`)

When a Candidate Block or root Workflow configures `budget.mode: 'strict-usd'` (`limitMicrousd`):

1. **Pre-Dispatch Reservation**: Before admitting any attempt, the admission service requires a verified or bounded upper-bound cost estimate (`upperBoundMicrousd`) and checks `settledMicrousd + reservedMicrousd + upperBoundMicrousd <= limitMicrousd`.
2. **Unverifiable Spend Pause (`spend-unverifiable`)**: If the selected backend/model lacks pricing telemetry or cannot bound the attempt's cost before dispatch, automatic admission pauses with `spend-unverifiable`. Switching to another candidate or backend cannot downgrade a `strict-usd` root into `count-only` mode.
3. **Post-Attempt Spend Limit (`spend-limit-reached` / `spend-bound-exceeded`)**: If settled usage reaches or exceeds `limitMicrousd` (or an attempt settles without verified USD telemetry under `strict-usd`), subsequent candidate dispatches, `Repeat` passes, or `ForEach` items pause before the next admission boundary.
4. **Explicit `count-only` Mode**: Enforces attempt/dispatch caps (`maxAttempts`, `maxDispatches`, root `100`-dispatch cap) and discloses in the UI (`CandidateBlockInspector`) that monetary enforcement is not active while still recording observed token/cost telemetry.

---

## 5. Uncertain Effects, Workspace Handover, and Crash Recovery (`D4`, `D5`, `D9`)

- **Attributable Workspace Handover (`RecoveryEnvelope`)**:
  - Before a fallback candidate starts, Schegent captures a bounded `RecoveryEnvelope` comparing the workspace against the pre-attempt checkpoint.
  - Preexisting dirty and untracked files are preserved byte-for-byte. Schegent **never** runs `git reset --hard`, `git checkout --`, `git clean`, or automatic stash/rollback during candidate handover.
  - Each candidate starts in a fresh backend session with its own Phase instruction contract.
- **Ambiguous Spawn or Uncertain External Effects (`uncertain-effect`)**:
  - If the host crashes after recording `spawn-intent` (`stage: 'spawn-intent'`) or after a process produces unattributed/non-idempotent side effects without a clean terminal marker, recovery transitions the frame to `intervention-required` (`pauseCause: 'uncertain-effect'`).
  - Held quota permits enter `held-uncertain` and are **never** released by fake-clock or wall-clock expiry alone; they release only after confirmed process teardown or explicit operator resolution.
- **`Repeat` and `ForEach` Recovery**:
  - **`Repeat`**: Evaluates `until` only on the current completed pass's validated `decisionResults`. Failed passes never reuse prior-pass `decisionResults`. Recovery resumes at the exact persisted pass boundary (`before-child-return`, `after-child-return-before-eval`, `after-eval-before-advance`, `after-advance-commit`) without replaying completed passes.
  - **`ForEach`**: Freezes the input collection bytes, SHA-256 digest, and item keys at invocation entry. Subsequent edits to the source file on disk do not alter remaining items. Under `onItemError: 'continue'`, terminal child failures are recorded in their slot (`state: 'failed'`) and never replayed on restart; authoritative host/uncertainty conditions (`uncertain-effect`, `trust-denied`, `manual-pause`, `spend-limit-reached`) still pause or halt immediately.

---

## 6. Retained Protected Evidence and Privacy Boundaries

- **Evidence File Modes**: All frozen collections, ordered `ForEach` result indexes, `RecoveryEnvelope` artifacts, and structured result files are written inside contained workspace roots using narrow permissions (`0600` for files, `0700` for directories).
- **Metadata-Only Audit by Default**: Ordinary audit events record occurrence IDs, workflow/node/candidate IDs, generation numbers, counters, and closed reason codes. Prompts, raw CLI transcripts, workspace file bodies, and raw error strings are excluded from ordinary audit payloads, and all operator-visible error summaries pass through `redactForAudit` with strict byte caps (`<= 512` UTF-8 bytes).

