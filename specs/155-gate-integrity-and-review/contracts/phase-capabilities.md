# Contract: Declared phase capabilities and their enforcement

**Source item**: FR-R3-086 (posture shape 2, route A) · **Spec**: FR-065…FR-073

## What this bounds, and what it does not

It bounds **what an agent may do** during a phase, by narrowing the authority the backend CLI grants
itself. It does **not** bound the agent by observing each tool call at the host: the host declares, the
backend enforces. That limit is stated here, in the threat model, and in every operator-facing sentence
about the mechanism — a containment claim without its limits is the `R-14` class.

## The capability union (closed)

```ts
type PhaseCapability =
  | 'workspace-write'
  | 'outside-workspace-write'
  | 'process-spawn'
  | 'network';
```

Closed on purpose: the enforcement plan must be exhaustive over it, and the audit payload must be a
closed union.

## The declared set

```ts
interface DeclaredCapabilitySet {
  readonly capabilities: ReadonlySet<PhaseCapability>;
  readonly declaredAt: 'phase-definition' | 'default';
}

const DEFAULT_CAPABILITY_SET: DeclaredCapabilitySet; // every member, declaredAt: 'default'
```

**The default contains everything.** A phase that declares nothing produces the argv it produces today,
byte for byte. This is what keeps FR-072 true and what stops the change from altering any existing run.

Declared sets are frozen into the pipeline snapshot with the plan. They are never retargeted in flight,
per the existing hard rule on in-flight pipeline snapshots. Phases are addressed by `phaseIndex`, never
by `phaseId` — a sequence may repeat a phase.

## Authoring and the exchange format

A phase declares its set in the catalog (`capabilities?: PhaseCapability[]`) and in the portable YAML
document. Both validators refuse an unknown member and a repeated one rather than dropping it: dropping
yields a **narrower** set than the author wrote, and the phase is then refused at run time for a reason
invisible in the definition. The two must agree, or a definition the catalog accepts cannot survive its
own export.

**Three readings, and the middle one is why the format carries this field as a scalar.**

| Written | Means |
|---|---|
| key absent | `DEFAULT_CAPABILITY_SET` — every member granted, today's argv byte for byte |
| `capabilities: ""` | the empty set — nothing granted |
| `capabilities: "network,process-spawn"` | exactly those members |

The YAML subset this project emits writes block style only, and its one list convention is that an
**absent key reads back as `[]`** (`types.ts`, `YamlSequenceNode`). For this field that convention is
exactly inverted — absent must be the unbounded default — and a block sequence cannot write an empty
list at all. A list-shaped key would therefore turn the **most** restrictive declaration into the
**least**: a silent widening of a bound an operator approved, through an export/import path that
reports success. So the members are joined by `,` into a scalar, and the reader checks each against the
closed union above. Member order is the document's own and is not canonicalized, so the round trip is
byte-exact; order carries no meaning, because `declaredCapabilitySet` filters to a canonical order at
the point of use.

## The enforcement plan (pure)

```ts
function planCapabilityEnforcement(
  kind: BackendRunnerKind,
  declared: DeclaredCapabilitySet
): CapabilityEnforcementPlan;

type CapabilityEnforcementPlan =
  | { readonly outcome: 'argv'; readonly args: readonly string[] }
  | { readonly outcome: 'refused';
      readonly reason: 'capability-not-enforceable';
      readonly kind: BackendRunnerKind;
      readonly unenforceable: readonly PhaseCapability[] };
```

Pure: no I/O, no environment reads, no clock. Exhaustively testable over 3 backends × the capability
power set.

## Per-backend translation

Surfaces re-derived from the installed CLIs (research R10). Where a narrowing is expressed with a flag,
the flag replaces `--dangerously-skip-permissions`; where the set is the default, the current argv is
emitted unchanged.

| Backend | Full set (default) | Narrowed |
|---|---|---|
| `claude` | `--dangerously-skip-permissions` | `--permission-mode` + `--disallowedTools` naming the tools that would exercise the withheld capabilities |
| `agy` | `--dangerously-skip-permissions` | `--sandbox` (terminal restrictions) and/or `--mode` |
| `codex` | `--sandbox workspace-write` | a narrower `--sandbox` mode and/or `--ask-for-approval never` |

**Never a prompting mode.** Constitution principle I forbids an interactive halt: a capability that could
only be enforced by asking a human is treated as **unenforceable**, not as a prompt.

## Refusal

A phase whose declared set contains a capability the chosen backend cannot express is **refused before
it starts**, listing every unenforceable capability rather than the first. The refusal is:

- a **Run-level** outcome with a named cause, distinguishable from a phase failure;
- accompanied by the `capability-refused` audit event declared in `src/contracts/audit-events.ts`;
- never a silent downgrade to the full set. Running with the declared set ignored is the fence problem
  again.

## Audit events

Two, and the second was missing at first. A refusal was recorded and a **grant** was not, so a Run whose
phase declared a narrowed set and ran successfully left nothing in evidence saying which bound applied.
The bound lives in argv, and `argv` is an omitted key in `audit-payload.ts` — deliberately, because it
carries paths — so there was no second place to look. A control whose effect cannot be observed after
the fact is the shape this round exists to refuse.

```ts
{ eventType: 'capability-refused',
  kind: BackendRunnerKind,
  unenforceable: readonly PhaseCapability[],
  phaseIndex: number }              // outcome: 'failure'; the phase does not start

{ eventType: 'capability-applied',
  kind: BackendRunnerKind,
  granted: readonly PhaseCapability[],
  phaseIndex: number }              // outcome: 'success'; emitted only when a set was DECLARED
```

They are mutually exclusive per phase. A phase that declares nothing emits neither: its argv is
unchanged, and a line saying "unchanged" in every Run's evidence would bury the narrowings rather than
surface them.

Declared in the contract **before** any operator-facing text claims it. No workspace path, no task
description, no operator-authored content — every field is a closed union, a number, or an array of
closed-union members.

## Non-vacuity, and how a refusal is observed without a live model

Runners take an injectable `spawnFn` (`ProcessLifecycleRunner`). The test supplies a **fake CLI** that
behaves like a permission-enforcing one: given a deny flag in argv, it emits a permission-denied event on
stdout. The host must classify it as a capability refusal, emit the audit event, and end the Run with a
named cause.

1. Declared set **excludes** `process-spawn`; the fake CLI attempts it → refused at the attempt, refusal
   in evidence.
2. Declared set **includes** `process-spawn`, same attempt → succeeds. The refusal was non-vacuous.
3. `DEFAULT_CAPABILITY_SET` → argv byte-identical to today's, per backend.
4. A capability with no expression for a backend → phase refused before start, capability named.

**Stated limit**: (1) and (2) prove the host half — the argv it produces, the classification, the event,
the outcome. They do not prove the CLI enforces the flag; that is the backend's own guarantee and is
recorded as a trust anchor, not as a claim of this feature.
