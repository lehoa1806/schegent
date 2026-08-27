# The phase verdict default

**Decided 2026-08-27** · `FR-R3-117` · Supersedes the opt-in posture `FR-R3-058`
shipped deliberately.

## The decision

**`hostVerification` resolves to `'exit-code'` for any Phase whose resolved
`sideEffects` is other than `'none'`, or which produces a declared output.**
Explicit `'model-token'` becomes the opt-out. Omission means the resolved default.

`src/config/phase-runner-policy.ts` owns the rule. The freeze applies it.

## What was wrong

`FR-R3-058` built the mechanism and shipped it opt-in. A Phase declaring
`hostVerification: 'exit-code'` was judged on its process's exit status, and a clean
termination token could not override a non-zero exit or a timeout. A Phase declaring
nothing was judged on the model's own account of its work.

The shipped threat model stated the consequence in its own words: a timed-out process
whose output parsed clean was treated as success, and a non-zero exit alongside a clean
termination token was logged and **advanced**. A failed build, a failed test run, or a
crashed tool reported success. That was the single highest-consequence default in the
product, and it was the default.

## The three shapes, and why the middle one

**Shape 1 — leave it opt-in, document harder.** Rejected. `FR-R3-056` already settled
this argument for uncontained backends: disclosure changes informed consent, not
reachability. A document does not bound a process. `FR-R3-038` disclosed the
self-certified verdict and that was the right first step; it did not change what
happens when an agent reports success it did not achieve.

**Shape 2 — default on for load-bearing Phases, explicit opt-out for the rest.**
**Taken.** It targets exactly the Phases whose claims matter, leaves a purely advisory
Phase alone, and the migration is a resolver default plus a forward migrator — patterns
this codebase has run thirteen times.

**Shape 3 — unconditional: a non-zero exit never advances, no opt-out.** **This is the
destination**, and it is recorded here as such. It is not the first move because a
Phase that legitimately exits non-zero — a linter used as a probe, a diff check —
becomes unexpressible, and the closed-set work to express it is larger than this item.
When that work is done, shape 3 is what it should land on.

## The trigger reads the resolved value, not the wire

`FR-R3-117` phrased the trigger as *"any Phase that **declares** `sideEffects`"*. That
is not well defined against this codebase. `sideEffects` is optional on the wire and
`snapshotPhaseDef` resolves omission to `'workspace'` (FR-005), so **every** Phase has
a resolved value and none can be said to have declared nothing by the time anything
reads it. Reading wire presence would make a Phase's verdict depend on whether an
author typed a field whose omission already means something.

So the trigger is the resolved class. `'none'` is the only class that is not
load-bearing: such a Phase writes neither the workspace nor Git nor anything outside
it, so its report is advisory and judging it on exit status would break advisory
Phases for no gain.

## The blast radius, stated rather than discovered

Because `'workspace'` is the resolved default, **most existing Phases become
exit-code-judged.** That is the intent, not a side effect. `RELEASE.md` and
`docs/operations/release-notes.md` record it as breaking and name the opt-out.

## Two things that fall out of it

**The opt-out needed no new enum value.** `PHASE_HOST_VERIFICATIONS` was already the
closed pair `['model-token', 'exit-code']` with omission meaning the former. After this
change, omission means the resolved default and explicit `'model-token'` means opt out
— so the set is untouched and the validators' unknown-value refusal keeps working.

**Omission and explicit `'model-token'` stopped being interchangeable**, which they had
always been. They are now different instructions, and on a load-bearing Phase they
produce opposite verdicts. The mapper already emitted the key only when the definition
carried it — correct behaviour that nothing tested, because nothing could distinguish
the cases before. The bijection test now asserts it in both directions.

## The provenance field, and the trap it closes

The snapshot carries `hostVerificationDeclaredAt: 'default' | 'phase-definition'`,
copying `evidencePolicyDeclaredAt` (`FR-R3-096`) rather than re-inventing it.

Without it: a Phase with `sideEffects: 'none'` resolves to a stored `'model-token'`. If
that Phase's `sideEffects` later becomes `'workspace'`, the stored value reads as an
author's opt-out that **nobody wrote** — a load-bearing Phase judged on its own account
by a decision no one made. That is the FR-R3-096 hazard, pointing the other way.

## The migration preserves old plans rather than tightening them

`STATE_SCHEMA_VERSION` 13 → 14. `migrateV13ToV14()` stamps the resolved value and its
provenance into every phase of every persisted plan snapshot.

**It stamps `'model-token'` into a pre-v14 phase that declared nothing** — it preserves
the old meaning rather than applying the new default. That looks backwards for about
ten seconds, and it is not. A plan snapshot is a frozen record of what the operator
approved, and a frozen plan is never retargeted in flight — the rule the capability set
already states. Retroactively tightening an in-flight Run's verdict basis would change
the meaning of a plan after approval, invisibly: a Run resumed after the upgrade could
start failing phases its own snapshot said would advance.

The new default applies to plans frozen **after** the upgrade, where an operator can
see it and where the release notes tell them to look.

## What this does not claim

Exit status does not prove correctness. It proves the process did not report failure,
which is strictly more than the model's own account and strictly less than
verification. `docs/features/custom-phases.md` recommends an independent verification
Phase and this change does not replace that advice.

`resolveRunOutputs` still checks that a declared output **exists**, not that it is
correct. Existence remains the weakest available proxy for completion, and closing that
is not this decision.
