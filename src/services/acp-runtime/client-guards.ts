/**
 * FR-R6-F13 (FR-001, FR-012, FR-015, research R5) — the pure checks and builders the ACP client
 * uses: input shapes, profile qualification, stop-reason validation and the usage update.
 *
 * Zero `vscode` imports.
 */
import {
  ACP_STOP_REASONS,
  type AcpFailureReason,
  type AcpStopReason,
  type AgentProfile
} from '../../contracts/acp-runtime';
import type { AcpUsageUpdate } from '../usage-accounting/acp-usage-mapping';
import { isAgentIdentifier } from './agent-identifier';
import type { RpcSettlement } from './rpc-connection';
import type { UsageReading } from './session-update-mapper';
import type { Attribution } from './session-state';

/** Host identities (attempt, root) use the bounded identifier F06 attributes by. */
const HOST_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STOP_REASONS: ReadonlySet<string> = new Set(ACP_STOP_REASONS);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isSessionId(value: unknown): value is string {
  return isAgentIdentifier(value);
}

export function isHostIdentifier(value: unknown): value is string {
  return typeof value === 'string' && HOST_IDENTIFIER.test(value);
}

/** A fixture profile is launched only when the caller opted in (tests and the smoke harness). */
export function qualifies(profile: AgentProfile, allowFixtureProfiles: boolean): boolean {
  if (profile.qualification === 'qualified') return true;
  return profile.qualification === 'fixture' && allowFixtureProfiles;
}

/** The prompt result's stop reason, or null when it is missing or not an ACP v1 value. */
export function stopReasonOf(value: unknown): AcpStopReason | null {
  if (!isRecord(value)) return null;
  const stopReason = value['stopReason'];
  return typeof stopReason === 'string' && STOP_REASONS.has(stopReason) ? (stopReason as AcpStopReason) : null;
}

/** Why a request produced no answer; an error answer here is a protocol violation. */
export function failureOf(settlement: RpcSettlement): AcpFailureReason {
  return settlement.kind === 'lost' || settlement.kind === 'not-dispatched' ? settlement.reason : 'protocol-violation';
}

/** Adds `detail` only when there is one, so no `detail: undefined` key appears. */
export function withDetail<T extends object>(base: T, detail: string | undefined): T & { detail?: string } {
  return detail === undefined ? base : { ...base, detail };
}

export interface UsageContext {
  readonly profileId: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly attribution: Attribution;
  readonly hostReceiveSeq: number;
  readonly eventUtc: string;
}

/** The F06 usage update for one `usage_update`; a loaded-history reading is `replayed`. */
export function buildUsageUpdate(context: UsageContext, reading: UsageReading): AcpUsageUpdate {
  const update: AcpUsageUpdate = {
    profileId: context.profileId,
    acpSessionId: context.sessionId,
    connectionGeneration: context.generation,
    turnId: context.attribution.turnId,
    hostReceiveSeq: context.hostReceiveSeq,
    eventUtc: context.eventUtc,
    replayed: context.attribution.origin === 'history',
    used: reading.used,
    size: reading.size,
    hasQualifiedSessionBaseline: false
  };
  return reading.cost === undefined ? update : { ...update, cost: reading.cost };
}
