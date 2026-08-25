import { describe, it, expect } from 'vitest';
import {
  EvidenceHealthMonitor,
  EVIDENCE_SINK_NAMES,
  pathRefusedWarning
} from '../../../src/services/evidence-health/evidence-health-monitor';
import { RECORDABLE_PHASE_END_WARNINGS } from '../../../src/audit/audit-payload';

/**
 * FR-R3-080 (T1075, T1076) — a write refused by the audit path reaches an
 * operator, not just a log line.
 *
 * The finding is one sentence long: `AuditPathRefusedError` and its siblings are
 * on no phase-end warning allowlist, because no producer routes writer-level
 * codes into `diagnosticWarnings`. A refusal nobody surfaces is a refusal nobody
 * acts on — and the sinks this round migrated refuse for exactly the reason an
 * operator would want to know about, which is that something in their tree moved
 * under a path the host was told to write.
 *
 * Three properties, and each fails on a different way of half-doing it:
 *
 *   1. A refusal is REPORTED as a refusal, distinctly from a failure. Folding
 *      `path-refused` into `io-error` would tell an operator to look at their
 *      disk when they should be looking at their tree.
 *   2. Every sink's code is on the allowlist. A code that is not on it is
 *      dropped by the phase-end projection, silently, which is the state before
 *      this item with extra steps.
 *   3. The drain empties. A refusal is reported against the phase it happened
 *      in, not against every phase after it.
 */
describe('FR-R3-080 — a refused evidence write reaches phase end', () => {
  it('reports a refusal as a refusal, not as an I/O failure', () => {
    const monitor = new EvidenceHealthMonitor();
    monitor.reportFailure('rawTranscript', 'path-refused');
    expect(monitor.getSnapshot().rawTranscript.cause).toBe('path-refused');

    // The neighbouring case, unchanged: a write that was attempted and failed.
    const other = new EvidenceHealthMonitor();
    other.reportFailure('rawTranscript', 'EIO');
    expect(other.getSnapshot().rawTranscript.cause).not.toBe('path-refused');
  });

  it.each(EVIDENCE_SINK_NAMES)('surfaces a %s refusal as an allowlisted code', (sink) => {
    const monitor = new EvidenceHealthMonitor();
    monitor.reportFailure(sink, 'path-refused');

    const drained = monitor.drainPathRefusals();
    expect(drained).toEqual([pathRefusedWarning(sink)]);
    // On the allowlist, so the phase-end projection keeps it rather than
    // dropping it as an unrecognized string.
    expect(RECORDABLE_PHASE_END_WARNINGS.has(drained[0]!)).toBe(true);
  });

  it('enumerates every sibling code rather than one', () => {
    // The item's wording: "the same reasoning applies to every sibling refusal
    // code the sinks can raise; enumerate them rather than adding one".
    for (const sink of EVIDENCE_SINK_NAMES) {
      expect(RECORDABLE_PHASE_END_WARNINGS.has(pathRefusedWarning(sink))).toBe(true);
    }
  });

  it('reports one warning per sink however many lines were refused', () => {
    // A sink refusing on every line of a chatty phase contributes one warning,
    // not ten thousand.
    const monitor = new EvidenceHealthMonitor();
    for (let i = 0; i < 1_000; i += 1) monitor.reportFailure('runtimeLog', 'path-refused');
    expect(monitor.drainPathRefusals()).toEqual([pathRefusedWarning('runtimeLog')]);
  });

  it('drains, so a refusal is reported against its own phase and no later one', () => {
    const monitor = new EvidenceHealthMonitor();
    monitor.reportFailure('audit', 'path-refused');
    expect(monitor.drainPathRefusals()).toHaveLength(1);
    // The next phase ends with nothing to report, because nothing was refused
    // during it.
    expect(monitor.drainPathRefusals()).toEqual([]);
  });

  it('reports nothing when a sink fails for a reason that is not a refusal', () => {
    const monitor = new EvidenceHealthMonitor();
    monitor.reportFailure('metricsRollup', 'ENOSPC');
    monitor.reportFailure('rawTranscript', 'partial-write');
    expect(monitor.drainPathRefusals()).toEqual([]);
  });
});
