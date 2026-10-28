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
| A chatty child the idle window never catches | 6.0 h wall clock | an approach is recorded at 80% of it, then the invocation is terminated | `schegent.invocation.maxDurationSeconds` |
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

A host restart does not hand a run its whole bound again. At activation the tally of every live
run is rebuilt from the `phase-end` rows in the last 2 MiB of `.schegent/audit.log`. Nothing is
evaluated or paused while it is rebuilt, so a tally the rebuild leaves over the bound pauses its
run at the run's next phase boundary. Rows before that window, or in an archived log, are not
counted, which understates. A run the operator resumed past its bound before a restart pauses
once more at its next phase boundary. A resumed Claude session's first row after a restart
records only its own cost, because the run keeps the session's cumulative cost beside its id.
Rows written before this release, by a resume after a restart, count a session's earlier cost
again, and so does the first resume of a run persisted before it. Such a run can pause early,
once per host session.

## What the spend bound reads, and the period it did not

**A pause at a phase boundary, never a ceiling inside an invocation.** The bound reads the
`phase-end` record of a phase that has already finished and been paid for. No backend reports
spend until its turn ends, so a Run that crosses the bound overshoots by at most the phase that
crossed it, and nothing stops an invocation partway.

**The denomination is the backend's, not the figures'.** The bound compares a Run's total with the
limit in the unit the ended phase's backend reports: USD for `claude`, tokens for `codex` and `agy`
(the table above). A limit in that unit with no recorded figure in it is **not measurable**, and an
unmeasurable Run is never read as within its bound. The operator is told once per Run per unit in a
host session, in a notice that names the unit and says the usage is not reported by that backend,
with no amount. No price is inferred and nothing is converted between cost and tokens.

**The period in which a configured bound did not act.** The audit writer has recorded a phase's
usage nested under `metrics` since 2026-08-02 (`159ba0cd`). The spend bound was added on 2026-08-27
(`13f54fc3`) and read only the flat keys of the record from then until feature 240 (FR-R4-F02), so
**in that period a configured spend bound read every real record as unmeasurable and never paused a
Run.** The metrics rollup read the flat cost key from 2026-08-01 (`31ce9337`), so its per-phase and
per-task cost missed nested cost from 2026-08-02. The dates are the first commits that contain
each read, found with `git log -S` on the reading expression.

**Nothing is back-filled.** The rollup is read from the audit log each time, so a record that carries
cost now shows it, and a phase that never reported a cost shows **not measured** where it showed
nothing or a partial sum. No cost is estimated for a period in which none was recorded, and a total
that is missing is shown as missing, never as `$0.00`.

**A restart keeps a Run's spend, or says it could not.** When the host restarts with a Run still in
flight, Schegent rebuilds that Run's total by reading the audit log and its rotated archives, newest
first, up to 8 MiB in all, and stopping once it reaches a record from before the Run began. The read
only reads: it writes, truncates and removes nothing. A Run comes back with a **complete** total,
or with the reason the total is only a **lower bound**, in plain words: the read hit its 8 MiB limit
before reaching the start of the Run; the older archive that held the start is gone; a log file could
not be read; a line in the Run's span was unreadable; or a record was written by a newer version of the
tool than this one. An incomplete total is shown as not trustworthy and still pauses the Run at the
bound, because a lower bound that is already at or over the limit is a measured crossing. Below the
limit it is never reported as within budget; the operator is told once per Run per unit in a host
session that the history is incomplete, with no amount. Log retention (`FR-R4-F04`) can turn a total
incomplete by deleting the archive that held a Run's start; it can never make a total smaller than
what was read. Nothing about this is stored: a restart repeats the read, so it may repeat the notice.

## Where each limit comes from

The table above lists the **default** bounds. The settings behind them (`schegent.loop.maxIterations`,
the two invocation timeouts, `schegent.retry.forceContinueOnCap` and the two spend bounds) are
resource-scoped, so a trusted workspace or a workspace folder may set them as well as the user's own
settings (the two spend bounds are read for the workspace as a whole, so a folder's value does not
apply to them). **That is accepted behaviour:** a workspace you have chosen to trust may tighten or
loosen the bounds a Run is held to, and the page you are reading cannot say which it did.

So each Run shows the limits it actually runs under, in the Run's detail view: the iteration cap, the
idle and wall-clock timeouts, the retry cap and what happens at it, and the spend bound with its unit.
Beside each is where it came from, in one of five fixed phrases: **default**, **user settings**,
**workspace settings**, **folder settings** or **this Phase**. The value shown is the value execution
uses: it is worked out by the same functions, from the same settings reads, and from the Phase as it
was frozen when the Run started, so a Phase edited afterwards does not change it. The retry cap is a
constant in the product and is always shown as **default**. A Phase that sets no spend bound in its
backend's unit shows "No spend bound applies to this Phase's backend." A bound whose spend cannot be
fully measured is shown with a warning that it is not trustworthy. Nothing a setting says reaches that
view as text: only numbers and the five phrases do, so a setting cannot put a path, a secret or markup
into it.

Narrowing these settings to the user scope only would be a separate, reviewed change with a migration
for the workspaces that set them today. This feature does not make it.

## Per-phase overrides

A Phase may declare `spendBoundUsd` or `spendBoundTokens`, which override the workspace
default while that phase runs. Precedence is per denomination and independent: a phase
declaring only a token bound keeps the operator's dollar bound rather than clearing it.
See `docs/features/custom-phases.md` for the authored field table and its bounds.
