# Live-canary cadence

**Declared**: 2026-08-27 · **Item**: `FR-R3-129` (T1489) · **Owner**: the operator holding the
checkout (see §2) · **Spec**: `specs/165-qualification-residuals-dated`

The live backend canary answers one question: *can this build still complete a real turn against the
installed CLI?* It has existed since [`FR-R3-084`](../../../docs/features/round_3/DONE_84_FR-R3-084_a_canary_with_a_live_phase.md)
and it runs when somebody runs it. This page says **when somebody should**, and who that is.

<!-- Source: scripts/backend-canary-run.mjs -->
<!-- Source: scripts/backend-qualification.mjs -->
<!-- Source: docs/release/backend-qualification-log.md -->

## 1. What already exists, and what was missing

**A freshness bound exists.** `QUALIFICATION_MAX_AGE_MS` in
`repo/scripts/backend-qualification.mjs` is the authority on how long a qualification stands, and
`npm run release:preflight` refuses a release when the newest record is absent, unreadable, undated,
older than that bound, taken against a different CLI version than the installed one, or taken before a
change under `src/runner/`, `src/parser/` or `src/contracts/backend-kinds.ts`. The number is not
repeated here; [the qualification log](../release/backend-qualification-log.md) states it once and a
test fails if that sentence and the constant disagree.

**A cadence did not.** The bound is enforced *at a release* and deliberately not on `gate` or `ci`,
because a live turn costs the operator's own subscription quota and a gate that charges a turn per run
is a gate people disable. That is the right trade and it leaves a real gap, which the audit of
2026-08-27 named: parser fixtures stay green after an upstream CLI changes its wire behaviour, and
nothing says when anyone would notice.

## 2. The owner

**The operator holding the checkout.** Not a team, not a rotation, and the reason is not modesty: this
product has no hosted CI ([`FR-R3-099`](../../../docs/features/round_3/DONE_99_FR-R3-099_actions_retired_by_decision.md)
retired Actions by decision) and no shared credential. A canary run spends *someone's* subscription
quota, and the only person who can spend it is the person whose credentials are installed. Naming a
committee would be naming nobody.

The practical consequence: **an operator who has not run the canary should not make a qualification
claim.** That is the whole obligation, and §3 says when it bites.

## 3. The cadence

| When | Obligatory? | Why |
|---|---|---|
| **Before any release** | **Yes, already enforced** | `release:preflight` refuses a stale record. Nothing new here; this row exists so the table is the whole picture. |
| **Before any backend-version qualification claim** | **Yes** | This is the rule `FR-R3-129` adds. If a document, a release note or a commit message is about to say this build works with CLI version X, a fresh record against version X is what makes that a claim rather than an assumption. `release:preflight` already refuses a record taken against a different CLI version, so the mechanism exists — what was missing is the obligation outside a release. |
| **After any change under `src/runner/`, `src/parser/`, `src/contracts/backend-kinds.ts`** | **Yes, already enforced** | Same preflight rule. Those are the three trees whose fixtures can stay green while wire behaviour moves. |
| **On upgrading an installed backend CLI** | **Yes** | The upgrade is the event the fixtures cannot see. One run, immediately after, is the cheapest moment to find out. |
| **Otherwise, monthly** | **Recommended, not enforced** | A month is chosen against the 14-day release bound: an operator who releases at all is already running it more often than monthly, so this row only binds a checkout that has gone quiet. Nothing enforces it, and nothing should — see §4. |

## 4. The cost bound, and why the monthly row is not a gate

**One run is one turn per backend**, on a fixed trivial prompt, with a 120-second wall-clock deadline
per turn and no workspace mutation. That is the bound: three turns for three backends.

The `--record` mode, `npm run canary:record`, is the costlier run, not a cheaper one: it re-records
every case of the canary corpus. The threat model states its cost in turns and
[the decision](../security/threat-model.md#injection-corpus-recorded-on-demand-never-per-release--2026-10-02)
that keeps it off every release. What costs nothing is the replay:
`tests/unit/build/canary-live-records.test.ts` reads the committed recordings through the host's
parsers inside `npm run gate`, which answers "does the parser still handle what we last saw". Until
2026-10-02 this paragraph said the `--record` mode was that replay; it spends live turns.

The monthly row is a recommendation because the alternative is worse. A scheduled gate that spends the
operator's quota without being asked is a gate that gets disabled, and a disabled gate is a cadence of
never. An obligation attached to a *claim* — §3's second row — costs nothing until someone is about to
assert something, which is exactly when it should cost something.

## 5. The first run under this cadence is OWED

**No live canary run was performed by `FR-R3-129`**, and this page does not imply one was. A live turn
spends the operator's subscription quota; the repository audit of 2026-08-27 deliberately did not spend
it, and this cycle did not either.

<!-- canary-review-date: 2026-12-11 -->

**Trigger for the first run**: whichever of these comes first —

1. the next backend-version qualification claim, per §3;
2. the next upgrade of an installed backend CLI;
3. **2026-11-27**, whether or not either has happened.

**A trigger was wrong here, and correcting it is worth more than the correction.** This list used to
open with *"the next `npm run release:preflight`, which will demand it"*. It does not.
`scripts/require-local-gate.mjs` contains **zero** occurrences of "canary" — the sentence described a
mechanism that was never built, in a document whose entire subject is recording an obligation
honestly. That is the class this round closed seven times in `FR-R3-124`…`132`, written by the cycle
that closed one of them.

**What the preflight actually does**, which covers two of the three triggers under a different name:
`decideQualification` refuses a release on `version-drift` (an installed CLI moved),
`runner-changed-since-qualification`, `stale-qualification` (the record aged past its freshness
bound) and `no-qualification`, each with a named override that prints `RELEASING UNQUALIFIED`. So
triggers 1 and 2 above **are** enforced at release time; they were simply attributed to the wrong
script.

**A fourth preflight binding was considered and declined.** Making the preflight refuse specifically
on a missing canary would be redundant with a refusal that already fires on the same events, and it
would spend the operator's live quota on **every** release — the cost this round twice declined to
spend. The date above is what covers the residue, on the same reasoning `FR-R3-129` used for the
platform decline: three event triggers and no date is a deferral that expires quietly, because no
gate in a repository can observe an event.

**This deferral is reviewed on or before 2026-11-27**, and
`repo/tests/lint/dated-review-records.test.ts` fails on that day until someone re-reads it. It is one
of four dated records that gate registers; before `FR-R3-134` there were three gate files each
hard-coding one document, which is how this page came to carry no date at all while its three
siblings from the same week each carried one.

**Where it lands**: [the qualification log](../release/backend-qualification-log.md), which is the
existing record and the answer to *"has the canary ever produced a result, and what did it say?"*
Nothing new is created for it.

**Amended 2026-10-19: a live run was made.** `npm run canary:record` ran on 2026-10-19 at the
operator's request and qualified claude 2.1.302, codex 0.159.2 and agy 1.4.2; the result is the
2026-10-19 entry in [the qualification log](../release/backend-qualification-log.md). Trigger 2 had
already fired: every installed CLI had moved past the versions qualified on 2026-08-26 (2.1.246,
0.149.0 and 1.1.21). The heading, the triggers and §6's first bullet are left as written on
2026-08-27, and where they disagree this paragraph is the newer statement. The review date stays, and
so does this page's entry in `dated-review-records.test.ts`: whether the run discharges the deferral
is the operator's call at that review.

### Review 2026-11-06

Feature 282 (`FR-R5-F21`) re-read this deferral ahead of its date.

- **Evidence checked**: every commit since the date was written on 2026-08-28 (`a2f97115`) to this
  page and to `scripts/backend-canary*`: eight. Two of them are the live run: `80abb7d4` adopts the
  2026-10-19 recordings of every corpus case, and `bedb6aa4` qualifies claude 2.1.302, codex
  0.159.2 and agy 1.4.2. The run is the 2026-10-19 entry in
  [the qualification log](../release/backend-qualification-log.md).
- **Still owed**: the operator's decision, at the review on or before 2026-11-27, on whether that
  run discharges this deferral, and the next live backend canary run when a trigger above fires. The
  owner is the operator, who is the maintainer.
- **The date stands at 2026-11-27.** The amendment above leaves the decision to the operator, and
  this review is not that decision, so it does not renew the date.

### Decision on 2026-11-27

The October live record discharges the original first-run obligation. On 27 November all three installed backends passed a fresh live turn through their shipped transports at `6f8cace6`. Keep distribution private. Reassess on 2026-12-11 or at the next candidate or backend upgrade, whichever comes first. The maintainer owns the evidence in [the backend qualification log](../release/backend-qualification-log.md).

## 6. What this page does not claim

- It does not claim a canary run happened. §5.
- It does not claim the preflight demands one. §5 corrects a sentence that did, and names what the
  preflight refuses on instead.
- It does not claim the monthly row is enforced. §4 says why it is not, and a recommendation stated as
  a recommendation is not a gap.
- It does not restate the freshness bound. §1 cites the constant, because a second copy of a number
  enforced elsewhere is how the two come to disagree.
- It does not claim a cadence substitutes for the real-CLI matrix, which stays opt-in. The canary
  establishes that one turn completes; the matrix is a broader question and a separate cost.

## 7. Scheduled credential-free prompt-behavior eval fixture freshness (FR-R7-18 N04)

<!-- eval-fixture-review-date: 2026-12-24 -->

Alongside the 14-day live paid canary qualification (`QUALIFICATION_MAX_AGE_MS` in
`repo/scripts/backend-qualification.mjs`, per `FR-R7-14` `14-10`), Schegent runs a deterministic,
credential-free prompt-behavior fixture replay suite (`repo/tests/evals/backend-behavior-eval.test.ts`)
inside `npm run test:evals` and `npm run gate`.

- **Coverage**: 4 stable representative behavioral tasks per advertised backend (`claude`, `codex`,
  `agy` — 12 tasks total: `structured-token`, `read-only-inspect`, `scoped-file-create`, and
  `injection-refusal`) backed by recorded CLI/ACP invocation argument and stream fixtures under
  `repo/tests/evals/fixtures/backend-behavior/`.
- **Cost & credential posture**: Zero credentials, zero network calls, zero paid provider turns.
  `npm run canary -- --fixture` and live `npm run canary` optionally attach an additive
  `behaviorEvals` summary of `manifest.json` to v2 `.backend-qualification.json` records while
  keeping live release qualification (`mode: 'live'`, 14-day bound) explicitly separate.
- **Freshness window & stale-fixture owner**: **30 days** (`maxAgeDays: 30` in
  `repo/tests/evals/fixtures/backend-behavior/manifest.json`), enforced offline by
  `backend-behavior-eval.test.ts` and tracked on the calendar by `<!-- eval-fixture-review-date: ... -->`
  via `repo/scripts/review-cadence.mjs` (`npm run review:due`) and
  `repo/tests/lint/dated-review-records.test.ts`. The stale-fixture owner is **the operator holding
  the checkout** (the same single-owner rule as §2, because hosted CI is retired under `FR-R3-099`).
- **Refresh procedure** (when `eval-fixture-review-date` comes due, when `manifest.json` ages past
  30 days, or after a backend CLI / ACP profile / transport contract update):
  1. Confirm the installed CLI versions and shipped ACP transports (`npm run canary -- --fixture`
     for credential-free bridge/native verification, or deliberate `npm run canary` when also
     refreshing live release qualification under §3).
  2. Re-verify or re-record the 12 invocation and stream fixtures under
     `repo/tests/evals/fixtures/backend-behavior/` with zero secrets, exact SHA-256 `promptDigest`
     matches, and `cliVersion`/`profileId`/`transport`/`costUnits` parity against
     `BACKEND_DESCRIPTORS` and `EXPECTED_BACKEND_TRANSPORTS`.
  3. Update `recordedAt` in `repo/tests/evals/fixtures/backend-behavior/manifest.json` (and per-task
     `recordedAt` values), advance `<!-- eval-fixture-review-date: YYYY-MM-DD -->` above by at most
     30 days, and record a short dated review note below.
  4. Verify locally with `npm run test:evals`, `npm run review:due`, `npm run security:secrets`, and
     `npx vitest run tests/lint/dated-review-records.test.ts`.
- **What this gate cannot see**: live model or upstream provider behavior drift occurring between
  refreshes. The offline replay proves contract, parser, side-effect, and fixture-freshness
  invariants against recorded fixtures; live provider turns remain deliberate under §3.

### Fixture baseline 2026-11-24

Initial 12-task behavioral fixture baseline recorded on `2026-11-24` (`claude` `2.1.302` via
`acp-stdio-bridge`, `codex` `0.159.2` via `acp-stdio-bridge`, `agy` `1.4.2` via `acp-native`).
Next 30-day freshness review is due on or before `2026-12-24`.
