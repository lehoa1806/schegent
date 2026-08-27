// FR-R3-130 (T1495) — the warning an operator gets at the point they raise the cap.
//
// WHY A MODEL AND NOT A CONSTANT. `FR-R3-081` ruled that any mechanism work on the
// aggregate stream bound must be argued from *measured resident heap*, and its own
// record says so in its own words. A threshold picked at the keyboard would be the
// arithmetic that ruling rejected, wearing a warning's clothes.
//
// THE MODEL, from `docs/operations/large-workspace-resource-measurement.md` §5:
//
//     resident cost ~= cap x 2 streams x min(bytes a phase's stream produces, 64 MiB)
//
// The coefficient is `RETAINED_PER_ACCEPTED_BYTE` below, and it is derived from the
// measurement's RETAINED column rather than its heap column. That distinction is a
// correction the measurement produced on its second run: the heap delta swung from
// 62.7 MiB to 26.7 MiB for the same load, because GC timing dominates a window this
// short, while retained bytes were identical to two decimal places both times. A
// coefficient taken from the noisy column would have been a different number every
// afternoon.
//
// THE CORRECTION THIS MODEL CARRIES. `FR-R3-081`'s record credits a compressed head
// — *"retained gzip-compressed at roughly 0.66x the cap"* — and the large-workspace
// sweep found that saving ABSENT at 4 MiB per stream: retained tracked accepted to
// within 0.1%. The compression is a property of the cap-relative head/tail split and
// only pays as a stream approaches its own 64 MiB bound. So the model does not apply
// a 0.66 discount, and an operator sizing a cap should expect to pay for what the
// process accepted.
//
// IT WARNS. It does not refuse. The cap's range is ratified
// (`docs/architecture/local-queue-parallelism-ratification.md`) and an operator on a
// large machine raising it is making a legitimate choice; a refusal here would be
// this module deciding something the ratification already decided. What was missing
// is that the choice was invisible.

/** Per-stream accepted-input cap, mirrored from `runner/zipped-stream-buffer`. */
export const PER_STREAM_ACCEPTED_CAP_BYTES = 64 * 1024 * 1024;

/** Streams a Run holds: stdout and stderr, bounded independently. */
export const STREAMS_PER_RUN = 2;

/**
 * Bytes the buffers RETAIN per byte they accept, measured.
 *
 * 1.0, from `docs/operations/large-workspace-resource-measurement.md` §4: retained
 * tracked accepted to within 0.1% at every level (8.08/8.1, 16.16/16.2, 32.31/32.3,
 * 64.63/64.6). Deterministic across runs, which is why it is the column the model
 * reads.
 *
 * THE CORRECTION THIS CARRIES. `FR-R3-081`'s record credits a compressed head —
 * *"retained gzip-compressed at roughly 0.66x the cap"* — and at 4 MiB per stream
 * that saving is ABSENT. The compression is a property of the cap-relative head/tail
 * split and only pays as a stream approaches its own 64 MiB bound, so an operator
 * whose phases produce a few MiB per stream pays for what the process accepted. A
 * model applying a 0.66 discount would under-warn exactly the operator most likely
 * to be surprised.
 */
export const RETAINED_PER_ACCEPTED_BYTE = 1.0;

/**
 * The share of machine memory above which the warning fires.
 *
 * A quarter, and the reasoning is the extension host rather than the machine: the
 * host shares a process with VS Code's own extension population, and a Node heap
 * approaching a quarter of physical memory on a machine also hosting an editor, a
 * language server and a browser is the point where the operator's
 * experience degrades before any bound is hit. It is not derived from a measurement
 * because it is not a measurable quantity — it is a judgement, and it is stated as
 * one rather than presented as arithmetic.
 */
export const WARN_AT_MACHINE_MEMORY_SHARE = 0.25;

export interface StreamPressureInputs {
  /** The cap the operator is about to set. */
  readonly cap: number;
  /** `os.totalmem()`, read by the host and carried to the surface that warns. */
  readonly machineMemoryBytes: number;
  /**
   * What one stream of one phase is expected to accept.
   *
   * The operator's workload, and the reason the model takes it as an input rather
   * than assuming it. Defaults to the per-stream cap — the worst case — because an
   * operator who has not measured their own phases should be warned against the
   * bound the product actually permits.
   */
  readonly expectedStreamBytes?: number;
}

export type StreamPressureAdvice =
  | { readonly level: 'ok'; readonly projectedResidentBytes: number }
  | {
      readonly level: 'warn';
      readonly projectedResidentBytes: number;
      readonly machineShare: number;
      readonly message: string;
    };

const mib = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)} MiB`;

/**
 * Project the resident cost of a cap and say whether it warrants a warning.
 *
 * Pure, so the decision is testable without a machine — the shape
 * `judgeBackendContainment` and `resolveCapabilityDecision` take, and for the same
 * reason: a threshold that can only be exercised on a particular machine is a
 * threshold nobody exercises.
 */
export function adviseStreamPressure(inputs: StreamPressureInputs): StreamPressureAdvice {
  const perStream = Math.min(
    inputs.expectedStreamBytes ?? PER_STREAM_ACCEPTED_CAP_BYTES,
    PER_STREAM_ACCEPTED_CAP_BYTES
  );
  const projectedResidentBytes = Math.round(
    inputs.cap * STREAMS_PER_RUN * perStream * RETAINED_PER_ACCEPTED_BYTE
  );
  // A machine that did not answer is not a machine to warn about: `os.totalmem()`
  // returning 0, a negative, or NaN would otherwise make every cap look
  // catastrophic, and a warning derived from an absent fact is worse than silence.
  //
  // `NaN` is checked explicitly rather than left to the comparison below: `NaN < x`
  // is false, so a NaN memory would have fallen through to the warn branch and
  // reported `NaN%` to the operator. Found by the test that drives all three.
  if (!Number.isFinite(inputs.machineMemoryBytes) || inputs.machineMemoryBytes <= 0) {
    return { level: 'ok', projectedResidentBytes };
  }

  const machineShare = projectedResidentBytes / inputs.machineMemoryBytes;
  if (machineShare < WARN_AT_MACHINE_MEMORY_SHARE) {
    return { level: 'ok', projectedResidentBytes };
  }
  return {
    level: 'warn',
    projectedResidentBytes,
    machineShare,
    message:
      `At a cap of ${inputs.cap}, in-flight Runs may accept up to ` +
      `${mib(projectedResidentBytes)} of stream output — about ` +
      `${Math.round(machineShare * 100)}% of this machine's ${mib(inputs.machineMemoryBytes)}. ` +
      'Measured 2026-08-27: buffers retain what they accept, roughly 1:1, below the per-stream ' +
      'cap — the compression that discounts a full stream does not apply at a few MiB. So this is ' +
      'a real cost rather than an arithmetic ceiling. The cap is still permitted; this is what it ' +
      'costs. See docs/operations/large-workspace-resource-measurement.md.'
  };
}
