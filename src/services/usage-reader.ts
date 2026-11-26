// FR-R4-F02 (spec 240, US3; contract S1; data-model §6; FR-027) — the one validated reader of the
// usage a `phase-end` audit row carries.
//
// THE DEFECT IT REMOVES. The audit writer's projection (`src/audit/audit-payload.ts`) nests usage
// under `payload.metrics`, and the spend bound read only the flat legacy keys, so on every row the
// real writer produced it found nothing, called the Run's spend "unmeasurable", and never paused
// one. The metrics rollup read the flat cost key the same way. Two readers, one wrong, and nothing
// that compared them. This is the single reader: the live tally, the restart replay and the rollup
// all go through it, and a census (`tests/lint/usage-reader-census.test.ts`) keeps it single.
//
// WHAT IT DECIDES, per field: `payload.metrics[field]` first, `payload[field]` second. A value that
// is not a number is ABSENT. A negative or non-finite number is REJECTED. A zero is a PRESENT zero:
// a known amount, which is not the same fact as no amount.
//
// WHAT IT NEVER DOES. It invents nothing: no price table, no conversion between cost and tokens, no
// default of 0. `codex` and `agy` report tokens and no cost (FR-R3-098 left cost absent rather than
// derive it, because a derived price is a guess about someone else's rate card), and a cost that is
// absent stays absent here.
//
// It imports nothing from the host (no `vscode`), so the webview-free tiers can use it.

import type { CacheRelation } from '../contracts/usage-accounting/accounting-types';
import { qualificationFor } from '../contracts/usage-accounting/provider-qualifications';

/** One usage figure as the row carries it. */
export type UsageValue =
  | { readonly kind: 'present'; readonly value: number }
  | { readonly kind: 'absent' }
  | { readonly kind: 'rejected' };

/** The usage of one `phase-end` row, field by field. */
export interface PhaseEndUsage {
  readonly costUsd: UsageValue;
  readonly inputTokens: UsageValue;
  readonly outputTokens: UsageValue;
  readonly cacheCreationInputTokens: UsageValue;
  readonly cacheReadInputTokens: UsageValue;
}

const ABSENT: UsageValue = Object.freeze({ kind: 'absent' });
const REJECTED: UsageValue = Object.freeze({ kind: 'rejected' });

/** The payload key each field is read from, in both places. */
const COST_KEY = 'totalCostUsd';
const TOKEN_KEYS = [
  'inputTokens',
  'outputTokens',
  'cacheCreationInputTokens',
  'cacheReadInputTokens'
] as const;

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function valueOf(raw: number): UsageValue {
  return Number.isFinite(raw) && raw >= 0 ? { kind: 'present', value: raw } : REJECTED;
}

/**
 * One field: the nested number if the nested object holds one (even a rejected one: nested decides,
 * it does not fall through), else the flat number, else absent.
 */
function readField(payload: Readonly<Record<string, unknown>>, key: string): UsageValue {
  const metrics = payload.metrics;
  if (isPlainObject(metrics)) {
    const nested = metrics[key];
    if (typeof nested === 'number') return valueOf(nested);
  }
  const flat = payload[key];
  if (typeof flat === 'number') return valueOf(flat);
  return ABSENT;
}

/** Read one `phase-end` payload's usage. Never throws, whatever the payload holds. */
export function readPhaseEndUsage(payload: Readonly<Record<string, unknown>>): PhaseEndUsage {
  return {
    costUsd: readField(payload, COST_KEY),
    inputTokens: readField(payload, TOKEN_KEYS[0]),
    outputTokens: readField(payload, TOKEN_KEYS[1]),
    cacheCreationInputTokens: readField(payload, TOKEN_KEYS[2]),
    cacheReadInputTokens: readField(payload, TOKEN_KEYS[3])
  };
}

export interface QualifiedTokenTotal {
  /** Confirmed billable token sum (or lower bound when partial/ambiguous), or `undefined` if no token field is present. */
  readonly total: number | undefined;
  /** True when cache tokens are present with an unknown or contradictory cache-vs-input relation. */
  readonly cacheRelationAmbiguous: boolean;
}

function resolveCacheRelation(relationOrBackend?: CacheRelation | string): CacheRelation {
  if (relationOrBackend === undefined) return 'disjoint';
  if (
    relationOrBackend === 'disjoint' ||
    relationOrBackend === 'subset-of-input' ||
    relationOrBackend === 'unknown'
  ) {
    return relationOrBackend;
  }
  return qualificationFor(relationOrBackend).cacheRelation;
}

/**
 * Provider-qualified billable token sum for one `phase-end` usage row.
 *
 * - `'disjoint'` (e.g. `claude`): cache read/creation counters are disjoint from `inputTokens`,
 *   so all four present counters sum additively.
 * - `'subset-of-input'` (e.g. `codex`): cache counters are a subset of `inputTokens` and MUST NOT
 *   be double-counted on top of `inputTokens` (if `cacheRead > input`, marks `cacheRelationAmbiguous`).
 * - `'unknown'` (e.g. `agy` or unlisted adapters): sums confirmed primary counters (`input + output`)
 *   without inventing a disjoint assumption for positive cache counters; marks `cacheRelationAmbiguous`
 *   whenever a positive cache counter is present so an operator bound is not falsely certified `within`.
 */
export function qualifiedTotalTokens(
  usage: PhaseEndUsage,
  cacheRelationOrBackend?: CacheRelation | string
): QualifiedTokenTotal {
  const relation = resolveCacheRelation(cacheRelationOrBackend);
  if (relation === 'disjoint') {
    let total: number | undefined;
    for (const key of TOKEN_KEYS) {
      const value = usage[key];
      if (value.kind === 'present') total = (total ?? 0) + value.value;
    }
    return { total, cacheRelationAmbiguous: false };
  }

  let total: number | undefined;
  if (usage.inputTokens.kind === 'present') total = (total ?? 0) + usage.inputTokens.value;
  if (usage.outputTokens.kind === 'present') total = (total ?? 0) + usage.outputTokens.value;

  const cacheRead = usage.cacheReadInputTokens.kind === 'present' ? usage.cacheReadInputTokens.value : undefined;
  const cacheCreate =
    usage.cacheCreationInputTokens.kind === 'present' ? usage.cacheCreationInputTokens.value : undefined;

  if (relation === 'subset-of-input') {
    if (usage.inputTokens.kind === 'present') {
      const inconsistent =
        (cacheRead !== undefined && cacheRead > usage.inputTokens.value) ||
        (cacheCreate !== undefined && cacheCreate > usage.inputTokens.value);
      return { total, cacheRelationAmbiguous: inconsistent };
    }
    // `inputTokens` absent: any present cache counter still contributes a lower bound.
    const cacheLower = Math.max(cacheRead ?? 0, cacheCreate ?? 0);
    if (cacheRead !== undefined || cacheCreate !== undefined) {
      total = (total ?? 0) + cacheLower;
    }
    return { total, cacheRelationAmbiguous: false };
  }

  // `relation === 'unknown'`: never double-count positive cache tokens onto `inputTokens`;
  // if positive cache tokens exist, mark ambiguous so below-limit totals read as `incomplete`.
  const hasPositiveCache = (cacheRead !== undefined && cacheRead > 0) || (cacheCreate !== undefined && cacheCreate > 0);
  if (usage.inputTokens.kind !== 'present' && (cacheRead !== undefined || cacheCreate !== undefined)) {
    total = (total ?? 0) + Math.max(cacheRead ?? 0, cacheCreate ?? 0);
  }
  return { total, cacheRelationAmbiguous: hasPositiveCache };
}

/**
 * The sum of the PRESENT token fields under the given provider qualification (defaults to
 * `'disjoint'` when omitted for direct callers), or `undefined` when none is present, never 0.
 */
export function totalTokens(
  usage: PhaseEndUsage,
  cacheRelationOrBackend?: CacheRelation | string
): number | undefined {
  return qualifiedTotalTokens(usage, cacheRelationOrBackend).total;
}
