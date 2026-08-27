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
per turn and no workspace mutation. That is the bound: three turns for three backends, and the
`--record` mode replays from fixtures at zero cost when the question is "does the parser still handle
what we last saw".

The monthly row is a recommendation because the alternative is worse. A scheduled gate that spends the
operator's quota without being asked is a gate that gets disabled, and a disabled gate is a cadence of
never. An obligation attached to a *claim* — §3's second row — costs nothing until someone is about to
assert something, which is exactly when it should cost something.

## 5. The first run under this cadence is OWED

**No live canary run was performed by `FR-R3-129`**, and this page does not imply one was. A live turn
spends the operator's subscription quota; the repository audit of 2026-08-27 deliberately did not spend
it, and this cycle did not either.

**Trigger for the first run**: whichever of these comes first —

1. the next `npm run release:preflight`, which will demand it;
2. the next backend-version qualification claim, per §3;
3. the next upgrade of an installed backend CLI.

**Where it lands**: [the qualification log](../release/backend-qualification-log.md), which is the
existing record and the answer to *"has the canary ever produced a result, and what did it say?"*
Nothing new is created for it.

## 6. What this page does not claim

- It does not claim a canary run happened. §5.
- It does not claim the monthly row is enforced. §4 says why it is not, and a recommendation stated as
  a recommendation is not a gap.
- It does not restate the freshness bound. §1 cites the constant, because a second copy of a number
  enforced elsewhere is how the two come to disagree.
- It does not claim a cadence substitutes for the real-CLI matrix, which stays opt-in. The canary
  establishes that one turn completes; the matrix is a broader question and a separate cost.
