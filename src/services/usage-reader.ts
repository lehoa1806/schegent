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

/**
 * The sum of the PRESENT token fields, or `undefined` when none is present, never 0. All four count
 * against a bound: cache reads are cheaper than fresh input and are not free, and a bound that
 * ignored them would be defeated by the workload that grows fastest, a long conversation re-reading
 * a large cached context. A rejected field contributes nothing and does not make the others
 * unusable.
 */
export function totalTokens(usage: PhaseEndUsage): number | undefined {
  let total: number | undefined;
  for (const key of TOKEN_KEYS) {
    const value = usage[key];
    if (value.kind === 'present') total = (total ?? 0) + value.value;
  }
  return total;
}
