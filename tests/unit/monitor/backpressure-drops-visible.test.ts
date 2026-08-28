import { describe, expect, it } from 'vitest';
import { withDropReporting } from '../../../src/monitor/drop-reporting-transport';
import { EvidenceHealthMonitor } from '../../../src/services/evidence-health/evidence-health-monitor';
import type { CliTransportRecord } from '../../../src/monitor/cli-transport-sink';

/**
 * FR-R3-106 (FR-075) — a dropped transport line is visible somewhere an operator reads.
 *
 * THE DEFECT. `CliTransportSink.droppedForBackpressure` has counted refused lines and bytes
 * since `FR-R3-052`, under a docstring saying "readable, because a counter nothing can read
 * is a silent cap". It was readable and nothing read it: the only consumers were two unit
 * tests. So the bound was real, the loss of transcript was real, and the evidence surface
 * said nothing — which is the silent cap that docstring was written to prevent, one layer up.
 *
 * WHY THE DROPS ARE A COUNT AND NOT A DEGRADATION. A drop means the cap did its job and the
 * run continued; what it costs is transcript completeness, which matters later when someone
 * reads that transcript to explain a run. Making it degrade `overall` would put the whole
 * surface amber for a working system, and a status that is amber for working systems is a
 * status people stop reading.
 */
const record = (line: string): CliTransportRecord => ({
  runId: 'run-1',
  phase: 'speckit-implement',
  stream: 'stdout',
  line
});

/** A sink that refuses everything after `acceptFirst` records. */
function fakeSink(acceptFirst: number) {
  let seen = 0;
  let lines = 0;
  let bytes = 0;
  return {
    record: (entry: CliTransportRecord): void => {
      seen++;
      if (seen > acceptFirst) {
        lines++;
        bytes += entry.line.length;
      }
    },
    flushPendingWrites: async (): Promise<void> => {},
    get droppedForBackpressure() {
      return { lines, bytes };
    },
    // FR-R3-137 — the interface's fourth member. Required rather than optional,
    // because a lifecycle a caller may omit is one a caller will omit; this fake
    // holds no descriptor, so the whole cost of that decision is this line.
    flushAndDispose: async (): Promise<void> => {}
  };
}

describe('FR-R3-106 — backpressure drops reach the evidence-health surface', () => {
  it('a forced drop is visible; before the wiring the surface reported nothing', () => {
    const health = new EvidenceHealthMonitor();
    expect(health.getSnapshot().transportDrops).toEqual({ lines: 0, bytes: 0 });

    const transport = withDropReporting(fakeSink(1), health);
    transport.record(record('accepted'));
    expect(health.getSnapshot().transportDrops, 'nothing dropped yet').toEqual({
      lines: 0,
      bytes: 0
    });

    transport.record(record('dropped-line'));
    const after = health.getSnapshot().transportDrops;
    expect(after.lines).toBe(1);
    expect(after.bytes).toBe('dropped-line'.length);
  });

  it('drops do NOT degrade the overall status, because the cap working is not a failure', () => {
    const health = new EvidenceHealthMonitor();
    const transport = withDropReporting(fakeSink(0), health);
    for (let i = 0; i < 50; i++) transport.record(record(`line-${i}`));
    const snapshot = health.getSnapshot();
    expect(snapshot.transportDrops.lines).toBe(50);
    expect(
      snapshot.overall,
      'a working cap must not make the surface amber, or the surface stops being read'
    ).toBe('healthy');
  });

  it('bytes are counted as well as lines, because they answer different questions', () => {
    // A thousand short lines and one huge line are the same number to a line counter, and
    // only one of them loses a meaningful amount of a transcript.
    const health = new EvidenceHealthMonitor();
    const transport = withDropReporting(fakeSink(0), health);
    transport.record(record('x'.repeat(10_000)));
    expect(health.getSnapshot().transportDrops).toEqual({ lines: 1, bytes: 10_000 });
  });

  it('notifies subscribers only when the counts actually move', () => {
    // The wrapper reports on every record, so the no-change path must be silent — otherwise
    // a busy run notifies the surface once per line for a counter that never changes.
    const health = new EvidenceHealthMonitor();
    let notifications = 0;
    health.subscribe(() => {
      notifications++;
    });
    const baseline = notifications; // subscribe() delivers once immediately

    const transport = withDropReporting(fakeSink(5), health);
    for (let i = 0; i < 5; i++) transport.record(record(`ok-${i}`));
    expect(notifications, 'accepted lines must not notify').toBe(baseline);

    transport.record(record('refused'));
    expect(notifications, 'a real drop must notify').toBe(baseline + 1);
  });

  it('NON-VACUITY: reverting the surfacing makes the forced drop invisible', () => {
    // The mutation: the unwrapped sink, which is what the code did before this item. The
    // drop still happens and the surface still says zero — the exact state this closes.
    const health = new EvidenceHealthMonitor();
    const sink = fakeSink(0);
    sink.record(record('dropped-and-unreported'));
    expect(sink.droppedForBackpressure.lines, 'the sink did refuse it').toBe(1);
    expect(
      health.getSnapshot().transportDrops.lines,
      'unwrapped, the surface reports nothing — which is the defect'
    ).toBe(0);
  });

  it('flushPendingWrites and the getter pass through, so the wrapper is not a new sink', () => {
    const health = new EvidenceHealthMonitor();
    const inner = fakeSink(0);
    const transport = withDropReporting(inner, health);
    transport.record(record('a'));
    expect(transport.droppedForBackpressure).toEqual(inner.droppedForBackpressure);
    return expect(transport.flushPendingWrites()).resolves.toBeUndefined();
  });
});
