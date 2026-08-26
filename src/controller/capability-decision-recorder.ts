// FR-R3-086 — record what a phase's declared capability set actually did, and
// refuse the phase when the chosen backend has no way to enforce it.
//
// BOTH OUTCOMES ARE RECORDED, and only one of them was at first. A set the
// backend cannot enforce is refused and logged; a set it CAN enforce used to be
// applied silently. Argv is where an applied bound lives, and argv is an omitted
// key in the structured log by design, so a completed Run said nothing about
// whether its phase ran bounded. The mechanism's whole claim is a bound an
// operator approved, and evidence is where approval is checked afterwards — so a
// grant is now as observable as a refusal.
//
// WHY THIS IS ITS OWN MODULE. `phase-runner.ts` carries a LoC budget, and the
// budget is a forcing function rather than a formality: `STATE-1` was closed on a
// ratchet precisely because a waiver had removed one without replacing it, and
// the reviewer brief is still asking whether the wrong half was closed. Adding a
// method here and raising the budget would be the same move again, so the
// mechanism moves out instead — which is what `backend-posture-recorder.ts` and
// `process-tree-degradation-recorder.ts` both did before it, and this deliberately
// mirrors their shape.
//
// TWO HALVES, AND BOTH ARE REQUIRED. This module refuses a set the backend cannot
// enforce. The other half is `phase-runner.ts` FORWARDING the declared set into
// the InvocationRequest, without which the adapter never sees it: an
// unenforceable set is refused correctly while an ENFORCEABLE one silently runs
// with the unbounded argv — exactly the failure the mechanism exists to prevent.
// It shipped that way, and was found by a security pass asking "is the refusal
// bypassable?" rather than by a test: each half was covered against its own
// input, and nothing drove one into the other.
//
// ORDER MATTERS. The audit event is appended BEFORE the throw, so the record
// exists even though the phase does not. An operator reconstructing why a phase
// never started has something to read; a refusal that leaves no trace is
// indistinguishable from a phase nobody scheduled.
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import type {
  AmbientConfigObservation,
  CapabilityAppliedPayload,
  CapabilityRefusalEventType,
  CapabilityRefusedPayload
} from '../contracts/audit-events';
import {
  declaredCapabilitySet,
  type DeclaredCapabilitySet,
  type PhaseCapability
} from '../contracts/phase-capabilities';
import { planCapabilityEnforcement } from '../services/capability-enforcement-plan';
import { CapabilityNotEnforceableError } from '../services/capability-refusal';

/** What the recorder needs from a phase run, and nothing more. */
export interface CapabilityRefusalContext {
  readonly phaseDef?: { readonly capabilities?: readonly PhaseCapability[] } | undefined;
  /** By INDEX, never by id: a sequence may repeat a phase. */
  readonly iteration: number;
}

/**
 * Appends one audit entry.
 *
 * Deliberately the same shape `PhaseRunner.appendAudit` already has, so the call
 * site passes a bound method rather than wrapping it in a closure. A wrapper
 * would be four lines in a file that carries a LoC budget, which is how a budget
 * gets raised for a reason nobody would defend on its merits.
 */
export type CapabilityAuditAppender<TContext> = (
  inputs: TContext,
  eventType: CapabilityRefusalEventType,
  outcome: 'failure' | 'success',
  payload: Record<string, unknown>
) => Promise<unknown>;

/**
 * Throw `CapabilityNotEnforceableError` when the backend cannot enforce the
 * declared set, after recording it. Records the applied set otherwise — including for a
 * phase that declared nothing, which is the overwhelmingly common case and must
 * cost nothing.
 *
 * A FUNCTION, not a class: it holds no state between calls, and the appender is
 * passed per call so the caller keeps ownership of its own audit writer rather
 * than this module capturing a reference to it.
 */
export async function recordCapabilityDecision<TContext extends CapabilityRefusalContext>(
  context: TContext,
  kind: BackendRunnerKind,
  append: CapabilityAuditAppender<TContext>,
  /**
   * FR-R3-105 (FR-066) — how the ambient configuration is observed, injected.
   *
   * Passed in rather than imported so this module keeps holding no state and reaching for
   * no filesystem of its own, which is the property its docstring above claims. Omitted,
   * the observation is `null` — the same reading as "no configuration found", which is
   * what a caller that cannot observe honestly has.
   */
  observeAmbient?: (kind: BackendRunnerKind) => Promise<AmbientConfigObservation | null>
): Promise<void> {
  const declared = context.phaseDef?.capabilities;
  if (declared === undefined) return;
  const set = declaredCapabilitySet(declared);
  const plan = planCapabilityEnforcement(kind, set);
  if (plan.outcome !== 'refused') {
    // The narrowing SUCCEEDED, and that is the case with no other trace. Argv is
    // where the bound lives and argv is never written to the structured log, so
    // without this line a completed Run cannot tell an operator whether the phase
    // ran bounded or unbounded. Recorded as `success`: nothing failed here.
    // Observed BEFORE the event is appended, so the record describes the configuration
    // that was in force when the bound applied rather than whatever it became later.
    // A failure to observe is `null`, never a thrown error: an unreadable settings file
    // must not fail a phase, and "nothing observed" is an honest answer that an operator
    // can tell apart from "observed and unchanged".
    const ambientConfig = observeAmbient === undefined ? null : await observeAmbient(kind);
    const applied: CapabilityAppliedPayload = {
      kind,
      granted: set.capabilities,
      phaseIndex: context.iteration,
      ambientConfig
    };
    await append(context, 'capability-applied', 'success', { ...applied });
    return;
  }

  const payload: CapabilityRefusedPayload = {
    kind: plan.kind,
    unenforceable: plan.unenforceable,
    phaseIndex: context.iteration
  };
  // Spread, not a cast: a closed interface has no index signature, so it is not
  // assignable to the writer's `Record<string, unknown>`. Same reasoning as
  // `backend-posture-recorder.ts`, and it is stated here so a later reader does
  // not "simplify" it back into a compile error.
  await append(context, 'capability-refused', 'failure', { ...payload });
  throw new CapabilityNotEnforceableError(plan.kind, plan.unenforceable);
}

/**
 * The capability fields an `InvocationRequest` carries, or nothing.
 *
 * Mirrors `policyRequestFields` in shape and exists for the same reason: the
 * coordinator shell forwards decisions, and the decision about how to spell one
 * belongs beside the module that makes it. Omission stays omission — the
 * enforcement plan reads an absent set as the default, and writing the full list
 * into every request would change the shape of every existing invocation.
 */
export function capabilityRequestFields(
  context: CapabilityRefusalContext
): { capabilities?: DeclaredCapabilitySet } {
  const declared = context.phaseDef?.capabilities;
  return declared === undefined ? {} : { capabilities: declaredCapabilitySet(declared) };
}
