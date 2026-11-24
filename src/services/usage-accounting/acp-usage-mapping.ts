/**
 * FR-R6-F06 (T039, FR-023, FR-024, SC-009, research R12) & FR-R7-17 (`R7-17-04`) — one ACP usage
 * update becomes one accounting observation, read by the source's own semantics.
 *
 * `AcpUsageUpdate` is the shared F06/F13 contract wired through production ACP observation
 * ingestion (`recordAcpObservation`).
 *
 * - `used` and `size` are context occupancy and capacity: measures `context_used` and
 *   `context_size`, scope `acp-context-occupancy`. They are never billable tokens, and the
 *   query reports them as the latest value, never as a sum.
 * - The cost is session-cumulative. It is known only when the producer qualified a session
 *   baseline and named a currency; it is then `derived`. Otherwise it is unknown.
 * - Credits are their own non-monetary unit and follow the same baseline rule; they are never
 *   relabelled or converted to money.
 * - Attribution needs an admitted prompt-to-attempt binding for the same profile, ACP session,
 *   connection generation and turn. Anything else stays unattributed.
 * - The canonical source identity is a fixed-length 71-byte domain-separated SHA-256 hash
 *   `acp-v1:<sha256>` over `(profileId, acpSessionId, producerEventId)` where `profileId`
 *   matches `PROFILE_IDENTIFIER` and both `acpSessionId` and `producerEventId` satisfy
 *   `isAgentIdentifier` (1–256 printable UTF-16 code units, rejecting `Cc`/`Cf`/`Cs`/`Zl`/`Zp`).
 *   The host receive sequence and the connection generation are never part of it, so a replay
 *   across connections deduplicates with zero colon-concatenation ambiguity while staying within
 *   the immutable 256-byte SQLite `source_identity` column constraint. A replay with no valid
 *   source identity and no qualified baseline is `historical`: stored and never counted.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { createHash } from 'node:crypto';
import { ACP_USAGE_PRODUCER_NAMESPACE } from '../../contracts/usage-accounting/accounting-types';
import { isAgentIdentifier } from '../acp-runtime/agent-identifier';
import { qualifyAcpSessionCost } from './cumulative-qualifier';
import { isCreditUnit, isCurrencyCode } from './exact-quantities';
import type { AccountingMeasureInput, AccountingObservationInput } from './observation-normalizer';

export const ACP_USAGE_ADAPTER_VERSION = 'acp-usage/1';
export const ACP_USAGE_SOURCE = 'acp-usage-update';
export const ACP_BACKEND = 'acp';

const PROFILE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ACP_USAGE_SOURCE_DOMAIN = 'acp-usage-source/1';
const ACP_USAGE_SOURCE_PREFIX = 'acp-v1:';
const COUNT_UNIT = 'count';
/** The unit an unknown cost is filed under when the producer named no valid currency. */
const UNKNOWN_COST_UNIT = 'USD';
/** The unit unknown credits are filed under when the producer named no valid credit unit. */
const UNKNOWN_CREDIT_UNIT = 'credits';
const REASON_NOT_REPORTED = 'not-reported';
const REASON_REJECTED = 'rejected-value';

/** The identity fields every ACP event carries (F13's envelope). */
export interface AcpEventEnvelope {
  readonly profileId: string;
  readonly acpSessionId: string;
  readonly connectionGeneration: number;
  readonly turnId: string;
  /** This host's receive order. Kept by the transport; never a dedup key. */
  readonly hostReceiveSeq: number;
  readonly eventUtc: string;
  /** True when the transport redelivers history after a reconnect or a session load. */
  readonly replayed: boolean;
  /** The underlying provider session, when the agent reports one. Optional and separate. */
  readonly providerSessionId?: string | undefined;
}

/** One ACP `usage_update`, as F06 freezes it for F13. */
export interface AcpUsageUpdate extends AcpEventEnvelope {
  readonly used: number;
  readonly size: number;
  readonly cost?: { readonly amount: string; readonly currency?: string | undefined } | undefined;
  readonly credits?: { readonly amount: string; readonly unit?: string | undefined } | undefined;
  /** The upstream event id, when the agent provides a stable one. */
  readonly producerEventId?: string | undefined;
  /** The producer subtracted a session baseline it could vouch for. */
  readonly hasQualifiedSessionBaseline: boolean;
}

/** An admitted prompt-to-attempt entry: this turn on this connection belongs to this attempt. */
export interface AcpAttemptBinding {
  readonly profileId: string;
  readonly acpSessionId: string;
  readonly connectionGeneration: number;
  readonly turnId: string;
  readonly rootId: string;
  readonly attemptId: string;
}

function isProfileIdentifier(value: unknown): value is string {
  return typeof value === 'string' && PROFILE_IDENTIFIER.test(value);
}

function bindingMatches(update: AcpUsageUpdate, binding: AcpAttemptBinding): boolean {
  return (
    binding.profileId === update.profileId &&
    binding.acpSessionId === update.acpSessionId &&
    binding.connectionGeneration === update.connectionGeneration &&
    binding.turnId === update.turnId
  );
}

/**
 * Derives the uniform 71-byte ASCII canonical source identity (`acp-v1:<sha256>`) for one ACP
 * usage update, or `null` when any required identity component is missing or invalid.
 */
export function sourceIdentityOf(update: AcpUsageUpdate): string | null {
  if (
    !isProfileIdentifier(update.profileId) ||
    !isAgentIdentifier(update.acpSessionId) ||
    !isAgentIdentifier(update.producerEventId)
  ) {
    return null;
  }
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        ACP_USAGE_SOURCE_DOMAIN,
        update.profileId,
        update.acpSessionId,
        update.producerEventId
      ]),
      'utf8'
    )
    .digest('hex');
  return `${ACP_USAGE_SOURCE_PREFIX}${digest}`;
}

function unknownMeasure(measure: AccountingMeasureInput['measure'], unit: string, reason: string): AccountingMeasureInput {
  return { measure, quantity: null, unit, provenance: 'provider-reported', unknownReason: reason };
}

function occupancyMeasure(measure: 'context_used' | 'context_size', value: unknown): AccountingMeasureInput {
  if (value === undefined) return unknownMeasure(measure, COUNT_UNIT, REASON_NOT_REPORTED);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return unknownMeasure(measure, COUNT_UNIT, REASON_REJECTED);
  }
  return { measure, quantity: value, unit: COUNT_UNIT, provenance: 'provider-reported' };
}

/**
 * A session-cumulative amount (money or credits): known only with a valid unit and a qualified
 * baseline. `validUnit` is `null` when the producer named no acceptable unit. When no baseline is
 * qualified, the unknown measure folds to `fallbackUnit` so an unbaselined ACP producer cannot
 * mint arbitrary distinct currencies or credit units (FR-R7-16 / 16-05).
 */
function cumulativeMeasure(
  measure: 'cost' | 'credits',
  amount: string | undefined,
  validUnit: string | null,
  fallbackUnit: string,
  hasQualifiedSessionBaseline: boolean
): AccountingMeasureInput {
  if (amount === undefined) return unknownMeasure(measure, fallbackUnit, REASON_NOT_REPORTED);
  if (validUnit === null || typeof amount !== 'string') return unknownMeasure(measure, fallbackUnit, REASON_REJECTED);
  const qualification = qualifyAcpSessionCost(hasQualifiedSessionBaseline);
  if (!qualification.known) return unknownMeasure(measure, fallbackUnit, qualification.reason);
  return { measure, quantity: amount, unit: validUnit, provenance: qualification.provenance };
}

function costMeasure(update: AcpUsageUpdate): AccountingMeasureInput {
  const currency = update.cost?.currency;
  const validUnit = typeof currency === 'string' && isCurrencyCode(currency) ? currency : null;
  return cumulativeMeasure('cost', update.cost?.amount, validUnit, UNKNOWN_COST_UNIT, update.hasQualifiedSessionBaseline);
}

function creditMeasures(update: AcpUsageUpdate): AccountingMeasureInput[] {
  if (update.credits === undefined) return [];
  const unit = update.credits.unit;
  const validUnit = typeof unit === 'string' && isCreditUnit(unit) ? unit : null;
  return [
    cumulativeMeasure('credits', update.credits.amount, validUnit, UNKNOWN_CREDIT_UNIT, update.hasQualifiedSessionBaseline)
  ];
}

/** The observation for one ACP usage update. Deterministic in its inputs; `observedUtc` is the ingest clock. */
export function acpUsageObservation(
  update: AcpUsageUpdate,
  binding: AcpAttemptBinding | null,
  observedUtc: string
): AccountingObservationInput {
  const bound = binding !== null && bindingMatches(update, binding);
  const sourceIdentity = sourceIdentityOf(update);
  const historical = update.replayed && sourceIdentity === null && !update.hasQualifiedSessionBaseline;
  return {
    producerNamespace: ACP_USAGE_PRODUCER_NAMESPACE,
    source: ACP_USAGE_SOURCE,
    sourceKind: 'acp-usage-update',
    sourceIdentity,
    rootId: bound ? binding.rootId : null,
    attemptId: bound ? binding.attemptId : null,
    counterScope: 'acp-context-occupancy',
    adapterVersion: ACP_USAGE_ADAPTER_VERSION,
    dimensions: { backend: ACP_BACKEND, providerSessionId: update.providerSessionId ?? null },
    eventUtc: update.eventUtc,
    observedUtc,
    measures: [
      occupancyMeasure('context_used', update.used),
      occupancyMeasure('context_size', update.size),
      costMeasure(update),
      ...creditMeasures(update)
    ],
    ...(historical ? { disposition: 'historical' as const } : {})
  };
}
