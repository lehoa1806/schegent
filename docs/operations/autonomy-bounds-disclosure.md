# Autonomy bounds — what stops an unattended run

**Status**: current. Every figure in the tables below is **derived** from the constant or
manifest default that enforces it; `tests/lint/autonomy-bounds-disclosure-parity.test.ts`
fails if this page and the code disagree. Do not hand-edit the tables — change the
constant and regenerate.

Verification posture: as with every claim in this repository, the checks behind this page
were verified locally, once, on one platform (macOS/darwin). See
`docs/architecture/release-posture-engineering-preview.md`.

## Why this page exists

Before 2026-08-27 every bound on an unattended run was **time- or count-shaped**:
iterations, retries, idle time, wall-clock time. Spend was *recorded* — the metrics rollup
accumulated `costUsd` and validated it — and no code path ever read it to refuse, pause or
warn. An operator reading four caps could reasonably conclude a run was bounded, and be
wrong about the one bound that costs money. Invocation counts stop correlating with spend
as soon as context grows, so a pathological run could burn budget at full speed inside
every cap that existed.

`FR-R3-112` added the spend bound. This page lists the whole set, so the shape of what is
bounded is visible rather than inferred.

## The bounds

| Runaway | Default bound | On crossing | Derived from |
|---|---|---|---|
| A phase that never converges | 10 iterations | force-advance or fail, per the phase | `schegent.loop.maxIterations` |
| A failure that repeats | 5 delayed retries | pause, resumable by the operator | `DELAYED_RETRY_CAP` in src/contracts/retry-bounds.ts |
| A child that stops producing output | 1.5 h idle | the invocation is terminated | `schegent.invocation.idleTimeoutSeconds` |
| A chatty child the idle window never catches | 6.0 h wall clock | the invocation is terminated | `schegent.invocation.maxDurationSeconds` |
| Spend, on a backend that reports cost | no bound by default; USD, per run | pause, resumable; **never** a terminal transition | `schegent.spend.maxUsdPerRun`, or `spendBoundUsd` on a Phase |
| Spend, on a backend that reports tokens and no cost | no bound by default; tokens, per run | pause, resumable; **never** a terminal transition | `schegent.spend.maxTokensPerRun`, or `spendBoundTokens` on a Phase |

**The spend bound ships unset, on purpose.** A shipped default would pause existing
operators' runs on upgrade, and a bound arriving as a surprise mid-run is worse than no
bound. The mechanism is present, documented and derived into this table; its default is
"no bound", and this row says so rather than leaving a reader to assume otherwise.

## Which denomination applies where

A single number cannot carry two units. `claude` reports a cost; `codex` and `agy` report
tokens and **no cost at all** — `FR-R3-098` left cost absent there rather than derived,
because a dollar figure computed from token counts and a hard-coded rate table would put a
fabricated number in an evidence record. So the bound in force follows what the backend
reports:

| Backend | Reports | Spend bound in force |
|---|---|---|
| `claude` | cost and tokens | `schegent.spend.maxUsdPerRun` (USD) |
| `codex` | tokens only | `schegent.spend.maxTokensPerRun` (tokens) |
| `agy` | tokens only | `schegent.spend.maxTokensPerRun` (tokens) |

Set the denomination that matches the backend you run. Setting only the dollar bound while
running `codex` bounds nothing — which is why this table exists rather than a sentence
saying "the bound is denomination-aware".

## What crossing the spend bound does

1. The run **pauses** through the ordinary operator-resumable pause, with cause
   `spend-bound-reached`. The dashboard's phase badge reads **Spend bound reached**.
2. A notice names the measured spend and the bound it reached, so the choice between
   raising the bound and investigating the run is informed.
3. **Nothing is cancelled and nothing is discarded.** There is no terminal transition: an
   operator returning to a paused run has lost time; to a failed one, possibly work.
4. Resume from the dashboard or `Schegent: Resume`, exactly as for any other pause.

The bound is evaluated at a phase boundary, against the `phase-end` audit record that
carries the usage — the same record an operator reads and `npm run audit:verify` chains.
Spend cannot be observed mid-turn, because no backend reports it until the turn ends, so
the overshoot is at most the phase that crossed the bound.

## Per-phase overrides

A Phase may declare `spendBoundUsd` or `spendBoundTokens`, which override the workspace
default while that phase runs. Precedence is per denomination and independent: a phase
declaring only a token bound keeps the operator's dollar bound rather than clearing it.
See `docs/features/custom-phases.md` for the authored field table and its bounds.
