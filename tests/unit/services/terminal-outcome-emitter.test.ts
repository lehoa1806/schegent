import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * FR-R3-107 (FR-077, FR-078) — one terminal-outcome emitter, and the CLI-probe path
 * reports DERIVED statistics.
 *
 * WHAT WAS WRONG. `drive()` emitted `task-execution-ended` from three places, and they
 * had already drifted three ways:
 *
 *   | site | statistics | durationMs | optional dep |
 *   |---|---|---|---|
 *   | `:441` CLI-probe failure | hand-written zeros | **omitted** | guarded, silently skipped |
 *   | `:840` failed | derived | present | unguarded |
 *   | `:1035` completed | derived | present | unguarded |
 *
 * So the same event left three shapes, and one terminal path emitted nothing at all when
 * the optional dependency was absent while the others logged a warning. Triplication
 * drifting was not hypothetical here; it was observed.
 *
 * WHY THE ZEROS WERE A BUG AND NOT A SHAPE. They were *correct* — a CLI probe fails before
 * any phase runs — but correct **by position**, and nothing pinned the position. Deriving
 * through `computeRunPhaseStats` preserves the same values (it returns zeros for a Run with
 * no phase records) while making a future reordering visible instead of silently wrong.
 * That is the difference between a number that is right and a number that is right for a
 * reason.
 *
 * The assertions are on the source because what changed is structural — one body, three
 * call sites — and the existing `drive()` suites already cover the behaviour, unmodified,
 * which is FR-080's requirement.
 */
const ROOT = resolve(__dirname, '../../..');
const SOURCE = readFileSync(resolve(ROOT, 'src/services/run-driver.ts'), 'utf8');

describe('FR-R3-107 — the terminal outcome has one emitter', () => {
  it('exactly one call to emitTaskLifecycleAudit names task-execution-ended', () => {
    const emissions = [
      ...SOURCE.matchAll(/emitTaskLifecycleAudit\(\s*'task-execution-ended'/g)
    ];
    expect(
      emissions.length,
      'more than one emission body means the drift this item removed can return'
    ).toBe(1);
  });

  it('the emitter derives its statistics rather than hand-writing them', () => {
    const method = /private async emitTerminalOutcome\([\s\S]*?\n {2}\}/.exec(SOURCE);
    expect(method, 'the single emitter must exist').not.toBeNull();
    const body = (method as RegExpExecArray)[0];
    expect(body).toContain('...this.computePhaseStats(run)');
    expect(body).toContain('durationMs');
    // The specific regression: zeros typed in rather than computed.
    expect(body).not.toMatch(/phasesCompleted:\s*0/);
    expect(body).not.toMatch(/phasesSkipped:\s*0/);
  });

  it('the emitter guards the optional dependency once, and warns rather than throwing', () => {
    const method = /private async emitTerminalOutcome\([\s\S]*?\n {2}\}/.exec(SOURCE);
    const body = (method as RegExpExecArray)[0];
    // Guarded, so an absent appender is a no-op rather than a thrown TypeError...
    expect(body).toContain('if (!this.deps.emitTaskLifecycleAudit) return;');
    // ...and wrapped, so an audit failure never turns a completed Run into a failed one.
    expect(body).toContain('catch');
    expect(body).toContain('logger.warn');
    // The warning names WHICH terminal status failed; before, two of three did.
    expect(body).toContain('${terminalStatus}');
  });

  it('no call site hand-writes the payload any more', () => {
    // Each of the three now passes only what it alone knows: the status, and an error
    // summary where it has one.
    const calls = [...SOURCE.matchAll(/this\.emitTerminalOutcome\(([^;]*?)\);/gs)];
    expect(calls.length, 'all three terminal paths must route through the emitter').toBe(3);
    for (const call of calls) {
      const args = call[1] as string;
      expect(args).not.toContain('taskId');
      expect(args).not.toContain('phasesTotal');
      expect(args).not.toContain('computePhaseStats');
    }
  });

  it('the CLI-probe path is one of the three, so its zeros are now derived', () => {
    // The specific site that had drifted. Its neighbourhood is distinctive: it follows the
    // probe failure's queue.finish and precedes the run-ended breakpoint audit.
    // Searched FORWARD from the probe marker: `emitRunEndedBreakpointAudit` also appears
    // in the dependency interface far above, so an unbounded indexOf would slice
    // backwards and silently produce an empty region — a check that passes over nothing.
    const probeAt = SOURCE.indexOf('queue.finish (probe failed)');
    expect(probeAt, 'the probe-failure path must still exist').toBeGreaterThan(0);
    const probeRegion = SOURCE.slice(
      probeAt,
      SOURCE.indexOf('emitRunEndedBreakpointAudit', probeAt)
    );
    expect(probeRegion.length, 'the probe region must not be empty').toBeGreaterThan(50);
    expect(probeRegion).toContain("this.emitTerminalOutcome(run, 'failed'");
    expect(probeRegion).not.toMatch(/phasesCompleted:\s*0/);
  });

  it('the persistence chain was not reordered by the extraction (FR-081)', () => {
    // The extraction moved code; it must not have moved an await relative to the
    // serialized commit point. The ordering that matters at the failed path is: queue
    // finish, then history record, then the audit — the audit last, because it is the only
    // one whose failure is tolerated.
    const failedRegion = SOURCE.slice(
      SOURCE.indexOf('history record (failed)'),
      SOURCE.indexOf('history record (failed)') + 800
    );
    const historyAt = failedRegion.indexOf('history record (failed)');
    const auditAt = failedRegion.indexOf('emitTerminalOutcome');
    expect(historyAt).toBeGreaterThanOrEqual(0);
    expect(auditAt).toBeGreaterThan(historyAt);
  });
});
