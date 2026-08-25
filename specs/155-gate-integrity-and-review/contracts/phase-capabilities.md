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

## Audit event

```ts
{ eventType: 'capability-refused',
  kind: BackendRunnerKind,
  unenforceable: readonly PhaseCapability[],
  phaseIndex: number }
```

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
