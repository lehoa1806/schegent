// FR-R4-F04 (FR-003, data-model §4) — how much CLI transport this workspace retains, as the Settings tab
// shows it under the transport mode row.
//
// Lives in a sub-module for the reason `uncontained-grant.ts` and `run-launcher.ts` state in their own
// headers: the barrel is near its LOC ceiling and carries only the registration edits. The barrel
// re-exports this module, so `contracts/sidebar-ipc` is where a consumer imports it from and this file is
// the type's one home: the transport router produces a value of it and the snapshot carries it.
//
// It is a read-only, optional field of the general-settings snapshot. Absent means "not yet measured",
// and the webview then shows nothing, so an older host or a window that has not measured yet needs no
// special case. It is recorded by each Run end and each maintenance pass and held in memory; a snapshot
// never walks the disk to build it.

export interface TransportUsage {
  readonly version: 1;
  /** Every Run transport file plus the legacy generations, in bytes. */
  readonly retainedBytes: number;
  /** How many Runs have a transport file. */
  readonly runCount: number;
  /** The legacy generations alone, in bytes; nothing writes them any more. */
  readonly legacyBytes: number;
  /** ISO: the latest newest-record time plus the age bound, or `null` when nothing is retained. */
  readonly agesOutBy: string | null;
  /** ISO: when this was measured. */
  readonly measuredAt: string;
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isIso = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

/** The shape guard: a present value of any other shape is rejected. */
export function isTransportUsage(value: unknown): value is TransportUsage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    isCount(candidate.retainedBytes) &&
    isCount(candidate.runCount) &&
    isCount(candidate.legacyBytes) &&
    (candidate.agesOutBy === null || isIso(candidate.agesOutBy)) &&
    isIso(candidate.measuredAt)
  );
}

/** Absence is valid; a present value must pass `isTransportUsage`. */
export function isOptionalTransportUsage(value: unknown): value is TransportUsage | undefined {
  return value === undefined || isTransportUsage(value);
}
