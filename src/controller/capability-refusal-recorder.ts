// FR-R3-086 — refuse a phase whose declared capability set the chosen backend
// has no way to enforce, and record the refusal in evidence first.
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
// ORDER MATTERS. The audit event is appended BEFORE the throw, so the record
// exists even though the phase does not. An operator reconstructing why a phase
// never started has something to read; a refusal that leaves no trace is
// indistinguishable from a phase nobody scheduled.
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import type { CapabilityRefusedPayload } from '../contracts/audit-events';
import { declaredCapabilitySet, type PhaseCapability } from '../contracts/phase-capabilities';
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
  eventType: 'capability-refused',
  outcome: 'failure',
  payload: Record<string, unknown>
) => Promise<unknown>;

/**
 * Throw `CapabilityNotEnforceableError` when the backend cannot enforce the
 * declared set, after recording it. Returns silently otherwise — including for a
 * phase that declared nothing, which is the overwhelmingly common case and must
 * cost nothing.
 *
 * A FUNCTION, not a class: it holds no state between calls, and the appender is
 * passed per call so the caller keeps ownership of its own audit writer rather
 * than this module capturing a reference to it.
 */
export async function refuseUnenforceableCapabilities<TContext extends CapabilityRefusalContext>(
  context: TContext,
  kind: BackendRunnerKind,
  append: CapabilityAuditAppender<TContext>
): Promise<void> {
  const declared = context.phaseDef?.capabilities;
  if (declared === undefined) return;
  const plan = planCapabilityEnforcement(kind, declaredCapabilitySet(declared));
  if (plan.outcome !== 'refused') return;

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
