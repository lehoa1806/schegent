# IPC validator fuzz: the hazard map

**Captured**: 2026-09-06 · **Feature**: 207 (`FR-R3-168`) · **Tree**: `repo/` at `b5b015d1`

**Refresh obligation**: whoever next changes example coverage of `validateInboundMessage` — adds a
test that drives a new hazard shape at it, or deletes one that drove an old shape — refreshes the
verdict table below in the same change. This page is the reason the property test does not re-prove
what nineteen example files already prove; a stale verdict quietly makes the property redundant in
one direction and blind in another, and neither shows up as a failure.

**Produced by**: `tests/unit/contracts/runtime-validators.property.test.ts` and the survey recorded
here. The property owns every count it can compute — the size of the derived command set, the number
of hazard classes exercised, the number of distinct refusal reasons a run reached. Those are
assertions in the file, not sentences on this page.

---

## What the map is for

The filing `FR-R3-168` names six classes of adversarial input and asks for property-based evidence
across all six. Before writing that property it is worth knowing which classes the existing suite
already drives at the validator, because a property that re-proves example coverage costs wall clock
and buys nothing. This page records that survey and what it decided.

A class counts as covered only where a test drives **that shape at `validateInboundMessage`**. The
string appearing somewhere in the tests tree does not count: `NaN` appears in twenty-seven files, but
in only two of them does it reach this validator.

---

## Two facts about the shape of the refusal surface

These shape the generator more than any individual class does.

**The three front-door guards.** `validateInboundMessage` (`src/contracts/runtime-validators.ts`)
refuses on three conditions before it reaches its `switch`: the input is not an object
(`not-an-object`), `type` is not a string (`missing-or-non-string-type`), and `correlationId` is
absent, empty, non-string or longer than `CORRELATION_ID_MAX` (`invalid-correlationId`).

**Everything else sits behind them.** Measured on this tree on 2026-09-06: 156 `fail()` call sites
across the validator and the seventeen modules in `src/contracts/validators/`, resolving to 39
distinct `reason` strings. No test computes those two numbers, so they are stated here; they are a
dated measurement and will drift as the contract grows.

The consequence is the whole reason the generator has two tiers. A generator that produces a random
`type` and a random `correlationId` will satisfy both guards essentially never, so a naive fuzz run
dies at guard one or two on almost every iteration and reports green having exercised three of the
39 reasons. The property therefore generates a **well-formed envelope** for most cases and injects
the hazard *behind* the guards, and asserts a floor on the number of distinct reasons a run reached
so that a future edit cannot silently return it to hitting the doormat.

---

## The six classes and their prior coverage

| Class | Prior coverage | Evidence | What the property must therefore add |
|---|---|---|---|
| `type-confusion` | **partial** | `tests/unit/ui/sidebar/ipc-validator.test.ts:139-140` drives `null` and `'string'` | Those two hit the envelope guard. Nothing drives a non-object where a *payload* is expected, behind the guards. |
| `structural` | **partial** | length bounds only: `tests/contract/history-rerun-uses-launch-path.test.ts:261`, `tests/contract/continue-workflow.test.ts:272,282`, `tests/contract/metrics-run-scoped-read.test.ts:288` | Depth, sparse arrays and cyclic objects are undriven. Long strings are covered on chosen fields, not as a class. |
| `prototype-shaped` | **none** | no `__proto__`, `Object.defineProperty` or `Object.create` appears in any of the nineteen | The whole class. See the construction note below — this is the class most likely to be written inert. |
| `unicode` | **none** | no `normalize`, NFKC, surrogate or `\uXXXX` escape appears in any of the nineteen | The whole class, including a normalisation collider derived from a real command name. |
| `numeric-boundary` | **partial** | `tests/contract/continue-workflow.test.ts:254` (`-1`, `1.5`, `'3'`, `null`, `NaN`), `tests/unit/contracts/sidebar-ipc-start-intent.test.ts:134` (`NaN`) | `Infinity`, `-0`, `2 ** 53` appear nowhere in the nineteen. Coverage is per-field, on two fields. |
| `unknown-key` | **partial** | `runtime-validators.phase-log.test.ts:107`, `runtime-validators.uncontained-grant.test.ts:104`, `launch-pipeline.test.ts:113` | Hand-written per command. Nothing derives a near-miss key by mutating a real member, and nothing sweeps the set. |

Three classes have literally no prior coverage at this validator. That is the finding the survey was
run to produce, and it is why the property is worth its wall clock.

---

## Two construction notes the survey produced

**A prototype key planted with an object literal is not a key.** `{ __proto__: x }` is
prototype-assignment syntax: it sets the object's prototype and creates no own property, so
`Object.keys` returns `[]`. `hasUnexpectedKeys` (`src/contracts/validators/shared.ts:73-78`)
iterates `Object.keys`. A generator built on the literal form would run its full iteration budget
containing no prototype-shaped key at all and pass, with no outward sign that the class was inert.
The property plants these keys with `JSON.parse` on a constructed JSON string, or with
`Object.defineProperty(o, k, { value, enumerable: true })`.

**A failure renderer must not be a bare `JSON.stringify`.** Measured on this tree, it throws on all
three shapes this property deliberately generates: a cyclic object (`TypeError`), a `BigInt`
(`TypeError`), and an object with a throwing getter (the getter's own error propagates). A renderer
that throws destroys exactly the case that mattered — the run goes red on the renderer instead of on
the finding, and the input is unrecoverable.

---

## What the property does not cover

Stated so the map is not read as claiming more than it does. The property drives
`validateInboundMessage` only: not the host→webview direction, not the audit or transcript sinks,
not CLI argv, and never a live webview or the real message router. It asserts that a result comes
back well-shaped and that the validator never throws; it never asserts that a given input is
*accepted*. Widening the unit under test would make a failure unattributable, which is the reason
the boundary is drawn here rather than one layer out.
