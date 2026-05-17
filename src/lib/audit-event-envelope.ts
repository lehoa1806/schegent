import { getOperatorActor } from './operator-attribution';

export type AuditActor =
  | { readonly kind: 'operator'; readonly id: string }
  | { readonly kind: 'system'; readonly id: string };

export interface StateTransitionAuditEnvelope {
  readonly timestamp: string;
  readonly correlationId: string | null;
  readonly actor: AuditActor;
  readonly reasonCode: string;
  readonly priorState: Readonly<Record<string, unknown>> | null;
  readonly newState: Readonly<Record<string, unknown>> | null;
}

export interface AuditEnvelopeInput {
  readonly correlationId?: string | null;
  readonly actor?: AuditActor;
  readonly reasonCode: string;
  readonly priorState?: Readonly<Record<string, unknown>> | null;
  readonly newState?: Readonly<Record<string, unknown>> | null;
  readonly now?: Date;
}

export function operatorAuditActor(id: string = getOperatorActor()): AuditActor {
  return { kind: 'operator', id };
}

export function systemAuditActor(id: string): AuditActor {
  return { kind: 'system', id };
}

export function createStateTransitionAuditEnvelope(
  input: AuditEnvelopeInput
): StateTransitionAuditEnvelope {
  const timestamp = (input.now ?? new Date()).toISOString();
  return {
    timestamp,
    correlationId: input.correlationId ?? null,
    actor: input.actor ?? operatorAuditActor(),
    reasonCode: input.reasonCode,
    priorState: input.priorState ?? null,
    newState: input.newState ?? null
  };
}
